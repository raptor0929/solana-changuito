# Working on the agent

changuito's agent is the part of this repo with the most decisions per line, and
most of those decisions were made by watching it get something wrong. This file
records what changed and why, so the next person to touch it does not undo a fix
that has no visible scar.

Everything the agent is lives under `apps/web/lib/agent`:

| File | Holds |
|---|---|
| `loop.ts` | the tool loop: hops, what reaches the UI, and where the cache breakpoint goes |
| `prompt.ts` | the system prompt, and the per-turn state banner |
| `render-tools.ts` | the tools that draw, and the cache they draw from |
| `turn-store.ts` | where the conversation lives between requests |
| `providers/types.ts` | the one interface a model has to satisfy |
| `providers/anthropic.ts` | the model, and the two knobs that decide what a turn costs |

`apps/web/CLAUDE.md` is not this file's sibling in spirit — it is a one-line
pointer to `AGENTS.md`, which `next dev` writes and re-adds on every run. Leave
both alone; edits there come back.

---

## The shape it started with, and the five things that changed it

### 1. The model was given tools for drawing, not just for shopping

*`47f9704`, refined since.*

The first loop handed MCP results to the UI directly: a `search_products` call
returned twelve items, so the grid showed twelve items. That is the wrong unit.
A search result is data — it is the same twelve whether the model recommends
three of them or none — and *which ones to surface* is a decision. Decisions
have to be calls, or the UI is guessing.

So `render_products` and `render_cart` exist alongside the MCP tools. They never
reach the MCP server; `runRenderTool` handles them in-process and emits a UI
event.

**The rule that makes this safe: render tools take identifiers only.** Never a
price, never a name. The model picks SKUs, and the server looks those up in
`RenderCache` to fill in what they cost. A model that hallucinates a price
cannot get that price onto the screen, because there is no argument for it to
put it in. That matters most directly above a button that spends money.

If you add a render tool, keep the property. The moment an input carries a
value rather than a reference, the grid can be wrong.

### 2. The cart draws itself, and §1 does not apply to it

*First the bug: two cart cards in one reply, the first without a link. Then the
opposite bug, which the fix for the first one caused.*

`render_cart` used to be called twice on purpose — once when the basket was
built, once after `get_cart_link` so the card carried the link. Both appended,
so the user read a cart, then the same cart again. It looks like the order went
through twice, which is an alarming thing to show someone mid-payment. So the
prompt and the tool description were tightened to *once*, and `chat-state.ts`
learned to dedupe as well, because a prompt is a request and not a guarantee.

Once cost the shopper the other half. Asked to change something, the model
changed it and then pointed at the card already on screen — the old lines, the
old total, "usá el mismo link". Which was **true**: `handoffUrl` is derived from
the cart id (`?orderFormId=…#/cart`) and does not move when lines change. And
useless, because the products and the amount above the pay button were the ones
from before.

**The cart is not the kind of thing §1 is about.** §1 is a set of twelve search
results and three recommendations — *which* to surface is a decision, so it is a
call. There is exactly one cart, the user built it, and its current contents are
not a choice anybody is making. Making the model ask to show them meant the
screen was right only when it remembered to.

So the basket draws itself. `autoRenderCart` in `render-tools.ts` runs from the
loop after **every** tool, and emits a `cart` event when the basket's
fingerprint has changed since the last card. Four parts hold it up:

- **The tools that change the cart now say so.** `add_to_cart` and
  `update_cart_item` returned text only — no `outputSchema`, no
  `structuredContent` — so `RenderCache.cart` went stale on the one call that
  made it stale, and even an explicit `render_cart` would have drawn the old
  lines. They declare `CartOutput` and return the cart they produced. If you add
  a tool that touches the basket, it reports the basket.
- **The fingerprint is the card, not the total.** `cardPrint` covers the cart id,
  the total, the link and every line's index, sku, quantity, line total and
  availability. A swap for another item at the same price changes the card and
  not the total.
