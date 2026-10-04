'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import { DEFAULT_NETWORK, type NetworkId } from '../lib/deployments.ts';

/**
 * Which network the app is on. Since the move to Solana there is one: devnet.
 *
 * It used to be a toggle, then a value derived from the wallet session
 * (preview on one chain, production on another). Both are gone; the context
 * stays because a dozen call sites read `network` and pass it on, and a fixed
 * value behind the same hook is cheaper than touching every one of them.
 *
 * Nothing is read from storage during render, so the server's HTML and the
 * browser's first paint agree.
 */

interface NetworkState {
  network: NetworkId;
  /** Kept for the shape of the context; with one network nothing calls it. */
  setNetwork: (net: NetworkId) => void;
}

const Ctx = createContext<NetworkState>({ network: DEFAULT_NETWORK, setNetwork: () => {} });

export function useNetwork(): NetworkState {
  return useContext(Ctx);
}

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [network, setStored] = useState<NetworkId>(DEFAULT_NETWORK);

  const setNetwork = useCallback((net: NetworkId) => {
    setStored((current) => (current === net ? current : net));
  }, []);

  const value = useMemo(() => ({ network, setNetwork }), [network, setNetwork]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
