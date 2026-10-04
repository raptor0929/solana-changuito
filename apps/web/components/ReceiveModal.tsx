'use client';

import { useEffect, useId, useRef } from 'react';

import { receiveCopy } from '../lib/mode-copy.ts';
import { useLang } from './LangProvider';
import { qrPicture } from '../lib/qr.ts';
import { CopyField } from './CopyField';

/**
 * Where a shopper gets their own address, so somebody can send money to it.
 *
 * Both halves matter and they are for two different people in the same person.
 * The QR is for the one holding a phone with Lemon open, who would otherwise
 * type forty-odd base58 characters into a withdrawal form. The text is for the
 * one on a laptop, who cannot photograph their own screen — and it is the
 * **whole** address, not `EV5c…ZPS`, because a truncated address is a thing
 * you can read and not a thing you can use.
 *
 * The QR encodes the bare address and nothing else. A Solana Pay `solana:`
 * URI carries more — the token, an amount — and is understood by Solana
 * wallets, but the scanner this is actually pointed at belongs to an exchange's
 * withdrawal form, which wants a destination and would paste the scheme and
 * the query string into it as if they were part of the account. Bare also means
 * the code and the text below it are the same value, so there is one thing to
 * be right about rather than two.
 *
 * Presentational, like FaucetConfirm. On Solana there is no trustline to
 * open: the faucet creates the USDC account, and so does any sender.
 */
export function ReceiveModal({ address, onClose }: { address: string; onClose: () => void }) {
  const lang = useLang();
  const receive = receiveCopy(lang);
  const titleId = useId();
  const leadId = useId();
  const dialog = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  const qr = qrPicture(address);

  useEffect(() => {
    primary.current?.focus();
  }, []);

  // Same trap as FaucetConfirm, for the same reasons. Kept as a copy rather
  // than hoisted: two call sites is not yet a pattern, and the day this needs
  // to differ is the day a shared one gets a flag.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog.current) return;
      const focusable = dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="modal receive-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        data-testid="receive-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id={titleId}>{receive.title}</h2>
        </header>

        <p id={leadId} className="pay-note">
          {receive.lead}
        </p>

        {/* A white plate under the code regardless of the page's theme: a QR is
            dark-on-light by definition, and inverting it stops it scanning. */}
        <div className="receive-qr">
          <svg
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            role="img"
            aria-label={receive.qrAlt}
            data-testid="receive-qr"
            shapeRendering="crispEdges"
          >
            <rect width={qr.size} height={qr.size} fill="#fff" />
            <path d={qr.d} fill="#000" />
          </svg>
        </div>

        <dl className="ck-fields">
          <CopyField label={receive.addressLabel} value={address} testid="receive-address" mono />
        </dl>

        <ul className="receive-facts">
          {receive.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>

        <p className="pay-warn">{receive.warn}</p>

        <div className="modal-actions">
          <button
            ref={primary}
            type="button"
            className="btn btn-ghost"
            data-testid="receive-close"
            onClick={onClose}
          >
            {receive.dismiss}
          </button>
        </div>
      </section>
    </div>
  );
}
