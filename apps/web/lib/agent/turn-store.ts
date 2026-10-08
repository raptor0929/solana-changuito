import type Anthropic from '@anthropic-ai/sdk';
import type { Cart, Product } from '@changuito/mcp/types';

import { hasDatabase } from '../db.ts';
import { kvGet, kvSet } from '../kv.ts';

// Type-only, deliberately: a store that imported the agent loop would drag the
// Anthropic client and the whole MCP bridge in behind it, for a file that only
// ever moves plain data.
import type { Turn } from './loop';

/**
 * Where a conversation lives between two requests.
 *
 * `lib/mcp/session.ts` states the hard part already: a lambda's module scope is
 * a cache, not a database. MCP state got an answer for that — the browser holds
 * the snapshot and sends it back. Message history never did, and it showed: a
 * cold start mid-basket left the agent replying with no idea what had been
 * asked, while the UI still displayed every bubble. The user sees continuity
 * the server does not have, which is the worst shape a bug can take.
 *
 * History cannot ride along in the snapshot the way a postal code can. The
 * snapshot is public — a cart id is already handed over as a URL — whereas the
 * transcript is the conversation itself, and it grows every hop. So it goes to
 * the database instead, keyed by session: the `kv` table (lib/kv.ts), where
 * Redis used to be.
 *
 * With no DATABASE_URL — a fresh clone, `npm run dev`, nobody's account — this
 * falls back to the in-process Map it replaces. One developer on one machine
 * has exactly one instance, so the Map is not a compromise there; it is the
 * same guarantee for free.
 */

/**
 * Long enough to finish a shop after a phone call, short enough that abandoned
 * baskets expire themselves. Nothing here is worth keeping overnight: the cart
 * lives at the retailer, and the escrow lives on-chain.
 */
const TTL_SECONDS = 60 * 60;

const KEY = (sessionId: string) => `changuito:turn:${sessionId}`;

// --------------------------------------------------------------- wire format

/**
 * `RenderCache.products` is a Map, and `JSON.stringify` renders a Map as `{}` —
 * silently, with no error to notice. So the shape that goes over the wire is
 * not the shape held in memory, and the conversion is explicit in both
 * directions rather than implied by a spread.
 */
interface StoredTurn {
  v: 1;
  messages: Anthropic.MessageParam[];
  products: [string, Product][];
  cart?: Cart;
  handoffUrl?: string;
  /**
   * Which cart the link opens, and what the last cart card showed. Both are
   * new, and both are optional rather than a `v: 2` — a version bump resets
   * the history of every conversation in flight at deploy time, which is a
   * worse trade than one turn without a link on a card that already had one.
   * See autoRenderCart in render-tools.ts.
   */
  handoffFor?: string;
  drawn?: string;
}

export function encodeTurn(turn: Turn): StoredTurn {
  return {
    v: 1,
    messages: turn.messages,
    products: [...turn.cache.products],
    cart: turn.cache.cart,
    handoffUrl: turn.cache.handoffUrl,
    handoffFor: turn.cache.handoffFor,
    drawn: turn.cache.drawn,
  };
}

/**
 * Anything unrecognised decodes to undefined rather than throwing. A stored
 * value can outlive the code that wrote it — a deploy mid-conversation is the
 * ordinary case — and starting a fresh turn is a far better answer there than
 * a 500 on a key the next deploy would have expired anyway.
 */
export function decodeTurn(raw: unknown): Turn | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<StoredTurn>;
  if (s.v !== 1 || !Array.isArray(s.messages) || !Array.isArray(s.products)) return undefined;

  return {
    messages: s.messages,
    cache: {
      products: new Map(s.products),
      cart: s.cart,
      handoffUrl: s.handoffUrl,
      handoffFor: s.handoffFor,
      drawn: s.drawn,
    },
  };
}

// ------------------------------------------------------------------- backends

export interface TurnStore {
  /** The conversation so far, or undefined to start one. */
  get(sessionId: string): Promise<Turn | undefined>;
  set(sessionId: string, turn: Turn): Promise<void>;
  /** For the banner in the server log, so it is obvious which one is running. */
  readonly kind: 'postgres' | 'memory';
}

function postgresStore(): TurnStore {
  return {
    kind: 'postgres',

    // A database that is down should cost the user their history, not their
    // turn. Both paths swallow and degrade: `get` starts a fresh conversation,
    // `set` leaves the old value to expire. Either is survivable; a 500 is not.
    async get(sessionId) {
      try {
        return decodeTurn(await kvGet(KEY(sessionId)));
      } catch (e) {
        console.error('[turn-store] read failed, starting fresh:', e);
        return undefined;
      }
    },

    async set(sessionId, turn) {
      try {
        await kvSet(KEY(sessionId), encodeTurn(turn), TTL_SECONDS);
      } catch (e) {
        console.error('[turn-store] write failed, history not saved:', e);
      }
    },
  };
}

/**
 * The single-instance fallback. Bounded, unlike the bare Map it replaces: that
 * one held every session it had ever seen for the life of the process, which a
 * long-running server would eventually notice.
 */
function memoryStore(): TurnStore {
  const turns = new Map<string, { turn: Turn; lastUsed: number }>();
  const MAX = 64;

  return {
    kind: 'memory',

    async get(sessionId) {
      const hit = turns.get(sessionId);
      if (!hit) return undefined;
      if (Date.now() - hit.lastUsed > TTL_SECONDS * 1000) {
        turns.delete(sessionId);
        return undefined;
      }
      hit.lastUsed = Date.now();
      return hit.turn;
    },

    async set(sessionId, turn) {
      turns.set(sessionId, { turn, lastUsed: Date.now() });
      while (turns.size > MAX) {
        const oldest = [...turns.entries()].reduce((a, b) => (a[1].lastUsed <= b[1].lastUsed ? a : b));
        turns.delete(oldest[0]);
      }
    },
  };
}

let store: TurnStore | undefined;

export function turnStore(): TurnStore {
  if (!store) {
    store = hasDatabase() ? postgresStore() : memoryStore();
    console.log(
      store.kind === 'postgres'
        ? '[turn-store] Postgres — history survives cold starts.'
        : '[turn-store] in-memory — history is lost when this process restarts. Set DATABASE_URL to persist it.',
    );
  }
  return store;
}
