import { hasDatabase } from '../db.ts';
import { kvGet, kvSet } from '../kv.ts';

/**
 * A checkout between the quote and the settle: what the shopper was quoted,
 * which sandbox job is buying it, and how it ended.
 *
 * Same shape as lib/agent/turn-store.ts: the `kv` table when DATABASE_URL is
 * set, an in-process Map when not, so a fresh clone runs. The Map lives on
 * `globalThis` because Next compiles each route into its own bundle, and
 * /quote, /start and /[orderId] must see the same one.
 *
 * Losing a record is survivable: the escrow holds the money, not this store,
 * and the buyer can refund on chain after the deadline without us.
 */
export interface CheckoutRecord {
  /** Hex of the 32-byte order id. */
  orderId: string;
  buyer: string;
  /** USDC base units the order must lock, as a decimal string. */
  amount: string;
  /** US cents, for display. */
  amountCents: number;
  /** Hex. */
  basketHash: string;
  arsPerUsd: number;
  /** Pesos as the shopper saw them. */
  totalDisplay: string;
  retailer: string;
  lines: { name: string; skuId: string; quantity: number; lineTotal: string }[];
  /** The shopper's own cart link at the store. */
  handoffUrl: string | null;
  createdAt: number;

  jobId?: string;
  /**
   * Base64 of the `open` message the server built for this order, with the
   * resolver as fee payer. The resolver co-signs exactly these bytes and
   * nothing else: its key pays the fee, so it must not sign whatever the
   * browser sends back.
   */
  openMessage?: string;
  openSig?: string;
  /** Last phase the sandbox reported. */
  phase?: string;
  outcome?: 'settled' | 'refunded';
  closeSig?: string;
  /** The sandbox's own cart id at the store: evidence, never shown as a link. */
  storeOrderForm?: string;
  error?: string;
}

const TTL_SECONDS = 60 * 60 * 24;
const KEY = (orderId: string) => `checkout:${orderId}`;

interface Store {
  get(orderId: string): Promise<CheckoutRecord | undefined>;
  set(rec: CheckoutRecord): Promise<void>;
}

function postgresStore(): Store {
  return {
    async get(orderId) {
      return ((await kvGet(KEY(orderId))) as CheckoutRecord | undefined) ?? undefined;
    },
    async set(rec) {
      await kvSet(KEY(rec.orderId), rec, TTL_SECONDS);
    },
  };
}

const g = globalThis as { __chgCheckouts?: Map<string, CheckoutRecord> };

function memoryStore(): Store {
  const map = (g.__chgCheckouts ??= new Map());
  return {
    async get(orderId) {
      return map.get(orderId);
    },
    async set(rec) {
      map.set(rec.orderId, rec);
    },
  };
}

let store: Store | undefined;

export function checkoutStore(): Store {
  if (!store) store = hasDatabase() ? postgresStore() : memoryStore();
  return store;
}
