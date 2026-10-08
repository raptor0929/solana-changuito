import type { Cart, CartLine, LocationContext, Money, Product, Seller } from '@changuito/mcp/types';
import type { SessionSnapshot } from '@changuito/mcp/session';

import type { Block, ChatState, ToolRun } from './chat-state.ts';

/**
 * Chats in localStorage.
 *
 * Two keys: an index of every chat, and one record per chat. The index is
 * what the history rail reads, so opening the app costs one small parse
 * rather than one per chat.
 *
 * Everything here follows NetworkProvider.tsx, which is the only other place
 * in the app that touches storage: every access is wrapped, because Safari in
 * private mode throws on `localStorage` rather than returning null, and
 * everything that comes back is re-validated, because stored JSON is written
 * by the user's own browser and can be edited by hand.
 *
 * ## What is never written
 *
 * No password, no PAN, no CVV, no CVC, no Stellar secret, no bearer token.
 * That is not enforced by remembering it — it is enforced by `packBlock` and
 * its neighbours building every record **field by field from a fixed list**.
 * There is no `JSON.stringify(state)` anywhere in this file, so a field added
 * to `Block` or to `Cart` upstream is not written here until someone comes and
 * writes the line that writes it. A guardrail that needs to be remembered is
 * not a guardrail.
 *
 * The test "drops fields the serializer does not name" states the same rule
 * from the other side: it hangs a password, a PAN and a CVV off blocks that
 * are then saved, and fails if any of them reaches storage.
 *
 * ## Why a chat stops being resumable
 *
 * CLAUDE.md §4: agent history lives in the `kv` table with a **one hour expiry**, and
 * reload is a fresh start by design because persisting the session id without
 * the transcript gives "an empty page backed by a server that remembers".
 * Restoring both halves fixes that only while the server still has its half.
 * After an hour the id is live but the server has forgotten it, so the chat
 * comes back **read-only** instead of pretending it can continue. A paid chat
 * is read-only for the same reason from the other direction: one chat is one
 * order, and its order is over.
 */

const INDEX_KEY = 'changuito:chats';
const CHAT_PREFIX = 'changuito:chat:';

/** Matches TTL_SECONDS in lib/agent/turn-store.ts. Past it, the server has forgotten. */
export const RESUMABLE_MS = 60 * 60 * 1000;

/** Newest first, and this many. A rail is a list, not an archive. */
export const MAX_CHATS = 20;

export type OrderState = 'none' | 'open' | 'paid';

export interface ChatSummary {
  id: string;
  /** The shopper's first message, trimmed. Never empty — falls back to a date. */
  title: string;
  createdAt: number;
  updatedAt: number;
  orderState: OrderState;
}

/** What the app knows about an order once it has been paid for. */
export interface Receipt {
  orderId: string;
  retailer: string;
  /** What the shopper handed over, in the units the deposit was quoted in. */
  paidDisplay: string;
  paidAt: number;
  lines: { name: string; quantity: number; lineTotal: string }[];
  total: string;
  /**
   * The order's id at the store, when it gave us one — see `storeOrderUrl`.
   * Optional, so `VERSION` stays where it is and a receipt written before this
   * existed still loads; those simply link to the orders list instead.
   */
  orderRef?: string;
}

export interface StoredChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  orderState: OrderState;
  /** The agent's session id. Live only while `resumable` says so. */
  sessionId: string | null;
  blocks: Block[];
  snapshot: SessionSnapshot | null;
  cart: Cart | null;
  handoffUrl: string | null;
  receipt: Receipt | null;
}

/** Bumped when a stored shape changes. A record at another version is dropped, not migrated. */
const VERSION = 1;

/* -------------------------------------------------------------- serializing */

function packMoney(m: Money): Money {
  return { centavos: m.centavos, display: m.display };
}

function packLine(l: CartLine): CartLine {
  return {
    index: l.index,
    skuId: l.skuId,
    name: l.name,
    quantity: l.quantity,
    sellerId: l.sellerId,
    unitPrice: packMoney(l.unitPrice),
    lineTotal: packMoney(l.lineTotal),
    available: l.available,
  };
}