- **Nothing is drawn without a link that opens *this* cart.** `handoffFor`
  records which cartId `handoffUrl` belongs to, at `get_cart_link`, the one
  moment the pairing is known. A card whose only actionable control is missing
  is the first bug again; a link carried onto a different basket opens somebody
  else's.
- **`drawn` and `handoffFor` ride in `turn-store.ts` as optional fields**, not a
  `v: 2`. A version bump resets every conversation in flight at deploy time,
  which is a worse trade than one redundant card.

`render_cart` survives for the one job left to it: bringing an *unchanged*
basket back after a question about it. Its description says so, and says never
to answer a change by pointing at a card already on screen. When the description
and the prompt disagree the description wins, so they must not disagree.

`chat-state.ts`'s dedupe is now load-bearing rather than a backstop, because the
automatic render is what mostly draws. Its rule: a `cart` event for a cartId
already shown **in the current turn** replaces that block in place, keeping its
`id` (React keys off it, and a fresh id unmounts and re-animates the card —
which looks exactly like the duplicate it replaced) and never dropping a
`handoffUrl` it already had.

Scoped to the current turn deliberately. A cart shown three messages ago is a
record of what the basket was *then*; merging across turns would rewrite history
the user has already scrolled past. `lib/test/chat-state.test.ts` pins that, and
`lib/test/render-tools.test.ts` pins the automatic render — including the cases
where it must *not* fire.

**Product grids are the other half of the same complaint** and got the opposite
treatment, because §1 does apply to them. The images only ever appeared for the
first search: nothing asked for a `render_products` after a second one, so a
shopper who said "mostrame más" got names in prose and had to ask for the
pictures. The lever there is the prompt and the tool description, since
auto-rendering search results would surface twelve items the model did not
recommend. Both now require a call for **every** search whose results the model
mentions — a later page, another brand, a replacement for something out of
stock.

### 3. The tool trail shows work, not drawing

*Today, same bug.*

`tool_start` / `tool_end` used to fire for every tool. So a failed `render_cart`
— which happens when the model renders before a cart exists, recovers, and
retries half a second later — put a red ✗ **mostrando el carrito** in front of
the user, reporting a failure with no consequence.

Now `loop.ts` traces MCP tools only. The distinction is whether the user is
owed an explanation: an MCP call reaches a supermarket and can take twenty
seconds, so naming it explains the wait and a ✗ explains a gap in the answer. A
render tool only moves data the user is already looking at.

Failed MCP tools stay visible. Do not "clean up" the trail by hiding those.

### 4. Conversation history outlives the process

*`c88332d`.*

History used to be a module-scope `Map`. On one developer's machine that is
correct and free. On Vercel it is not: module scope is a cache, not a database,
and a cold start, a deploy or a scale-out mid-basket wipes it. The symptom was
the agent re-asking a question the user had already answered while the page
still showed every bubble — the user sees continuity the server does not have,
which is the worst shape a bug can take.

`turn-store.ts` puts it in Postgres keyed by session — the `kv` table behind
`lib/kv.ts`, with a one hour expiry — and **falls back to the in-process Map
when no `DATABASE_URL` is set** so a fresh clone still runs. It was Upstash
Redis until the cache workloads were folded into the one database the archive
already used: `kv` holds the turn and the checkout record, `quota` holds the
chat and faucet counters, and every read carries `expires_at > now()` so a
dead row is invisible before the opportunistic sweep reaches it. One
consequence worth knowing: `DATABASE_URL` is now **required in production**,
because the quotas fail closed without a shared counter.

Three things to know before editing it:

- **`RenderCache.products` is a `Map`, and `JSON.stringify` renders a Map as
  `{}`** — silently, no error. `encodeTurn` / `decodeTurn` convert explicitly in
  both directions. Never replace them with a spread.
- **Failures degrade, they do not throw.** A read that fails starts a fresh
  turn; a write that fails logs and leaves the old value to expire. Losing
  history is survivable; a 500 in the middle of a shop is not.
- **The write happens only after a clean return.** A turn that threw mid-hop can
  leave an assistant `tool_use` with no matching `tool_result`, and the API
  rejects that pairing on the *next* request — so the failure would surface one
  message later, on a turn that did nothing wrong.

