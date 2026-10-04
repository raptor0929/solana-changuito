import { newTurnState, runTurn } from '@/lib/agent/loop';
import { isChatImage } from '@/lib/chat-image';
import { turnStore } from '@/lib/agent/turn-store';
import { archiveChat, chatTitle } from '@/lib/chat-archive';
import { asNetwork, DEFAULT_NETWORK } from '@/lib/deployments';
import { langFrom } from '@/lib/lang';
import { withSession } from '@/lib/mcp/session';
import { encodeEvent, HEARTBEAT, SSE_HEADERS, type ChatRequest, type UiEvent } from '@/lib/protocol';
import { requireHuman } from '@/lib/human-gate';
import { readLoggedInUser, requireLoginOrFreeTurn } from '@/lib/login-gate';

/**
 * Node, not edge: the MCP server reads `node:url` and @solana/kit needs
 * real crypto. Edge would fail at import, not at request time, which is a
 * confusing way to find out.
 */
export const runtime = 'nodejs';
export const maxDuration = 300;

/** Conversation history, alongside the MCP session it belongs to. */
const turns = turnStore();

const HEARTBEAT_MS = 15_000;

const MAX_MESSAGE_CHARS = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const gated = await requireHuman(req);
  if (gated) return gated;

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  if (!body.sessionId || typeof body.message !== 'string' || !body.message.trim()) {
    return Response.json({ error: 'sessionId and a non-empty message are required.' }, { status: 400 });
  }
  // The browser mints a UUID. Anything else is a caller choosing keys for
  // the turn store and the counters.
  if (typeof body.sessionId !== 'string' || !UUID.test(body.sessionId)) {
    return Response.json({ error: 'sessionId must be a UUID.' }, { status: 400 });
  }
  // A grocery list is short. Megabytes of text would ride every hop of the
  // turn, twelve times, on someone's model bill.
  if (body.message.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { error: 'message_too_long', message: `El mensaje es muy largo. Probá con menos de ${MAX_MESSAGE_CHARS} caracteres.` },
      { status: 413 },
    );
  }
  // Absent is the ordinary turn. Present has to be a photo we can hand the
  // model. Checked before the guest counter, so a bad payload does not spend a turn.
  if (body.image !== undefined && !isChatImage(body.image)) {
    return Response.json(
      { error: 'invalid_image', message: 'No pude usar esa imagen. Probá con otra foto.' },
      { status: 400 },
    );
  }

  // Guests: at most FREE_TURNS chat POSTs per sessionId (server-side). Logged-in
  // users (chg_user cookie from /api/session/login after Privy login) skip the limit.
  const loginGate = await requireLoginOrFreeTurn(req, body.sessionId);
  if (loginGate) return loginGate;

  // Read again rather than have the gate hand it back: the gate's answer is
  // "may this request run", and widening it to "and who is it" would make a
  // quota decision the place identity is established. Verifying the cookie is
  // an HMAC and no I/O, so the second read costs nothing worth saving.
  // A guest is `null` here, and `archiveChat` writes nothing for a guest.
  const user = await readLoggedInUser(req);
  const owner = user.ok ? user.address : null;
  const network = asNetwork(body.network) ?? DEFAULT_NETWORK;
  // Which language the agent answers in, and nothing else. This route's own
  // refusals stay Spanish: they are shared with the MCP server and with the
  // agent, neither of which reads a cookie from this browser, so the client
  // prefers its own copy over whatever lands here. `langFrom` puts anything
  // unrecognised on the default rather than trusting the body.
  const lang = langFrom(body.lang);

  // One key, checked here so a misconfigured deployment says so up front
  // rather than opening a stream and dying on the first hop.
  //
  // This used to accept either a key or a local model, and the shape of that
  // check is why chat broke: a deployment could satisfy it with AGENT_PROVIDER
  // and OLLAMA_URL, and when the URL was removed while the provider name
  // stayed, the route still opened a stream that the loop then refused to run.
  // A single condition cannot disagree with itself that way.
  // OpenAI is the model this deployment searches with. Anthropic remains a
  // fallback for a clone that still has that key and not the other. Either
  // one is enough; requiring both is how a working key gets told it is missing.
  if (!process.env.OPENAI_API_KEY?.trim() && !process.env.ANTHROPIC_API_KEY?.trim()) {
    return Response.json(
      { error: 'Falta OPENAI_API_KEY. Cargala en el proyecto y volvé a publicar.' },
      { status: 500 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true; // the browser went away mid-turn
        }
      };
      const emit = (e: UiEvent): void => write(encodeEvent(e));

      // A single search against a slow storefront can go 20s without a byte,
      // and an idle stream is a stream a proxy feels free to close.
      const beat = setInterval(() => write(HEARTBEAT), HEARTBEAT_MS);

      // First byte of the body, before the MCP boot and the model. The
      // browser now knows the message landed, and so does anything between
      // us and it that waits for a byte before committing to the response.
      emit({ t: 'status', stage: 'received' });

      // Hoisted out of the callback so the `done` event can carry it.
      let brain: string | undefined;

      try {
        const { snapshot } = await withSession(body.sessionId, body.snapshot, async (session) => {
          // Read, run, write — all inside the callback, so `withSession`'s
          // per-session queue covers the whole read-modify-write and two tabs
          // on one id cannot each save a history missing the other's messages.
          const turn = (await turns.get(body.sessionId)) ?? newTurnState();
          brain = (await runTurn(session, turn, body.message, emit, lang, body.image)).brain;

          // Only after a clean return. A turn that threw mid-hop can leave an
          // assistant `tool_use` with no matching `tool_result`, and the API
          // rejects that pairing on the *next* request — so the failure would
          // surface one message later, on a turn that did nothing wrong.
          // Keeping the previous history leaves every stored value valid, at
          // the cost of one message the user is about to retry anyway.
          await turns.set(body.sessionId, turn);

          // The durable copy, for a signed-in shopper only. Inside the same
          // callback as the Redis write so `withSession`'s per-session queue
          // covers both, and awaited so a lambda frozen at the response does
          // not drop it — it cannot throw, and it is one round-trip per turn
          // rather than one per hop.
          await archiveChat({
            id: body.sessionId,
            network,
            address: owner,
            turn,
            // Every turn offers a title and `saveChat` coalesces, so the
            // first one to land wins and the rest are no-ops. Sending it only
            // on the opening turn would read as tighter and be worse: a chat
            // that started as a guest and signed in mid-basket has no opening
            // turn to archive, and would sit in the list with no name on it.
            title: chatTitle(body.message),
          });
        });

        // The browser keeps this and sends it back, because this instance
        // might not be here next time.
        emit({ t: 'done', stopReason: 'end_turn', snapshot, brain });
      } catch (e) {
        emit({
          t: 'error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: true,
        });
      } finally {
        clearInterval(beat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