function packCart(c: Cart): Cart {
  return {
    retailer: c.retailer,
    cartId: c.cartId,
    lines: c.lines.map(packLine),
    total: packMoney(c.total),
    messages: [...c.messages],
  };
}

/**
 * Products keep only what the grid draws. `url`, `categories` and the rest are
 * dropped: a restored transcript is a record of what was shown, and the fields
 * nothing renders are the ones most likely to grow something we would not want
 * on disk.
 */
function packProduct(p: Product): Product {
  const out: Product = {
    skuId: p.skuId,
    productId: p.productId,
    name: p.name,
    sellerId: p.sellerId,
    price: packMoney(p.price),
    available: p.available,
  };
  if (p.brand !== undefined) out.brand = p.brand;
  if (p.listPrice !== undefined) out.listPrice = packMoney(p.listPrice);
  if (p.imageUrl !== undefined) out.imageUrl = p.imageUrl;
  return out;
}

function packTool(t: ToolRun): ToolRun {
  const out: ToolRun = { id: t.id, name: t.name };
  if (t.ms !== undefined) out.ms = t.ms;
  if (t.ok !== undefined) out.ok = t.ok;
  return out;
}

/**
 * One arm per block kind, each naming its own fields. The `never` default is
 * the point: adding a kind to `Block` upstream stops this file compiling
 * rather than silently writing a shape nobody checked.
 */
function packBlock(b: Block): Block | null {
  switch (b.kind) {
    case 'user':
      // `failed` is deliberately dropped. A restored transcript is a record,
      // and the retry control it drives cannot work against a session the
      // server has forgotten.
      // The photo is dropped too. It is hundreds of kilobytes, and this store
      // is the shopper's words, not a camera roll. The live bubble still shows
      // it; the model keeps it for the hour the turn store holds the chat.
      return { kind: 'user', id: b.id, text: b.text };
    case 'say':
      // `thinking` is not kept: it is transient by design (CLAUDE.md §6) and
      // it is the longest string in the block.
      return { kind: 'say', id: b.id, text: b.text, thinking: '', tools: b.tools.map(packTool) };
    case 'products':
      return b.note === undefined
        ? { kind: 'products', id: b.id, items: b.items.map(packProduct) }
        : { kind: 'products', id: b.id, items: b.items.map(packProduct), note: b.note };
    case 'cart':
      return b.handoffUrl === undefined
        ? { kind: 'cart', id: b.id, cart: packCart(b.cart) }
        : { kind: 'cart', id: b.id, cart: packCart(b.cart), handoffUrl: b.handoffUrl };
    case 'error':
      return { kind: 'error', id: b.id, message: b.message, recoverable: b.recoverable };
    default: {
      const never: never = b;
      void never;
      return null;
    }
  }
}

/**
 * The snapshot is handed back to the agent verbatim on the next turn, so
 * unlike everything else here it is packed in full rather than trimmed:
 * `sellers`, `salesChannel` and `degraded` are what make prices match what
 * the shopper will actually pay, and a restored snapshot missing them would
 * be a lie the agent then acts on. Still field by field — it is a location
 * and a map of cart ids, and nothing else belongs in it.
 */
function packSnapshot(s: SessionSnapshot): SessionSnapshot {
  const out: SessionSnapshot = { carts: { ...s.carts } };
  const l = s.location;
  if (l) {
    out.location = {
      retailer: l.retailer,
      country: l.country,
      postalCode: l.postalCode,
      sellers: l.sellers.map((seller) => ({ id: seller.id, name: seller.name })),
      salesChannel: l.salesChannel,
      degraded: l.degraded,
      ...(l.regionId === undefined ? {} : { regionId: l.regionId }),
      ...(l.note === undefined ? {} : { note: l.note }),
    };
  }
  return out;
}

