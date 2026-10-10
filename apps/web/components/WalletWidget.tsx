'use client';

import { useEffect, useRef, useState } from 'react';

import { track, trackLoginStart } from '../lib/analytics';
import { GRANT_UNITS } from '../lib/faucet-policy.ts';
import { usdcAmount } from '../lib/faucet-copy.ts';
import { modeCopy, previewMasthead } from '../lib/mode-copy.ts';
import { initials, profileCopy } from '../lib/profile-copy.ts';
import { ensureUserCookie, forgetUserCookie } from '../lib/session-login.ts';
import { useBalances } from '../lib/use-balances.ts';
import { shortAddress, useWallet } from '../lib/use-wallet.ts';
import { uiCopy } from '../lib/ui-copy.ts';
import { useLang } from './LangProvider';
import { FaucetConfirm } from './FaucetConfirm';
import { ModeBadge } from './ModeBadge';
import { OrdersModal } from './OrdersModal';
import { ProfileModal } from './ProfileModal';
import { ReceiveModal } from './ReceiveModal';

/**
 * The balance widget in the masthead: the Privy wallet's devnet USDC, the
 * faucet, what was bought, and the way out.
 *
 * Privy lives behind `useWallet()` (lib/use-wallet.ts), so this renders the
 * same tree whether or not the build has an app id; `enabled: false` is the
 * misconfiguration, not a signed-out visitor.
 */
export function WalletWidget() {
  const wallet = useWallet();
  const lang = useLang();
  const copy = uiCopy(lang).wallet;
  const mode = modeCopy('devnet', lang);
  const masthead = previewMasthead(lang);
  const address = wallet.address;
  const { data, loading, error, refresh } = useBalances(address);

  const [funding, setFunding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [showingOrders, setShowingOrders] = useState(false);
  const [showingProfile, setShowingProfile] = useState(false);
  const profileButton = useRef<HTMLButtonElement>(null);
  const fundButton = useRef<HTMLButtonElement>(null);
  const receiveButton = useRef<HTMLButtonElement>(null);

  const wasAuthed = useRef(wallet.authenticated);
  useEffect(() => {
    if (!wasAuthed.current && wallet.authenticated) track('login_success');
    wasAuthed.current = wallet.authenticated;
  }, [wallet.authenticated]);

  // After login, mint the httpOnly `chg_user` cookie from the Privy access
  // token, so /api/chat skips the guest limit and the checkout routes know
  // who is paying. Shared with the chat — see lib/session-login.ts.
  useEffect(() => {
    if (!address) return;
    track('payment_view', { state: 'ready' });
    let cancelled = false;
    void ensureUserCookie(address, wallet.accessToken).then((ok) => {
      if (!cancelled && !ok) track('login_fail', { code: 'session' });
    });
    return () => {
      cancelled = true;
    };
  }, [address, wallet.accessToken]);

  async function fund() {
    if (!address) return;
    track('payment_start', { flow: 'faucet' });
    setFunding(true);
    setNote(null);
    try {
      await ensureUserCookie(address, wallet.accessToken);
      const res = await fetch('/api/faucet', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      // 429 carries a real answer ("you already have enough"), not a failure.
      if (!res.ok && res.status !== 429) throw new Error(json.message ?? json.error ?? `faucet failed (${res.status})`);
      track('payment_success', { flow: 'faucet', code: res.status === 429 ? 'enough' : 'ok' });
      setNote(json.note ?? copy.fundedAmount(usdcAmount(GRANT_UNITS, lang)));
      refresh();
    } catch (err) {
      track('payment_fail', { flow: 'faucet', code: 'error' });
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setFunding(false);
    }
  }

  if (!wallet.enabled) {
    return (
      <div className="wallet wallet-off" title="Falta NEXT_PUBLIC_PRIVY_APP_ID. Ver DEPLOY.md">
        <span className="wallet-label">{copy.label}</span>
        <span className="wallet-muted">{copy.unconfigured}</span>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="wallet">
        <ModeBadge network="devnet" />
        <span className="wallet-muted">{masthead.hint}</span>
        <button type="button" className="btn" onClick={() => trackLoginStart(wallet.login)} disabled={!wallet.ready}>
          {masthead.action}
        </button>
      </div>
    );
  }

  return (
    <div className="wallet">
      <div className="wallet-head">
        <span className="wallet-who">
          <button
            ref={profileButton}
            type="button"
            className="avatar"
            data-testid="wallet-profile"
            aria-label={profileCopy(lang).avatarAria}
            aria-haspopup="dialog"
            onClick={() => setShowingProfile(true)}
          >
            {initials(wallet.email, address)}
          </button>
          <span className="wallet-label">{wallet.email ?? copy.label}</span>
        </span>
        <button
          ref={receiveButton}
          type="button"
          className="wallet-addr"
          data-testid="wallet-receive"
          aria-haspopup="dialog"
          onClick={() => setReceiving(true)}
          title={copy.addressTitle(address)}
        >
          {shortAddress(address)}
        </button>
      </div>

      <div className="wallet-balance">
        <strong>{data ? data.usdcDisplay : '-'}</strong>
        <span className="wallet-unit">{mode.balanceUnit}</span>
        {loading && <span className="wallet-muted">{copy.refreshing}</span>}
      </div>

      <ModeBadge network="devnet" />

      {error && <p className="wallet-error">{error}</p>}
      {note && <p className="wallet-note">{note}</p>}

      <div className="wallet-actions">
        <button
          ref={fundButton}
          type="button"
          className="btn btn-sm"
          data-testid="wallet-fund"
          aria-haspopup="dialog"
          onClick={() => {
            setNote(null);
            setConfirming(true);
          }}
          disabled={funding || confirming}
        >
          {funding ? copy.funding : copy.fundCta}
        </button>
        <button
          type="button"
          className="btn btn-ghost wallet-icon-btn"
          data-testid="wallet-orders"
          aria-label={copy.purchasesAria}
          aria-haspopup="dialog"
          onClick={() => setShowingOrders(true)}
        >
          <BagIcon />
        </button>
        <button
          type="button"
          className="btn btn-ghost wallet-icon-btn"
          data-testid="wallet-logout"
          aria-label={copy.signOutAria}
          onClick={() => {
            track('logout');
            forgetUserCookie();
            void fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin' }).finally(() =>
              wallet.logout(),
            );
          }}
        >
          <LogoutIcon />
        </button>
      </div>

      {showingOrders ? <OrdersModal onClose={() => setShowingOrders(false)} /> : null}

      {showingProfile ? (
        <ProfileModal
          onClose={() => {
            setShowingProfile(false);
            requestAnimationFrame(() => profileButton.current?.focus());
          }}
        />
      ) : null}

      {receiving ? (
        <ReceiveModal
          address={address}
          onClose={() => {
            setReceiving(false);
            requestAnimationFrame(() => receiveButton.current?.focus());
          }}
        />
      ) : null}

      {confirming ? (
        <FaucetConfirm
          balanceUnits={data ? BigInt(data.usdc) : null}
          onClose={() => {
            setConfirming(false);
            requestAnimationFrame(() => fundButton.current?.focus());
          }}
          onConfirm={() => {
            setConfirming(false);
            void fund();
          }}
        />
      ) : null}
    </div>
  );
}

function BagIcon() {
  return (
    <svg className="wallet-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 8h16l-1.2 11.2a1.5 1.5 0 0 1-1.5 1.3H6.7a1.5 1.5 0 0 1-1.5-1.3Z" />
      <path d="M8.5 8V6.2a3.5 3.5 0 0 1 7 0V8" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg className="wallet-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
