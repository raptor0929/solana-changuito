/**
 * The shopper's Día details: what the checkout sandbox needs to buy in their
 * own Día account. Saved once from the profile modal instead of typed into
 * every checkout.
 *
 * Stored encrypted (lib/profile-crypto.ts) in the `profile` table, keyed by
 * network and wallet address, read with both in the WHERE — an address is the
 * only identity this app has, and it comes from the session cookie, never
 * from the request body.
 *
 * Two views, never confused:
 *   - `DiaProfile` has the password. It exists only inside the server, between
 *     decrypt and the sandbox job body (app/api/checkout/start).
 *   - `PublicProfile` is what a browser may see: everything but the password,
 *     which is reduced to `hasPassword`.
 *
 * Without DATABASE_URL, development keeps profiles in an in-process Map (on
 * globalThis, as lib/checkout/store.ts does, so every route bundle sees the
 * same one). Production without a database refuses to store one at all.
 */
import { db, hasDatabase } from './db.ts';
import { aadFor, decryptProfile, encryptProfile, keyring, type Envelope } from './profile-crypto.ts';

export interface DiaProfile {
  email?: string;
  password?: string;
  dni?: string;
  postcode?: string;
}

export interface PublicProfile {
  email: string | null;
  dni: string | null;
  postcode: string | null;
  hasPassword: boolean;
  /** Email, password and DNI: enough for the sandbox to log in. */
  complete: boolean;
}

export const PROFILE_NETWORK = 'devnet';

export class ProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileInputError';
  }
}

export class ProfileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileUnavailableError';
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const POSTCODE = /^[A-Za-z0-9]{4,8}$/;

export function isComplete(p: DiaProfile | undefined): boolean {
  return Boolean(p?.email && p.password && p.dni);
}

export function publicProfile(p: DiaProfile | undefined): PublicProfile {
  return {
    email: p?.email ?? null,
    dni: p?.dni ?? null,
    postcode: p?.postcode ?? null,
    hasPassword: Boolean(p?.password),
    complete: isComplete(p),
  };
}

/**
 * Apply a patch from the profile form to what is stored. A field left blank
 * keeps its stored value, the password above all: the form never shows it,
 * so an empty password box means "unchanged", not "delete". Throws
 * ProfileInputError with a message the form can show.
 */
export function mergeProfile(current: DiaProfile | undefined, patch: unknown): DiaProfile {
  const p = (patch ?? {}) as Record<string, unknown>;
  const next: DiaProfile = { ...current };
  const text = (k: string, max: number) => {
    const v = p[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
    if (typeof v !== 'string' || v.length > max) throw new ProfileInputError(`Revisá el campo ${k}.`);
    return v.trim();
  };
  const email = text('email', 254);
  if (email !== undefined) {
    if (!EMAIL.test(email)) throw new ProfileInputError('Ese email no parece válido.');
    next.email = email;
  }
  if (typeof p.password === 'string' && p.password.length > 0) {
    if (p.password.length > 128) throw new ProfileInputError('La contraseña es demasiado larga.');
    next.password = p.password; // not trimmed: a password is what it is
  }
  const dni = text('dni', 12)?.replace(/\D/g, '');
  if (dni !== undefined) {
    if (!/^\d{7,9}$/.test(dni)) throw new ProfileInputError('El DNI tiene que tener 7 a 9 números.');
    next.dni = dni;
  }
  const postcode = text('postcode', 8);
  if (postcode !== undefined) {
    if (!POSTCODE.test(postcode)) throw new ProfileInputError('El código postal tiene que tener 4 a 8 letras o números.');
    next.postcode = postcode.toUpperCase();
  }
  return next;
}

// ---- storage -----------------------------------------------------------------

const g = globalThis as { __chgProfiles?: Map<string, Envelope> };
const memory = (g.__chgProfiles ??= new Map());

function backend(env: NodeJS.ProcessEnv = process.env): 'db' | 'memory' {
  if (hasDatabase(env)) return 'db';
  if (env.NODE_ENV === 'production') throw new ProfileUnavailableError('DATABASE_URL is not set');
  return 'memory';
}

async function readEnvelope(network: string, address: string): Promise<Envelope | undefined> {
  if (backend() === 'memory') return memory.get(aadFor(network, address));
  const rows = await db()`select secret from profile where network = ${network} and address = ${address}`;
  return rows[0]?.secret as Envelope | undefined;
}

async function writeEnvelope(network: string, address: string, env: Envelope): Promise<void> {
  if (backend() === 'memory') {
    memory.set(aadFor(network, address), env);
    return;
  }
  await db()`
    insert into profile (network, address, secret) values (${network}, ${address}, ${db().json(env as never)})
    on conflict (network, address) do update set secret = excluded.secret`;
}

/** The full profile, password included. Server-only; see the header. */
export async function getProfile(address: string, network = PROFILE_NETWORK): Promise<DiaProfile | undefined> {
  const env = await readEnvelope(network, address);
  if (!env) return undefined;
  return decryptProfile<DiaProfile>(env, aadFor(network, address), keyring());
}

export async function saveProfile(address: string, patch: unknown, network = PROFILE_NETWORK): Promise<DiaProfile> {
  const ring = keyring(); // before any read: no key, no write
  const next = mergeProfile(await getProfile(address, network), patch);
  await writeEnvelope(network, address, encryptProfile(next, aadFor(network, address), ring));
  return next;
}
