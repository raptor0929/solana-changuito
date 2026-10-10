/**
 * Encryption for the shopper's Día details (lib/profile.ts).
 *
 * AES-256-GCM in the web server, with a key from the environment that never
 * reaches the database. The row in `profile` is an envelope:
 *
 *   { v: 1, kid, iv, tag, ct }        base64 fields, 12-byte random IV
 *
 * The additional authenticated data is `network|address`, so an envelope only
 * opens for the wallet it was written for: a row copied onto another address
 * fails the tag check instead of handing somebody else's password over.
 *
 * Keys: PROFILE_ENC_KEY is 32 random bytes in base64 (`openssl rand -base64
 * 32`). Rotation: move the old key to PROFILE_ENC_KEY_OLD, set a new one;
 * reads open either, writes always use the new one. `kid` is a short hash of
 * the key, so the envelope says which key it needs without naming it.
 *
 * No fallback key, ever. A missing or malformed key is an error the caller
 * turns into a 503: a profile encrypted with a dev default would be readable
 * by anyone with the repo.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface Envelope {
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface Keyring {
  /** Writes use this one. */
  current: { kid: string; key: Buffer };
  /** Reads accept any of these, current included. */
  all: Map<string, Buffer>;
}

export class ProfileKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileKeyError';
  }
}

function parseKey(name: string, raw: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new ProfileKeyError(`${name} must be 32 bytes in base64 (openssl rand -base64 32)`);
  return key;
}

const kidOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

export function keyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env.PROFILE_ENC_KEY?.trim();
  if (!raw) throw new ProfileKeyError('PROFILE_ENC_KEY is not set');
  const key = parseKey('PROFILE_ENC_KEY', raw);
  const current = { kid: kidOf(key), key };
  const all = new Map([[current.kid, key]]);
  const old = env.PROFILE_ENC_KEY_OLD?.trim();
  if (old) {
    const k = parseKey('PROFILE_ENC_KEY_OLD', old);
    all.set(kidOf(k), k);
  }
  return { current, all };
}

export function aadFor(network: string, address: string): string {
  return `${network}|${address}`;
}

export function encryptProfile(data: unknown, aad: string, ring: Keyring): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return {
    v: 1,
    kid: ring.current.kid,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Throws on a wrong key, a wrong owner (AAD) or any tampering. Never returns partial data. */
export function decryptProfile<T>(env: Envelope, aad: string, ring: Keyring): T {
  if (env?.v !== 1) throw new Error('unknown profile envelope version');
  const key = ring.all.get(env.kid);
  if (!key) throw new ProfileKeyError(`no key for kid ${env.kid}: was PROFILE_ENC_KEY rotated without PROFILE_ENC_KEY_OLD?`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
