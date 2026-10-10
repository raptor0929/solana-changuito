/**
 * The card the checkout sandbox pays with: the `shared_card` row (migration
 * 0004), typed in by the operator. It used to be CARD_* on the sandbox
 * service; reading it from the table means rotating the card is an UPDATE,
 * not a redeploy of two services.
 *
 * 0004's header is the honest account of what this row is — a PAN and CVV at
 * rest, behind RLS and the server's credentials. This module adds one reader
 * and one destination: /api/checkout/start reads it and puts it in the job
 * body to the sandbox, over the same token-authenticated request that carries
 * the shopper's login. Nothing else reads it, nothing logs it, and the
 * browser never sees it — shoppers are not `shared_card_member`s of anything;
 * the card pays for their order without being shown to them.
 *
 * Which row: this app runs on devnet, but the card is real. The devnet row
 * wins when the operator has put one there; otherwise the mainnet row.
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

export async function checkoutCard(env: NodeJS.ProcessEnv = process.env): Promise<CheckoutCard | undefined> {
  if (!hasDatabase(env)) return undefined;
  const rows = await db(env)`
    select network, pan, cvv, exp_month, exp_year, holder, brand from shared_card
    where network in ('devnet', 'mainnet')
    order by (network = 'devnet') desc
    limit 1`;
  const r = rows[0];
  if (!r) return undefined;
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
