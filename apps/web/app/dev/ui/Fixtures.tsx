'use client';

import { useState } from 'react';

import { TurnProgressLine, UserBubble } from '../../../components/Chat';
import { CheckoutModal } from '../../../components/CheckoutModal';
import { FaucetConfirm } from '../../../components/FaucetConfirm';
import { ReceiveModal } from '../../../components/ReceiveModal';
import type { ChatState } from '../../../lib/chat-state';
import { ENOUGH_UNITS } from '../../../lib/faucet-policy';

/**
 * The fixtures that need event handlers. A server component cannot hand a
 * function to a client one, which is what made this page a 500.
 */

const noop = () => {};

const DELIVERED = { kind: 'user' as const, id: 'd1', text: 'galletas de avena para 4' };

/** The bug this scheme exists for: the supermarket and the postal code, lost. */
const FAILED_LOGIN = {
  kind: 'user' as const,
  id: 'd2',
  text: 'jumbo 1430',
  failed: { reason: 'login' as const, message: 'Para seguir, iniciá sesión.' },
};

/** Failed, but the user typed something after it — the mark stays, the button goes. */
const FAILED_OLD = {
  kind: 'user' as const,
  id: 'd3',
  text: 'sumale dos docenas de huevos',
  failed: { reason: 'network' as const, message: 'Se cortó la conexión antes de terminar. Probá de nuevo.' },
};

/** The server had it, and the answer never came: "se cortó", not "no se envió". */
const DROPPED = {
  kind: 'user' as const,
  id: 'd4',
  text: 'CP 1414, Día',
  failed: { reason: 'dropped' as const, message: 'Se cortó la conexión antes de terminar. Probá de nuevo.' },
};

const SEARCHING: ChatState = {
  streaming: true,
  progress: { stage: 'thinking', hop: 1, writing: false },
  blocks: [
    { kind: 'user', id: 'p1', text: 'CP 1414, Día' },
    { kind: 'say', id: 'p2', text: '', thinking: '', tools: [{ id: 't1', name: 'search_products' }] },
  ],
};

/**
 * A basket for the checkout dialog. Unlike the payment modal it needs no
 * wallet — the shopper pays the súper themselves — so it can be opened here,
 * which is the only cheap way to look at the login and lock steps
 * without driving a whole conversation against a live supermarket.
 */
const CHECKOUT_CART = {
  retailer: 'dia',
  cartId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  lines: [
    { index: 0, skuId: '1', sellerId: '1', name: 'Leche descremada 1L', quantity: 2, available: true,
      unitPrice: { centavos: 157500, display: '$1.575,00' },
      lineTotal: { centavos: 315000, display: '$3.150,00' } },
    { index: 1, skuId: '2', sellerId: '1', name: 'Galletitas de avena 250g', quantity: 1, available: true,
      unitPrice: { centavos: 300000, display: '$3.000,00' },
      lineTotal: { centavos: 300000, display: '$3.000,00' } },
  ],
  total: { centavos: 615000, display: '$6.150,00' },
  messages: [],
};

/** A real-length devnet address (the treasury in deployments.json), so the QR draws at the size a shopper sees. */
const DEMO_ADDRESS = '9TNtBk4RL2dmYdffqfudhLGc1DEtnHc8nmw7yWcD2ctc';

export function Fixtures() {
  const [faucet, setFaucet] = useState<'empty' | 'full' | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [receive, setReceive] = useState(false);

  return (
    <>
      {/* Reaching an undelivered message for real costs three free turns and
          a logged-out browser, so the states live here instead. */}
      <UserBubble block={DELIVERED} canRetry={false} onRetry={noop} />
      <UserBubble block={FAILED_LOGIN} canRetry onRetry={noop} />
      <UserBubble block={FAILED_OLD} canRetry={false} onRetry={noop} />
      <UserBubble block={DROPPED} canRetry onRetry={noop} />
      <p className="bubble is-error" role="alert">
        Se cortó la respuesta. Probá de nuevo.
      </p>

      {/* Static: the real composer is sticky, and here it would slide over
          the fixtures below it. */}
      <form
        className="composer"
        style={{ position: 'static' }}
        data-testid="fixture-progress"
        onSubmit={(e) => e.preventDefault()}
      >
        <textarea className="composer-input" placeholder="¿Qué necesitás del súper y para cuántos?" rows={2} disabled />
        <button type="button" className="btn btn-ghost">
          Parar
        </button>
        <TurnProgressLine state={SEARCHING} />
      </form>

      <div className="cart-actions">
        <button type="button" className="btn btn-sm" data-testid="fixture-faucet" onClick={() => setFaucet('empty')}>
          Cargar USDC (saldo 0)
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFaucet('full')}>
          Cargar USDC (saldo 100)
        </button>
      </div>
      {faucet ? (
        <FaucetConfirm
          balanceUnits={faucet === 'empty' ? 0n : ENOUGH_UNITS}
          onClose={() => setFaucet(null)}
          onConfirm={() => setFaucet(null)}
        />
      ) : null}

      {/* Presentational, so it needs no session — which is the only reason the
          QR is cheap to look at. */}
      <div className="cart-actions">
        <button type="button" className="btn btn-sm" data-testid="fixture-receive" onClick={() => setReceive(true)}>
          Cargar dólares
        </button>
      </div>
      {receive ? <ReceiveModal address={DEMO_ADDRESS} onClose={() => setReceive(false)} /> : null}

      <button
        type="button"
        className="btn"
        data-testid="fixture-open-checkout"
        onClick={() => setCheckout(true)}
      >
        Abrir el checkout
      </button>
      {checkout ? (
        <CheckoutModal
          cart={CHECKOUT_CART}
          handoffUrl="https://diaonline.supermercadosdia.com.ar/checkout/?orderFormId=f0e1d2c3b4a5968778695a4b3c2d1e0f"
          onClose={() => setCheckout(false)}
          onPaid={() => setCheckout(false)}
        />
      ) : null}

    </>
  );
}
