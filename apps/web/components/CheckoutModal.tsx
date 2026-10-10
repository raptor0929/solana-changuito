'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import type { Cart, LocationContext } from '@changuito/mcp/types';

import { track } from '../lib/analytics';
import type { Receipt } from '../lib/chat-store.ts';
import { escrowCopy } from '../lib/checkout/copy.ts';
import type { QuoteResponse, StatusResponse } from '../lib/checkout/types.ts';
import type { PublicProfile } from '../lib/profile.ts';
import { ensureUserCookie } from '../lib/session-login';
import { explorerTx } from '../lib/solana.ts';
import { useBalances } from '../lib/use-balances.ts';
import { useWallet } from '../lib/use-wallet.ts';
import { useLang } from './LangProvider';

/**
 * From a full basket to a settled escrow, in four steps:
 *
 *   1. login   — email through Privy; the embedded Solana wallet comes with it.
 *   2. lock    — the server quotes goods + envío at belo's USDC rate (order
 *                id, basket hash, USDC amount) and the shopper confirms that
 *                breakdown and types their Día login. The server builds
 *                `open` with the resolver as fee payer; the wallet signs it
 *                as the buyer, the server co-signs and sends. The USDC is
 *                now in a vault the program owns, not in an account of ours.
 *   3. shop    — the server starts a sandbox job (services/sandbox) that logs
 *                into the shopper's Día account, fills the cart, picks the
 *                delivery and pays with the operator's card. This dialog
 *                polls /api/checkout/status, which reports the phase.
 *   4. done    — Día placed the order: the resolver settled the escrow to the
 *                treasury. Anything else, a declined card included, refunds.
 *
 * The Día login comes from the shopper's saved profile when it is complete:
 * the browser sends nothing and the server decrypts it at start. Otherwise it
 * is typed here, lives in this component's state and the one request to
 * /api/checkout/start (plus /api/profile when "guardar" is ticked), and is
 * never put in chat-store or anywhere else.
 *
 * The dialog never decides an outcome. Every stage after `lock` is what the
 * server read from the chain or the sandbox, and the server reads the chain
 * before it moves anything.
 */
interface Props {
  cart: Cart;
  /** Where the shopper browsed (the chat's session snapshot): the envío is quoted here. */
  location?: Pick<LocationContext, 'postalCode' | 'salesChannel' | 'country'>;
  handoffUrl?: string;
  chatId?: string;
  onClose: () => void;
  onPaid: (receipt: Receipt) => void;
}

const POLL_MS = 3_000;

const ARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
const pesos = (centavos: number) => ARS.format(centavos / 100);

interface DiaLogin {
  email: string;
  password: string;
  dni: string;
  street: string;
  number: string;
  phone: string;
}

const EMPTY_LOGIN: DiaLogin = { email: '', password: '', dni: '', street: '', number: '', phone: '' };

function loginReady(d: DiaLogin): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim()) && d.password.length > 0 && /^\d{7,9}$/.test(d.dni.replace(/\D/g, ''));
}

type Step = 'login' | 'review' | 'locking' | 'shopping' | 'done' | 'refunded';

