import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from '@solana/kit';

import { DEPLOYMENTS } from '../deployments.ts';

/**
 * The resolver: the backend hot key that settles and refunds escrow orders and
 * mints devnet USDC for the faucet.
 *
 * `SOLANA_RESOLVER_SECRET` is the 64-byte keypair, either as the JSON array
 * `solana-keygen` writes or as base58. Its public key must match the one the
 * escrow was initialized with (deployments.json): a different key would sign
 * transactions the program rejects, so it is refused here, by name.
 */
let cached: Promise<KeyPairSigner> | null = null;

function secretBytes(raw: string): Uint8Array {
  const s = raw.trim();
  if (s.startsWith('[')) return Uint8Array.from(JSON.parse(s) as number[]);
  return Uint8Array.from(getBase58Encoder().encode(s));
}

export function resolverConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SOLANA_RESOLVER_SECRET);
}

export function resolverSigner(env: NodeJS.ProcessEnv = process.env): Promise<KeyPairSigner> {
  if (cached) return cached;
  const raw = env.SOLANA_RESOLVER_SECRET;
  if (!raw) return Promise.reject(new Error('SOLANA_RESOLVER_SECRET is not set'));
  cached = createKeyPairSignerFromBytes(secretBytes(raw)).then((signer) => {
    if (signer.address !== DEPLOYMENTS.devnet.resolver) {
      throw new Error(`SOLANA_RESOLVER_SECRET is ${signer.address}, the escrow expects ${DEPLOYMENTS.devnet.resolver}`);
    }
    return signer;
  });
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
