import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { aadFor, decryptProfile, encryptProfile, keyring, ProfileKeyError } from '../profile-crypto.ts';

type Env = Parameters<typeof keyring>[0];
const KEY = randomBytes(32).toString('base64');
const OTHER = randomBytes(32).toString('base64');
const ring = keyring({ PROFILE_ENC_KEY: KEY } as Env);
const AAD = aadFor('devnet', 'BuyerAddress1111111111111111111111111111111');
const DATA = { email: 'a@b.com', password: 'hunter2', dni: '30123456', postcode: '1425' };

describe('profile encryption', () => {
  it('round-trips, and the envelope holds no plaintext', () => {
    const env = encryptProfile(DATA, AAD, ring);
    assert.deepEqual(decryptProfile(env, AAD, ring), DATA);
    assert.ok(!JSON.stringify(env).includes('hunter2'));
    assert.ok(!JSON.stringify(env).includes('30123456'));
  });

  it('uses a fresh IV every time', () => {
    assert.notEqual(encryptProfile(DATA, AAD, ring).iv, encryptProfile(DATA, AAD, ring).iv);
  });

  it("will not open for another wallet's address", () => {
    const env = encryptProfile(DATA, AAD, ring);
    assert.throws(() => decryptProfile(env, aadFor('devnet', 'SomeoneElse1111111111111111111111111111111'), ring));
  });

  it('rejects a tampered ciphertext or tag', () => {
    const env = encryptProfile(DATA, AAD, ring);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, 'base64');
      b[0] = b[0]! ^ 1;
      return b.toString('base64');
    };
    assert.throws(() => decryptProfile({ ...env, ct: flip(env.ct) }, AAD, ring));
    assert.throws(() => decryptProfile({ ...env, tag: flip(env.tag) }, AAD, ring));
  });

  it('has no fallback key', () => {
    assert.throws(() => keyring({} as Env), ProfileKeyError);
    assert.throws(() => keyring({ PROFILE_ENC_KEY: 'c2hvcnQ=' } as Env), ProfileKeyError);
  });

  it('reads with the old key after a rotation, and writes with the new one', () => {
    const before = encryptProfile(DATA, AAD, keyring({ PROFILE_ENC_KEY: OTHER } as Env));
    const rotated = keyring({ PROFILE_ENC_KEY: KEY, PROFILE_ENC_KEY_OLD: OTHER } as Env);
    assert.deepEqual(decryptProfile(before, AAD, rotated), DATA);
    assert.equal(encryptProfile(DATA, AAD, rotated).kid, ring.current.kid);
    assert.throws(() => decryptProfile(before, AAD, ring), ProfileKeyError);
  });
});
