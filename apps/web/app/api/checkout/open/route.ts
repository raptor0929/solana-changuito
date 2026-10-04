/**
 * The `open` transaction, with the resolver paying the fee.
 *
 *   POST /api/checkout/open { orderId }          ->  { tx }       unsigned, base64
 *   PUT  /api/checkout/open { orderId, tx }      ->  { openSig }  buyer-signed in, sent out
 *
 * The shopper's embedded wallet holds USDC and a little SOL for rent, but not
 * for fees, and Privy's gas sponsorship is not set up. So the server builds
 * the transaction with the resolver as fee payer, the wallet signs it as the
 * buyer (sign only, no send), and the server adds the resolver's signature and
 * sends it.
 *
 * The resolver co-signs only the exact message it built for this order and
 * this buyer, stored with the quote. Anything else the browser sends back is
 * refused: a key that pays fees must not sign whatever it is handed.
 */
import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  verifySignature,
  type Address,
} from '@solana/kit';

import { openTransaction } from '../../../../lib/checkout/open-tx.ts';
import { checkoutStore } from '../../../../lib/checkout/store.ts';
import { DEPLOYMENTS } from '../../../../lib/deployments.ts';
import { readLoggedInUser } from '../../../../lib/login-gate.ts';
import { DEFAULT_TIMEOUT_SECS } from '../../../../lib/order.ts';
import { resolverSigner } from '../../../../lib/server/resolver.ts';
import { rpc, waitFor } from '../../../../lib/solana.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

async function load(req: Request) {
  const user = await readLoggedInUser(req);
  if (!user.ok) return { ok: false, res: Response.json({ error: 'Iniciá sesión para pagar.' }, { status: 401 }) } as const;
  const body = (await req.json().catch(() => null)) as { orderId?: unknown; tx?: unknown } | null;
  const orderId = typeof body?.orderId === 'string' && /^[0-9a-f]{64}$/.test(body.orderId) ? body.orderId : null;
  if (!orderId) return { ok: false, res: Response.json({ error: 'Pedido inválido.' }, { status: 400 }) } as const;
  const rec = await checkoutStore().get(orderId);
  if (!rec || rec.buyer !== user.address) {
    return { ok: false, res: Response.json({ error: 'No encontramos ese pedido.' }, { status: 404 }) } as const;
  }
  return { ok: true, rec, tx: body?.tx } as const;
}

export async function POST(req: Request): Promise<Response> {
  const got = await load(req);
  if (!got.ok) return got.res;
  const { rec } = got;
  if (rec.openSig) return Response.json({ error: 'Ese pedido ya está bloqueado.' }, { status: 409 });

  // Rebuilt on every call: a retry after the blockhash expired gets a fresh
  // one, and the order id makes a second `open` fail on chain regardless.
  const wire = await openTransaction(
    rec.buyer,
    {
      programId: DEPLOYMENTS.devnet.programId,
      usdcMint: DEPLOYMENTS.devnet.usdcMint,
      orderId: rec.orderId,
      amount: rec.amount,
      basketHash: rec.basketHash,
      timeoutSecs: DEFAULT_TIMEOUT_SECS,
    },
    DEPLOYMENTS.devnet.resolver,
  );
  const tx = getTransactionDecoder().decode(wire);
  rec.openMessage = toB64(Uint8Array.from(tx.messageBytes));
  await checkoutStore().set(rec);
  return Response.json({ tx: toB64(wire) });
}

export async function PUT(req: Request): Promise<Response> {
  const got = await load(req);
  if (!got.ok) return got.res;
  const { rec } = got;
  if (rec.openSig) return Response.json({ openSig: rec.openSig });
  if (typeof got.tx !== 'string' || !rec.openMessage) {
    return Response.json({ error: 'Falta la firma.' }, { status: 400 });
  }

  let tx;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(got.tx));
  } catch {
    return Response.json({ error: 'Firma inválida.' }, { status: 400 });
  }
  if (toB64(Uint8Array.from(tx.messageBytes)) !== rec.openMessage) {
    return Response.json({ error: 'La transacción no es la que preparamos.' }, { status: 400 });
  }
  const buyerSig = tx.signatures[rec.buyer as Address];
  const key = await getPublicKeyFromAddress(rec.buyer as Address);
  if (!buyerSig || !(await verifySignature(key, buyerSig, tx.messageBytes))) {
    return Response.json({ error: 'Falta la firma de tu billetera.' }, { status: 400 });
  }

  const resolver = await resolverSigner();
  const signed = await partiallySignTransaction([resolver.keyPair], tx);
  const sig = getSignatureFromTransaction(signed);
  try {
    await rpc()
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();
    await waitFor(sig);
  } catch (err) {
    console.error('[checkout/open]', err);
    return Response.json({ error: 'No pudimos bloquear el pago. Probá de nuevo.' }, { status: 502 });
  }

  rec.openSig = sig;
  await checkoutStore().set(rec);
  return Response.json({ openSig: sig });
}
