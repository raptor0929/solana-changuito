/**
 * Solana devnet primitives shared by client and server: the RPC, address
 * checks, explorer links and USDC units. No relative imports, so tests and
 * scripts running under --experimental-strip-types can load it.
 */
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Encoder,
  getSignatureFromTransaction,
  pipe,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

export const DEFAULT_RPC = 'https://api.devnet.solana.com';

export function rpcUrl(): string {
  return (
    (typeof process !== 'undefined' && (process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL)) ||
    DEFAULT_RPC
  );
}

export const rpc = (url: string = rpcUrl()) => createSolanaRpc(url);

/** Base58, 32–44 chars, decodes to exactly 32 bytes. Case-sensitive: never upper-case one. */
export function isSolanaAddress(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return getBase58Encoder().encode(s).length === 32;
  } catch {
    return false;
  }
}

export const explorerTx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
export const explorerAccount = (a: string) => `https://solscan.io/account/${a}?cluster=devnet`;

export const USDC_DECIMALS = 6;
export const usdcToBase = (cents: number): bigint => BigInt(Math.round(cents)) * 10_000n;
export const baseToUsd = (base: bigint | number | string): number => Number(BigInt(base)) / 10 ** USDC_DECIMALS;

/**
 * Sign with the signers embedded in the instructions plus the fee payer, send,
 * and poll until confirmed. Polling rather than a websocket subscription: it
 * runs in a serverless function, where a socket is a liability.
 */
export async function sendIxs(feePayer: TransactionSigner, ixs: Instruction[], url: string = rpcUrl()): Promise<string> {
  const r = rpc(url);
  const { value: blockhash } = await r.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  await sendTransactionWithoutConfirmingFactory({ rpc: r })(tx as never, { commitment: 'confirmed' });
  await waitFor(sig, url);
  return sig;
}

export async function waitFor(sig: string, url: string = rpcUrl(), timeoutMs = 60_000): Promise<void> {
  const r = rpc(url);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // Public devnet answers 429 freely; a throttled poll is a pause, not a failure.
    const res = await r.getSignatureStatuses([sig as never]).send().catch(() => null);
    const s = res?.value[0];
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(`transaction ${sig} not confirmed in ${timeoutMs / 1000}s`);
}

export async function tokenBalance(tokenAccount: Address, url: string = rpcUrl()): Promise<bigint> {
  try {
    const { value } = await rpc(url).getTokenAccountBalance(tokenAccount).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}
