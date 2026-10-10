'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { profileCopy, type ProfileCopy } from '../lib/profile-copy.ts';
import type { PublicProfile } from '../lib/profile.ts';
import { useLang } from './LangProvider';
import { Modal } from './Modal';
import { Purchases } from './Purchases';

/**
 * The profile dialog, opened from the avatar in the masthead. Two tabs: the
 * Día details the checkout sandbox buys with (lib/profile.ts, stored
 * encrypted), and what this wallet has bought.
 *
 * The password box is always empty. The server never sends the password back,
 * only `hasPassword`, so leaving the box empty keeps the saved one and typing
 * replaces it. What is typed lives in this component's state until Guardar,
 * and is cleared as soon as the server has it.
 */
type Tab = 'dia' | 'orders';
const TABS: Tab[] = ['dia', 'orders'];

export function ProfileModal({ onClose, initialTab = 'dia' }: { onClose: () => void; initialTab?: Tab }) {
  const copy = profileCopy(useLang());
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ dia: null, orders: null });

  // Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = TABS[(TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const strip = (
    <div className="tabs" role="tablist" aria-label={copy.title} onKeyDown={onKey}>
      {TABS.map((t) => (
        <button
          key={t}
          ref={(el) => {
            tabRefs.current[t] = el;
          }}
          type="button"
          role="tab"
          id={`profile-tab-${t}`}
          className="tab"
          aria-selected={tab === t}
          aria-controls={`profile-panel-${t}`}
          tabIndex={tab === t ? 0 : -1}
          onClick={() => setTab(t)}
        >
          {t === 'dia' ? copy.tabDia : copy.tabOrders}
        </button>
      ))}
    </div>
  );

  return (
    <Modal title={copy.title} onClose={onClose} className="modal-orders" testId="profile-modal" head={strip}>
      <div role="tabpanel" id={`profile-panel-${tab}`} aria-labelledby={`profile-tab-${tab}`}>
        {tab === 'dia' ? <ProfileLoader copy={copy} /> : <Purchases embedded />}
      </div>
    </Modal>
  );
}

function ProfileLoader({ copy }: { copy: ProfileCopy }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch('/api/profile', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok) setError(body?.error ?? copy.failed);
        else setProfile(body as PublicProfile);
      })
      .catch(() => live && setError(copy.failed));
    return () => {
      live = false;
    };
  }, [copy.failed]);

  if (error) return <p className="pay-error" role="alert">{error}</p>;
  if (!profile) return <p className="ck-note">{copy.loading}</p>;
  return <ProfileForm copy={copy} profile={profile} onSave={saveProfile} />;
}

async function saveProfile(patch: Record<string, string>): Promise<PublicProfile> {
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? '');
  return body as PublicProfile;
}

/** The form alone, with no fetching: what the dev fixtures render. */
export function ProfileForm({
  copy,
  profile,
  onSave,
}: {
  copy: ProfileCopy;
  profile: PublicProfile;
  onSave: (patch: Record<string, string>) => Promise<PublicProfile>;
}) {
  const [saved, setSaved] = useState(profile);
  const [form, setForm] = useState({
    email: profile.email ?? '',
    password: '',
    dni: profile.dni ?? '',
    postcode: profile.postcode ?? '',
  });
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setState('idle');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('saving');
    setError(null);
    try {
      const next = await onSave(form);
      setSaved(next);
      setForm((f) => ({ ...f, password: '' })); // the server has it now
      setState('saved');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : copy.failed);
      setState('idle');
    }
  };

  return (
    <form className="ck-pay" onSubmit={(e) => void submit(e)} data-testid="profile-form">
      <p className="ck-note">{copy.lead}</p>
      <div className="ck-form">
        <label>
          {copy.email}
          <input className="ck-input" type="email" autoComplete="off" value={form.email} onChange={set('email')} />
        </label>
        <label>
          {copy.password}
          <input
            className="ck-input"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
            placeholder={saved.hasPassword ? '••••••••' : ''}
          />
          <span className="ck-hint">{saved.hasPassword ? copy.passwordSaved : copy.passwordHint}</span>
        </label>
        <label>
          {copy.dni}
          <input className="ck-input" inputMode="numeric" autoComplete="off" value={form.dni} onChange={set('dni')} />
          <span className="ck-hint">{copy.dniHint}</span>
        </label>
        <label>
          {copy.postcode}
          <input className="ck-input" autoComplete="postal-code" value={form.postcode} onChange={set('postcode')} />
          <span className="ck-hint">{copy.postcodeHint}</span>
        </label>
      </div>
      {error ? (
        <p className="pay-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-actions">
        {state === 'saved' ? (
          <span className="ck-ok" role="status">
            {copy.saved}
          </span>
        ) : null}
        <button type="submit" className="btn" disabled={state === 'saving'} data-testid="profile-save">
          {state === 'saving' ? copy.saving : copy.save}
        </button>
      </div>
    </form>
  );
}
