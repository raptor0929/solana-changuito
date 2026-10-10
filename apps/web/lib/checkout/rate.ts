/**
 * Pesos per USDC for the escrow quote: belo's USDC `compra` from dolarapi.
 *
 * Why this rate and not a reference one: the shopper pays in USDC and the
 * basket is bought in pesos, so the number that matters is what an
 * Argentine exchange quotes for USDC, not the official or blue dollar.
 *
 * `compra` is the higher of belo's two quotes. Dividing pesos by it gives the
 * shopper the smaller USDC amount; turning that USDC back into pesos happens
 * at `venta`, so the treasury absorbs the spread (about 1.6% when this was
 * written). That is a product choice, not an oversight.
 *
 * No fallback to another source. A quote at a different exchange's rate is a
 * different price, and the shopper is about to lock money against it, so a
 * dead feed fails the quote instead.
 */
import { RATE_MIN, RATE_MAX } from '@changuito/mcp/fx';

export const RATE_SOURCE = 'https://dolarapi.com/v1/exchanges/monedas/usd/ars';
export const RATE_LABEL = 'belo · USDC';
const TTL_MS = 5 * 60_000;

export interface QuoteRate {
  arsPerUsd: number;
  source: string;
  fetchedAt: number;
}

interface Row {
  exchange?: string;
  criptomonedaBase?: string | null;
  compra?: number | null;
}

/** The first belo row quoting USDC, by its `compra`. Undefined when absent or absurd. */
export function pickBeloUsdc(rows: unknown): number | undefined {
  if (!Array.isArray(rows)) return undefined;
  const row = (rows as Row[]).find((r) => r?.exchange === 'belo' && r?.criptomonedaBase === 'USDC');
  const rate = row?.compra;
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX ? rate : undefined;
}

let cached: QuoteRate | null = null;

export async function quoteRate(opts: { override?: number; fetchImpl?: typeof fetch; now?: number } = {}): Promise<QuoteRate> {
  const now = opts.now ?? Date.now();
  if (opts.override && opts.override >= RATE_MIN && opts.override <= RATE_MAX) {
    return { arsPerUsd: opts.override, source: 'ARS_PER_USD', fetchedAt: now };
  }
  if (cached && now - cached.fetchedAt < TTL_MS) return cached;
  const res = await (opts.fetchImpl ?? fetch)(RATE_SOURCE, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`dolarapi answered ${res.status}`);
  const rate = pickBeloUsdc(await res.json());
  if (rate === undefined) throw new Error('dolarapi has no usable belo USDC quote');
  cached = { arsPerUsd: rate, source: RATE_LABEL, fetchedAt: now };
  return cached;
}