function packReceipt(r: Receipt): Receipt {
  return {
    orderId: r.orderId,
    retailer: r.retailer,
    paidDisplay: r.paidDisplay,
    paidAt: r.paidAt,
    lines: r.lines.map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal })),
    total: r.total,
    ...(r.orderRef === undefined ? {} : { orderRef: r.orderRef }),
  };
}

/* ------------------------------------------------------------ deserializing */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function asOrderState(v: unknown): OrderState {
  return v === 'open' || v === 'paid' ? v : 'none';
}

function asMoney(v: unknown): Money | null {
  if (!isObj(v)) return null;
  const centavos = num(v.centavos);
  const display = str(v.display);
  return centavos === null || display === null ? null : { centavos, display };
}

function asLine(v: unknown): CartLine | null {
  if (!isObj(v)) return null;
  const unitPrice = asMoney(v.unitPrice);
  const lineTotal = asMoney(v.lineTotal);
  const skuId = str(v.skuId);
  const name = str(v.name);
  const sellerId = str(v.sellerId);
  const index = num(v.index);
  const quantity = num(v.quantity);
  if (!unitPrice || !lineTotal || skuId === null || name === null || sellerId === null) return null;
  if (index === null || quantity === null) return null;
  return { index, skuId, name, quantity, sellerId, unitPrice, lineTotal, available: v.available === true };
}

function asCart(v: unknown): Cart | null {
  if (!isObj(v)) return null;
  const retailer = str(v.retailer);
  const cartId = str(v.cartId);
  const total = asMoney(v.total);
  if (retailer === null || cartId === null || !total) return null;
  return {
    retailer,
    cartId,
    total,
    lines: arr(v.lines).map(asLine).filter((l): l is CartLine => l !== null),
    messages: arr(v.messages).filter((m): m is string => typeof m === 'string'),
  };
}

function asProduct(v: unknown): Product | null {
  if (!isObj(v)) return null;
  const skuId = str(v.skuId);
  const productId = str(v.productId);
  const name = str(v.name);
  const sellerId = str(v.sellerId);
  const price = asMoney(v.price);
  if (skuId === null || productId === null || name === null || sellerId === null || !price) return null;
  const out: Product = { skuId, productId, name, sellerId, price, available: v.available === true };
  const brand = str(v.brand);
  if (brand !== null) out.brand = brand;
  const listPrice = asMoney(v.listPrice);
  if (listPrice) out.listPrice = listPrice;
  const imageUrl = str(v.imageUrl);
  if (imageUrl !== null) out.imageUrl = imageUrl;
  return out;
}

function asTool(v: unknown): ToolRun | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const name = str(v.name);
  if (id === null || name === null) return null;
  const out: ToolRun = { id, name };
  const ms = num(v.ms);
  if (ms !== null) out.ms = ms;
  if (typeof v.ok === 'boolean') out.ok = v.ok;
  return out;
}

/** Anything that does not parse is dropped, not repaired. A half-block is worse than a gap. */
function asBlock(v: unknown): Block | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  if (id === null) return null;
  switch (v.kind) {
    case 'user': {
      const text = str(v.text);
      return text === null ? null : { kind: 'user', id, text };
    }
    case 'say': {
      const text = str(v.text);
      if (text === null) return null;
      return {
        kind: 'say',
        id,
        text,
        thinking: str(v.thinking) ?? '',
        tools: arr(v.tools).map(asTool).filter((t): t is ToolRun => t !== null),
      };
    }
    case 'products': {
      const items = arr(v.items).map(asProduct).filter((p): p is Product => p !== null);
      if (items.length === 0) return null;
      const note = str(v.note);
      return note === null ? { kind: 'products', id, items } : { kind: 'products', id, items, note };
    }
    case 'cart': {
      const cart = asCart(v.cart);
      if (!cart) return null;
      const handoffUrl = str(v.handoffUrl);
      return handoffUrl === null ? { kind: 'cart', id, cart } : { kind: 'cart', id, cart, handoffUrl };
    }
    case 'error': {
      const message = str(v.message);
      return message === null ? null : { kind: 'error', id, message, recoverable: v.recoverable === true };
    }
    default:
      return null;
  }
}

