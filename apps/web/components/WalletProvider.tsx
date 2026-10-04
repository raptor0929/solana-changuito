'use client';

import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useSignAndSendTransaction, useWallets } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions, getBase58Decoder } from '@solana/kit';
import { useCallback, useMemo } from 'react';

import { DEFAULT_RPC } from '../lib/solana.ts';
import { WalletContext, WALLET_OFF, type WalletState } from '../lib/use-wallet.ts';

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';
const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || DEFAULT_RPC;
const WS = RPC.replace(/^http/, 'ws');

/**
 * Privy: email login, an embedded Solana wallet created on first login, and
 * sponsored fees on devnet. Without an app id the children render as they are
 * and `useWallet()` answers `enabled: false`.
 */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const rpcs = useMemo(
    () => ({
      'solana:devnet': {
        rpc: createSolanaRpc(RPC),
        rpcSubscriptions: createSolanaRpcSubscriptions(WS),
        blockExplorerUrl: 'https://solscan.io/?cluster=devnet',
      },
    }),
    [],
  );

  if (!APP_ID) return <WalletContext.Provider value={WALLET_OFF}>{children}</WalletContext.Provider>;

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ['email'],
        appearance: { walletChainType: 'solana-only', theme: 'light', accentColor: '#1f7a4d' },
        embeddedWallets: { solana: { createOnLogin: 'all-users' }, ethereum: { createOnLogin: 'off' } },
        solana: { rpcs: rpcs as never },
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}

function Bridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  // The embedded wallet, not whatever else the user linked.
  const wallet =
    wallets.find((w) => (w as { standardWallet?: { name?: string } }).standardWallet?.name === 'Privy') ?? wallets[0];
  const address = authenticated ? (wallet?.address ?? null) : null;

  const signAndSend = useCallback(
    async (tx: Uint8Array) => {
      if (!wallet) throw new Error('No hay billetera conectada.');
      const { signature } = await signAndSendTransaction({
        transaction: tx,
        wallet,
        chain: 'solana:devnet',
        options: { sponsor: true },
      });
      return getBase58Decoder().decode(signature);
    },
    [wallet, signAndSendTransaction],
  );

  const value = useMemo<WalletState>(
    () => ({
      enabled: true,
      ready: ready && (!authenticated || walletsReady),
      authenticated,
      address,
      email: user?.email?.address ?? null,
      login: () => login(),
      logout: () => logout(),
      accessToken: () => getAccessToken(),
      signAndSend,
    }),
    [ready, walletsReady, authenticated, address, user, login, logout, getAccessToken, signAndSend],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
