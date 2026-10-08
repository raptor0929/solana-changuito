/**
 * The only module in this app that opens a Postgres connection.
 *
 * Everything the money path needs to remember lives here rather than in
 * Redis, and the reason is not preference. A card the customer keeps has no
 * expiry, and a binding with no expiry does not belong in a cache with an
 * eviction policy: `SET NX` gives atomicity but Redis can still drop the key
 * under memory pressure, at which point the next deposit mints a second card
 * for somebody who already has one. A primary key cannot be evicted.
 *
 * The cache workloads followed later — the agent's in-flight turn, the
 * checkout record and the quotas, all of which expire — into the `kv` and
 * `quota` tables behind lib/kv.ts, so one credential runs the whole app. They
 * keep their degrade rules (CLAUDE.md §4); only the store underneath changed.
 *
 * ## Three things about this connection specifically
 *
 * `prepare: false` is not optional. Supabase's pooler rejects named prepared
 * statements, and the failure is a confusing "prepared statement already
 * exists" on the *second* request rather than the first.
 *
 * `max: 1` because a lambda handles one request at a time; a larger pool just
 * holds connections open against the pooler's own limit.
 *
 * The connection is created lazily and cached on the module. A fresh clone with
 * no DATABASE_URL should still boot and still serve the chat half of the app —
 * the same degrade lib/pollar.ts makes for a missing wallet key — so nothing
 * here throws at import time. It throws when a money path actually needs a
 * database and there is none, which is a state that must be loud.
 */
import postgres from 'postgres';

import type { NetworkId } from './deployments.ts';

export type Sql = ReturnType<typeof postgres>;

let cached: Sql | undefined;

/** Whether this deployment has a database at all. */
export function hasDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.DATABASE_URL ?? '').trim());
}

/**
 * The pooled connection, made once.
 *
 * DATABASE_URL is the transaction pooler (6543). DIRECT_URL (5432) is for
 * migrations only and is deliberately not read here: transaction-mode pooling
 * is what makes a lambda-per-request workload survivable, and a route that
 * quietly opened a session connection would exhaust the database under load
 * rather than at deploy.
 */
export function db(env: NodeJS.ProcessEnv = process.env): Sql {
  if (cached) return cached;
  const url = (env.DATABASE_URL ?? '').trim();
  if (!url) {
    // Reached only from a money path. The message names the variable because
    // the person reading this log is the person who can set it.
    throw new Error('DATABASE_URL is not set — the card and order tables are unreachable.');
  }
  cached = postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    // A serverless function is killed, not shut down. Logging a fetch of a
    // closed connection as an error would be noise on every cold start.
    onnotice: () => {},
  });
  return cached;
}

/** Tests only: drop the cached connection so a fake can take its place. */
export function resetDb(next?: Sql): void {
  cached = next;
}

/* ---- the card a customer keeps ------------------------------------------ */

/**
 * The customer's card, or nothing if they have never been issued one.
 *
 * Keyed on (network, address) rather than address alone, so a testnet card
 * funded with play money can never be the one a mainnet deposit tops up.
 */
export async function cardOf(net: NetworkId, address: string): Promise<string | undefined> {
  const rows = await db()`
    select card_id from card_owner where network = ${net} and address = ${address}`;
  return rows[0]?.card_id as string | undefined;
}

/** The binding with its cached face, for a panel that only has to name the
 *  card rather than show it. `last4`/`brand` are null on rows written before
 *  0003_card_face.sql and whenever the caller had nothing to cache. */
export async function cardFaceOf(
  net: NetworkId,
  address: string,
): Promise<{ cardId: string; last4: string | null; brand: string | null } | undefined> {
  const rows = await db()`
    select card_id, last4, brand
      from card_owner where network = ${net} and address = ${address}`;
  const r = rows[0];
  if (!r) return undefined;
  return {
    cardId: r.card_id as string,
    last4: (r.last4 as string | null) ?? null,
    brand: (r.brand as string | null) ?? null,
  };
}

/**
 * Bind a freshly created card to a customer, once.
 *
 * Returns the id that ended up bound, which is **not always the one passed in**.
 * Two lambdas can reach `createCard` concurrently for the same wallet — the
 * deposit watcher and a refreshed tab, say — and both will hold a real card
 * from Vyrion. `on conflict do nothing` lets exactly one of them win, and the
 * loser learns it lost by getting back an id that is not theirs. The caller
 * must then terminate the card it created, or the customer is charged for two.
 *
 * That is the same losing-race shape app/api/card/route.ts already implements
 * for the per-deposit claim, and it is here rather than there because the
 * atomicity is a property of the constraint.
 */
