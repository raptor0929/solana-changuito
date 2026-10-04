/**
 * POST /api/checkout/quote { cart, handoffUrl? }  ->  QuoteResponse
 *
 * Turns the basket on screen into the arguments of `escrow.open`: a fresh
 * order id, the basket hash, and how much USDC to lock. The browser builds
 * the instruction from these and the shopper's wallet signs it; the server
 * never touches the buyer's money until it has the order on chain.
 *
 * The amount is the peso total at today's rate plus 15%: the sandbox learns
 * the envío only at Día's checkout, after the money is locked. The buffer is
 * float, not price — it goes to the treasury with the rest on settle, which
 * is a demo simplification the README says out loud.
 */
import { arsToUsdCents, getArsPerUsd } from '@changuito/mcp/fx';
import type { Cart } from '@changuito/mcp/types';

import { checkoutStore } from '../../../../lib/checkout/store.ts';
import type { QuoteResponse } from '../../../../lib/checkout/types.ts';
import { DEPLOYMENTS } from '../../../../lib/deployments.ts';
import { bytesToHex } from '../../../../lib/escrow.ts';
import { readLoggedInUser } from '../../../../lib/login-gate.ts';
import { basketHash, DEFAULT_TIMEOUT_SECS, newOrderId } from '../../../../lib/order.ts';
import { usdcToBase } from '../../../../lib/solana.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUFFER = 0.15;

function isCart(c: unknown): c is Cart {
  const x = c as Cart;
  return Boolean(x && typeof x.cartId === 'string' && Array.isArray(x.lines) && typeof x.total?.centavos === 'number');
}

export async function POST(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión para pagar.' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { cart?: unknown; handoffUrl?: unknown } | null;
  if (!isCart(body?.cart)) return Response.json({ error: 'Falta el changuito.' }, { status: 400 });
  const cart = body.cart;
  const lines = cart.lines.filter((l) => l.available && l.quantity > 0);
  if (lines.length === 0 || cart.total.centavos <= 0) {
    return Response.json({ error: 'El changuito está vacío.' }, { status: 400 });
  }

  const override = Number(process.env.ARS_PER_USD);
  const rate = await getArsPerUsd(Number.isFinite(override) && override > 0 ? { override } : {});
  const cents = arsToUsdCents(cart.total.centavos as never, rate.arsPerUsd, BUFFER) as unknown as number;
  const orderId = bytesToHex(newOrderId());
  const hash = bytesToHex(await basketHash(cart));
  const handoffUrl =
    typeof body.handoffUrl === 'string' && /^https:\/\//.test(body.handoffUrl) ? body.handoffUrl : null;

  await checkoutStore().set({
    orderId,
    buyer: user.address,
    amount: usdcToBase(cents).toString(),
    amountCents: cents,
    basketHash: hash,
    arsPerUsd: rate.arsPerUsd,
    totalDisplay: cart.total.display,
    retailer: cart.retailer,
    lines: lines.map((l) => ({ name: l.name, skuId: l.skuId, quantity: l.quantity, lineTotal: l.lineTotal.display })),
    handoffUrl,
    createdAt: Date.now(),
  });

  const res: QuoteResponse = {
    orderId,
    amount: usdcToBase(cents).toString(),
    amountCents: cents,
    amountDisplay: (cents / 100).toFixed(2),
    basketHash: hash,
    timeoutSecs: DEFAULT_TIMEOUT_SECS,
    arsPerUsd: rate.arsPerUsd,
    programId: DEPLOYMENTS.devnet.programId,
    usdcMint: DEPLOYMENTS.devnet.usdcMint,
  };
  return Response.json(res);
}
