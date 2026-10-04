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

export interface OpenArgs {
  programId: string;
  usdcMint: string;
  orderId: string;
  amount: string;
  basketHash: string;
  timeoutSecs: number;
}

/**
 * The unsigned `open` transaction, serialized. Built on the server
 * (app/api/checkout/open) with the resolver as fee payer, so the shopper's
 * wallet needs no SOL for fees; it signs as the buyer and the server adds the
 * resolver's signature and sends. The buyer still pays the rent for the order
 * and vault accounts (`payer = buyer` in the program), which is why the faucet
 * sends a little SOL with the USDC.
 */
export async function openTransaction(buyer: string, q: OpenArgs, feePayer: string = buyer): Promise<Uint8Array> {
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
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return Uint8Array.from(getTransactionEncoder().encode(compileTransaction(msg)));
}
