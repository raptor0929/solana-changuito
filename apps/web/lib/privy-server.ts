import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Server-side Privy: verify an access token and find the user's embedded
 * Solana wallet.
 *
 * Not @privy-io/node: it pins @solana/kit 5 against the 8 the rest of the app
 * uses. An access token is an ES256 JWT signed by the app's JWKS, and a user's
 * wallets are one REST call, so `jose` and `fetch` are the whole dependency.
 */
const AUTH = 'https://auth.privy.io';

let jwks: { appId: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

function keySet(appId: string) {
  if (!jwks || jwks.appId !== appId) {
    jwks = { appId, set: createRemoteJWKSet(new URL(`${AUTH}/api/v1/apps/${appId}/jwks.json`)) };
  }
  return jwks.set;
}

export interface PrivyIdentity {
  userId: string;
  address: string | null;
  email: string | null;
}

export async function verifyPrivyToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PrivyIdentity | null> {
  const appId = env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';
  const secret = env.PRIVY_APP_SECRET ?? '';
  if (!appId || !secret || !token) return null;

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, keySet(appId), { issuer: 'privy.io', audience: appId });
    if (typeof payload.sub !== 'string') return null;
    userId = payload.sub;
  } catch {
    return null;
  }

  const res = await fetch(`${AUTH}/api/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
      'privy-app-id': appId,
    },
    cache: 'no-store',
  }).catch(() => null);
  if (!res?.ok) return { userId, address: null, email: null };

  const user = (await res.json().catch(() => null)) as {
    linked_accounts?: { type?: string; chain_type?: string; wallet_client_type?: string; address?: string }[];
  } | null;
  const accounts = user?.linked_accounts ?? [];
  const wallet =
    accounts.find((a) => a.type === 'wallet' && a.chain_type === 'solana' && a.wallet_client_type === 'privy') ??
    accounts.find((a) => a.type === 'wallet' && a.chain_type === 'solana');
  const email = accounts.find((a) => a.type === 'email')?.address ?? null;
  return { userId, address: wallet?.address ?? null, email };
}