export async function bindCard(
  net: NetworkId,
  address: string,
  cardId: string,
  /** last4 and brand, so reading the binding back does not cost a provider
   *  call. Optional because the caller may not have them, and because they are
   *  a cache rather than the truth — see 0003_card_face.sql. Written on the
   *  winning insert only: the loser's card is about to be handed back, so its
   *  face would be a lie the moment it landed. */
  face?: { last4?: string; brand?: string },
): Promise<string> {
  const sql = db();
  const last4 = /^\d{4}$/.test(face?.last4 ?? '') ? face!.last4! : null;
  const brand = face?.brand?.trim() || null;
  const inserted = await sql`
    insert into card_owner (network, address, card_id, last4, brand)
    values (${net}, ${address}, ${cardId}, ${last4}, ${brand})
    on conflict (network, address) do nothing
    returning card_id`;
  if (inserted[0]) return inserted[0].card_id as string;
  const held = await cardOf(net, address);
  // No row after a conflict means it was deleted between the two statements —
  // a card terminated at exactly the wrong moment. Ours is as good as any.
  return held ?? cardId;
}

/**
 * Forget a card that Vyrion says is gone.
 *
 * Guarded on card_id so a stale read cannot unbind a card the customer was
 * issued after the one being forgotten.
 */
export async function unbindCard(net: NetworkId, address: string, cardId: string): Promise<void> {
  await db()`
    delete from card_owner
     where network = ${net} and address = ${address} and card_id = ${cardId}`;
}

/* ---- orders -------------------------------------------------------------- */

export type OrderStatus = 'quoted' | 'paid' | 'carded' | 'done' | 'failed';

