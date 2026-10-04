'use client';

import { createContext, useContext } from 'react';

/**
 * The one wallet surface the app sees. Privy lives behind it
 * (components/WalletProvider.tsx), so no component imports a Privy hook and a
 * build without NEXT_PUBLIC_PRIVY_APP_ID renders the same tree with
 * `enabled: false` — chat, search and cart work, paying does not.
 *
 * It is a context rather than a hook over Privy's hooks because those hooks
 * throw outside a PrivyProvider, and whether there is one is a build-time
 * fact. A context default is the cheapest way to keep hook order fixed.
 */
export interface WalletState {
  /** This build has a Privy app id at all. */
  enabled: boolean;
  /** Privy finished restoring its session. Before this, `address` means nothing. */
  ready: boolean;
  authenticated: boolean;
  /** The embedded Solana wallet, base58. Case-sensitive: never upper-case it. */
  address: string | null;
  email: string | null;
  login: () => void;
  logout: () => Promise<void>;
  /** Privy access token, for /api/session/login. */
  accessToken: () => Promise<string | null>;
  /**
   * Sign and send a serialized transaction with the embedded wallet. Fees are
   * sponsored by Privy, so the wallet needs no SOL for them (rent is separate).
   * Resolves to the base58 signature.
   */
  signAndSend: (tx: Uint8Array) => Promise<string>;
}

const missing = async (): Promise<never> => {
  throw new Error('wallet unavailable');
};

export const WALLET_OFF: WalletState = {
  enabled: false,
  ready: true,
  authenticated: false,
  address: null,
  email: null,
  login: () => {},
  logout: async () => {},
  accessToken: async () => null,
  signAndSend: missing,
};

export const WalletContext = createContext<WalletState>(WALLET_OFF);

export function useWallet(): WalletState {
  return useContext(WalletContext);
}

/** `9rYN…tdMM` — the ends are what a person compares. */
export function shortAddress(address: string, keep = 4): string {
  if (address.length <= keep * 2 + 1) return address;
  return `${address.slice(0, keep)}…${address.slice(-keep)}`;
}
