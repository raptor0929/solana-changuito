/**
 * The envío, quoted before the money is locked.
 *
 * The sandbox attaches an address and picks a delivery option at Día's
 * checkout (services/sandbox/checkout.py, `_pick_sla`): home delivery, the
 * scheduled option when there is one, its earliest window, otherwise the
 * cheapest. This runs VTEX's simulation for the same items at the shopper's
 * postal code and applies the same rule, so the line in the modal is the
 * price the sandbox will choose — not an estimate on top of it.
 *
 * It is still a quote: a window's price can change between now and the run,
 * and the card pays whatever Día charges then.
 */

export interface ShippingLocation {
  postalCode: string;
  salesChannel?: string;
  country?: string;
}

export interface ShippingQuote {
  centavos: number;
  sla: string;
}

interface Sla {
  id: string;
  deliveryChannel?: string;
  price?: number;
  availableDeliveryWindows?: { startDateUtc: string; price?: number }[];
}

interface Logistics {
  itemIndex: number;
  slas?: Sla[];
}

export const NO_DELIVERY = 'no home delivery to this postal code';

const HOSTS: Record<string, string> = { dia: 'diaonline.supermercadosdia.com.ar' };

/** Same rule as the sandbox's `_pick_sla`. Exported for tests. */
export function pickSla(slas: Sla[]): { sla: Sla; windowPrice: number } | undefined {
  const delivery = slas.filter((s) => (s.deliveryChannel ?? 'delivery') === 'delivery');
  if (delivery.length === 0) return undefined;
  const earliest = (s: Sla) => s.availableDeliveryWindows!.map((w) => w.startDateUtc).sort()[0]!;
  const windowed = delivery.filter((s) => s.availableDeliveryWindows?.length);
  if (windowed.length) {
    const sla = windowed.reduce((a, b) => (earliest(b) < earliest(a) ? b : a));
    const window = [...sla.availableDeliveryWindows!].sort((a, b) => a.startDateUtc.localeCompare(b.startDateUtc))[0]!;
    return { sla, windowPrice: window.price ?? 0 };
  }
  const sla = delivery.reduce((a, b) => ((b.price ?? 0) < (a.price ?? 0) ? b : a));
  return { sla, windowPrice: 0 };
}

/** Total envío over every item's logistics entry, in centavos. Undefined when an item cannot be delivered. */
export function shippingFrom(logistics: Logistics[]): ShippingQuote | undefined {
  let centavos = 0;
  const names = new Set<string>();
  for (const info of logistics) {
    const pick = pickSla(info.slas ?? []);
    if (!pick) return undefined;
    centavos += (pick.sla.price ?? 0) + pick.windowPrice;
    names.add(pick.sla.id);
  }
  return names.size ? { centavos: Math.round(centavos), sla: [...names].join(', ') } : undefined;
}

export async function quoteShipping(
  retailer: string,
  lines: { skuId: string; quantity: number; sellerId: string }[],
  loc: ShippingLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<ShippingQuote> {
  const host = HOSTS[retailer];
  if (!host) throw new Error(`no shipping quote for ${retailer}`);
  const sc = encodeURIComponent(loc.salesChannel ?? '1');
  const res = await fetchImpl(`https://${host}/api/checkout/pub/orderForms/simulation?sc=${sc}&RnbBehavior=0`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      items: lines.map((l) => ({ id: l.skuId, quantity: l.quantity, seller: l.sellerId })),
      country: loc.country ?? 'ARG',
      postalCode: loc.postalCode,
    }),
  });
  if (!res.ok) throw new Error(`simulation answered ${res.status}`);
  const of = (await res.json()) as { logisticsInfo?: Logistics[] };
  const quote = shippingFrom(of.logisticsInfo ?? []);
  if (!quote) throw new Error(NO_DELIVERY);
  return quote;
}
