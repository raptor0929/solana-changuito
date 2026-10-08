/**
 * The expiring key-value and counter tables, which is what Redis used to be.
 *
 * Three callers: the agent's in-flight turn (agent/turn-store.ts), the
 * checkout record between quote and settle (checkout/store.ts), and the chat
 * and faucet quotas (login-gate.ts). Each used to open its own Upstash client;
 * now each goes through here, so the SQL for "a value that expires" is written
 * once. See supabase/migrations/0006_kv.sql for the tables.
 *
 * Two things carried over from the Redis shape on purpose:
 *
 * - **Expiry is the database's clock.** `expires_at` is compared to `now()` in
 *   every read, so a row past its time is already invisible whether or not the
 *   sweep has reached it. Lambdas do not agree on the time; Postgres does.
 * - **The sweep is opportunistic.** One write in every `SWEEP_EVERY` deletes
 *   the expired rows of its table, fire and forget. A cron would do it more
 *   evenly, and would be one more thing to provision; the index on
 *   `expires_at` makes the delete cheap enough that nobody will notice.
 *
 * Nothing here catches errors. Each caller decides what a failed round trip
 * means — a lost turn degrades, a counter refuses — and that decision belongs
 * next to the reason for it.
 */
import { db } from './db.ts';

const SWEEP_EVERY = 32;
let writes = 0;

function sweep(table: 'kv' | 'quota'): void {
  if (++writes % SWEEP_EVERY !== 0) return;
  const gone =
    table === 'kv' ? db()`delete from kv where expires_at <= now()` : db()`delete from quota where expires_at <= now()`;
  gone.then(
    () => {},
    (e) => console.error(`[kv] sweep of ${table} failed:`, e),
  );
}

/** The value under `key`, or undefined when there is none or it has expired. */
export async function kvGet(key: string): Promise<unknown> {
  const rows = await db()`select value from kv where key = ${key} and expires_at > now()`;
  return rows[0]?.value;
}

/** Write `value` under `key`, to live `ttlSeconds` from now. Replaces. */
export async function kvSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const sql = db();
  await sql`
    insert into kv (key, value, expires_at)
    values (${key}, ${sql.json(value as never)}, now() + make_interval(secs => ${ttlSeconds}))
    on conflict (key) do update
       set value      = excluded.value,
           expires_at = excluded.expires_at`;
  sweep('kv');
}

/** The live count under `key`, or 0. */
export async function quotaGet(key: string): Promise<number> {
  const rows = await db()`select n from quota where key = ${key} and expires_at > now()`;
  const n = rows[0]?.n;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Count one more under `key` and return the new total.
 *
 * The window starts on the first increment and does not slide: a lapsed row
 * restarts at 1 with a fresh `expires_at`, a live one keeps its deadline. One
 * statement, so two lambdas incrementing at once cannot both see 1.
 */
export async function quotaIncr(key: string, ttlSeconds: number): Promise<number> {
  const rows = await db()`
    insert into quota (key, n, expires_at)
    values (${key}, 1, now() + make_interval(secs => ${ttlSeconds}))
    on conflict (key) do update
       set n          = case when quota.expires_at <= now() then 1 else quota.n + 1 end,
           expires_at = case when quota.expires_at <= now() then excluded.expires_at else quota.expires_at end
    returning n`;
  sweep('quota');
  const n = rows[0]?.n;
  return typeof n === 'number' ? n : 1;
}
