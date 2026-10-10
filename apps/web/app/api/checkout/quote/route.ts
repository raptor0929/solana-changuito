/**
 * POST /api/checkout/quote { cart, handoffUrl?, location }  ->  QuoteResponse
 *
 * Turns the basket on screen into the arguments of `escrow.open`: a fresh
 * order id, the basket hash, and how much USDC to lock. The browser builds
 * the instruction from these and the shopper's wallet signs it; the server
 * never touches the buyer's money until it has the order on chain.
 *
 * The amount is what the store will charge, converted at Belo's USDC rate:
 * the basket re-priced by the store's own cart simulation, plus the delivery
 * fee the same simulation returns for the shopper's postal code (see
 * lib/checkout/shipping.ts and lib/checkout/rate.ts). Nothing is padded, and
 * the browser's own total is not trusted — the modal shows exactly the three
 * numbers this route computed, and the shopper confirms those.
 */
import { arsToUsdCents } from '@changuito/mcp/fx';
import { fromCentavos } from '@changuito/mcp/money';
import type { Cart } from '@changuito/mcp/types';

import { getCheckoutRate } from '../../../../lib/checkout/rate.ts';
import { QuoteError, quoteBasket } from '../../../../lib/checkout/shipping.ts';
import { checkoutStore } from '../../../../lib/checkout/store.ts';
import type { QuoteResponse } from '../../../../lib/checkout/types.ts';
import { DEPLOYMENTS } from '../../../../lib/deployments.ts';
import { bytesToHex } from '../../../../lib/escrow.ts';
import { readLoggedInUser } from '../../../../lib/login-gate.ts';
import { basketHash, DEFAULT_TIMEOUT_SECS, newOrderId } from '../../../../lib/order.ts';
import { usdcToBase } from '../../../../lib/solana.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isCart(c: unknown): c is Cart {
  const x = c as Cart;
  return Boolean(x && typeof x.cartId === 'string' && Array.isArray(x.lines) && typeof x.total?.centavos === 'number');
}

/** The shopper's location from the chat session: what the store needs to quote delivery. */
function readLocation(v: unknown): { postalCode: string; salesChannel: string } | null {
  const x = v as { postalCode?: unknown; salesChannel?: unknown } | null;
  const postalCode = typeof x?.postalCode === 'string' ? x.postalCode.trim() : '';
  const salesChannel = typeof x?.salesChannel === 'string' ? x.salesChannel.trim() : '';
  if (!/^[A-Za-z]?\d{4}[A-Za-z]{0,3}$/.test(postalCode) || !/^\d{1,4}$/.test(salesChannel)) return null;
  return { postalCode, salesChannel };
}

export async function POST(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión para pagar.' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { cart?: unknown; handoffUrl?: unknown; location?: unknown }
    | null;
  if (!isCart(body?.cart)) return Response.json({ error: 'Falta el changuito.' }, { status: 400 });
  const cart = body.cart;
  const lines = cart.lines.filter((l) => l.available && l.quantity > 0);
  if (lines.length === 0) return Response.json({ error: 'El changuito está vacío.' }, { status: 400 });
  const location = readLocation(body.location);
  if (!location) return Response.json({ error: 'Falta tu código postal para calcular el envío.' }, { status: 400 });

  let basket;
  try {
    basket = await quoteBasket({
      retailer: cart.retailer,
      ...location,
      lines: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, sellerId: l.sellerId })),
    });
  } catch (e) {
    const code = e instanceof QuoteError ? e.code : 'upstream';
    console.error('[quote] basket', code, e instanceof Error ? e.message : e);
    const error =
      code === 'unavailable'
        ? 'Algún producto ya no está disponible. Revisá el changuito.'
        : 'No pudimos calcular el envío. Probá de nuevo en un rato.';
    return Response.json({ error }, { status: 409 });
  }

  let rate;
  try {
    rate = await getCheckoutRate();
  } catch (e) {
    console.error('[quote] rate', e instanceof Error ? e.message : e);
    return Response.json({ error: 'No pudimos obtener el tipo de cambio. Probá de nuevo en un rato.' }, { status: 503 });
  }

  const totalCentavos = basket.itemsCentavos + basket.shippingCentavos;
  const cents = arsToUsdCents(totalCentavos as never, rate.arsPerUsd, 0) as unknown as number;
  const items = fromCentavos(basket.itemsCentavos);
  const shipping = fromCentavos(basket.shippingCentavos);
  const total = fromCentavos(totalCentavos);
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
    totalDisplay: total.display,
    itemsCentavos: basket.itemsCentavos,
    shippingCentavos: basket.shippingCentavos,
    shippingLabel: basket.shippingLabel,
    rateSource: rate.source,
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
    rateSource: rate.source,
    itemsCentavos: basket.itemsCentavos,
    shippingCentavos: basket.shippingCentavos,
    totalCentavos,
    itemsDisplay: items.display,
    shippingDisplay: shipping.display,
    totalDisplay: total.display,
    shippingLabel: basket.shippingLabel,
    programId: DEPLOYMENTS.devnet.programId,
    usdcMint: DEPLOYMENTS.devnet.usdcMint,
  };
  return Response.json(res);
}