Note the split with `lib/mcp/session.ts`, which solves the same problem the
opposite way: MCP state rides in a **snapshot the browser holds and sends back**,
because it is a postal code and a cart id — things the user already has. History
is the conversation itself and grows every hop, so it goes server-side.

**A reload starts a new chat, and the old one is still there.** The rule that
got us here was: persisting the session id *without* rehydrating the transcript
is worse than either end state — an empty page backed by a server that
remembers — so do both halves or neither. Both halves are now done.
`chat-store.ts` holds the blocks and the session id in localStorage, the rail
lists them, and `use-chat.ts`'s `resume` puts one back with `seedIds` so the
restored blocks do not collide with new ones. A chat the server can no longer
continue comes back **read-only** rather than pretending, which is what
`isResumable` is for. Do not re-add the id to storage on its own.

**Three stores hold a conversation, and they are not redundant.** The `kv`
table (`turn-store.ts`) is the working store the hop loop reads up to twelve
times a turn, at a one hour expiry. localStorage (`chat-store.ts`) is what the
shopper sees. The `chat` table (`chat-archive.ts`) is the record: it outlives
the expiry, survives a cleared browser, and is what an order is joined back to.
Two of the three are in the same database now, and they are still two stores:
one expires and one does not.

The archive is one write per turn, in the same place and under the same rule as
the working one — **only after a clean return** — and it matters more there: a
transcript archived with an assistant `tool_use` that has no matching
`tool_result` is a permanent copy of a pairing the API rejects. It is also
**only for a signed-in wallet**. `chat.address` is `not null` and that is the
enforcement rather than an oversight: a transcript is a list of what somebody
bought and usually carries their postal code, so moving it from an hour in a
cache to durable storage is a real change in exposure. Reads are narrowed the
same way, in the `WHERE` clause — a chat id is a UUID, not a capability.

### 5. There was a local model, and taking it out is the fix

*It ran on a Mac at home over a Cloudflare Tunnel, per hop, with the hosted
model catching whatever the machine could not take. It is gone. What follows is
the part worth keeping in mind, because the shape of it caused an outage.*

`loop.ts` used to hold `new Anthropic()` and a model name, then it held a
choice: `selectBrains()` picked between a local provider and the hosted one,
per hop, behind four gates — a `/api/tags` probe, a Redis circuit breaker, a
Redis lane lease, and a first-byte deadline. `providers/wire.ts` translated
Anthropic's message shape out to OpenAI's and back, purely, so a turn could
start on the laptop and finish on Sonnet without `turn.messages` ever leaving
Anthropic's shape.

It was good machinery and it was solving the wrong problem. The local model was
**slower** than the thing it was standing in for, hop after hop, and what it
saved was an API bill that was never the constraint. So: `provider.ts`,
`providers/ollama.ts`, `providers/wire.ts` and `providers/gate.ts` are deleted,
along with their tests, and `loop.ts` calls `anthropicProvider()` directly.

**How it broke, which is the part to remember.** `AGENT_PROVIDER=ollama` meant
*strict local, never fall back*. That was deliberate and it was the only way to
answer "is the machine really being used?", because `auto` succeeds either way
by design. But it made two variables that had to agree — the provider name and
the URL — and they were set in different moments, so removing `OLLAMA_URL` from
Vercel while the provider name stayed behind asked for a model that could not
be reached and forbade the only fallback. Every turn died at the first hop, in
Spanish, saying the local model was unavailable. A working deployment turned
off by deleting a variable that was no longer used.

The general lesson is not "strict modes are bad" — it is that a strict mode
keyed off a *second* variable can outlive the thing it is strict about. If you
add a mode like it, derive it from the resource, not from a name for the
resource.

**The `Provider` interface stays**, with `kind` narrowed to one value. It costs
one indirection and it is where the model, the thinking budget and the effort
level live, which is worth having in a file that is not the loop.

**Two things survived the removal and should not be undone:**

