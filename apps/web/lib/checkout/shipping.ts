import type { VtexOrderForm } from '@changuito/mcp/orderform';

import { STOREFRONT_HOSTS } from '../storefront.ts';

/**
 * What the store will charge for this basket, delivered to this postal code,
 * read from the store before the shopper locks anything.
 *
 * The quote used to take the peso total the browser posted and add 15% for a
 * delivery fee nobody had asked for. This asks VTEX's cart simulation instead,
 * with the basket's SKUs and the shopper's postal code, so the items are
 * re-priced on the server and the delivery fee is the store's own number.
 *
 * Measured on Día (2026-10-10): the fee comes back split across the items'
 * `logisticsInfo` — one `Envío a Domicilio` SLA at $4.999 was 2.308,91 +
 * 2.690,09 over two items — so the fee for an SLA is its price summed over
 * every item that offers it.
 *
 * The fee is for the *shopper's* postal code. The sandbox checks out with the
 * operator's account and address, so on devnet the fee it meets at the store
 * can differ; nothing is charged at the store either way.
 */

export interface BasketLine {
  skuId: string;
  quantity: number;
  sellerId: string;
}

export interface BasketQuote {
  /** Goods, after promotions, in centavos. */
  itemsCentavos: number;
  /** The chosen delivery option, in centavos. */
  shippingCentavos: number;
  /** The store's name for that option, e.g. "Envío a Domicilio". */
  shippingLabel: string;
}

export class QuoteError extends Error {
  code: 'unavailable' | 'no_shipping' | 'upstream';
  constructor(code: 'unavailable' | 'no_shipping' | 'upstream', message: string) {
    super(message);
    this.code = code;
  }
}

type Logistics = NonNullable<NonNullable<VtexOrderForm['shippingData']>['logisticsInfo']>;

/**
 * The delivery option and its total. Home delivery only (pickup points are
 * not a delivery fee), and among those the cheapest total that covers every
 * item offering any delivery at all. Null when nothing is deliverable.
 */
export function pickShipping(logistics: Logistics | undefined): { centavos: number; label: string } | null {
  const byItem = (logistics ?? []).map((li) => (li.slas ?? []).filter((s) => (s.deliveryChannel ?? 'delivery') === 'delivery'));
  const deliverable = byItem.filter((slas) => slas.length > 0);
  if (deliverable.length === 0) return null;

  const totals = new Map<string, { centavos: number; label: string; items: number }>();
  for (const slas of deliverable) {
    for (const s of slas) {
      const t = totals.get(s.id) ?? { centavos: 0, label: s.name ?? s.id, items: 0 };
      t.centavos += Math.round(s.price ?? 0);
      t.items += 1;
      totals.set(s.id, t);
    }
  }
  const covering = [...totals.values()].filter((t) => t.items === deliverable.length);
  if (covering.length === 0) return null;
  covering.sort((a, b) => a.centavos - b.centavos);
  return { centavos: covering[0].centavos, label: covering[0].label };
}

/** Items after promotions, on the same basis as the cart's own total (see toCart). */
export function itemsCentavos(of: Pick<VtexOrderForm, 'totalizers' | 'totals'>): number {
  const totalizers = of.totalizers ?? of.totals ?? [];
  const pick = (id: string) => totalizers.find((t) => t.id === id)?.value ?? 0;
  return Math.round(pick('Items') + pick('Discounts'));
}

/** Pure: a simulation response to a quote, or the reason it cannot be one. */
export function quoteFromSimulation(of: VtexOrderForm, requested: number): BasketQuote {
  const items = of.items ?? [];
  if (items.length < requested || items.some((it) => it.availability && it.availability !== 'available')) {
    throw new QuoteError('unavailable', 'A product is no longer available');
  }
  const shipping = pickShipping((of as { logisticsInfo?: Logistics }).logisticsInfo ?? of.shippingData?.logisticsInfo);
  if (!shipping) throw new QuoteError('no_shipping', 'The store offers no home delivery for this basket');
  const subtotal = itemsCentavos(of);
  if (subtotal <= 0) throw new QuoteError('upstream', 'The store returned no item total');
  return { itemsCentavos: subtotal, shippingCentavos: shipping.centavos, shippingLabel: shipping.label };
}

export async function quoteBasket(args: {
  retailer: string;
  salesChannel: string;
  postalCode: string;
  lines: BasketLine[];
}): Promise<BasketQuote> {
  const host = STOREFRONT_HOSTS[args.retailer];
  if (!host) throw new QuoteError('upstream', `Unknown retailer ${args.retailer}`);
  // RnbBehavior=0: cart-stage promotions, the same call the MCP price check makes.
  const url = `https://${host}/api/checkout/pub/orderForms/simulation?sc=${encodeURIComponent(args.salesChannel)}&RnbBehavior=0`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        items: args.lines.map((l) => ({ id: l.skuId, quantity: l.quantity, seller: l.sellerId })),
        country: 'ARG',
        postalCode: args.postalCode,
      }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch (e) {
    throw new QuoteError('upstream', e instanceof Error ? e.message : 'simulation failed');
  }
  if (!res.ok) throw new QuoteError('upstream', `simulation answered ${res.status}`);
  return quoteFromSimulation((await res.json()) as VtexOrderForm, args.lines.length);
}
