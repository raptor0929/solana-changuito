/**
 * The card the checkout sandbox pays with: the `shared_card` row (migration
 * 0004), typed in by the operator, and the list of wallets allowed to buy
 * with it, `shared_card_member` (same migration).
 *
 * 0004's header is the honest account of what the row is — a PAN and CVV at
 * rest, behind RLS and the server's credentials. This module is its only
 * reader, and /api/checkout/start its only destination: the card goes into
 * the job body to the sandbox, over the same token-authenticated request that
 * carries the shopper's login. Nothing logs it and the browser never sees it.
 *
 * Who may buy with it: only wallets on `shared_card_member` for the card's
 * network. The card is real money, and "any signed-in wallet" is anybody with
 * an email. The check runs twice — at the quote, so a wallet that is not on
 * the list is told before it locks anything, and at the start, which is the
 * one that counts — and it fails closed: a member list that cannot be read is
 * an empty one. Add and remove members with `npm run members`.
 *
 * The mock sandbox (config.sandbox_mock) never touches the card, so it skips
 * the gate: a demo on the mock stays open to everyone.
 *
 * Which row: this app runs on devnet, but the card is real. The devnet row
 * wins when the operator has put one there; otherwise the mainnet row. The
 * member list is read for the same network as the row in use.
 */
import { db, hasDatabase } from './db.ts';

/** What the sandbox types into Día's card form. */
export interface CheckoutCard {
  pan: string;
  cvv: string;
  /** Two digits. */
  exp_month: string;
  /** Two digits, as stored; the sandbox widens it when a form wants four. */
  exp_year: string;
  holder: string;
  /** Which payment group Día files it under. */
  kind: 'debit' | 'credit';
  /** Which network's row was used, for the job log. Never the number. */
  network: string;
}

/** Credit only when the brand says so; the operator's card is a debit card. */
export function cardKind(brand: string | null | undefined): 'debit' | 'credit' {
  return /cr[eé]dit/i.test(brand ?? '') ? 'credit' : 'debit';
}

/**
 * Whether a checkout may go ahead, before any money moves.
 *   - `mock`: the mock sandbox runs it; no card is involved, everyone may.
 *   - `ok`: a card exists and this wallet is on its member list.
 *   - `no-card`: no `shared_card` row, so nothing could pay.
 *   - `not-member`: a card exists and this wallet is not allowed to use it.
 */
export type CardAccess = 'mock' | 'ok' | 'no-card' | 'not-member';

/** The decision alone, so it is testable without a database. */
export function decideAccess(i: { mock: boolean; cardNetwork: string | undefined; member: boolean }): CardAccess {
  if (i.mock) return 'mock';
  if (!i.cardNetwork) return 'no-card';
  return i.member ? 'ok' : 'not-member';
}

/** The network whose row is the card in use, or undefined when there is none. */
export async function cardNetwork(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!hasDatabase(env)) return undefined;
  const rows = await db(env)`
    select network from shared_card where network in ('devnet', 'mainnet')
    order by (network = 'devnet') desc limit 1`;
  return rows[0]?.network as string | undefined;
}

/** Fails closed: an unreadable list is an empty one. */
export async function isCardMember(network: string, address: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!hasDatabase(env)) return false;
  try {
    const rows = await db(env)`
      select 1 from shared_card_member where network = ${network} and address = ${address}`;
    return rows.length > 0;
  } catch (err) {
    console.error('[shared-card] member list unreadable; treating as not a member:', err instanceof Error ? err.name : err);
    return false;
  }
}

/** The quote's check: may this wallet start a checkout at all? */
export async function cardAccess(address: string, mock: boolean): Promise<CardAccess> {
  if (mock) return 'mock';
  const net = await cardNetwork().catch(() => undefined);
  return decideAccess({ mock, cardNetwork: net, member: net ? await isCardMember(net, address) : false });
}

/** The card for this wallet's checkout, or undefined when there is none or it is not a member. */
export async function checkoutCardFor(address: string, env: NodeJS.ProcessEnv = process.env): Promise<CheckoutCard | undefined> {
  if (!hasDatabase(env)) return undefined;
  const rows = await db(env)`
    select network, pan, cvv, exp_month, exp_year, holder, brand from shared_card
    where network in ('devnet', 'mainnet')
    order by (network = 'devnet') desc
    limit 1`;
  const r = rows[0];
  if (!r) return undefined;
  if (!(await isCardMember(r.network as string, address, env))) return undefined;
  return {
    pan: r.pan as string,
    cvv: r.cvv as string,
    exp_month: r.exp_month as string,
    exp_year: r.exp_year as string,
    holder: r.holder as string,
    kind: cardKind(r.brand as string),
    network: r.network as string,
  };
}
