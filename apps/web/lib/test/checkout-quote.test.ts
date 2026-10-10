import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getCheckoutRate, pickBeloUsdc } from '../checkout/rate.ts';
import { itemsCentavos, pickShipping, QuoteError, quoteFromSimulation } from '../checkout/shipping.ts';

// The shape dolarapi answered on 2026-10-10, trimmed to the rows that matter.
const ROWS = [
  { exchange: 'belo', criptomonedaBase: 'USDT', compra: 1581, venta: 1561 },
  { exchange: 'belo', criptomonedaBase: 'USDC', compra: 1584.179019465, venta: 1559.43782925 },
  { exchange: 'belo', criptomonedaBase: 'USD_AR', compra: 1559.17, venta: 1485.25 },
  { exchange: 'dolarapp', criptomonedaBase: 'USDC', compra: 1563.35, venta: 1560.9375 },
];

describe('checkout rate', () => {
  it("RULE: takes Belo's USDC row, compra — not the first Belo row, which is USDT", () => {
    assert.equal(pickBeloUsdc(ROWS), 1584.179019465);
  });

  it('refuses rather than falling back when Belo has no USDC row', () => {
    assert.throws(() => pickBeloUsdc(ROWS.filter((r) => r.criptomonedaBase !== 'USDC' || r.exchange !== 'belo')));
    assert.throws(() => pickBeloUsdc({ error: 'down' }));
  });

  it('refuses a row with no compra, or one outside the sanity bounds', () => {
    assert.throws(() => pickBeloUsdc([{ exchange: 'belo', criptomonedaBase: 'USDC', compra: null }]));
    assert.throws(() => pickBeloUsdc([{ exchange: 'belo', criptomonedaBase: 'USDC', compra: 1.58 }]));
  });

  it('ARS_PER_USD pins the rate without a request', async () => {
    const rate = await getCheckoutRate({ ARS_PER_USD: '1400' } as NodeJS.ProcessEnv);
    assert.equal(rate.arsPerUsd, 1400);
    assert.equal(rate.source, 'ARS_PER_USD');
  });
});

// Measured on Día: one SLA, its price split across the items that offer it.
const SPLIT = [
  { itemIndex: 0, slas: [{ id: 'Envío a Domicilio', name: 'Envío a Domicilio', deliveryChannel: 'delivery', price: 230891 }] },
  { itemIndex: 1, slas: [{ id: 'Envío a Domicilio', name: 'Envío a Domicilio', deliveryChannel: 'delivery', price: 269009 }] },
];

describe('delivery fee', () => {
  it("RULE: an SLA's fee is its price summed over the items, as the store splits it", () => {
    assert.deepEqual(pickShipping(SPLIT), { centavos: 499900, label: 'Envío a Domicilio' });
  });

  it('takes the cheapest home delivery that covers every deliverable item, never a pickup', () => {
    const logistics = [
      {
        slas: [
          { id: 'express', name: 'Express', deliveryChannel: 'delivery', price: 900000 },
          { id: 'normal', name: 'Normal', deliveryChannel: 'delivery', price: 300000 },
          { id: 'pickup', name: 'Retiro', deliveryChannel: 'pickup-in-point', price: 0 },
        ],
      },
      { slas: [{ id: 'express', name: 'Express', deliveryChannel: 'delivery', price: 100000 }] },
    ];
    // `normal` is cheaper on one item but does not cover the second.
    assert.deepEqual(pickShipping(logistics), { centavos: 1000000, label: 'Express' });
  });

  it('is null when nothing is deliverable', () => {
    assert.equal(pickShipping([{ slas: [] }]), null);
    assert.equal(pickShipping(undefined), null);
  });

  it('items are on the same basis as the cart: Items plus Discounts', () => {
    assert.equal(itemsCentavos({ totalizers: [{ id: 'Items', value: 1263000 }, { id: 'Discounts', value: -294525 }] }), 968475);
  });

  it('RULE: refuses to quote a basket with an unavailable item, or with no delivery', () => {
    const ok = {
      items: [{ availability: 'available' }, { availability: 'available' }],
      totals: [{ id: 'Items', value: 372000 }],
      logisticsInfo: SPLIT,
    } as never;
    assert.deepEqual(quoteFromSimulation(ok, 2), {
      itemsCentavos: 372000,
      shippingCentavos: 499900,
      shippingLabel: 'Envío a Domicilio',
    });

    const gone = { ...(ok as object), items: [{ availability: 'available' }, { availability: 'withoutStock' }] } as never;
    assert.throws(() => quoteFromSimulation(gone, 2), (e) => e instanceof QuoteError && e.code === 'unavailable');

    const missing = { ...(ok as object), items: [{ availability: 'available' }] } as never;
    assert.throws(() => quoteFromSimulation(missing, 2), (e) => e instanceof QuoteError && e.code === 'unavailable');

    const noShip = { ...(ok as object), logisticsInfo: [{ slas: [] }, { slas: [] }] } as never;
    assert.throws(() => quoteFromSimulation(noShip, 2), (e) => e instanceof QuoteError && e.code === 'no_shipping');
  });
});
