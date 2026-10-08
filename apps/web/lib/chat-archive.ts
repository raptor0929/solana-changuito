/**
 * The conversation, kept after the hour is up.
 *
 * Three stores hold a chat now, and they are not redundant — they answer
 * different questions, and the split is deliberate:
 *
 * - **The `kv` table** (`agent/turn-store.ts`) is the *working* store. The
 *   hop loop reads and writes it up to twelve times a turn, and it holds the
 *   Anthropic message list the model needs to keep going. One hour expiry,
 *   because an abandoned basket is not worth keeping overnight. It was Redis
 *   until the two stores were folded into one database.
 * - **localStorage** (`chat-store.ts`) is what the shopper *sees*: the history
 *   rail, the blocks, the receipt. It is also what decides a chat is no longer
 *   resumable, since it knows the hour has passed.
 * - **Postgres** — this file — is the *record*. It outlives the TTL, survives a
 *   cleared browser, and is what the purchases list joins an order back to.
 *
 * The working store and the record stay separate on purpose, same database or
 * not: `kv` rows expire and `chat` rows do not, and the archive writes once,
 * in the same place `turn-store.ts` writes: **only after a clean return.** That
 * rule matters more here than there. A turn that threw mid-hop can leave an
 * assistant `tool_use` with no matching `tool_result`, and a transcript
 * archived in that state is a permanent copy of a pairing the API rejects.
 *
 * ## Guests are not archived
 *
 * No `chg_user`, no row. `chat.address` is `not null` in the schema and that is
 * the enforcement, not an oversight — a transcript is a list of what somebody
 * bought and usually carries their postal code, so moving it from an hour in
 * an expiring row to a durable one is a real change in exposure. It happens only for
 * someone who proved a wallet. Reading it back is narrowed the same way, in
 * SQL rather than in a caller: see `loadChat` in db.ts.
 *
 * ## Nothing here can fail a turn
 *
 * Every path returns an outcome instead of throwing. The shopper's answer is
 * already on their screen by the time this runs; losing the archive copy costs
 * a row in a history list, and a 500 after a complete reply would cost the
 * reply.
 */
import { encodeTurn } from './agent/turn-store.ts';
import { hasDatabase, saveChat } from './db.ts';
import type { NetworkId } from './deployments.ts';

import type { Turn } from './agent/loop.ts';

/** How much of the first message becomes the line in a list. */
const TITLE_MAX = 120;

/**
 * The shopper's own words, trimmed to a list row.
 *
 * Newlines collapse because a title is one line wherever it is shown, and a
 * pasted grocery list is the ordinary first message here. Truncation is by
 * character rather than by word: a cut mid-word reads as a cut, and a cut at a
 * word boundary reads as the whole message.
 */
export function chatTitle(message: string, max = TITLE_MAX): string | null {
  const flat = message.replace(/\s+/gu, ' ').trim();
  if (!flat) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export interface ArchiveInput {
  /** The session id the browser minted; the chat's primary key. */
  id: string;
  network: NetworkId;
  /** The wallet behind `chg_user`, or null for a guest. */
  address: string | null;
  turn: Turn;
  /** The first message of the conversation, or null on every later turn. */
  title: string | null;
}

/**
 * Why nothing was written, when nothing was. Returned rather than logged so a
 * caller can count them; `guest`, `preview` and `no-database` are ordinary,
 * `failed` is the one worth watching.
 */
export type ArchiveOutcome = 'saved' | 'guest' | 'preview' | 'no-database' | 'failed';

export interface ArchiveDeps {
  hasDatabase: () => boolean;
  saveChat: typeof saveChat;
}

const REAL: ArchiveDeps = { hasDatabase, saveChat };

export async function archiveChat(i: ArchiveInput, deps: ArchiveDeps = REAL): Promise<ArchiveOutcome> {
  if (!i.address) return 'guest';
  if (!deps.hasDatabase()) return 'no-database';
  try {
    await deps.saveChat({
      id: i.id,
      network: i.network,
      address: i.address,
      title: i.title,
      // The same `v: 1` codec the working turn gets, and for the same reason: `RenderCache
      // .products` is a Map, and `JSON.stringify` renders a Map as `{}` with no
      // error to notice. jsonb would store that silently too.
      transcript: encodeTurn(i.turn),
    });
    return 'saved';
  } catch (e) {
    console.error('[chat-archive] could not save the transcript:', e instanceof Error ? e.message : String(e));
    return 'failed';
  }
}