export interface OrderRow {
  /** Null until a chat claims it — see 0002_order_identity.sql. */
  chatId: string | null;
  network: NetworkId;
  memo: string;
  /** Null in `open` mode, where no address was ever proven. */
  address: string | null;
  status: OrderStatus;
  amountCents: number;
  arsQuoted: number | null;
  cardId: string | null;
  txHash: string | null;
  cartId: string | null;
  handoffUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const toOrder = (r: Record<string, unknown>): OrderRow => ({
  chatId: (r.chat_id as string | null) ?? null,
  network: r.network as NetworkId,
  memo: r.memo as string,
  address: (r.address as string | null) ?? null,
  status: r.status as OrderStatus,
  amountCents: r.amount_cents as number,
  arsQuoted: (r.ars_quoted as number | null) ?? null,
  cardId: (r.card_id as string | null) ?? null,
  txHash: (r.tx_hash as string | null) ?? null,
  cartId: (r.cart_id as string | null) ?? null,
  handoffUrl: (r.handoff_url as string | null) ?? null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

/**
 * Open an order when the deposit intent is minted.
 *
 * This is where `rememberDepositor` used to write, and it records the same
 * fact: this memo was issued to a wallet the gate let through. What it adds is
 * that the fact no longer expires after 24 hours, so a deposit confirmed late
 * cannot become an unowned memo — which was a 403 to somebody who had paid.
 *
 * `address` is optional because in `realModeMode() === 'open'` nothing is
 * proven, and the deposit route deliberately declines to write a claimed
 * address down. The row still exists, so the claim latch still works; it just
 * has no depositor to check against, which is exactly the state `open` means.
 *
 * `chatId` is optional because this runs before any chat id has crossed the
 * wire. `attachChat` links them afterwards.
 *
 * The conflict target is the primary key `(network, memo)` — a re-quote against
 * the same memo amends. In practice `mintMemo()` makes a fresh memo per quote,
 * so this is the idempotency guard for a retried request rather than the
 * common path.
 */
export async function openOrder(o: {
  network: NetworkId;
  memo: string;
  amountCents: number;
  address?: string | null;
  chatId?: string | null;
  arsQuoted?: number | null;
  cartId?: string | null;
}): Promise<OrderRow> {
  const rows = await db()`
    insert into orders (network, memo, address, chat_id, amount_cents, ars_quoted, cart_id)
    values (${o.network}, ${o.memo}, ${o.address ?? null}, ${o.chatId ?? null},
            ${o.amountCents}, ${o.arsQuoted ?? null}, ${o.cartId ?? null})
    on conflict (network, memo) do update
       set amount_cents = excluded.amount_cents,
           ars_quoted   = coalesce(excluded.ars_quoted, orders.ars_quoted),
           cart_id      = coalesce(excluded.cart_id, orders.cart_id),
           address      = coalesce(orders.address, excluded.address),
           chat_id      = coalesce(orders.chat_id, excluded.chat_id)
    returning *`;
  return toOrder(rows[0]);
}

/**
 * The chat's order, opened or amended — the "one order per chat" rule, made
 * useful instead of merely enforced.
 *
 * `unique (chat_id)` already says a chat cannot have two orders, but on its own
 * it says it by throwing 23505 at the second quote, and a second quote is
 * ordinary: a shopper closes the payment dialog, changes the basket and opens
 * it again. So the rule is read forwards here. A chat that already has an order
 * nobody has paid a card out of gets **that order amended and its memo handed
 * back**, which is better than a fresh memo for three reasons:
 *
 * - a deposit already sent against the old memo still matches, so a shopper who
 *   paid and then reloaded is not stranded with money against a dead código;
 * - the row keeps its `created_at`, so the record says when the shopper started
 *   rather than when they last changed their mind;
 * - there is only ever one row per chat to reconcile against the ledger.
 *
 * `closed` is the other answer: the order already bought a card, or it finished.
 * That chat is over — one chat is one order — and the caller refuses rather than
 * opening a second the shopper could not pay for anyway.
 *
 * `select … for update` locks the chat's row for the amend. It cannot lock a row
 * that is not there yet, so two first quotes in one chat can both reach the
 * insert and one loses on `orders_one_per_chat`; that loser re-reads and
 * amends, which is the same answer it would have got by arriving a moment later.
 *
 * ## `linked: false`, and why it is not a failure
 *
 * `orders.chat_id` references `chat (id)`, and the chat row is written by
 * `archiveChat` after a clean turn. That is nearly always already true by the
 * time anyone reaches checkout — a shopper has to talk to the agent to get a
 * basket — but "nearly always" is not a constraint, and the gap is real: an
 * archive write that failed, or a signed-in shopper on a deployment where the
 * archive is off. The insert then raises 23503 and the honest answer is to open
 * the order **without** the link rather than refuse to quote, because the row
 * is what `POST /api/card` reads to decide whether a memo has an owner, and a
 * shopper who cannot get a memo cannot pay at all.
 *
 * What is lost is the one-order-per-chat rule for that order, which is what
 * `linked` reports so the caller can say so in the log. The insert runs in a
 * savepoint because in Postgres one error aborts the whole transaction: without
 * it the retry would die at 25P02 rather than inserting.
 */
export type ChatOrder =
  | { kind: 'open'; order: OrderRow; linked: boolean }
  | { kind: 'closed'; order: OrderRow };

export interface ChatOrderInput {
  network: NetworkId;
  chatId: string;
  /** The memo to use only if this chat has no order yet. */
  memo: string;
  amountCents: number;
  address?: string | null;
  arsQuoted?: number | null;
  cartId?: string | null;
}

/** Spoken for: a card was bought against it, or it is over. */
const settled = (o: OrderRow): boolean => Boolean(o.cardId) || o.status === 'done' || o.status === 'failed';

/**
 * A transaction, structurally. `Sql` is the top-level client type and does not
 * carry `savepoint`, and postgres.js's own `TransactionSql` is not exported
 * from the shape this file imports — so the one method that is actually needed
 * is named here rather than casting the whole thing to `any` at the call site.
 */
type Tx = Sql & { savepoint: <T>(fn: (sp: Sql) => Promise<T>) => Promise<T> };

export async function openChatOrder(o: ChatOrderInput): Promise<ChatOrder> {
  const insert = async (tx: Sql, chatId: string | null) => {
    const rows = await tx`
      insert into orders (network, memo, address, chat_id, amount_cents, ars_quoted, cart_id)
      values (${o.network}, ${o.memo}, ${o.address ?? null}, ${chatId},
              ${o.amountCents}, ${o.arsQuoted ?? null}, ${o.cartId ?? null})
      on conflict (network, memo) do update
         set amount_cents = excluded.amount_cents,
             ars_quoted   = coalesce(excluded.ars_quoted, orders.ars_quoted),
             cart_id      = coalesce(excluded.cart_id, orders.cart_id),
             address      = coalesce(orders.address, excluded.address),
             chat_id      = coalesce(orders.chat_id, excluded.chat_id)
      returning *`;
    return toOrder(rows[0]!);
  };

  const run = async (tx: Tx): Promise<ChatOrder> => {
    const held = await tx`select * from orders where chat_id = ${o.chatId} for update`;
    if (held[0]) {
      const prior = toOrder(held[0]);
      if (settled(prior)) return { kind: 'closed', order: prior };
      const rows = await tx`
        update orders
           set amount_cents = ${o.amountCents},
               ars_quoted   = coalesce(${o.arsQuoted ?? null}, ars_quoted),
               cart_id      = coalesce(${o.cartId ?? null}, cart_id),
               address      = coalesce(address, ${o.address ?? null})
         where network = ${prior.network} and memo = ${prior.memo}
         returning *`;
      return { kind: 'open', order: toOrder(rows[0]!), linked: true };
    }
    try {
      return { kind: 'open', order: await tx.savepoint((sp) => insert(sp, o.chatId)), linked: true };
    } catch (err) {
      // No chat row to point at yet. Quote anyway — see the header.
      if ((err as { code?: string }).code !== '23503') throw err;
      return { kind: 'open', order: await insert(tx, null), linked: false };
    }
  };

  try {
    return (await db().begin((tx) => run(tx as unknown as Tx))) as unknown as ChatOrder;
  } catch (err) {
    // Lost the race to be this chat's first order. The winner's row is the
    // answer, so read it and amend it — one more round-trip on a path that
    // happens when a shopper double-taps, and never otherwise.
    if ((err as { code?: string }).code !== '23505') throw err;
    return (await db().begin((tx) => run(tx as unknown as Tx))) as unknown as ChatOrder;
  }
}

/**
 * Link an order to the conversation that produced it.
 *
 * Separate from `openOrder` because the chat id arrives later and from a
 * different place. `where chat_id is null` makes it write-once: a memo cannot
 * be re-pointed at a second conversation, so the audit trail cannot be edited
 * by replaying a request.
 *
 * A conflict on `orders_one_per_chat` (23505) means that chat already has an
 * order — the "one order per chat" rule refusing, which is not an error the
 * caller should crash on.
 */
export async function attachChat(net: NetworkId, memo: string, chatId: string): Promise<boolean> {
  try {
    const rows = await db()`
      update orders set chat_id = ${chatId}
       where network = ${net} and memo = ${memo} and chat_id is null
       returning chat_id`;
    return rows.length > 0;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

/** The order a memo belongs to, if any. */
export async function orderByMemo(net: NetworkId, memo: string): Promise<OrderRow | undefined> {
  const rows = await db()`
    select * from orders where network = ${net} and memo = ${memo}`;
  return rows[0] ? toOrder(rows[0]) : undefined;
}

/**
 * Claim this deposit for a card, exactly once.
 *
 * The conditional update is the whole guarantee, and it is the same one Redis
 * `SET NX` gave: `card_id is null` in the WHERE means two concurrent writers
 * cannot both match, because the first one's commit makes the second's
 * predicate false. An empty result is not an error — it means somebody else
 * claimed it, and `existing` says who with.
 *
 * Unlike the Redis version this leaves a row behind afterwards, so "which
 * deposit paid for which card" is answerable a month later.
 */
export async function claimOrder(
  net: NetworkId,
  memo: string,
  cardId: string,
): Promise<{ claimed: boolean; existing?: string }> {
  const sql = db();
  const won = await sql`
    update orders set card_id = ${cardId}, status = 'carded'
     where network = ${net} and memo = ${memo} and card_id is null
     returning card_id`;
  if (won[0]) return { claimed: true };
  const held = await orderByMemo(net, memo);
  return { claimed: false, existing: held?.cardId ?? undefined };
}

/**
 * The deposit landed, and the order says so from now on.
 *
 * Monotonic, and that is the whole design. The browser polls `GET /api/deposit`
 * every four seconds and keeps confirming the same payment for as long as the
 * dialog is open — including after `claimOrder` has moved the order to
 * `carded` — so a plain `set status = 'paid'` would walk a carded order
 * backwards once every four seconds. `case when status = 'quoted'` is what
 * makes the write safe to repeat.
 *
 * The hash is recorded either way: it is evidence that this memo was paid by
 * that transaction, and that stays true whatever the status has moved on to.
 *
 * The WHERE clause excludes the rows that would not change, rather than
 * updating them to themselves. `orders_touch` fires on every UPDATE, so
 * without it a dialog left open would bump `updated_at` every four seconds and
 * the order's own record of when anything last happened to it would be a clock.
 */
export async function markPaid(net: NetworkId, memo: string, txHash: string): Promise<void> {
  await db()`
    update orders
       set status  = case when status = 'quoted' then 'paid' else status end,
           tx_hash = coalesce(tx_hash, ${txHash})
     where network = ${net} and memo = ${memo}
       and (status = 'quoted' or tx_hash is null)`;
}

/**
 * The shopper has their groceries, and the order stops being open.
 *
 * This is the only status the browser's word decides, and it is deliberately
 * the harmless one: `done` moves no money, issues nothing and reveals nothing.
 * It is a shopper saying "that one is finished" so the purchases list can stop
 * listing it as in flight. `markPaid` above is the opposite kind of fact — it
 * is written from a payment read off the ledger, never from a request.
 *
 * Monotonic in the same shape and for a sharper reason. An order only closes
 * from `paid` or `carded`, so a `done` cannot arrive before the money did and
 * cannot resurrect a `failed` one. A second press writes nothing at all, which
 * is what keeps `orders_touch` from moving `updated_at` on a row where
 * nothing happened.
 *
 * There is no `markOrder(status)` any more. It had no caller and it was the
 * exact footgun this pair of functions exists to avoid: a caller that can set
 * any status can set `paid`, and `paid` is a claim about a ledger.
 *
 * Returns whether a row actually closed — for the log line, not for the
 * shopper. The route answers the same either way, because a memo that closes
 * nothing is indistinguishable from one that does not exist and the caller has
 * no business learning which.
 */
export async function markDone(net: NetworkId, memo: string): Promise<boolean> {
  const rows = await db()`
    update orders set status = 'done'
     where network = ${net} and memo = ${memo}
       and status in ('paid', 'carded')
     returning memo`;
  return rows.length > 0;
}

/** A customer's orders, newest first, for the purchases list. */
export async function ordersOf(net: NetworkId, address: string, limit = 50): Promise<OrderRow[]> {
  const rows = await db()`
    select * from orders
     where network = ${net} and address = ${address}
     order by created_at desc
     limit ${limit}`;
  return rows.map(toOrder);
}

/* ---- chat ---------------------------------------------------------------- */

/**
 * Save a conversation.
 *
 * `transcript` is `encodeTurn()`'s output and nothing else. Do not build that
 * object here or anywhere else: `RenderCache.products` is a `Map`, and
 * `JSON.stringify` renders a Map as `{}` with no error at all, so a hand-rolled
 * shape loses every product silently and only shows it on rehydration. The
 * `v: 1` codec in lib/agent/turn-store.ts exists for exactly that, and the same
 * encoded object is what the `kv` table holds for the working turn.
 *
 * Called only after a clean return, which is the rule turn-store.ts already
 * keeps: a turn that threw mid-hop can leave an assistant `tool_use` with no
 * matching `tool_result`, and the API rejects that pairing on the *next*
 * request — so persisting it would surface the failure one turn later, on a
 * turn that did nothing wrong.
 */
export async function saveChat(c: {
  id: string;
  network: NetworkId;
  address: string;
  title?: string | null;
  transcript: unknown;
}): Promise<void> {
  await db()`
    insert into chat (id, network, address, title, transcript)
    values (${c.id}, ${c.network}, ${c.address}, ${c.title ?? null},
            ${db().json(c.transcript as never)})
    on conflict (id) do update
       set transcript = excluded.transcript,
           title      = coalesce(chat.title, excluded.title)`;
}

/**
 * Read a conversation back — **only for the wallet that owns it**.
 *
 * The address is part of the WHERE rather than something the caller checks
 * afterwards. A chat id is a UUID, not a capability: guessing one should get
 * you nothing, and the way to guarantee that is for the query to be incapable
 * of returning somebody else's row.
 */
export async function loadChat(
  id: string,
  address: string,
): Promise<{ transcript: unknown; network: NetworkId } | undefined> {
  const rows = await db()`
    select transcript, network from chat where id = ${id} and address = ${address}`;
  if (!rows[0]) return undefined;
  return { transcript: rows[0].transcript, network: rows[0].network as NetworkId };
}

/** A customer's conversations, newest first, for the orders list to join on. */
export async function chatsOf(
  net: NetworkId,
  address: string,
  limit = 50,
): Promise<{ id: string; title: string | null; updatedAt: Date }[]> {
  const rows = await db()`
    select id, title, updated_at from chat
     where network = ${net} and address = ${address}
     order by updated_at desc
     limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    updatedAt: r.updated_at as Date,
  }));
}
