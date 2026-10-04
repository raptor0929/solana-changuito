import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { hexToBytes, openIx } from '../escrow.ts';
import { rpc } from '../solana.ts';
import { usdcAccount } from '../usdc.ts';
import type { QuoteResponse } from './types.ts';

/**
 * The unsigned `open` transaction, serialized, for the Privy wallet to sign
 * and send. The buyer is the fee payer on paper; with `sponsor: true` Privy
 * pays the fee, and the buyer pays only the rent for the order and vault
 * accounts (the faucet sends SOL for that).
 */
export async function openTransaction(buyer: string, q: QuoteResponse): Promise<Uint8Array> {
  const ix = await openIx({
    program: address(q.programId),
    buyer: address(buyer),
    mint: address(q.usdcMint),
    buyerToken: await usdcAccount(buyer),
    orderId: hexToBytes(q.orderId),
    amount: BigInt(q.amount),
    basketHash: hexToBytes(q.basketHash),
    timeoutSecs: BigInt(q.timeoutSecs),
  });
  const { value: blockhash } = await rpc().getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(buyer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return Uint8Array.from(getTransactionEncoder().encode(compileTransaction(msg)));
}