function asSnapshot(v: unknown): SessionSnapshot | null {
  if (!isObj(v)) return null;
  const carts: Record<string, string> = {};
  if (isObj(v.carts)) {
    for (const [k, id] of Object.entries(v.carts)) if (typeof id === 'string') carts[k] = id;
  }
  const out: SessionSnapshot = { carts };
  const loc = v.location;
  if (isObj(loc)) {
    const retailer = str(loc.retailer);
    const country = str(loc.country);
    const postalCode = str(loc.postalCode);
    const salesChannel = str(loc.salesChannel);
    // All four or none. A half-restored location sends the agent shopping in
    // the wrong sales channel, which shows wrong prices rather than failing.
    if (retailer !== null && country !== null && postalCode !== null && salesChannel !== null) {
      const location: LocationContext = {
        retailer,
        country,
        postalCode,
        salesChannel,
        degraded: loc.degraded === true,
        sellers: arr(loc.sellers)
          .map((seller) => {
            if (!isObj(seller)) return null;
            const id = str(seller.id);
            const name = str(seller.name);
            return id === null || name === null ? null : { id, name };
          })
          .filter((seller): seller is Seller => seller !== null),
      };
      const regionId = str(loc.regionId);
      if (regionId !== null) location.regionId = regionId;
      const note = str(loc.note);
      if (note !== null) location.note = note;
      out.location = location;
    }
  }
  return out;
}

function asReceipt(v: unknown): Receipt | null {
  if (!isObj(v)) return null;
  const orderId = str(v.orderId);
  const retailer = str(v.retailer);
  const paidDisplay = str(v.paidDisplay);
  const total = str(v.total);
  const paidAt = num(v.paidAt);
  if (orderId === null || retailer === null || paidDisplay === null || total === null || paidAt === null) {
    return null;
  }
  const lines = arr(v.lines)
    .map((l) => {
      if (!isObj(l)) return null;
      const name = str(l.name);
      const quantity = num(l.quantity);
      const lineTotal = str(l.lineTotal);
      return name === null || quantity === null || lineTotal === null ? null : { name, quantity, lineTotal };
    })
    .filter((l): l is Receipt['lines'][number] => l !== null);
  const orderRef = str(v.orderRef);
  return { orderId, retailer, paidDisplay, paidAt, lines, total, ...(orderRef === null ? {} : { orderRef }) };
}

/* --------------------------------------------------------------- the store */

/**
 * Every read and write goes through these two. `localStorage` is reached for
 * lazily rather than captured, because this module is imported by a server
 * component's tree and there is no `window` when that import runs.
 */
function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    // Absent, unparseable, or a browser that refuses. All three mean the same
    // thing to every caller: there is nothing here.
    return null;
  }
}

/** True if it was written. False is survivable everywhere it is called. */
function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota, or private mode. Either way the chat in memory is still correct;
    // only the record of it is lost, and there is nothing useful to say to a
    // shopper about it mid-basket.
    return false;
  }
}

function drop(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do. The record expires with the browser profile.
  }
}

const chatKey = (id: string) => `${CHAT_PREFIX}${id}`;

function asSummary(v: unknown): ChatSummary | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const createdAt = num(v.createdAt);
  if (id === null || createdAt === null) return null;
  const title = str(v.title);
  return {
    id,
    title: title === null || title.trim() === '' ? dateTitle(createdAt) : title,
    createdAt,
    updatedAt: num(v.updatedAt) ?? createdAt,
    orderState: asOrderState(v.orderState),
  };
}

/** The fallback title. A chat opened and abandoned before the first message still needs a name. */
export function dateTitle(at: number): string {
  return new Date(at).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
}

