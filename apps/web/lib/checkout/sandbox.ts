/**
 * The client for services/sandbox: a Jev + Playwright worker on Railway that
 * logs into the shopper's Día account, fills its cart with the basket, walks
 * checkout and pays with the operator's card.
 *
 *   POST {SANDBOX_URL}/jobs        { order_id, items, shopper }   -> { job_id }
 *   GET  {SANDBOX_URL}/jobs/{id}                                  -> SandboxJob
 *
 * `shopper` carries the shopper's Día login. It goes from the start route
 * straight into this request body and nowhere else: not the checkout record,
 * not a log line. The sandbox holds it in memory for the run and drops it.
 *
 * The mock is switched in the `config` table (lib/config.ts), not the
 * environment: `npm run config -- set sandbox_mock true` makes every new
 * checkout run on an in-process mock that walks the same phases on a clock
 * (~25s) and reports a placed order, even when SANDBOX_URL is set. That is how
 * the escrow flow is exercised without a browser farm, and how a demo turns
 * the real sandbox off in seconds. `sandbox_mock_fail` makes the mock's card
 * come back declined, which is the refund path. Neither flag set and no
 * SANDBOX_URL: checkout is off and every locked order refunds.
 *
 * The mock is stateless on purpose: the phase is derived from when the job
 * started, so it survives Next compiling each route into its own bundle.
 */

export type SandboxPhase = 'queued' | 'login' | 'empty_cart' | 'shop' | 'checkout' | 'payment' | 'placed';

/** What the store answered to the card. Only `placed` settles the escrow. */
export type SandboxPayment = 'placed' | 'declined' | 'not_attempted' | 'error';

export interface SandboxJob {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  phase: SandboxPhase;
  /** Present when status is done or failed. */
  result?: {
    /** True when the job reached Día's card step. */
    reached_payment: boolean;
    payment?: SandboxPayment;
    /** One line from the store's answer, with known personal values redacted by the sandbox. */
    payment_detail?: string | null;
    /** Día's order number, when placed. */
    store_order_id?: string | null;
    items_added: number;
    cart?: {
      orderFormId?: string;
      value?: number;
      shipping_centavos?: number | null;
      items?: { name: string; quantity: number; price?: number }[];
    };
    final_url?: string;
    wall_s?: number;
    timings?: Record<string, number>;
  };
  error?: string;
}

export interface SandboxItem {
  name: string;
  quantity: number;
  sku: string;
}

/** The shopper's Día login and where to deliver. Never stored; see the header. */
export interface SandboxShopper {
  email: string;
  password: string;
  dni: string;
  postcode?: string;
  street?: string;
  number?: string;
  phone?: string;
  complement?: string;
}

/** The two `config` flags this client reads. Mirrors lib/config.ts `SandboxFlags`; kept here so tests need no db. */
export interface MockFlags {
  mock: boolean;
  mockFail: boolean;
}

export function sandboxMode(flags: MockFlags, env: NodeJS.ProcessEnv = process.env): 'remote' | 'mock' | 'off' {
  if (flags.mock) return 'mock';
  return env.SANDBOX_URL ? 'remote' : 'off';
}

function remote(env: NodeJS.ProcessEnv) {
  const base = env.SANDBOX_URL!.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${env.SANDBOX_TOKEN ?? ''}` };
  return { base, headers };
}

export async function startJob(
  orderId: string,
  items: SandboxItem[],
  shopper: SandboxShopper,
  flags: MockFlags,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const mode = sandboxMode(flags, env);
  if (mode === 'off') throw new Error('checkout is off: no SANDBOX_URL and sandbox_mock is not on');
  if (mode === 'mock') {
    const fail = flags.mockFail ? 'f' : 'k';
    return `mock-${fail}-${Date.now()}-${items.length}`;
  }
  const { base, headers } = remote(env);
  const res = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ order_id: orderId, items, shopper }),
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
  [24, 'placed'],
];

function mockJob(jobId: string): SandboxJob {
  const [, flag, started, count] = jobId.split('-');
  const elapsed = (Date.now() - Number(started)) / 1000;
  let phase: SandboxPhase = 'login';
  for (const [at, p] of MOCK_PLAN) if (elapsed >= at) phase = p;
  const items = Number(count) || 0;

  if (phase !== 'placed') return { job_id: jobId, status: 'running', phase };
  const declined = flag === 'f';
  return {
    job_id: jobId,
    status: 'done',
    phase: declined ? 'payment' : 'placed',
    result: {
      reached_payment: true,
      payment: declined ? 'declined' : 'placed',
      payment_detail: declined ? 'mock: card declined (sandbox_mock_fail)' : 'mock: order placed',
      store_order_id: declined ? null : `mock-${started}`,
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
