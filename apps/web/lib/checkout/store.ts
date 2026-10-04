import { Redis } from '@upstash/redis';

/**
 * A checkout between the quote and the settle: what the shopper was quoted,
 * which sandbox job is buying it, and how it ended.
 *
 * Same shape as lib/agent/turn-store.ts: Redis when the Upstash pair is set,
 * an in-process Map when not, so a fresh clone runs. The Map lives on
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

function credentials(): { url: string; token: string } | undefined {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : undefined;
}

function redisStore(url: string, token: string): Store {
  const redis = new Redis({ url, token });
  return {
    async get(orderId) {
      return ((await redis.get(KEY(orderId))) as CheckoutRecord | null) ?? undefined;
    },
    async set(rec) {
      await redis.set(KEY(rec.orderId), rec, { ex: TTL_SECONDS });
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
  if (!store) {
    const creds = credentials();
    store = creds ? redisStore(creds.url, creds.token) : memoryStore();
  }
  return store;
}
