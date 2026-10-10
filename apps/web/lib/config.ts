/**
 * Runtime switches from the `config` table (migration 0008), so the operator
 * can flip them without a redeploy: `npm run config -- set sandbox_mock true`.
 *
 * The table is the only source. A missing row, a missing table or no
 * DATABASE_URL all read as "off", the conservative direction for every flag
 * here. Reads are cached for 15 seconds per instance, so a flip takes effect
 * within that on every lambda.
 */
import { db, hasDatabase } from './db.ts';

const TTL_MS = 15_000;

let cached: { at: number; values: Record<string, unknown> } | null = null;

export async function getConfig(now = Date.now()): Promise<Record<string, unknown>> {
  if (cached && now - cached.at < TTL_MS) return cached.values;
  let values: Record<string, unknown> = {};
  if (hasDatabase()) {
    try {
      const rows = await db()`select key, value from config`;
      values = Object.fromEntries(rows.map((r) => [r.key as string, r.value]));
    } catch (err) {
      // A missing table (migration not applied) or a down database: every flag off.
      console.warn('[config] read failed; flags read as off:', err instanceof Error ? err.message : err);
    }
  }
  cached = { at: now, values };
  return values;
}

/** Only a JSON `true` (or the string "true") turns a flag on. */
export function flagOn(values: Record<string, unknown>, key: string): boolean {
  const v = values[key];
  return v === true || v === 'true';
}

export interface SandboxFlags {
  /** Run checkouts on the in-process mock instead of the sandbox service. */
  mock: boolean;
  /** Make the mock's card come back declined (the refund path). */
  mockFail: boolean;
}

export async function sandboxFlags(): Promise<SandboxFlags> {
  const values = await getConfig();
  return { mock: flagOn(values, 'sandbox_mock'), mockFail: flagOn(values, 'sandbox_mock_fail') };
}