export function CheckoutModal({ cart, location, handoffUrl, onClose, onPaid }: Props) {
  const lang = useLang();
  const copy = escrowCopy(lang);
  const wallet = useWallet();
  const { data: balance, refresh } = useBalances(wallet.address);

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [step, setStep] = useState<Step>('login');
  const [error, setError] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  const [openSig, setOpenSig] = useState<string | null>(null);
  const [dia, setDia] = useState<DiaLogin>(EMPTY_LOGIN);
  // The saved profile (lib/profile.ts), without its password. When it is
  // complete the server decrypts it at /api/checkout/start and nothing is typed.
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [typeOwn, setTypeOwn] = useState(false);
  const [saveToProfile, setSaveToProfile] = useState(true);
  const quoting = useRef(false);
  const field = (k: keyof DiaLogin) => (e: ChangeEvent<HTMLInputElement>) => setDia((d) => ({ ...d, [k]: e.target.value }));

  // Signed in -> mint the session cookie -> quote. Once.
  useEffect(() => {
    if (!wallet.ready || !wallet.address) {
      setStep('login');
      return;
    }
    if (quote || quoting.current) return;
    quoting.current = true;
    setStep('review');
    void (async () => {
      try {
        const ok = await ensureUserCookie(wallet.address!, wallet.accessToken);
        if (!ok) throw new Error(copy.failed);
        const res = await fetch('/api/checkout/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cart, handoffUrl, location }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? copy.failed);
        setQuote(body as QuoteResponse);
        const p = await fetch('/api/profile', { cache: 'no-store' }).catch(() => null);
        if (p?.ok) setProfile((await p.json().catch(() => null)) as PublicProfile | null);
      } catch (e) {
        setError(e instanceof Error ? e.message : copy.failed);
        quoting.current = false;
      }
    })();
  }, [wallet.ready, wallet.address, wallet.accessToken, quote, cart, location, handoffUrl, copy.failed]);

  const short = Boolean(quote && balance && BigInt(balance.usdc) < BigInt(quote.amount));
  const fromProfile = Boolean(profile?.complete) && !typeOwn;
  const ready = fromProfile || loginReady(dia);

  const faucet = useCallback(async () => {
    setFunding(true);
    setError(null);
    try {
      const res = await fetch('/api/faucet', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok && res.status !== 429) throw new Error(body?.error ?? copy.failed);
      if (res.status === 429 && body?.note) setError(body.note);
      track('faucet_grant', {});
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : copy.failed);
    } finally {
      setFunding(false);
    }
  }, [copy.failed, refresh]);

  const lock = useCallback(async () => {
    if (!quote || !wallet.address) return;
    if (!ready) {
      setError(copy.diaMissing);
      return;
    }
    setStep('locking');
    setError(null);
    try {
      // The server builds `open` with the resolver paying the fee; the wallet
      // signs as the buyer and the server co-signs and sends.
      const built = await fetch('/api/checkout/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: quote.orderId }),
      });
      const unsigned = await built.json().catch(() => null);
      if (!built.ok) throw new Error(unsigned?.error ?? copy.failed);
      const signed = await wallet.signTransaction(Uint8Array.from(atob(unsigned.tx), (c) => c.charCodeAt(0)));
      const sent = await fetch('/api/checkout/open', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: quote.orderId, tx: btoa(String.fromCharCode(...signed)) }),
      });
      const opened = await sent.json().catch(() => null);
      if (!sent.ok) throw new Error(opened?.error ?? copy.failed);
      const sig = opened.openSig as string;
      setOpenSig(sig);
      track('escrow_open', { amount: quote.amountDisplay });
      if (!fromProfile && saveToProfile) {
        // Best effort: a profile that fails to save must not stop a purchase already paid for.
        await fetch('/api/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: dia.email, password: dia.password, dni: dia.dni }),
        }).catch(() => null);
      }
      const res = await fetch('/api/checkout/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orderId: quote.orderId,
          openSig: sig,
          // No `dia` means "use my saved profile"; the server decrypts it.
          ...(fromProfile
            ? {}
            : { dia: { email: dia.email.trim(), password: dia.password, dni: dia.dni.replace(/\D/g, '') } }),
          address: { street: dia.street, number: dia.number, phone: dia.phone },
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? copy.failed);
      setStatus(body as StatusResponse);
      setDia(EMPTY_LOGIN); // sent once; nothing to keep it for
      setStep('shopping');
    } catch (e) {
      console.warn('[checkout] lock failed', e);
      setError(e instanceof Error && e.message ? e.message : copy.failed);
      setStep('review');
    }
  }, [quote, wallet, dia, ready, fromProfile, saveToProfile, copy.failed, copy.diaMissing]);

  // Poll while the sandbox shops.
  useEffect(() => {
    if (step !== 'shopping' || !quote) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/checkout/status?orderId=${quote.orderId}`, { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as StatusResponse | null;
        if (stopped || !res.ok || !body) return;
        setStatus(body);
        if (body.stage === 'done' || body.stage === 'refunded') {
          setStep(body.stage);
          track(body.stage === 'done' ? 'escrow_settled' : 'escrow_refunded', {});
          refresh();
        }
      } catch {
        /* the next tick tries again */
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [step, quote, refresh]);

  const finish = useCallback(() => {
    if (step !== 'done' || !quote) return onClose();
    onPaid({
      orderId: quote.orderId.slice(0, 12),
      retailer: cart.retailer,
      paidDisplay: `${quote.amountDisplay} USDC`,
      paidAt: Date.now(),
      lines: cart.lines.filter((l) => l.available).map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal.display })),
      total: cart.total.display,
    });
  }, [step, quote, cart, onClose, onPaid]);

  // Closing mid-purchase is allowed: the server keeps shopping and the escrow
  // closes either way. Only the view goes.
  const close = step === 'done' ? finish : onClose;
  const railAt = step === 'login' ? 0 : step === 'review' || step === 'locking' ? 1 : 2;
  const closeSig = status?.closeSig ?? null;
  const lockSig = status?.openSig ?? openSig;

  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        data-testid="checkout-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{copy.title}</h2>
          <button type="button" className="modal-x" onClick={close} aria-label={copy.close}>
            ×
          </button>
        </header>

        <div className="ck-step">
          <ol className="ck-rail">
            {copy.steps.map((label, i) => (
              <li
                key={label}
                className={i === railAt ? 'ck-rail-step ck-rail-now' : i < railAt ? 'ck-rail-step ck-rail-done' : 'ck-rail-step'}
                aria-current={i === railAt ? 'step' : undefined}
              >
                <span className="ck-rail-n" aria-hidden="true">
                  {i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>

          {step === 'login' ? (
            <div className="ck-login" data-testid="checkout-login-step">
              <p className="ck-lead">{copy.loginLead}</p>
              <div className="ck-login-actions">
                <button type="button" className="btn" onClick={() => wallet.login()} disabled={!wallet.enabled || !wallet.ready}>
                  {copy.loginCta}
                </button>
              </div>
            </div>
          ) : null}

          {(step === 'review' || step === 'locking') && !quote && !error ? <p className="ck-lead">{copy.preparing}</p> : null}

          {(step === 'review' || step === 'locking') && quote ? (
            <div className="ck-pay" data-testid="checkout-lock-step">
              <dl className="ck-totals" data-testid="checkout-breakdown">
                <div className="ck-total-line">
                  <dt>{copy.subtotalLabel}</dt>
                  <dd>{pesos(quote.subtotalCentavos)}</dd>
                </div>
                <div className="ck-total-line">
                  <dt>{copy.shippingLabel}</dt>
                  <dd data-testid="checkout-shipping">{pesos(quote.shippingCentavos)}</dd>
                </div>
                <div className="ck-total-line">
                  <dt>{copy.totalLabel}</dt>
                  <dd>{pesos(quote.totalCentavos)}</dd>
                </div>
                <div className="ck-total-line">
                  <dt>{copy.rateLabel}</dt>
                  <dd data-testid="checkout-rate">{pesos(Math.round(quote.arsPerUsd * 100))} / USDC</dd>
                </div>
                <div className="ck-total-line ck-total-sum">
                  <dt>{copy.lockLabel}</dt>
                  <dd data-testid="checkout-amount">{quote.amountDisplay} USDC</dd>
                </div>
                {balance ? (
                  <div className="ck-total-line">
                    <dt>{copy.balanceLabel}</dt>
                    <dd>{balance.usdcDisplay} USDC</dd>
                  </div>
                ) : null}
              </dl>
              <p className="ck-note">{copy.rateNote(quote.rateSource)}</p>
              {quote.postalSource === 'profile' && quote.chatPostalCode && quote.chatPostalCode !== quote.postalCode ? (
                <p className="ck-note" data-testid="checkout-postal-note">
                  {copy.postalNote(quote.postalCode, quote.chatPostalCode)}
                </p>
              ) : null}
              <p className="ck-note">{copy.escrowNote}</p>

              {fromProfile ? (
                <div className="ck-delivery" data-testid="checkout-dia-profile">
                  <h3 className="ck-title">{copy.diaTitle}</h3>
                  <p className="ck-note">{copy.profileUsing(profile?.email ?? '')}</p>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTypeOwn(true)} disabled={step === 'locking'}>
                    {copy.profileOther}
                  </button>
                </div>
              ) : (
              <fieldset className="ck-delivery" disabled={step === 'locking'} data-testid="checkout-dia">
                <h3 className="ck-title">{copy.diaTitle}</h3>
                <p className="ck-note">{copy.diaLead}</p>
                <div className="ck-form">
                  <label>
                    {copy.emailLabel}
                    <input className="ck-input" type="email" autoComplete="off" value={dia.email} onChange={field('email')} />
                  </label>
                  <label>
                    {copy.passwordLabel}
                    <input className="ck-input" type="password" autoComplete="off" value={dia.password} onChange={field('password')} />
                  </label>
                  <label>
                    {copy.dniLabel}
                    <input className="ck-input" inputMode="numeric" autoComplete="off" value={dia.dni} onChange={field('dni')} />
                  </label>
                </div>
                <details className="ck-more">
                  <summary>{copy.addressMore}</summary>
                  <div className="ck-form">
                    <label>
                      {copy.streetLabel}
                      <input className="ck-input" autoComplete="address-line1" value={dia.street} onChange={field('street')} />
                    </label>
                    <label>
                      {copy.numberLabel}
                      <input className="ck-input" inputMode="numeric" value={dia.number} onChange={field('number')} />
                    </label>
                    <label>
                      {copy.phoneLabel}
                      <input className="ck-input" type="tel" autoComplete="tel" value={dia.phone} onChange={field('phone')} />
                    </label>
                  </div>
                </details>
                <label className="ck-check">
                  <input type="checkbox" checked={saveToProfile} onChange={(e) => setSaveToProfile(e.target.checked)} />
                  {copy.saveToProfile}
                </label>
              </fieldset>
              )}

              {short ? (
                <>
                  <p className="pay-warn">{copy.short}</p>
                  <button type="button" className="btn btn-ghost" onClick={() => void faucet()} disabled={funding}>
                    {funding ? copy.faucetWorking : copy.faucetCta}
                  </button>
                </>
              ) : null}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="checkout-lock"
                  onClick={() => void lock()}
                  disabled={step === 'locking' || short || !balance || !ready}
                >
                  {step === 'locking' ? copy.locking : copy.lockCta(quote.amountDisplay)}
                </button>
              </div>
            </div>
          ) : null}

          {step === 'shopping' ? (
            <div className="ck-pay" data-testid="checkout-shopping-step">
              <p className="ck-ok">{copy.lockedNote}</p>
              <p className="ck-waiting" role="status" data-testid="checkout-phase">
                {copy.phases[status?.phase ?? 'queued'] ?? copy.phases.queued}
              </p>
              <p className="ck-note">{copy.shoppingNote}</p>
            </div>
          ) : null}

          {step === 'done' ? (
            <div className="ck-pay" data-testid="checkout-done-step">
              <h3 className="ck-ok">{copy.doneTitle}</h3>
              <p className="ck-lead">{copy.doneLead(status?.storeOrderId ?? null)}</p>
              <p className="ck-note">{copy.doneNote}</p>
            </div>
          ) : null}

          {step === 'refunded' ? (
            <div className="ck-pay" data-testid="checkout-refunded-step">
              <h3 className="pay-warn">{copy.refundedTitle}</h3>
              <p className="ck-lead">{status?.payment === 'declined' ? copy.declinedLead : copy.refundedLead}</p>
            </div>
          ) : null}

          {lockSig || closeSig ? (
            <p className="ck-note" data-testid="checkout-txs">
              {lockSig ? (
                <a href={explorerTx(lockSig)} target="_blank" rel="noopener noreferrer">
                  {copy.lockTx} ↗
                </a>
              ) : null}
              {closeSig ? (
                <>
                  {' · '}
                  <a href={explorerTx(closeSig)} target="_blank" rel="noopener noreferrer">
                    {step === 'refunded' ? copy.refundTx : copy.settleTx} ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : null}

          {error ? (
            <p className="pay-error" role="alert" data-testid="checkout-error">
              {error}
            </p>
          ) : null}

          {step === 'done' || step === 'refunded' ? (
            <div className="modal-actions">
              <button type="button" className="btn" onClick={close}>
                {copy.finish}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
