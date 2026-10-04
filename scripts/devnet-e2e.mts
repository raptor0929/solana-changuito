/**
 * The checkout routes against devnet, without a browser or Privy.
 *
 *   node --experimental-strip-types scripts/devnet-e2e.mts [base-url]
 *
 * A throwaway keypair stands in for the Privy wallet, and a `chg_user` cookie
 * is minted with the dev session secret (so this only works against
 * `next dev` without CHG_SESSION_SECRET, or with it exported here too). Then:
 *
 *   faucet -> quote -> sign + send `open` -> start -> poll status
 *
 * and prints the outcome with Solscan links. With SANDBOX_MOCK_FAIL=1 on the
 * dev server the same run ends in a refund instead of a settle.
 */
import {
  generateKeyPairSigner,
  getTransactionDecoder,
  signTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
} from '@solana/kit';

import { openTransaction } from '../apps/web/lib/checkout/open-tx.ts';
import type { QuoteResponse, StatusResponse } from '../apps/web/lib/checkout/types.ts';
import { mintUserToken, sessionSecret } from '../apps/web/lib/login-gate.ts';
import { explorerTx, rpc, waitFor } from '../apps/web/lib/solana.ts';

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

const cart = {
  retailer: 'dia',
  cartId: 'e2e-' + Date.now(),
  lines: [
    { index: 0, skuId: '1', sellerId: '1', name: 'Leche descremada 1L', quantity: 2, available: true,
      unitPrice: { centavos: 157500, display: '$1.575,00' }, lineTotal: { centavos: 315000, display: '$3.150,00' } },
    { index: 1, skuId: '2', sellerId: '1', name: 'Galletitas de avena 250g', quantity: 1, available: true,
      unitPrice: { centavos: 300000, display: '$3.000,00' }, lineTotal: { centavos: 300000, display: '$3.000,00' } },
  ],
  total: { centavos: 615000, display: '$6.150,00' },
  messages: [],
};
const quote = (await call('/api/checkout/quote', {
  method: 'POST',
  body: JSON.stringify({ cart, handoffUrl: 'https://diaonline.supermercadosdia.com.ar/checkout/?orderFormId=e2e#/cart' }),
})) as QuoteResponse;
console.log('quote', quote.amountDisplay, 'USDC for', cart.total.display, 'order', quote.orderId.slice(0, 12));

// What Privy does in the browser: sign the bytes the app built, and send.
const wire = await openTransaction(buyer.address, quote);
const tx = await signTransaction([buyer.keyPair], getTransactionDecoder().decode(wire));
const openSig = getSignatureFromTransaction(tx);
await rpc()
  .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' })
  .send();
await waitFor(openSig);
console.log('open', explorerTx(openSig));

let status = (await call('/api/checkout/start', {
  method: 'POST',
  body: JSON.stringify({ orderId: quote.orderId, openSig }),
})) as StatusResponse;
const t0 = Date.now();
while (status.stage !== 'done' && status.stage !== 'refunded') {
  if (Date.now() - t0 > 180_000) throw new Error('timed out at ' + status.stage + '/' + status.phase);
  await new Promise((r) => setTimeout(r, 3000));
  status = (await call(`/api/checkout/status?orderId=${quote.orderId}`)) as StatusResponse;
  console.log('  ', status.stage, status.phase ?? '');
}
console.log(status.stage, status.closeSig ? explorerTx(status.closeSig) : '', 'handoff:', status.handoffUrl);