- **`status: 'fallback'` is still in the protocol** and `turn-progress.ts`
  still has copy for it. Nothing emits it. Removing a variant from the wire
  protocol means a browser holding an old bundle meets a server that no longer
  speaks its language, and the stage costs one unreachable branch.
- **`errorCode()` in `lib/analytics.ts` still maps the two local-model
  sentences** to `local_model`. Nothing produces them either. It is a
  classifier over strings that may still be sitting in an analytics backlog,
  and a row that classifies nothing is cheaper than a row that is missing.

### 5b. What a turn costs, and the breakpoint that moves

*The speed work that came with the removal.*

The system block carried `cache_control` and the messages did not. That is
fine for one hop and wrong for twelve: a basket appends an assistant turn and a
block of tool results per hop, and search results are the largest thing in the
request by hop three. Hop nine was paying full price — and full latency — for
everything hops one through eight had already said.

`cacheable()` in `loop.ts` marks the last content block of the last message,
and the mark moves forward each hop, so each hop's prefix is the block the
previous hop just wrote. Three details hold it up:

- **A shallow copy, never a mutation of `turn.messages`.** Two reasons, and
  both bite. The stored transcript stays free of request-shaping detail that
  `turn-store.ts`'s codec would otherwise have to carry (§4). And a mutation
  leaves last hop's breakpoint in place as well as this one's — four per
  request is the API's ceiling, and a twelve-hop turn would sail past it.
- **User messages only.** Before a hop the last message is the shopper's text
  or a block of tool results, both of which take `cache_control`. The exception
  is `pause_turn`, which loops with an assistant message last, and a thinking
  block cannot be marked.
- **Under the minimum cacheable length it is a silent no-op**, not an error.

The other knob is `AGENT_EFFORT`, defaulting to `low` where it used to be
`medium`. Adaptive thinking runs before *every* tool call, so a second of extra
deliberation per hop is twelve seconds of "Buscando…"; each hop is a small,
well-posed step with the tool schemas in front of it. It is env-overridable
because that is a claim worth being able to test rather than argue about.
`AGENT_USAGE=1` prints `cache_read` and `cache_write` per hop, which is how you
check any of this rather than assuming it.

### 6. The wait says what it is waiting for

*QA on production: a guest sat on "Buscando…" for ~35s and got "No se
envió"; a signed-in shopper waited 38–60s with nothing but Parar on screen.*

Two problems with one cause: before the first model output, the browser had
no evidence the server was doing anything. A local hop can reason for half a
minute without a text delta, and the first byte of the body was the 15s
heartbeat. So the UI could not tell a slow turn from a dead one, and when the
stream did die it blamed the user's message.

Now there is a `status` event, and it never creates a block:

- **`received`** is the first byte of the body, written before the MCP boot
  and the model. It is also what `failTurn` reads: a turn that failed with
  nothing on screen *after* `received` is `dropped` ("Se cortó antes de
  responder"), not `network` ("No se envió"). The retry control is the same
  — history is still only written on a clean return — but the copy is true.
- **`thinking`** at the top of every hop, with its index. Hop 0 is reading
  the user; later hops are reading tool results.
- **`fallback`** is in the protocol and emitted by nothing, since §5. Left
  there deliberately: an old bundle meeting a new server is the reason wire
  protocols shrink slowly.

`lib/turn-progress.ts` turns that, plus pending tools and the clock, into the
line under the composer. **Nothing in it is estimated.** Every stage is
something that happened, and the reassurance copy keys off elapsed time,
which is also something that happened. Do not add a progress bar: the server
does not know how many hops a basket will take, so a bar would be a promise
it cannot keep.

The failure detail (`El servidor respondió 504.`, `Se cortó la conexión…`)
is now printed under an undelivered bubble. It used to be discarded, which is
why the QA report could say *that* it failed and not *how*.

### 7. The first question is not a model call

*Same QA pass. Reproduced on production as a guest: the starter chip took
41.7s to come back with "¿cuál es tu código postal?", and the basket after it
178s, on the local model.*

The prompt requires a store and a postal code before anything else, so the
first reply to a starter chip is always the same question — and on a local
model it cost a full hop of prompt evaluation over twelve tool schemas.
`agent/early-ask.ts` answers it in-process when **all three** hold: it is the
first message of the conversation, no location is set, and nothing in the
text looks like a postal code. The question and the user's message go into
`turn.messages` like any other exchange, so the next hop reads the original
request, the question, and the answer in order.

Keep it that narrow. A follow-up ("no sé", "¿qué es un CPA?") deserves a
model; a false negative on the postal-code regex only means the model gets
the message, which is what used to happen to every message.

### 8. Checkout is an escrow and a sandbox, not an iframe

*The Solana port. Not the agent, but the agent's cart
is what it pays for, so the rules live here too.*

The store's checkout used to open in an iframe and the shopper typed a card
into it. Now the shopper locks USDC in the `changuito_escrow` program
(`anchor/`), and a separate service (`services/sandbox`, Jev + Playwright)
walks Día's checkout with the same basket. Reaching the card step settles the
escrow to the treasury; anything else refunds it. `lib/checkout/` is the server
half, `CheckoutModal.tsx` the browser half.

- **The sandbox never pays.** It stops at the card form, and the store's order
  and payment endpoints are aborted at the network layer. "Settled" means the
  basket was proven buyable, not that an order exists. Copy must not claim
  more than that.
- **The handoff link is the shopper's own cart** (`handoffUrl` from
  `get_cart_link`), never the sandbox's `orderFormId`. The sandbox's cart
  belongs to our Día account and opening it would expose that profile. The
  sandbox's id goes into the receipt hash as evidence and nowhere else.
- **`/api/checkout/start` reads the order PDA from chain before it starts a job**:
  buyer, status, amount and basket hash against the quote. A signature from
  the browser is a hint, not proof.
- **`open` is the buyer's signature and the resolver's fee.** Privy's gas
  sponsorship is not used. `/api/checkout/open` builds the transaction with the
  resolver as fee payer and keeps its message bytes on the checkout record
  (`openMessage`); the wallet signs as buyer and does not send; the `PUT`
  co-signs and sends only if the bytes that come back are **exactly** the ones
  stored and the buyer's signature verifies. A key that pays fees must never
  sign whatever a browser hands it — so do not relax that to "decodes to an
  `open` for this order". Rent stays the buyer's (`payer = buyer` in the
  program), which is why the faucet still sends SOL. The cost is that the
  resolver hot key now pays every shopper's fee and must be kept in devnet SOL.
- **Settle and refund check on-chain status first.** Polls overlap; the
  program rejects a second close anyway, but a failed transaction is a red
  line in the UI for nothing.
- **No `SANDBOX_URL` in dev means a mock job** (`lib/checkout/sandbox.ts`), and
  `SANDBOX_MOCK_FAIL=1` forces the refund path. In production the mock is off
  unless `SANDBOX_MOCK=1`. `scripts/devnet-e2e.mts` drives the routes against
  devnet with it.
- **`next build` typechecks through `tsconfig.build.json`**, which leaves out
  `lib/test`. Several tests still pin Stellar behaviour and fail typecheck; per
  the rule below they are reported, not edited, and `npm run typecheck` still
  covers them.

---

## Two repos, one product

This repo is one of two under `tote-hq`: **`stellar`** and **`solana`**. They
share everything up to `419304d` and diverge from there — the chain layer
(escrow, wallet, checkout) is different, and the agent, the MCP package, the
landing, the gates and the migrations are the same code twice. The split
exists so each chain's judges see only that chain's work, with real PRs,
reviews and CI; it is not a monorepo with a mirror, and nothing syncs by
itself.

The rules, enforced by `.github/workflows/shared-label.yml` and carried out
by `.github/workflows/sync.yml`:

- **A PR that touches a path in `.github/shared-paths.txt` must carry one of
  two labels**, or the check fails and it cannot merge. `shared` means: when
  this merges, cherry-pick it into the sibling repo and open a PR there.
  `chain-only` means: this touches shared paths but stays here on purpose —
  the sibling already has it, or it must not have it.
