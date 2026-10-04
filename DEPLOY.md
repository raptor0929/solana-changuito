# Deploying changuito

Three pieces, and only the first two are needed for a working deployment:

1. **The web app on Vercel** (`apps/web`) — the chat, the wallet, the checkout routes.
2. **The sandbox on Railway** (`services/sandbox`) — the browser agent that walks Día's checkout. Without it, a non-production build uses an in-process mock, and production needs `SANDBOX_MOCK=1`.
3. **The escrow program on Solana devnet** — already deployed. Its addresses are committed in `deployments.json` and the generated `apps/web/lib/deployments.ts`, so **you only need Part 3 to redeploy your own copy.**

Devnet only. There is no mainnet configuration and no network switch.

---

## Part 1 — the web app on Vercel

### 1.1 Accounts and keys you need first

| | Where | Becomes |
|---|---|---|
| **OpenAI or Anthropic** (one) | [platform.openai.com](https://platform.openai.com/api-keys) or [console.anthropic.com](https://console.anthropic.com) → API keys | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (Part 4) |
| **Privy** | [dashboard.privy.io](https://dashboard.privy.io) → your app → Settings | `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` |
| **Resolver keypair** | `~/.config/solana/changuito/resolver.json` on the machine that deployed the program | `SOLANA_RESOLVER_SECRET` |
| **Cloudflare Turnstile** | Cloudflare → Turnstile → add a site | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| **Upstash Redis** | Vercel → Storage → Marketplace (1.5) | `KV_REST_API_URL`, `KV_REST_API_TOKEN` |

### 1.2 Configure Privy

In the Privy dashboard, for the app whose id you will use:

1. **Login methods → Email** and **Google** on. The provider also passes
   `loginMethods: ['email', 'google']`, so anything else enabled there is not
   offered.
2. **Embedded wallets → Solana** on, **create on login for all users**.
   Ethereum embedded wallets off.
3. **Gas sponsorship** is not needed; leave it off. The wallet only signs
   `open`: `/api/checkout/open` builds it with the resolver as fee payer, adds
   the resolver's signature and sends it. So the **resolver needs devnet SOL**
   for those fees (about 0.00001 SOL each). Rent is still the buyer's — the
   faucet sends 0.01 SOL with the test USDC for that.
4. **Allowed origins:** `http://localhost:3124` and every domain you deploy to
   (production and, if you use them, Vercel preview URLs).
5. Copy the **App ID** and **App secret**.

`PRIVY_APP_SECRET` is required for login, not optional: the access token is
verified against Privy's public JWKS, but the user's linked Solana wallet is
read from Privy's REST API with the secret, and without it `/api/session/login`
answers 401 to everyone.

### 1.3 Import the repository

In Vercel: **Add New → Project**, import the repository.

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| Root directory | `apps/web` |
| Build / install command | *(defaults)* |
| Node.js version | **22.x** |

Root directory `apps/web` is a workspace and Vercel still installs from the repo
root, so `@changuito/mcp` resolves normally. Node 22 because the repo uses
`--experimental-strip-types` and `.nvmrc` pins 22.12.0.

### 1.4 Environment variables

Every variable, with what happens when it is missing, is in
[docs/tech-stack.md](docs/tech-stack.md#environment-variables) and annotated in
[`apps/web/.env.example`](apps/web/.env.example). For a production deployment:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | from 1.1; set one. With the OpenAI key set, it answers every hop |
| `NEXT_PUBLIC_PRIVY_APP_ID` | from 1.2 |
| `PRIVY_APP_SECRET` | from 1.2 |
| `CHG_SESSION_SECRET` | `openssl rand -hex 32`. Signs the `chg_user` cookie; unset in production, login answers 503. Rotating it signs everyone out |
| `SOLANA_RESOLVER_SECRET` | the contents of `resolver.json` (the 64-number JSON array), or its base58 form. Checked against the resolver address in `lib/deployments.ts` and refused if it does not match |
| `SOLANA_RPC_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL` | optional; a dedicated devnet RPC. The public `api.devnet.solana.com` rate-limits under traffic |
| `SANDBOX_URL`, `SANDBOX_TOKEN` | from Part 2. Until then, set `SANDBOX_MOCK=1` or checkout cannot start in production |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | injected by 1.5 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | from 1.1 |
| `ARS_PER_USD` | optional; pins the rate for a demo |
| `DATABASE_URL` | optional; 1.6 |

Three of these fail in ways worth knowing before they happen:

- **`TURNSTILE_SECRET_KEY` fails shut.** Unset in production, `middleware.ts`
  answers 403 `solo_humanos` on every `/api/*` route except `/api/human`, so
  chat, login, faucet and checkout are all dead. Deliberate: an open agent
  endpoint on a public URL bills somebody's model key. The site key does
  not affect the gate, but without it the widget never mounts and nobody gets
  through.
- **`SOLANA_RESOLVER_SECRET` is read at call time**, so a build without it
  succeeds and the faucet answers 503, and an order that reaches the end of
  shopping cannot be settled or refunded. Never prefix it `NEXT_PUBLIC_` and
  never log it.
- **Without `SANDBOX_URL` in production, checkout refunds.** `sandboxMode()` is
  `off` there unless `SANDBOX_MOCK=1`, so a shopper who locks USDC gets it back
  at the first status poll.

Only the `NEXT_PUBLIC_` names reach the browser. Do not add the prefix to any
other.

### 1.5 Redis: conversation history, quotas, checkout records

1. **Storage → Create Database → Marketplace → Upstash for Redis.**
2. Region: match your functions (Vercel's default is `iad1`). Leave Read
   Regions empty.
3. **Turn Eviction on.** Off means writes *fail* once the database is full.
   Conversations are a cache with a one hour TTL; checkout records live 24 hours.
4. **Connect Project.** That injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

Required in production because the quotas fail closed: without it (or with
Redis down) `/api/chat` answers 503 rather than running unlimited turns on your
key. It also matters for checkout — the record written at quote is read at
start and at every status poll, possibly by a different lambda, and the
in-process fallback does not survive that.

Use the REST pair, not `REDIS_URL` or `KV_URL`: those are `rediss://` strings
for a TCP client. Locally, leave them out and an in-process Map stands in.

### 1.6 The database (optional)

Postgres holds one thing now: the archive of conversations for signed-in
wallets. Orders are on chain. A deployment with no `DATABASE_URL` boots and
works; it just does not archive.

1. **supabase.com → New project.** Region: match your Vercel functions.
2. **Project Settings → Database → Connection string.** Take both: the
   *transaction pooler* on port **6543** and the *direct* connection on **5432**.
3. Put them in `apps/web/.env` locally as `DATABASE_URL` and `DIRECT_URL`, with
   `?sslmode=require` on each.
4. Apply the schema:

```bash
npm run db:migrate     # supabase/migrations/*.sql, in order, over DIRECT_URL
npm run db:status      # what is applied, what is pending
npm run db:invariants  # the constraints, against the real database
```

5. In Vercel, set **`DATABASE_URL` only**. Migrations are a laptop operation.

6543 is transaction-mode pooling, the right shape for a lambda per request;
5432 is a session, which DDL needs and a request handler must never hold.
`lib/db.ts` reads `DATABASE_URL` and deliberately not `DIRECT_URL`.
`prepare: false` is already passed: the pooler rejects named prepared
statements.

### 1.7 Check a deployment

The chat **streams** rather than arriving in one lump. If it arrives all at
once, something is buffering the SSE response — the route sets
`X-Accel-Buffering: no`, and the runtime must be `nodejs`, never edge.

Then walk it once: build a basket, press *Pagar*, sign in with an email, press
*Cargar 50 USDC de prueba*, lock, and wait for *¡Compra completada!*. Open the
*Bloqueo* and *Liberación* links: both should be devnet transactions against
program `9A2PXJafYxym4i8ah1QFQZngqz2j7rQh8xQX2eXB2wC9`.

Without a browser, `scripts/devnet-e2e.mts` drives the same routes against
any base URL, but it mints its own session cookie, so it only works where it
knows `CHG_SESSION_SECRET` — locally, or with the same value exported:

```bash
CHG_SESSION_SECRET=… node --experimental-strip-types scripts/devnet-e2e.mts https://<your-deployment>
```

Behind Turnstile in production it will be refused at the middleware; run it
against `npm run dev` instead (see [docs/judges.md](docs/judges.md#5-verify-it-yourself)).

## Part 2 — the sandbox on Railway

`services/sandbox` is a FastAPI service around a Playwright harness. It holds
one operator Día account and runs one job at a time. Details in
[docs/sandbox.md](docs/sandbox.md).

### 2.1 Create the service

1. **Railway → New Project → Deploy from GitHub repo**, this repository.
2. In the service's **Settings → Source**, set **Root directory** to
   `services/sandbox`. Railway then picks up `railway.json`, which builds the
   `Dockerfile` (`mcr.microsoft.com/playwright/python:v1.63.0-noble` plus `uv`),
   health-checks `/health`, restarts on failure, and runs **one replica**.
3. Keep it at one replica. The Día account's cart is bound to its session and
   jobs are held in memory; two replicas would share an account and split the
   jobs.

### 2.2 Variables

| Variable | Value |
|---|---|
| `SANDBOX_TOKEN` | `openssl rand -hex 32`. Unset, `/jobs` answers 503 |
| `TYPESAFE_API_KEY` | TypeSafe API key, for Jev |
| `DIA_ARG_EMAIL`, `DIA_ARG_PWD`, `DIA_ARG_DNI` | the operator's Día account. Typed from the environment and redacted from everything the model sees |
| `DIA_ARG_POSTCODE` | the delivery postcode checkout asks for |
| `PORT` | leave it; Railway sets it and the image defaults to 8080 |

### 2.3 Expose it and connect the app

1. **Settings → Networking → Generate Domain.**
2. Check it: `curl https://<railway-domain>/health`.
3. In Vercel, set `SANDBOX_URL=https://<railway-domain>` and
   `SANDBOX_TOKEN` to the **same** value as on Railway. Remove `SANDBOX_MOCK`.
4. Redeploy the web app so the new variables take effect.

A sandbox restart drops its in-memory jobs. The app sees a 404 on the next
status poll and refunds, which is the intended behaviour, not a bug.

To run it locally instead, see `services/sandbox/README.md`, and point
`SANDBOX_URL` at `http://localhost:8080`.

## Part 3 — the escrow program on devnet

Only needed to deploy your own copy. The committed one is live:

| | |
|---|---|
| Program | [`9A2PXJafYxym4i8ah1QFQZngqz2j7rQh8xQX2eXB2wC9`](https://solscan.io/account/9A2PXJafYxym4i8ah1QFQZngqz2j7rQh8xQX2eXB2wC9?cluster=devnet) |
| USDC mint | [`9rYNCiaaKQ5rT1QR8Ar6FJVUr7gnwZy3RYAT6MtAtdMM`](https://solscan.io/account/9rYNCiaaKQ5rT1QR8Ar6FJVUr7gnwZy3RYAT6MtAtdMM?cluster=devnet) |
| Resolver | [`AgTnHC9dmyuzjwp3oCRzaYrZbgeXD4tC2uSXmKhiyqQ5`](https://solscan.io/account/AgTnHC9dmyuzjwp3oCRzaYrZbgeXD4tC2uSXmKhiyqQ5?cluster=devnet) |
| Treasury | [`EV5c3mjEHBtTU6JmX31eLsfKX5zPgMVDEiKDhqjApZPS`](https://solscan.io/account/EV5c3mjEHBtTU6JmX31eLsfKX5zPgMVDEiKDhqjApZPS?cluster=devnet) |

### 3.1 Toolchain

- Rust and the Solana CLI (Agave), with `cargo build-sbf`.
- Platform tools **v1.52** — `cargo build-sbf --tools-version v1.52`. Older
  ones cannot parse the edition-2024 crates in the dependency tree.
- Anchor CLI 0.32, for `anchor idl build`.
- Node 22.12+.

### 3.2 Keys

All keys live in **`~/.config/solana/changuito/`** and are **never committed**:

| File | Role |
|---|---|
| `deployer.json` | pays for the deploy and `initialize`; the smoke run's buyer |
| `program.json` | the program's address keypair |
| `resolver.json` | signs settle, refund and faucet mints, and pays the fee for every shopper's `open`; the mint authority. Its contents become `SOLANA_RESOLVER_SECRET` |
| `treasury.json` | where settled USDC lands. The app never signs for it |

```bash
mkdir -p ~/.config/solana/changuito
for k in deployer program resolver treasury; do
  solana-keygen new --no-bip39-passphrase -o ~/.config/solana/changuito/$k.json
done
solana airdrop 5 $(solana-keygen pubkey ~/.config/solana/changuito/deployer.json) --url devnet
```

If the airdrop is rate-limited, transfer devnet SOL from another funded wallet,
or use the web faucet. The resolver also needs a little SOL: it pays fees for
`open`, settle, refund and the faucet, and the faucet's 0.01 SOL top-ups.
Every checkout draws on it, so check its balance before a demo.

### 3.3 A new copy needs code edits first

The committed addresses are baked in, so a fresh copy is not one command:

1. **Program id.** Set `declare_id!` in
   `anchor/programs/changuito_escrow/src/lib.rs` to
   `solana-keygen pubkey ~/.config/solana/changuito/program.json`.
2. **Mint.** No script creates it. Create a 6-decimal mint with the resolver as
   mint authority:
   ```bash
   spl-token create-token --decimals 6 \
     --mint-authority $(solana-keygen pubkey ~/.config/solana/changuito/resolver.json) \
     --fee-payer ~/.config/solana/changuito/deployer.json --url devnet
   ```
3. **`scripts/solana-init.mts`** hard-codes `PROGRAM`, `MINT` and `TREASURY`.
   Replace all three.

### 3.4 Build, deploy, initialize, smoke

```bash
./scripts/solana-deploy.sh            # or: npm run deploy:devnet
SKIP_BUILD=1 ./scripts/solana-deploy.sh   # redeploy the .so already built
```

The script:

1. builds with `cargo build-sbf --tools-version v1.52` and writes the IDL with
   `anchor idl build` (skipped with `SKIP_BUILD=1`);
2. `solana program deploy` with `program.json` as the id and `deployer.json`
   paying;
3. runs `scripts/solana-init.mts`: `initialize(resolver, treasury)` once
   (skipped if Config exists), then a smoke **open → settle** and
   **open → refund** with the deployer as buyer, then writes
   `deployments.json`;
4. runs `scripts/write-deployments-module.mjs`, which regenerates
   `apps/web/lib/deployments.ts` — addresses plus the `EVIDENCE` signatures.

`npm run devnet:init` runs step 3 without the smoke. `npm run program:build`
is step 1 alone. `SOLANA_RPC_URL` overrides the RPC for all of it.

Config is set once by `initialize`; there is no instruction to change the
resolver or treasury afterwards. Rotating either means a new program.

### 3.5 Commit what changed

`deployments.json` and `apps/web/lib/deployments.ts`, plus the edits from 3.3.
Never the keys. Then update `SOLANA_RESOLVER_SECRET` on Vercel if the resolver
changed, and redeploy the web app.

## Part 4 — the agent's model

One model answers every hop: `claude-sonnet-5`, from `ANTHROPIC_API_KEY` —
unless `OPENAI_API_KEY` is set, in which case `lib/agent/providers/openai.ts`
answers instead (`OPENAI_MODEL`, default `gpt-4.1`). The choice follows the key,
so there is no mode variable to forget. Set one key, not both, unless you mean
OpenAI. The rest of this part is about the Anthropic path, and worth a section
only because of what used to be here.

**There was a local model.** Inference ran on a Mac at home over a Cloudflare
Tunnel, with the hosted model catching whatever the machine could not take —
four gates deciding per turn, a circuit breaker and a lane lease in Redis, and
a per-hop fallback so a basket could start on the laptop and finish on Sonnet.
It worked. It was also *slower* than the thing it was saving, hop after hop,
and the saving was on an API bill that was never the constraint.

It is gone, and the way it went wrong on the way out is the reason this
paragraph exists. `AGENT_PROVIDER=ollama` meant **strict local, never fall
back** — that was its whole purpose, since `auto` cannot tell you whether the
machine is really being used. So a deployment that removed `OLLAMA_URL` and
left `AGENT_PROVIDER` behind asked for a model that could no longer be reached
and forbade the only fallback: every turn died at the first hop with *"El
modelo local no está disponible"*. Two variables that had to agree, set in two
different moments. There is no such pair now: the provider is chosen by which key exists.

`AGENT_PROVIDER`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_HEADERS`,
`OLLAMA_LANES`, `OLLAMA_FIRST_BYTE_MS` and `OLLAMA_KEEP_ALIVE` are read by
nothing. Delete them from Vercel; leaving them is harmless but misleading.

### 4.1 The two knobs that are left

| | Default | |
|---|---|---|
| `AGENT_MODEL` | `claude-sonnet-5` | Haiku 4.5 runs — the request switches to a fixed thinking budget, because adaptive thinking and the effort control are Claude 5 features and Haiku rejects them outright — but in the one run measured here it stopped after the product search without building the cart |
| `AGENT_EFFORT` | `low` | `low` \| `medium` \| `high` |

`AGENT_EFFORT` is the speed knob. Adaptive thinking runs before **every** tool
call and a basket is up to twelve of them, so a second of extra deliberation
per hop is twelve seconds the shopper spends watching *"Buscando…"*. Each hop
is a small, well-posed step with the tool schemas in front of it, which is not
work that rewards deliberation. `medium` restores what shipped before; move
this first if baskets start coming back wrong rather than slow.

### 4.2 What the turn actually costs

Two cache breakpoints, and they are not decoration — the second one is most of
the latency on a long basket.

- **The prefix**: the MCP server's instructions plus `CHANGUITO_PROMPT`, with
  the tool schemas ahead of the messages. Stable for the whole conversation,
  which is exactly why per-turn state goes in the *user* message via
  `stateBanner` and never in the system prompt.
- **The messages**, marked on the newest one, moving forward each hop. Without
  it the twelve searches in a basket are re-read twelve times: hop nine pays
  full price for everything hops one through eight already said. See
  `cacheable()` in `lib/agent/loop.ts` for the three details that keep it
  correct — a shallow copy rather than a mutation, user messages only, and a
  silent no-op below the minimum cacheable length.

`AGENT_USAGE=1` logs `cache_read` and `cache_write` per hop to the server
console, which is how you check the second one is working rather than assuming.

## Part 5 — www.changuito.me

The marketing site is a second Vercel project. It is `apps/landing`
(`@changuito/landing`), not a route inside `apps/web`. Do not point
`www.changuito.me` at the shopper project, and do not point `app.changuito.me`
at the landing.

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| Root directory | `apps/landing` |
| Install / build | defaults (install from the repo root, `next build` in this package) |
| Node.js version | **22.x** |
| Environment variables | none |

Details, including the manual install/build commands if Vercel does not detect
the workspace, are in [apps/landing/README.md](apps/landing/README.md). Locally:

```bash
npm run dev -w @changuito/landing     # http://localhost:3125
npm run build -w @changuito/landing
```
