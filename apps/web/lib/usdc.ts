import { address, type Address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';

import { DEPLOYMENTS } from './deployments.ts';
import { TOKEN_PROGRAM } from './escrow.ts';
import { rpc } from './solana.ts';

export const USDC_MINT = address(DEPLOYMENTS.devnet.usdcMint);

/** The shopper's USDC account: the associated token account of our devnet mint. */
export async function usdcAccount(owner: string): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM });
  return ata;
}

/** "12.34" from base units, rounded down. */
export function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const cents = (units % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

export interface Balances {
  lamports: bigint;
  usdc: bigint;
  hasUsdcAccount: boolean;
}

export async function readBalances(owner: string): Promise<Balances> {
  const r = rpc();
  const ata = await usdcAccount(owner);
  const [{ value: lamports }, tok] = await Promise.all([
    r.getBalance(address(owner), { commitment: 'confirmed' }).send(),
    r.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send().catch(() => null),
  ]);
  return { lamports, usdc: tok ? BigInt(tok.value.amount) : 0n, hasUsdcAccount: Boolean(tok) };
}
