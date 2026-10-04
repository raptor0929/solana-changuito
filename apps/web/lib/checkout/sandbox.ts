/**
 * The client for services/sandbox: a Jev + Playwright worker on Railway that
 * fills a Día cart with the basket and walks checkout up to the card step.
 *
 *   POST {SANDBOX_URL}/jobs        { order_id, items }   -> { job_id }
 *   GET  {SANDBOX_URL}/jobs/{id}                         -> SandboxJob
 *
 * Without SANDBOX_URL, outside production, a mock answers instead: it walks
 * the same phases on a clock (~20s) and then reports `reached_payment`. That
 * is how the escrow flow is exercised locally without a browser farm.
 * `SANDBOX_MOCK_FAIL=1` makes it fail at the checkout phase, which is the
 * refund path.
 *
 * The mock is stateless on purpose: the phase is derived from when the job
 * started, so it survives Next compiling each route into its own bundle.
 */

export type SandboxPhase = 'queued' | 'login' | 'empty_cart' | 'shop' | 'checkout' | 'payment';

export interface SandboxJob {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  phase: SandboxPhase;
  /** Present when status is done or failed. */
  result?: {
    /** True when the job reached Día's card step. */
    reached_payment: boolean;
    items_added: number;
    cart?: { orderFormId?: string; value?: number; items?: { name: string; quantity: number }[] };
    final_url?: string;
    wall_s?: number;
  };
  error?: string;
}

export interface SandboxItem {
  name: string;
  quantity: number;
  sku: string;
}

export function sandboxMode(env: NodeJS.ProcessEnv = process.env): 'remote' | 'mock' | 'off' {
  if (env.SANDBOX_URL) return 'remote';
  return env.NODE_ENV === 'production' && env.SANDBOX_MOCK !== '1' ? 'off' : 'mock';
}

function remote(env: NodeJS.ProcessEnv) {
  const base = env.SANDBOX_URL!.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.SANDBOX_TOKEN ?? ''}` };
  return { base, headers };
}

export async function startJob(
  orderId: string,
  items: SandboxItem[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const mode = sandboxMode(env);
  if (mode === 'off') throw new Error('SANDBOX_URL is not set');
  if (mode === 'mock') {
    const fail = env.SANDBOX_MOCK_FAIL === '1' ? 'f' : 'k';
    return `mock-${fail}-${Date.now()}-${items.length}`;
  }
  const { base, headers } = remote(env);
  const res = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ order_id: orderId, items }),
  });
  if (!res.ok) throw new Error(`sandbox answered ${res.status}`);
  const body = (await res.json()) as { job_id?: string };
  if (!body.job_id) throw new Error('sandbox returned no job_id');
  return body.job_id;
}

/** Seconds into a mock job at which each phase begins. */
const MOCK_PLAN: [number, SandboxPhase][] = [
  [0, 'login'],
  [4, 'empty_cart'],
  [7, 'shop'],
  [15, 'checkout'],
  [20, 'payment'],
];

function mockJob(jobId: string): SandboxJob {
  const [, flag, started, count] = jobId.split('-');
  const elapsed = (Date.now() - Number(started)) / 1000;
  let phase: SandboxPhase = 'login';
  for (const [at, p] of MOCK_PLAN) if (elapsed >= at) phase = p;
  const items = Number(count) || 0;

  if (flag === 'f' && phase === 'payment') {
    return { job_id: jobId, status: 'failed', phase: 'checkout', error: 'mock: forced failure (SANDBOX_MOCK_FAIL=1)' };
  }
  if (phase !== 'payment') return { job_id: jobId, status: 'running', phase };
  return {
    job_id: jobId,
    status: 'done',
    phase,
    result: {
      reached_payment: true,
      items_added: items,
      cart: { orderFormId: `mock-orderform-${started}` },
      final_url: 'https://diaonline.supermercadosdia.com.ar/checkout/#/payment',
      wall_s: Math.round(elapsed),
    },
  };
}

export async function readJob(jobId: string, env: NodeJS.ProcessEnv = process.env): Promise<SandboxJob> {
  if (jobId.startsWith('mock-')) return mockJob(jobId);
  const { base, headers } = remote(env);
  const res = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { headers, cache: 'no-store' });
  // The worker keeps jobs in memory. A 404 means it restarted and the job is
  // gone: that is a failure, and the escrow refunds.
  if (res.status === 404) return { job_id: jobId, status: 'failed', phase: 'queued', error: 'job lost (sandbox restarted)' };
  if (!res.ok) throw new Error(`sandbox answered ${res.status}`);
  return (await res.json()) as SandboxJob;
}
