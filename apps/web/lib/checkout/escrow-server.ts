import { address, getBase58Decoder } from '@solana/kit';

import { DEPLOYMENTS } from '../deployments.ts';
import { decodeOrder, hexToBytes, ORDER_DISCRIMINATOR, orderPda, refundIx, settleIx, type OrderAccount } from '../escrow.ts';
import { resolverSigner } from '../server/resolver.ts';
import { rpc, sendIxs } from '../solana.ts';
import { usdcAccount } from '../usdc.ts';

/**
 * The resolver's side of the escrow: read an order, settle it to the
 * treasury, refund it to the buyer. Every write checks the chain first, so a
 * poll that arrives twice cannot settle twice — and the program would refuse
 * a second close anyway (`OrderClosed`).
 */
const PROGRAM = address(DEPLOYMENTS.devnet.programId);
const TREASURY_TOKEN = address(DEPLOYMENTS.devnet.treasuryToken);

export async function readOrder(orderIdHex: string): Promise<OrderAccount | null> {
  const pda = await orderPda(PROGRAM, hexToBytes(orderIdHex));
  const { value } = await rpc().getAccountInfo(pda, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!value || value.owner !== PROGRAM) return null;
  return decodeOrder(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
}

export async function settleOrder(order: OrderAccount, receiptHash: Uint8Array): Promise<string> {
  const resolver = await resolverSigner();
  return sendIxs(resolver, [
    await settleIx({
      program: PROGRAM,
      resolver: resolver.address,
      orderId: hexToBytes(order.orderId),
      treasuryToken: TREASURY_TOKEN,
      buyer: order.buyer,
      basketHash: hexToBytes(order.basketHash),
      receiptHash,
    }),
  ]);
}

export async function refundOrder(order: OrderAccount): Promise<string> {
  const resolver = await resolverSigner();
  return sendIxs(resolver, [
    await refundIx({
      program: PROGRAM,
      caller: resolver.address,
      orderId: hexToBytes(order.orderId),
      buyerToken: await usdcAccount(order.buyer),
      buyer: order.buyer,
    }),
  ]);
}

/** Every order this wallet has opened, newest first. Order.buyer sits at byte 40. */
export async function ordersOf(buyer: string): Promise<OrderAccount[]> {
  const b58 = getBase58Decoder();
  const res = await rpc()
    .getProgramAccounts(PROGRAM, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0n, bytes: b58.decode(ORDER_DISCRIMINATOR) as never, encoding: 'base58' } },
        { memcmp: { offset: 40n, bytes: buyer as never, encoding: 'base58' } },
      ],
    })
    .send();
  return (res as unknown as { account: { data: [string, string] } }[])
    .map((a) => decodeOrder(Uint8Array.from(Buffer.from(a.account.data[0], 'base64'))))
    .filter((o): o is OrderAccount => o !== null)
    .sort((a, b) => b.openedAt - a.openedAt);
}