/** The shopper's first message, short enough for a 236px rail. */
export function titleFrom(blocks: Block[], createdAt: number): string {
  for (const b of blocks) {
    if (b.kind !== 'user') continue;
    const text = b.text.trim().replace(/\s+/g, ' ');
    if (text === '') continue;
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
  return dateTitle(createdAt);
}

export function listChats(): ChatSummary[] {
  return arr(read(INDEX_KEY))
    .map(asSummary)
    .filter((c): c is ChatSummary => c !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS);
}

export function loadChat(id: string): StoredChat | null {
  const v = read(chatKey(id));
  if (!isObj(v) || v.v !== VERSION) return null;
  const storedId = str(v.id);
  const createdAt = num(v.createdAt);
  if (storedId === null || storedId !== id || createdAt === null) return null;
  const blocks = arr(v.blocks)
    .map(asBlock)
    .filter((b): b is Block => b !== null);
  return {
    id,
    createdAt,
    updatedAt: num(v.updatedAt) ?? createdAt,
    title: str(v.title) ?? titleFrom(blocks, createdAt),
    orderState: asOrderState(v.orderState),
    sessionId: str(v.sessionId),
    blocks,
    snapshot: asSnapshot(v.snapshot),
    cart: asCart(v.cart),
    handoffUrl: str(v.handoffUrl),
    receipt: asReceipt(v.receipt),
  };
}

export interface SaveInput {
  id: string;
  createdAt: number;
  sessionId: string | null;
  state: Pick<ChatState, 'blocks' | 'snapshot' | 'cart'>;
  orderState: OrderState;
  receipt?: Receipt | null;
  now?: number;
}

/**
 * Write the chat and its index entry. Returns the summary that was written.
 *
 * A chat with no blocks is not written at all: opening the app mints an id
 * before anyone has said anything, and an empty chat in the rail is a row
 * that does nothing.
 */
export function saveChat(input: SaveInput): ChatSummary | null {
  const { id, createdAt, sessionId, state, orderState } = input;
  const now = input.now ?? Date.now();
  const blocks = state.blocks.map(packBlock).filter((b): b is Block => b !== null);
  if (blocks.length === 0) return null;

  const title = titleFrom(blocks, createdAt);
  const record = {
    v: VERSION,
    id,
    title,
    createdAt,
    updatedAt: now,
    orderState,
    sessionId,
    blocks,
    snapshot: state.snapshot ? packSnapshot(state.snapshot) : null,
    cart: state.cart ? packCart(state.cart.cart) : null,
    handoffUrl: state.cart?.handoffUrl ?? null,
    receipt: input.receipt ? packReceipt(input.receipt) : null,
  };
  if (!write(chatKey(id), record)) return null;

  const summary: ChatSummary = { id, title, createdAt, updatedAt: now, orderState };
  const rest = listChats().filter((c) => c.id !== id);
  const next = [summary, ...rest].slice(0, MAX_CHATS);
  // Whatever fell off the end goes with it, or its record outlives every way
  // of reaching it and sits in the quota forever.
  for (const gone of rest.slice(MAX_CHATS - 1)) drop(chatKey(gone.id));
  write(INDEX_KEY, next);
  return summary;
}

export function deleteChat(id: string): void {
  drop(chatKey(id));
  write(INDEX_KEY, listChats().filter((c) => c.id !== id));
}

/**
 * May this chat carry on, or does it open as a receipt?
 *
 * Both halves have to hold. A paid chat is finished — one chat is one order.
 * A chat older than the server's history TTL has a session id the server no
 * longer knows, and resuming into that is the exact failure CLAUDE.md §4
 * describes: the page shows a conversation the agent has no memory of.
 */
export function isResumable(chat: Pick<StoredChat, 'orderState' | 'updatedAt' | 'sessionId'>, now = Date.now()): boolean {
  if (chat.orderState === 'paid') return false;
  if (chat.sessionId === null) return false;
  return now - chat.updatedAt < RESUMABLE_MS;
}

/** Exported for tests and for a "borrar todo" control. Leaves `changuito:modo` alone. */
export function clearAllChats(): void {
  for (const c of listChats()) drop(chatKey(c.id));
  drop(INDEX_KEY);
}

export const KEYS = { index: INDEX_KEY, prefix: CHAT_PREFIX } as const;
