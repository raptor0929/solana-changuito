/**
 * Who may run a chat turn, and how many.
 *
 * Guests get FREE_TURNS chat POSTs per sessionId, a ceiling per Turnstile
 * pass (the `chg_human` cookie, which costs a solved challenge to replace),
 * and a softer ceiling per IP. After Pollar login the client proves the
 * wallet to /api/session/login (lib/session-issue.ts), which sets the signed
 * `chg_user` cookie; with it the guest counters are skipped and a per-wallet
 * hourly cap applies instead.
 *
 * The counters fail closed. They are the only thing between a stranger and
 * the Anthropic bill and the supermarkets' APIs, so a database error answers
 * 503 rather than waving the request through, and production without a
 * DATABASE_URL refuses too. Outside production an in-memory map stands in,
 * the same compromise as turn-store on one developer's machine.
 *
 * ## Failing closed has to mean failing *fast*
 *
 * This gate runs before /api/chat writes the first byte of its stream, and
 * that byte is what tells the browser the message landed — the difference
 * between a failed turn reading "No se envió" and "Se cortó antes de
 * responder" (CLAUDE.md §6). So every millisecond spent here is spent with
 * the shopper looking at a spinner and nothing behind it.
 *
 * The counters lived in Redis once, and the client there had no timeout at
 * all and retried five times, so one hung connection sat until Vercel cut the
 * request; and the guest path made seven of those calls in a row. Two fixes
 * came out of that and both are kept here: every round trip is raced against
 * a deadline, and the independent reads and writes are batched into two. The
 * worst case is a few seconds and a 503 the shopper can read, rather than a
 * minute of nothing. The verdict is unchanged — this is about how long it
 * takes to reach it.
 */

import { createHash } from 'node:crypto';

import { hasDatabase } from './db.ts';
import { HUMAN_COOKIE, readCookie } from './human-gate.ts';
import { quotaGet, quotaIncr } from './kv.ts';
import {
  FREE_TURNS,
  FREE_TURNS_PER_IP,
  LOGIN_REQUIRED,
  LOGIN_REQUIRED_MESSAGE,
  USER_COOKIE,
} from './login-constants.ts';

export {
  FREE_TURNS,
  FREE_TURNS_PER_IP,
  LOGIN_CTA,
  LOGIN_REQUIRED,
  LOGIN_REQUIRED_MESSAGE,
  USER_COOKIE,
  loginGateBannerText,
  shouldShowLoginGate,
} from './login-constants.ts';
export type { LoginGateInput } from './login-constants.ts';

/** Guest turns per Turnstile pass. Rotating sessionId stops here. */
export const FREE_TURNS_PER_HUMAN = FREE_TURNS * 3;

/** Turns per verified wallet per hour. A basket is a handful; this is a lot of baskets. */
export const USER_TURNS_PER_HOUR = 60;

const TTL_SECONDS = 60 * 60; // match turn-store: abandon after an hour
const HUMAN_TTL_SECONDS = 12 * 60 * 60; // as long as the chg_human cookie lives
const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const KEY_SESSION = (sessionId: string) => `changuito:guest-turns:${sessionId}`;
const KEY_IP = (ip: string) => `changuito:guest-turns-ip:${ip}`;
const KEY_HUMAN = (token: string) =>
  `changuito:guest-turns-human:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
const KEY_USER = (address: string) => `changuito:user-turns:${address}`;

// ---------------------------------------------------------------- cookie

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64url(sig);
}

/**
 * The key `chg_user` is signed with, or '' when there is none to use.
 *
 * Production takes CHG_SESSION_SECRET and nothing else: falling back to the
 * Turnstile secret made one leak forge both cookies, and the local constant
 * is public. Empty means no cookie is issued and none is accepted — signed-in
 * shoppers fall back to guest limits until the secret is set.
 */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = (env.CHG_SESSION_SECRET ?? '').trim();
  if (dedicated) return dedicated;
  if (env.NODE_ENV === 'production') return '';
  const turnstile = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (turnstile) return turnstile;
  return 'dev-chg-session-not-for-prod';
}

/**
 * Token format: `v2.exp.address.sig`, address base64url(utf8).
 *
 * v2 because every v1 cookie was minted for whatever address the browser
 * named, with no proof. Rejecting the old shape signs those out.
 */
const TOKEN_VERSION = 'v2';

export async function mintUserToken(
  address: string,
  secret: string,
  now = Date.now(),
  ttlMs = USER_TTL_MS,
): Promise<string> {
  if (!secret) throw new Error('no session secret');
  const exp = String(now + ttlMs);
  const addr = btoa(address).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const payload = `${TOKEN_VERSION}.${exp}.${addr}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyUserToken(
  token: string | undefined | null,
  secret: string,
  now = Date.now(),
): Promise<{ ok: true; address: string } | { ok: false }> {
  if (!token || !secret) return { ok: false };
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return { ok: false };
  const [version, expStr, addrB64, sig] = parts as [string, string, string, string];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return { ok: false };
  const expected = await hmac(secret, `${version}.${expStr}.${addrB64}`);
  if (expected.length !== sig.length) return { ok: false };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false };
  try {
    const pad = addrB64.length % 4 === 0 ? '' : '='.repeat(4 - (addrB64.length % 4));
    const b64 = addrB64.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const address = atob(b64);
    if (!address || address.length < 8) return { ok: false };
    return { ok: true, address };
  } catch {
    return { ok: false };
  }
}

