import { assertSaneRate } from '@changuito/mcp/fx';

/**
 * Pesos per USDC for the checkout quote: Belo's USDC `compra`, from dolarapi.
 *
 * `compra` is what Belo charges to *buy* one USDC. Selling the shopper's USDC
 * for pesos yields `venta`, about 1.6% less, so each settled order is worth a
 * little less in pesos than the basket it paid for, and the treasury absorbs
 * the difference. That is a product decision, not an oversight; README says it.
 *
 * There is no fallback to another source. The old one (open.er-api, the
 * official rate) sits about 10% away from this one, and quoting a shopper on a
 * different rate than the modal names, without saying so, is worse than
 * answering "no rate right now".
 *
 * `ARS_PER_USD` still pins the rate, so a demo quotes the same number every time.
 */
export const RATE_URL = 'https://dolarapi.com/v1/exchanges/monedas/usd/ars';
export const RATE_SOURCE = 'belo';

const TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60_000;

export interface CheckoutRate {
  arsPerUsd: number;
  source: string;
  fetchedAt: number;
}

export interface ExchangeRow {
  exchange?: string;
  criptomonedaBase?: string | null;
  compra?: number | null;
  venta?: number | null;
}

/** Belo's USDC row, `compra`. Pure, so the choice is testable without a network. */
export function pickBeloUsdc(rows: unknown): number {
  if (!Array.isArray(rows)) throw new Error('dolarapi: the response is not a list');
  const row = (rows as ExchangeRow[]).find(
    (r) => r?.exchange === RATE_SOURCE && r?.criptomonedaBase === 'USDC',
  );
  if (!row) throw new Error('dolarapi: no belo USDC row');
  if (typeof row.compra !== 'number' || !Number.isFinite(row.compra)) {
    throw new Error('dolarapi: belo USDC has no compra');
  }
  return assertSaneRate(row.compra, RATE_URL);
}

let cached: CheckoutRate | null = null;

export async function getCheckoutRate(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<CheckoutRate> {
  const override = Number(env.ARS_PER_USD);
  if (Number.isFinite(override) && override > 0) {
    return { arsPerUsd: assertSaneRate(override, 'ARS_PER_USD'), source: 'ARS_PER_USD', fetchedAt: now };
  }
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached;

  const res = await fetch(RATE_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`dolarapi answered ${res.status}`);
  cached = { arsPerUsd: pickBeloUsdc(await res.json()), source: RATE_SOURCE, fetchedAt: now };
  return cached;
}
