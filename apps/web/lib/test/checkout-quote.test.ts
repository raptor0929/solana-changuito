import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickBeloUsdc, quoteRate } from '../checkout/rate.ts';
import { pickSla, shippingFrom } from '../checkout/shipping.ts';
import { readShopper } from '../checkout/shopper.ts';

// The dolarapi response the rate was specified against.
const DOLARAPI = [
  { exchange: 'belo', moneda: 'ARS', monedaBase: 'USD', criptomoneda: null, criptomonedaBase: 'USDT', compra: 1581, venta: 1561 },
  { exchange: 'belo', moneda: 'ARS', monedaBase: 'USD', criptomoneda: null, criptomonedaBase: 'USDC', compra: 1584.179019465, venta: 1559.43782925 },
  { exchange: 'belo', moneda: 'ARS', monedaBase: 'USD', criptomoneda: null, criptomonedaBase: 'USD_AR', compra: 1559.17, venta: 1485.25 },
  { exchange: 'dolarapp', moneda: 'ARS', monedaBase: 'USD', criptomoneda: null, criptomonedaBase: 'USDC', compra: 1563.35, venta: 1560.9375 },
];

describe('the quote rate', () => {
  it('is belo USDC compra, not USDT and not another exchange', () => {
    assert.equal(pickBeloUsdc(DOLARAPI), 1584.179019465);
  });

  it('refuses a feed without it, or with an absurd number', () => {
    assert.equal(pickBeloUsdc(DOLARAPI.filter((r) => r.exchange !== 'belo')), undefined);
    assert.equal(pickBeloUsdc([{ exchange: 'belo', criptomonedaBase: 'USDC', compra: 1 }]), undefined);
    assert.equal(pickBeloUsdc({ error: 'nope' }), undefined);
  });

  it('does not fall back to another source when the feed is down', async () => {
    const down = (async () => new Response('', { status: 502 })) as typeof fetch;
    await assert.rejects(quoteRate({ fetchImpl: down, now: 1 }));
  });

  it('honours ARS_PER_USD as an explicit override', async () => {
    const r = await quoteRate({ override: 1500 });
    assert.equal(r.arsPerUsd, 1500);
    assert.equal(r.source, 'ARS_PER_USD');
  });
});

describe('the envío quote', () => {
  const windowed = {
    id: 'Envío a Domicilio',
    deliveryChannel: 'delivery',
    price: 499900,
    availableDeliveryWindows: [
      { startDateUtc: '2026-10-14T12:00:00+00:00', price: 0 },
      { startDateUtc: '2026-10-13T12:00:00+00:00', price: 0 },
    ],
  };

  it('picks the earliest window of a scheduled delivery, as the sandbox does', () => {
    const pick = pickSla([windowed, { id: 'Express', deliveryChannel: 'delivery', price: 100 }]);
    assert.equal(pick?.sla.id, 'Envío a Domicilio');
  });

  it('never quotes store pickup', () => {
    assert.equal(pickSla([{ id: 'Retiro', deliveryChannel: 'pickup-in-point', price: 0 }]), undefined);
  });

  it('falls back to the cheapest delivery when nothing is scheduled', () => {
    const pick = pickSla([
      { id: 'A', price: 900 },
      { id: 'B', price: 500 },
    ]);
    assert.equal(pick?.sla.id, 'B');
  });

  it('sums every item, and fails when one cannot be delivered', () => {
    assert.deepEqual(shippingFrom([{ itemIndex: 0, slas: [windowed] }]), { centavos: 499900, sla: 'Envío a Domicilio' });
    assert.equal(shippingFrom([{ itemIndex: 0, slas: [windowed] }, { itemIndex: 1, slas: [] }]), undefined);
  });
});

describe("the shopper's Día login", () => {
  const ok = { email: 'a@b.com', password: 'secret', dni: '30.123.456' };

  it('needs email, password and DNI, and normalises the DNI', () => {
    assert.deepEqual(readShopper(ok, undefined, '1425'), { email: 'a@b.com', password: 'secret', dni: '30123456', postcode: '1425' });
    assert.equal(readShopper({ ...ok, password: '' }, undefined), undefined);
    assert.equal(readShopper({ ...ok, email: 'nope' }, undefined), undefined);
    assert.equal(readShopper({ ...ok, dni: '12' }, undefined), undefined);
  });

  it('keeps only the address fields it knows, trimmed', () => {
    const s = readShopper(ok, { street: ' Av. Siempreviva ', number: '742', phone: '', evil: 'x' });
    assert.deepEqual(s, { email: 'a@b.com', password: 'secret', dni: '30123456', street: 'Av. Siempreviva', number: '742' });
  });
});
