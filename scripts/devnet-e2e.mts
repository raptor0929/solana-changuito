/**
 * The checkout routes against devnet, without a browser or Privy.
 *
 *   node --experimental-strip-types scripts/devnet-e2e.mts [base-url]
 *
 * A throwaway keypair stands in for the Privy wallet, and a `chg_user` cookie
 * is minted with the dev session secret (so this only works against
 * `next dev` without CHG_SESSION_SECRET, or with it exported here too). Then:
 *
 *   faucet -> save profile -> quote -> open (server builds, resolver pays the
 *   fee) -> buyer signs -> server co-signs and sends -> start -> poll status
 *
 * and prints the outcome with Solscan links. Which sandbox runs is the
 * `config` table's call, not this script's: `npm run config -- set
 * sandbox_mock true` for the mock (settles), plus `sandbox_mock_fail true` for
 * a declined card (refunds). With the mock off and no SANDBOX_URL, start fails
 * and the order refunds.
 *
 * The Día login comes from the saved profile, as it does in the app: the
 * script PUTs a placeholder profile and /start sends no login, so the server
 * decrypts it (PROFILE_ENC_KEY must be set on the dev server). A placeholder
 * is fine against the mock and will fail login against a real sandbox.
 *
 * The quote is real: it reads belo's USDC rate and asks Día's simulation for
 * the envío of a real SKU at the profile's postal code, E2E_POSTAL_CODE
 * (default 1425).
 */
import {
  generateKeyPairSigner,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from '@solana/kit';

import type { QuoteResponse, StatusResponse } from '../apps/web/lib/checkout/types.ts';
import { mintUserToken, sessionSecret } from '../apps/web/lib/login-gate.ts';
import { explorerTx } from '../apps/web/lib/solana.ts';

const BASE = process.argv[2] ?? 'http://localhost:3124';

const buyer = await generateKeyPairSigner();
console.log('buyer', buyer.address);

const cookie = `chg_user=${encodeURIComponent(await mintUserToken(buyer.address, sessionSecret()))}`;
const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const faucet = await call('/api/faucet', { method: 'POST' });
console.log('faucet', faucet.usdcDisplay, 'USDC', explorerTx(faucet.txHash));

const postal = process.env.E2E_POSTAL_CODE ?? '1425';
const profile = await call('/api/profile', {
  method: 'PUT',
  body: JSON.stringify({ email: 'e2e@example.com', password: 'e2e-placeholder', dni: '30000000', postcode: postal }),
});
console.log('profile saved', profile.complete ? 'complete' : 'INCOMPLETE', 'hasPassword', profile.hasPassword);

const cart = {
  retailer: 'dia',
  cartId: 'e2e-' + Date.now(),
  lines: [
    { index: 0, skuId: '61450', sellerId: '1', name: 'Fideos Tirabuzón Favorita 500 Gr.', quantity: 2, available: true,
      unitPrice: { centavos: 115900, display: '$1.159,00' }, lineTotal: { centavos: 231800, display: '$2.318,00' } },
  ],
  total: { centavos: 231800, display: '$2.318,00' },
  messages: [],
};
const quote = (await call('/api/checkout/quote', {
  method: 'POST',
  body: JSON.stringify({
    cart,
    handoffUrl: 'https://diaonline.supermercadosdia.com.ar/checkout/?orderFormId=e2e#/cart',
    location: { postalCode: postal, salesChannel: '1', country: 'ARG' },
  }),
})) as QuoteResponse;
const ars = (c: number) => `$${(c / 100).toFixed(2)}`;
console.log(
  'quote', quote.amountDisplay, 'USDC =', ars(quote.subtotalCentavos), '+ envío', ars(quote.shippingCentavos),
  '@', quote.arsPerUsd.toFixed(2), `(${quote.rateSource})`, 'order', quote.orderId.slice(0, 12),
);

// What Privy does in the browser: sign the server's bytes as the buyer, no send.
const { tx: unsigned } = await call('/api/checkout/open', { method: 'POST', body: JSON.stringify({ orderId: quote.orderId }) });
const signed = await partiallySignTransaction([buyer.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(unsigned)));
const { openSig } = await call('/api/checkout/open', {
  method: 'PUT',
  body: JSON.stringify({ orderId: quote.orderId, tx: getBase64EncodedWireTransaction(signed) }),
});
console.log('open', explorerTx(openSig));

let status = (await call('/api/checkout/start', {
  method: 'POST',
  // No `dia`: the server decrypts the profile saved above.
  body: JSON.stringify({ orderId: quote.orderId, openSig }),
})) as StatusResponse;
const t0 = Date.now();
while (status.stage !== 'done' && status.stage !== 'refunded') {
  if (Date.now() - t0 > 900_000) throw new Error('timed out at ' + status.stage + '/' + status.phase);
  await new Promise((r) => setTimeout(r, 3000));
  status = (await call(`/api/checkout/status?orderId=${quote.orderId}`)) as StatusResponse;
  console.log('  ', status.stage, status.phase ?? '');
}
console.log(status.stage, status.payment ?? '', status.storeOrderId ?? '', status.closeSig ? explorerTx(status.closeSig) : '');
