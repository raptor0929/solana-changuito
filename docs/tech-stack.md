# Tech stack

Versions are pinned exactly where a minor bump would be a real risk — the wallet
SDK, the agent SDK — and left as ranges where it would not.

## Application

| | Version | Why this one |
|---|---|---|
| **Next.js** | 16.3.5 | App Router, route handlers and streaming responses in one place. Every API route is `runtime = 'nodejs'` — the MCP server's `node:url` import and `node:crypto` in the checkout routes fail on edge, and they fail at *import* time, which is a confusing way to find out. |
| **React** | 19.2.0 | |
| **TypeScript** | 5.9.3 | `strict`, `target: ES2022`. ES2023 methods like `findLastIndex` do **not** typecheck here. |
| **Node** | ≥ 22.12 (`.nvmrc`: 22.12.0) | `--experimental-strip-types` for the test suite and the `.mts` scripts. On Vercel set the project's Node version explicitly. |
| **`postgres`** | ^3.4.9 | the chat archive, plus the `kv` and `quota` tables that replaced Redis (`lib/kv.ts`). Orders live on chain |
| **npm workspaces** | — | `apps/*`, `packages/*`. No Turborepo, no pnpm. |

No CSS framework, no state library, no component kit. The transcript is a
reducer in a plain file (`lib/chat-state.ts`) so the ordering rules can be
tested without a browser.

Three apps share the workspace: `apps/web` (the shopper), `apps/landing` (the
marketing site) and `apps/branding` (the assets). `packages/trust` exists so the
copyright line, the registered mark and the founder attribution are written once
and rendered by both public sites rather than drifting apart. `services/sandbox`
is the one non-JavaScript service (Python, below).

## The agent

| | Version | Notes |
|---|---|---|
| **`@anthropic-ai/sdk`** | 0.127.0 | written against `messages.stream()` rather than the tool runner, because every tool call here has a visible consequence and owning the loop means owning where those are emitted |
| **Model** | `claude-sonnet-5` | overridable with `AGENT_MODEL`. Adaptive thinking + the effort control are Claude 5 features; the loop falls back to a fixed thinking budget for Haiku 4.5, which otherwise rejects the request outright |
| **Effort** | `low` | overridable with `AGENT_EFFORT`. Thinking runs before every tool call and a basket is up to twelve of them, so this is a latency setting more than a quality one |
| **Prompt caching** | two breakpoints | the system + tools prefix, and a moving one on the newest message. The second is what stops hop nine re-reading hops one through eight at full price |
| **`@modelcontextprotocol/sdk`** | 1.30.0 | both the `Client` and the `McpServer`, linked with `InMemoryTransport` |

**One provider per deployment.** `lib/agent/loop.ts` uses Anthropic unless
`OPENAI_API_KEY` is set, in which case `providers/openai.ts` answers instead
(`OPENAI_MODEL`, default `gpt-4.1`). The choice is made from the key — the
resource — not from a separate mode variable, for the reason below.

There used to be a third option: a local model on a Mac at
home over a Cloudflare Tunnel, chosen per hop behind four gates, with a wire
translator between Anthropic's message shape and OpenAI's. It was slower than
the thing it stood in for and it saved an API bill that was never the
constraint, so `provider.ts`, `providers/ollama.ts`, `providers/wire.ts` and
`providers/gate.ts` are deleted along with their tests, and `loop.ts` calls
`anthropicProvider()` unless an OpenAI key is present. `lib/agent/providers/`
holds `anthropic.ts`, `openai.ts` and `types.ts`.

The `Provider` interface stays: it costs one
indirection and it is where the model, the thinking budget and the effort level
live, in a file that is not the loop. Two artefacts of the removal are
deliberate and should not be tidied away — `status: 'fallback'` is still in the
wire protocol though nothing emits it, and `errorCode()` still classifies the
two local-model sentences. [`../CLAUDE.md`](../CLAUDE.md) §5 has the outage that
taught us why.

## Solana

| | Version | Notes |
|---|---|---|
| **`@solana/kit`** | ^8.4.0 | RPC, transaction building and signing, client and server. The escrow client in `lib/escrow.ts` is hand-written against it: PDAs, instruction builders, `decodeOrder` — no generated IDL client |
| **`@solana-program/token`**, **`/system`** | ^0.17.0, ^0.15.0 | ATA creation, `mintTo`, SOL transfer (the faucet) |
| **`@privy-io/react-auth`** | 3.47.0 (exact) | email and Google login, the embedded Solana wallet, and `useSignTransaction` (sign only; the server sends `open` with the resolver as fee payer) |
| **`jose`** | ^6.1.0 | verifies the Privy access token against the app's JWKS server-side. `@privy-io/node` is not used: it pins `@solana/kit` 5 |
| **Anchor** | 0.32 (`anchor-lang`, `anchor-spl` with `token`) | the escrow program, `anchor/programs/changuito_escrow` |
| **Platform tools** | v1.52 (`cargo build-sbf --tools-version v1.52`) | older ones cannot parse the edition-2024 crates in the dependency tree |
| **Cluster** | devnet only | hard-coded in `lib/deployments.ts` (generated) and the deploy script, on purpose |