export function userCookieHeader(token: string, maxAgeSec = USER_TTL_MS / 1000): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${USER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}${secure}`;
}

export function clearUserCookieHeader(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function readLoggedInUser(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; address: string } | { ok: false }> {
  const token = readCookie(req.headers.get('cookie'), USER_COOKIE);
  return verifyUserToken(token, sessionSecret(env));
}

export function loginRequiredResponse(turnsUsed = FREE_TURNS): Response {
  return Response.json(
    {
      error: LOGIN_REQUIRED,
      message: LOGIN_REQUIRED_MESSAGE,
      freeTurns: FREE_TURNS,
      turnsUsed,
    },
    { status: 401 },
  );
}

export function limiterUnavailableResponse(): Response {
  return Response.json(
    { error: 'limiter_unavailable', message: 'No pudimos verificar tu cupo. Probá de nuevo en un momento.' },
    { status: 503 },
  );
}

export function rateLimitedResponse(message: string): Response {
  return Response.json({ error: 'rate_limited', message }, { status: 429 });
}

// ---------------------------------------------------------------- counter store

/** Thrown by a counter that cannot answer. Callers refuse the request. */
export class CounterUnavailable extends Error {}

export interface TurnCounter {
  get(key: string): Promise<number>;
  /**
   * Atomically increment and return the new value. The window starts on the
   * first increment and does not slide, so a steady trickle cannot keep a
   * count alive forever.
   */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  /**
   * `redis` is no longer built. It stays in the union because
   * lib/test/login-gate.test.ts pins the fail-closed path with a fake of that
   * kind, and the tests are the fixed point (CLAUDE.md).
   */
  readonly kind: 'postgres' | 'redis' | 'memory' | 'unavailable';
}

/**
 * How long one counter round trip may take.
 *
 * Generous for a pooled Postgres in the same region, which answers in tens of
 * milliseconds, and short enough that the two batched phases below cannot
 * come close to the time a gateway is willing to wait for a first byte.
 */
const COUNTER_TIMEOUT_MS = 2_500;

/**
 * The statement keeps running on the server when the race is lost; what is
 * cut short is the wait, which is the only part the shopper can see.
 */
function deadline<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`counter took longer than ${COUNTER_TIMEOUT_MS}ms`)), COUNTER_TIMEOUT_MS);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function postgresCounter(): TurnCounter {
  return {
    kind: 'postgres',
    async get(key) {
      try {
        return await deadline(quotaGet(key));
      } catch (e) {
        console.error('[login-gate] counter read failed:', e);
        throw new CounterUnavailable('counter read failed');
      }
    },
    async incr(key, ttlSeconds = TTL_SECONDS) {
      try {
        return await deadline(quotaIncr(key, ttlSeconds));
      } catch (e) {
        console.error('[login-gate] counter incr failed:', e);
        throw new CounterUnavailable('counter incr failed');
      }
    },
  };
}

/** Production with no database: nothing shared to count with, so nothing is allowed. */
function unavailableCounter(): TurnCounter {
  const refuse = async (): Promise<number> => {
    throw new CounterUnavailable('no shared counter store');
  };
  return { kind: 'unavailable', get: refuse, incr: refuse };
}

export function memoryCounter(): TurnCounter {
  const map = new Map<string, { n: number; expires: number }>();
  const MAX = 512;

  function prune(now: number) {
    for (const [k, v] of map) if (v.expires <= now) map.delete(k);
    while (map.size > MAX) {
      const oldest = [...map.entries()].reduce((a, b) => (a[1].expires <= b[1].expires ? a : b));
      map.delete(oldest[0]);
    }
  }

  return {
    kind: 'memory',
    async get(key) {
      const hit = map.get(key);
      if (!hit || hit.expires <= Date.now()) return 0;
      return hit.n;
    },
    async incr(key, ttlSeconds = TTL_SECONDS) {
      const now = Date.now();
      prune(now);
      const hit = map.get(key);
      if (!hit || hit.expires <= now) {
        map.set(key, { n: 1, expires: now + ttlSeconds * 1000 });
        return 1;
      }
      hit.n += 1;
      return hit.n;
    },
  };
}

let counter: TurnCounter | undefined;

/** Exposed for tests — swap in a fresh memory counter, or a failing one. */
export function __resetTurnCounterForTests(next?: TurnCounter): void {
  counter = next ?? memoryCounter();
}

export function guestTurnCounter(env: NodeJS.ProcessEnv = process.env): TurnCounter {
  if (!counter) {
    if (hasDatabase(env)) counter = postgresCounter();
    else if (env.NODE_ENV === 'production') {
      console.error('[login-gate] no DATABASE_URL in production — chat and faucet quotas refuse every request.');
      counter = unavailableCounter();
    } else counter = memoryCounter();
    if (counter.kind === 'memory') console.log('[login-gate] in-memory counters (lost on restart).');
  }
  return counter;
}

/**
 * Count one use of `key` against `limit` per `ttlSeconds`.
 *
 * `unavailable` means the store could not answer, and the caller must refuse.
 */
export async function takeQuota(
  key: string,
  limit: number,
  ttlSeconds: number,
  store: TurnCounter = guestTurnCounter(),
): Promise<'ok' | 'limited' | 'unavailable'> {
  try {
    if ((await store.get(key)) >= limit) return 'limited';
    await store.incr(key, ttlSeconds);
    return 'ok';
  } catch (e) {
    if (e instanceof CounterUnavailable) return 'unavailable';
    throw e;
  }
}

/**
 * The caller's IP, from a header the edge sets rather than the client.
 *
 * `cf-connecting-ip` is written by Cloudflare, which fronts app.changuito.me.
 * `x-real-ip` is Vercel's own, from the TCP peer. The first X-Forwarded-For
 * value is whatever the client typed, so it is never read.
 */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const real = req.headers.get('x-real-ip')?.trim();
  return real || null;
}

export interface GateVerdict {
  allow: boolean;
  /** Turns already used *including* this one when allow=true; or the blocked count. */
  turnsUsed: number;
  reason?: 'login_required' | 'ip_limit' | 'human_limit';
}

/**
 * Pure decision given current counts. Exported for unit tests.
 * Counts are values *before* this attempt.
 */
export function guestChatVerdict(args: {
  loggedIn: boolean;
  sessionCount: number;
  ipCount?: number;
  humanCount?: number;
  freeTurns?: number;
  freeTurnsPerIp?: number;
  freeTurnsPerHuman?: number;
}): GateVerdict {
  if (args.loggedIn) return { allow: true, turnsUsed: 0 };
  const free = args.freeTurns ?? FREE_TURNS;
  const freeIp = args.freeTurnsPerIp ?? FREE_TURNS_PER_IP;
  const freeHuman = args.freeTurnsPerHuman ?? FREE_TURNS_PER_HUMAN;
  if (args.sessionCount >= free) {
    return { allow: false, turnsUsed: args.sessionCount, reason: 'login_required' };
  }
  if (args.humanCount !== undefined && args.humanCount >= freeHuman) {
    return { allow: false, turnsUsed: args.sessionCount, reason: 'human_limit' };
  }
  if (args.ipCount !== undefined && args.ipCount >= freeIp) {
    return { allow: false, turnsUsed: args.sessionCount, reason: 'ip_limit' };
  }
  return { allow: true, turnsUsed: args.sessionCount + 1 };
}

/**
 * Gate /api/chat. Returns a Response to return immediately, or null to proceed.
 * Increments counters only when the request is allowed.
 */
export async function requireLoginOrFreeTurn(
  req: Request,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response | null> {
  const store = guestTurnCounter(env);

  try {
    const user = await readLoggedInUser(req, env);
    if (user.ok) {
      const quota = await takeQuota(KEY_USER(user.address), USER_TURNS_PER_HOUR, TTL_SECONDS, store);
      if (quota === 'unavailable') return limiterUnavailableResponse();
      if (quota === 'limited') {
        return rateLimitedResponse('Llegaste al límite de búsquedas por hora. Probá de nuevo en un rato.');
      }
      return null;
    }

    const ip = clientIp(req);
    const human = readCookie(req.headers.get('cookie'), HUMAN_COOKIE);

    // Three independent questions, so one round trip. They were asked in
    // sequence, which cost three and told us nothing extra: no answer here
    // depends on another, and `guestChatVerdict` wants all of them anyway.
    const [sessionCount, ipCount, humanCount] = await Promise.all([
      store.get(KEY_SESSION(sessionId)),
      ip ? store.get(KEY_IP(ip)) : Promise.resolve(undefined),
      human ? store.get(KEY_HUMAN(human)) : Promise.resolve(undefined),
    ]);

    const verdict = guestChatVerdict({ loggedIn: false, sessionCount, ipCount, humanCount });
    if (!verdict.allow) return loginRequiredResponse(verdict.turnsUsed);

    // Likewise. They are three separate keys and nothing orders them; the
    // turn is allowed or refused by the verdict above, and these only record
    // that it happened.
    await Promise.all([
      store.incr(KEY_SESSION(sessionId), TTL_SECONDS),
      ip ? store.incr(KEY_IP(ip), TTL_SECONDS) : Promise.resolve(0),
      human ? store.incr(KEY_HUMAN(human), HUMAN_TTL_SECONDS) : Promise.resolve(0),
    ]);
    return null;
  } catch (e) {
    if (e instanceof CounterUnavailable) return limiterUnavailableResponse();
    throw e;
  }
}
