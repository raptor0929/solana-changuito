'use client';

import { useCallback, useState } from 'react';

import { track, trackLoginStart } from '../lib/analytics';
import type { OrderLine } from '../lib/checkout/types.ts';
import { DEFAULT_LANG, type Lang } from '../lib/lang.ts';
import { purchaseDate, purchasesCopy } from '../lib/orders-copy.ts';
import { useWallet } from '../lib/use-wallet.ts';
import { uiCopy } from '../lib/ui-copy.ts';
import { useLang } from './LangProvider';

/**
 * What this shopper has bought here, read from the escrow program rather
 * than the browser: every Order account whose buyer is this wallet, through
 * `GET /api/checkout/orders`. The chain is the record, so it is the same list
 * on every device and survives a cleared browser.
 *
 * It is `OrdersModal`'s body, which is what `embedded` is for: inside a
 * dialog the heading and the way back are the dialog's.
 */
const STATUS: Record<Lang, Record<OrderLine['status'], string>> = {
  es: { open: 'En curso', settled: 'Completada', refunded: 'Devuelta' },
  en: { open: 'In progress', settled: 'Complete', refunded: 'Refunded' },
};

export function Purchases({ embedded = false }: { embedded?: boolean } = {}) {
  const lang = useLang();
  const copy = purchasesCopy(lang);
  const ui = uiCopy(lang);
  const wallet = useWallet();
  const address = wallet.address;

  const [orders, setOrders] = useState<OrderLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/checkout/orders', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(said(body, lang) ?? copy.error);
        return;
      }
      const list = Array.isArray(body?.orders) ? (body.orders as OrderLine[]) : [];
      setOrders(list);
      track('purchases_read', { count: String(list.length) });
    } catch {
      setError(copy.error);
    } finally {
      setLoading(false);
    }
  }, [address, copy, lang, loading]);

  if (!wallet.enabled) {
    return (
      <section className="purchases">
        {embedded ? null : <h2 className="purchases-title">{copy.title}</h2>}
        <p className="purchases-lead">{ui.purchasesUnconfigured}</p>
      </section>
    );
  }

  return (
    <section className="purchases" data-testid="purchases">
      {embedded ? null : <h2 className="purchases-title">{copy.title}</h2>}

      {!address ? (
        <div className="purchases-empty" data-testid="purchases-guest">
          <h3 className="purchases-sub">{copy.guestTitle}</h3>
          <p className="purchases-lead">{copy.guestBody}</p>
          <button type="button" className="btn" onClick={() => trackLoginStart(wallet.login)}>
            {copy.guestAction}
          </button>
        </div>
      ) : (
        <>
          <p className="purchases-lead">{copy.lead}</p>
          {orders === null ? (
            <div className="purchases-empty">
              <button
                type="button"
                className="btn"
                data-testid="purchases-load"
                onClick={() => void load()}
                disabled={loading}
              >
                {loading ? copy.loading : copy.loadCta}
              </button>
            </div>
          ) : orders.length === 0 ? (
            <p className="purchases-lead" data-testid="purchases-none">
              {copy.empty}
            </p>
          ) : (
            <ul className="purchases-list" data-testid="purchases-list">
              {orders.map((o) => (
                <li className="purchase" key={o.orderId}>
                  <div className="purchase-head">
                    <strong className="purchase-amount">{o.amountDisplay} USDC</strong>
                    <span className="purchase-status" data-status={o.status}>
                      {STATUS[lang][o.status]}
                    </span>
                  </div>
                  <p className="purchase-meta">
                    <span>{purchaseDate(new Date(o.openedAt).toISOString(), lang)}</span>
                    <span className="purchase-code">
                      {copy.codeLabel}{' '}
                      <a href={o.explorer} target="_blank" rel="noopener noreferrer">
                        <code>{o.orderId.slice(0, 8)}</code>
                      </a>
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {error ? (
            <p className="pay-warn" role="status" data-testid="purchases-error">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * What a failed route said, if it said anything a person can read. `message`
 * first, then `error`: the routes write the code for the logs in one and the
 * sentence for a person in the other, and the ones without a `message` are
 * already sentences.
 *
 * Except in English, where it says nothing. The API routes answer in Spanish
 * and always will — they are shared with the MCP server and with the agent,
 * and neither of those reads a cookie from this browser. Preferring the
 * server's sentence would hand a Spanish paragraph to the one reader who
 * cannot parse it, so the caller's own fallback wins instead: less specific,
 * and readable. The day a route learns to answer in two languages this
 * parameter goes away.
 */
function said(body: unknown, lang: Lang = DEFAULT_LANG): string | null {
  if (lang === 'en') return null;
  const b = (body ?? {}) as { message?: unknown; error?: unknown };
  if (typeof b.message === 'string') return b.message;
  if (typeof b.error === 'string') return sentence(b.error);
  return null;
}

/** A fragment from an API turned into something that can sit in a paragraph. CardPanel has the same one. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const capped = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}