- **A `shared` PR becomes a `sync: …` PR in the sibling**, on a
  `sync/<repo>-<pr>` branch, with the original author kept on the commit and
  the source hash in its message (`-x`). Review it there like any other PR,
  and merge it the same day: an unmerged sync PR is exactly the drift the
  labels exist to make visible.
- **A conflict opens an issue in the sibling, not a broken branch.** The
  issue holds the exact commands; whoever owns that repo resolves it.
- **Never label a `sync/…` PR `shared`.** The workflow skips those branches
  anyway, but the label would be a lie.
- **Merge by squash or merge commit, never rebase.** Rebase merging is off in
  both repos because its `merge_commit_sha` is only the last of N commits and
  the sync would carry one commit out of N.
- **`.github/shared-paths.txt` is itself a shared path.** Edit it in one repo
  with the `shared` label and let the sync carry it, so the two lists cannot
  disagree about what is shared.

Prefix PR titles with what the PR is — `stellar:`, `solana:` or `shared:` —
because judges read titles, not diffs. Needs that are not in the repo:
`SYNC_TOKEN` (a fine-grained PAT with Contents, Pull requests and Issues on
both repos) as a secret in each, and the two labels.

## Things that are the way they are on purpose

- **`MAX_HOPS = 12`.** A basket takes a handful of searches. Past this the model
  is stuck, not working, and the user gets a plain message saying so.
- **`claude-sonnet-5`** is the model, overridable with `AGENT_MODEL`.
  Haiku 4.5 runs — the loop switches to a fixed thinking budget for it,
  because adaptive thinking and the effort control are Claude 5 features and
  Haiku rejects the request outright — but in the one run measured here it
  stopped after the product search without building the cart. Swapping the
  model is not a one-line change; the request shape follows.
- **The system prompt is `SERVER_INSTRUCTIONS` from the MCP package, then ours,
  cached** — and it is only the *first* of two breakpoints; see §5b. The server is the authority on how to drive the server; a
  paraphrase would drift. Per-turn state goes in the *user* message via
  `stateBanner`, not the system prompt — anything that changes in the system
  prompt invalidates the cache for the whole conversation.
- **The loop is written against `messages.stream()`, not the tool runner.**
  Every tool call here has a visible consequence, and owning the loop means
  owning where those are emitted.
- **`chat-state.ts` is pure and framework-free**, so the ordering rules are
  testable without a browser. The hard part is ordering: a grid arrives
  mid-sentence, and appending it at the end of the turn makes the sentence that
  introduced it read as its caption.

## Before you commit

```
npm test -w @changuito/web      # 577 tests, node:test with --experimental-strip-types
npm run typecheck -w @changuito/web
npm run build
```

Two constraints that bite in this repo specifically:

- **`target: ES2022`** in `apps/web/tsconfig.json`. `findLastIndex` and friends
  are ES2023 and will not typecheck — `chat-state.ts` has a hand-written
  `lastIndexWhere` for exactly this reason.
- **`--experimental-strip-types` erases types; it does not compile.** Two
  separate consequences, and both have bitten here:

  *It cannot resolve extensionless imports.* A test that imports a module which
  imports `'../mcp/bridge'` fails at load. This is why `turn-store.ts` depends
  on `loop.ts` with `import type` only — type imports are erased, so they cost
  nothing at runtime — and why `lib/units.ts` has no imports at all while
  `deposit-watch.ts` spells its own as `'./units.ts'`. A package import
  resolves fine; a relative one does not.

  *It rejects any syntax that emits code.* A parameter property —
  `constructor(readonly stage: string)` — is a field assignment in disguise, so
  strip-only mode refuses the file with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
  A class that needs a field declares it and assigns it in the body instead.
  The same goes for `enum` and namespaces. If a test dies at load with that
  code, this is why.

**Don't modify the tests.** For now they are the fixed point the deployment is
checked against: a change that only passes because its test moved with it tells
you nothing once it is live. If a test is genuinely wrong, say so rather than
editing it — and a test file that has to go because the module under it is gone
is a deletion, which is a different thing and worth naming out loud.
  