The money rail is the escrow program: the buyer's wallet signs `open`, the
backend resolver signs `settle` or `refund`. Program, accounts and evidence
transactions are in [solana.md](solana.md); the flow is in
[flows.md](flows.md#3-checkout-quote-lock-shop-settle).

| Account | Devnet address |
|---|---|
| Program `changuito_escrow` | [`BFa1gZL9kVVo8Mq5gaDRM5RiCG4NDiyHLbpymfXvLz9d`](https://solscan.io/account/BFa1gZL9kVVo8Mq5gaDRM5RiCG4NDiyHLbpymfXvLz9d?cluster=devnet) |
| Config PDA | [`BCcorb5CVL86uDQQT4fBusAcobXugFfTTM6ypL4bDBPh`](https://solscan.io/account/BCcorb5CVL86uDQQT4fBusAcobXugFfTTM6ypL4bDBPh?cluster=devnet) |
| USDC mock mint (6 dp) | [`BZ6CHGyRnuuGRxDmd1bCFdeUTCJGcGcWtUct1NMELG85`](https://solscan.io/account/BZ6CHGyRnuuGRxDmd1bCFdeUTCJGcGcWtUct1NMELG85?cluster=devnet) |
| Resolver | [`5zeMdzZCXkCHbTwvoxtEHRHCP5fe7MLc4fHgG54ENhUD`](https://solscan.io/account/5zeMdzZCXkCHbTwvoxtEHRHCP5fe7MLc4fHgG54ENhUD?cluster=devnet) |
| Treasury | [`9TNtBk4RL2dmYdffqfudhLGc1DEtnHc8nmw7yWcD2ctc`](https://solscan.io/account/9TNtBk4RL2dmYdffqfudhLGc1DEtnHc8nmw7yWcD2ctc?cluster=devnet) |

## The sandbox service

`services/sandbox` — Python 3.12, managed with `uv`. Copied from
[raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg) and
credited (`UPSTREAM.md`). Details in [sandbox.md](sandbox.md).

| | Version | Notes |
|---|---|---|
| **`playwright`** (Python) | ≥ 1.63.0 | drives Chromium on Día's real site |
| **`typesafe-sdk`** | ≥ 0.7.2 | Jev, TypeSafe's System One model. It answers typed questions (Choice / Noul / Score) about the page and never generates text; the harness executes the choice |
| **FastAPI + uvicorn** | ≥ 0.115, ≥ 0.30 | `POST /jobs`, `GET /jobs/{id}`, `GET /health`, Bearer `SANDBOX_TOKEN` |
| **Image** | `mcr.microsoft.com/playwright/python:v1.63.0-noble` | Chromium's system libraries come with it |
| **Host** | Railway, one replica | one job at a time: one Día account, one session-bound cart |

## Data

| Store | Holds | Lifetime |
|---|---|---|
| **Solana devnet** | every order: buyer, amount, basket hash, status, receipt hash | the record. Read back with `getProgramAccounts` for "Mis compras" |
| **MCP session snapshot** | retailer, postal code, cart id | the browser holds it and sends it back each turn |
| **Postgres `kv` / `quota`** | the hop loop's conversation history (1h expiry); checkout records between quote and close (24h); chat and faucet quotas | `expires_at > now()` on every read, swept on writes. Falls back to an in-process `Map` without `DATABASE_URL` |
| **localStorage** | the transcript the shopper sees, their chat list, receipts | the browser |
| **Postgres `chat`** | archived chats, signed-in wallets only | same database; rows do not expire |

Five migrations in `supabase/migrations/`, applied with `npm run db:migrate`.
`0001`–`0004` are from the previous build (orders, deposits, cards); nothing in
the app writes those tables now. `0005_solana` renames the address domain to
`wallet_address`, accepts base58 Solana keys and adds `devnet` as a network,
with both checks `NOT VALID` so the old rows stay as a record of what was.

The archive is written only for a signed-in wallet: `chat.address` is `not null`
and reads are narrowed by it in the `WHERE` clause, because a transcript is a
list of what somebody bought and usually carries their postal code.

## The MCP server

`packages/mcp` — vendored from `supermarket-mcp-research/` so the repo is
self-contained and deployable from GitHub with no submodule and no published
package. Its only runtime dependencies are the MCP SDK and `zod`.

Ten tools: `list_retailers`, `set_location`, `search_products`, `get_product`,
`price_check`, `add_to_cart`, `update_cart_item`, `view_cart`, `get_cart_link`,
`where_am_i`.

Four things changed on the way in, all of them improvements upstream would want:

| Change | Why |
|---|---|
| `name` → `@changuito/mcp` | workspace resolution |
| `playwright`, `ethers` → `optionalDependencies` | they belong to the checkout half. Vercel installs with `--omit=optional`, so neither reaches the lambda |
| `createSupermercadoServer()` factory added | the web app connects a `Client` over an in-memory transport instead of spawning a process |
| checkout tools became a lazy `await import()` | keeps Playwright out of the read-only import graph |

The 492 tests it came with are unmodified and still pass; the rest were added
here, for the factory, the session state it takes, a cart total that turned out
to be the pre-discount subtotal, and the `payableTotal` / `totalizerBreakdown` /
`classifyOrderForm` trio the checkout reads through the `./orderform` subpath.

### Keeping the browser engine out of the lambda

Three independent barriers, because one is a boundary and three is a guarantee:

1. `@changuito/mcp/server` has **no reference** to the checkout module, not even
   a dynamic one.
2. `optionalDependencies` + Vercel's `--omit=optional` means Playwright is not
   installed there at all.
3. `next.config.ts` sets `outputFileTracingExcludes` for `/api/**` on
   `playwright`, `playwright-core`, `ethers`, and the compiled `checkout/` and
   `wallet/` directories.

`transpilePackages` carries `@changuito/mcp`, which is compiled ESM and gets
**bundled rather than marked external**: a symlinked workspace package that
Next treats as external is not traced into the lambda at all and fails at
runtime with `MODULE_NOT_FOUND`.

## The escrow program

| | |
|---|---|
| **Language** | Rust 2021, Anchor 0.32, `crate-type = ["cdylib", "lib"]` |
| **Release profile** | `lto = "fat"`, `codegen-units = 1`, **`overflow-checks = true`** |
| **Build** | `npm run program:build` → `cargo build-sbf --tools-version v1.52`; IDL with `anchor idl build` |
| **Tests** | no Rust test suite. Verified on devnet: `scripts/solana-init.mts` smokes open → settle and open → refund after every deploy, and `scripts/devnet-e2e.mts` drives both paths through the app's routes |

## Infrastructure

| | |
|---|---|
| **Vercel** | the Next apps. Node runtime, `maxDuration = 300` on `/api/chat` — a basket is a dozen HTTPS round trips to a storefront |
| **Railway** | `services/sandbox`, from its `Dockerfile` and `railway.json` (healthcheck `/health`, 1 replica) |
| **Privy** | login, embedded wallets (no gas sponsorship: the resolver pays the `open` fee) |
| **Solana devnet RPC** | `https://api.devnet.solana.com` by default; `SOLANA_RPC_URL` / `NEXT_PUBLIC_SOLANA_RPC_URL` to use another |
| **Solscan** | explorer links, `?cluster=devnet` |
| **Cloudflare Turnstile** | the human gate in `middleware.ts`. Unset in production it fails **shut**: every `/api/*` route but `/api/human` answers 403 |
| **Postgres (Supabase)** | over `DATABASE_URL`, the transaction pooler. Required in production: the working turn, the checkout record and the quotas (`kv`, `quota`, from `supabase/migrations/0006_kv.sql`) as well as the chat archive |

There is no Redis any more. Upstash held the expiring state until it was
folded into the database the archive already used; `KV_REST_API_URL` and
`KV_REST_API_TOKEN` are read by nothing in `apps/web`.

## Tests

```
npm test                          # mcp · trust · web · landing
npm test -w @changuito/mcp        # adapters, money, FX, cart maths
npm test -w @changuito/web        # chat-state, checkout copy, faucet policy, sessions, …
npm run typecheck -w @changuito/web
npm run build
node --experimental-strip-types scripts/devnet-e2e.mts   # against `npm run dev`; see judges.md
```

None of the unit suites needs an API key. `devnet-e2e` needs a dev server with
`SOLANA_RESOLVER_SECRET` set, and spends devnet SOL from the resolver.

`npm run test:e2e` runs Playwright. The web suite runs on `node:test` with
`--experimental-strip-types`, which erases types rather than compiling them.
Two sharp edges follow:

- **It cannot resolve extensionless imports.** A test that imports a module
  which imports `'../mcp/bridge'` fails at load. This is why `turn-store.ts`
  depends on the agent loop with `import type` only — type imports are erased
  and cost nothing at runtime — and why `lib/solana.ts` has no relative
  imports at all. A *package* import resolves fine.
- **It rejects syntax that emits code.** A parameter property, an `enum` or a
  namespace fails the whole file with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

## Environment variables

Nothing here is required to read the code, and the app degrades rather than
breaking when a value is missing — each row says into what. Annotated at length
in `apps/web/.env.example`; setup in [`../DEPLOY.md`](../DEPLOY.md).

### Web (`apps/web`, Vercel)

| | Required | For, and what happens without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes (or `OPENAI_API_KEY`) | the agent. With neither, `/api/chat` answers with a configuration error |
| `NEXT_PUBLIC_PRIVY_APP_ID` | for login and checkout | the Privy app. Unset, the wallet widget renders disabled and nobody can sign in or pay; chat still works for guests |
| `PRIVY_APP_SECRET` | for login | server-side lookup of the user's linked Solana wallet (`lib/privy-server.ts` returns no identity without it, so `/api/session/login` answers 401). The token itself is verified against Privy's public JWKS |
| `CHG_SESSION_SECRET` | in production | signs the httpOnly `chg_user` cookie. Unset in production, login answers 503. Locally a dev constant stands in |
| `SOLANA_RESOLVER_SECRET` | for faucet, `open` fees, settle, refund | the resolver keypair, as the 64-byte JSON array or base58. Checked against `DEPLOYMENTS.devnet.resolver` and refused on mismatch. Read at call time, so a build without it succeeds; the faucet answers 503 |
| `SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL` | no | server and browser RPC. Default `https://api.devnet.solana.com`, which rate-limits; a dedicated devnet RPC is worth it on a public URL |
| `SANDBOX_URL` | for real shopping in production | the Railway sandbox. Unset outside production, an in-process mock answers; unset in production, checkout cannot start (and refunds) unless `SANDBOX_MOCK=1` |
| `SANDBOX_TOKEN` | with `SANDBOX_URL` | Bearer token; must equal the sandbox's own `SANDBOX_TOKEN` |
| `SANDBOX_MOCK` | no | `1` lets a production build use the mock — a demo without the browser farm |
| `SANDBOX_MOCK_FAIL` | no | `1` makes the mock fail at checkout: the refund path |
| `ARS_PER_USD` | no | pin the rate so a demo quotes the same number every time. Unset means the live feed |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | in production | the human gate. The secret alone decides it, and unset in production it fails shut |
| `DATABASE_URL` | in production | conversation history, quotas and checkout records across instances (`kv`, `quota`), and the chat archive for signed-in wallets. Locally an in-process Map stands in; in production the quotas fail closed without it. Orders do not need it |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | no | if the key is set, the agent runs on OpenAI instead of Anthropic |
| `AGENT_MODEL`, `AGENT_EFFORT`, `AGENT_USAGE` | no | Anthropic model override; the speed knob; per-hop token logging including cache reads and writes |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID`, `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_CLARITY_PROJECT_ID` | no | analytics. Unset, nothing loads |

### Sandbox (`services/sandbox`, Railway)

| | Required | For |
|---|---|---|
| `SANDBOX_TOKEN` | yes | Bearer auth on `/jobs`. Unset, `/jobs` answers 503 |
| `TYPESAFE_API_KEY` | yes | Jev |
| `DIA_ARG_EMAIL`, `DIA_ARG_PWD`, `DIA_ARG_DNI` | yes | the operator's Día account. Typed by the harness from the environment and redacted from everything Jev sees |
| `DIA_ARG_POSTCODE` | yes | the delivery postcode checkout asks for |
| `PORT` | no | set by Railway; the image defaults to 8080 |

There is **no network or mode variable, and there must not be one.** Devnet is
the only cluster, and it is a constant in the generated `lib/deployments.ts`.

## Privy dashboard

The app expects this configuration (dashboard.privy.io → your app):

1. **Login methods:** email and Google. The provider also sets
   `loginMethods: ['email', 'google']`, so other methods enabled in the
   dashboard are not offered.
2. **Embedded wallets → Solana:** on, created on login for all users. Ethereum
   embedded wallets off.
3. **Gas sponsorship:** not needed. The wallet only signs `open`;
   `/api/checkout/open` adds the resolver's signature as fee payer and sends
   it, so the resolver needs devnet SOL instead.
4. **Allowed origins:** `http://localhost:3124` and the production domain.
5. **App ID** → `NEXT_PUBLIC_PRIVY_APP_ID`; **App secret** → `PRIVY_APP_SECRET`.
