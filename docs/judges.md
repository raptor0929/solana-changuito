# Reviewing changuito

A path through the repo for someone with fifteen minutes, and the evidence for
every claim the submission makes. Nothing here asks you to take our word for
something — each row points at a file, a command, or a devnet transaction.

Read [§4](#4-what-is-real-and-what-is-not) before anything else if you only
read one section. It states what is simulated, by us, before you find it.

---

## 0. Submission facts

| | |
|---|---|
| **Live app** | [app.changuito.me](https://app.changuito.me). Everything below is verifiable from a local clone, which is the build this document describes |
| **Marketing site** | [www.changuito.me](https://www.changuito.me) |
| **Repository** | [github.com/tote-hq/solana](https://github.com/tote-hq/solana), branch `main` — MIT. The Stellar build lives in [tote-hq/stellar](https://github.com/tote-hq/stellar); only Solana work lands here, and PRs labeled `shared` are mirrored between the two |
| **Built by** | [SimonethG](https://www.linkedin.com/in/simonethg/) and [Fabio](https://www.linkedin.com/in/fabio-laura-yavi/), in Argentina |
| **Cluster** | Solana **devnet** only. There is no mainnet configuration in the code |
| **What is on-chain** | an Anchor escrow: the shopper locks USDC, the backend resolver settles it to a treasury or refunds it. Every order is an account you can read |
| **Program** | `changuito_escrow` [`BFa1gZL9…vLz9d`](https://solscan.io/account/BFa1gZL9kVVo8Mq5gaDRM5RiCG4NDiyHLbpymfXvLz9d?cluster=devnet) — Anchor 0.32, source in [`anchor/programs/changuito_escrow`](../anchor/programs/changuito_escrow) |
| **USDC** | our own devnet mint, 6 decimals, [`BZ6CHGyR…MELG85`](https://solscan.io/account/BZ6CHGyRnuuGRxDmd1bCFdeUTCJGcGcWtUct1NMELG85?cluster=devnet). The resolver is its mint authority; the in-app faucet hands out 50 at a time |
| **Wallet** | Privy (`@privy-io/react-auth` 3.47.0): email or Google login creates an embedded Solana wallet that only signs. The server's resolver key pays the `open` fee and co-signs only the exact transaction it built, so a shopper needs no prior wallet and no SOL for fees |
| **Pitch video** | sources in [`creatives/`](../creatives) (Remotion). No hosted link in this repo — `npm run render` in any of those folders produces the mp4 |

## 1. The one-paragraph version

An Argentine supermarket sells in pesos through its own website. Somebody
holding dollars on-chain cannot pay with them, and the gap is not a swap — it is
the last mile: picking products, building a cart, getting through a checkout
that wants an account and a postcode.

changuito is a chat agent that shops a real store (Día) over
[MCP](https://modelcontextprotocol.io). When the basket is ready, the shopper
signs in with an email, locks the USDC equivalent in a Solana escrow, and a
browser agent walks the store's real checkout with that basket. If it reaches
the payment step, the escrow settles; if it does not, the escrow refunds. Either
outcome is a devnet transaction the shopper gets a Solscan link for.

## 2. Fifteen minutes, in order

| Minutes | Do this | What it shows |
|---|---|---|
| 0–3 | Run the app locally ([§5](#5-verify-it-yourself)) and ask for a basket in Spanish — *"armá un desayuno por menos de $10.000"* | The agent is driving a real store. Prices and stock are Día's, live |
| 3–6 | Press *Pagar*: **Entrar → Bloquear USDC → Comprar**. Sign in with an email, press *Cargar 50 USDC de prueba*, lock | Privy login, an `open` transaction the buyer signs and the resolver pays the fee for, then the shopping phases ticking by. Ends in *¡Compra completada!* with Solscan links for *Bloqueo* and *Liberación* |
| 6–9 | Read [`anchor/programs/changuito_escrow/src/lib.rs`](../anchor/programs/changuito_escrow/src/lib.rs) | The whole money rail: `initialize`, `open`, `settle`, `refund`. One file |
| 9–12 | Read [`apps/web/app/api/checkout/`](../apps/web/app/api/checkout/) — `quote`, `start`, `status` | How the server refuses to start shopping until the chain says the order is funded, and how it decides settle vs refund |
| 12–15 | Run `scripts/devnet-e2e.mts` ([§5](#5-verify-it-yourself)) | Both paths end to end on devnet, without a browser, printing Solscan links |

## 3. Claim → evidence

| The claim | Where to check it |
|---|---|
| The escrow is deployed and initialized on devnet | deploy [`4rNtLVRC…`](https://solscan.io/tx/4rNtLVRC8iQzHcnXVweNUkJ8yQYV4dBvnpw1rVKJQDFHNJRosMnWW3VuCE1FpFRuDjiVmQXNK7ycZvt73PoS6ixz?cluster=devnet) · initialize [`3ZQa77Kf…`](https://solscan.io/tx/3ZQa77Kf83ddFtxG4oxxbWSAYCELEytnvwqzZVQkCxEuuixj45BAkjccZyfrnm6gEYsmj4iaee61ErXnWvyCNG6E?cluster=devnet) · Config PDA [`BCcorb5C…`](https://solscan.io/account/BCcorb5CVL86uDQQT4fBusAcobXugFfTTM6ypL4bDBPh?cluster=devnet). Recorded in [`apps/web/lib/deployments.ts`](../apps/web/lib/deployments.ts) (`EVIDENCE`) |
| Settle and refund both work on the deployed program | smoke settle [`2Bmuhoev…`](https://solscan.io/tx/2Bmuhoev9j1HMFgi7RZ8mvsyvGt89CKwCNpvmc38NQnZhi2gsUPxYmjehgBtKrVSNZqxcfGuDn4CgH7BMbcr5o3B?cluster=devnet) · smoke refund [`3yvsvRXi…`](https://solscan.io/tx/3yvsvRXiV5Zue4rLPWhrBUpZMRyjJc2mAKsDHyzFLvTn7SxpV4ExqKh6rNMiT4Z9JusbzHsZB9ZFzTM9fsApYYpW?cluster=devnet), run by [`scripts/solana-init.mts`](../scripts/solana-init.mts) after deploy |
| The app's own routes drive the full settle path | faucet [`36qKsuaG…`](https://solscan.io/tx/36qKsuaGykkY9NyrkGG4PKNArByv6fXJtf5bBNNj2sUoQ1cV7DGebdqZJnLXmkdEncZjkRoncaCFDeo6zWUzgqzL?cluster=devnet) → open [`5aShGUf3…`](https://solscan.io/tx/5aShGUf3h1cJvNuLDUNZXjpBCBEf18bHkq8GpkcnN1D4yJaumBfNJkqNacRqMkBYq7r4FvEtnrTK1ZyRAyLze35Z?cluster=devnet) → settle [`32qUpErt…`](https://solscan.io/tx/32qUpErth2AG72KvXPCNSDX5NY9ftwsaH7u6SYSpZaB3N6b6Kz8csjhAWpNckTdsEkH53HPBQk2eySDrsjGR9a4K?cluster=devnet): 5.06 USDC for a $6.150 ARS basket at 1400 ARS/USD plus 15%. Produced by [`scripts/devnet-e2e.mts`](../scripts/devnet-e2e.mts) |
| …and the refund path | open [`2vaNKpBu…`](https://solscan.io/tx/2vaNKpBuuYbnfgT3gaZwr2gwcKbYLjgrP2dfAZBzr2PgheuXuHEDedVSkoHdhL6ZDsW88mofSZPjkyFKYvDXHbCZ?cluster=devnet) → refund [`244i1Squ…`](https://solscan.io/tx/244i1SqumYySTLBSFkEnPRN6KFEqBDWNEC9GQfPU9zEdsouRYVuwdPgtAGYMVY2BULq8KoEsPruPCqrDMyYVExKP?cluster=devnet), same script with `SANDBOX_MOCK_FAIL=1` on the server |
| Only the resolver can move locked funds before the deadline; the buyer can reclaim after it | `settle` and `refund` account constraints in [`lib.rs`](../anchor/programs/changuito_escrow/src/lib.rs) (`NotAuthorized`) |
| Settle only pays out the basket that was locked | `settle` takes the basket hash and fails with `BasketMismatch` if it differs from the one stored at `open` |
| An order cannot be closed twice | the program refuses a non-open order (`OrderClosed`); [`apps/web/app/api/checkout/status/route.ts`](../apps/web/app/api/checkout/status/route.ts) also reads chain status first and holds an in-process guard |
| Shopping does not start until the chain says the order is funded | [`apps/web/app/api/checkout/start/route.ts`](../apps/web/app/api/checkout/start/route.ts) — reads the Order PDA and requires buyer = signed-in wallet, status open, amount ≥ quote, basket hash = quote |
| The chain is the record of orders | *Mis compras* is `getProgramAccounts` filtered by buyer ([`apps/web/app/api/checkout/orders/route.ts`](../apps/web/app/api/checkout/orders/route.ts)). There is no orders table |
| The server knows who you are | [`apps/web/lib/privy-server.ts`](../apps/web/lib/privy-server.ts) verifies the Privy access token against Privy's JWKS with `jose`, then [`lib/session-issue.ts`](../apps/web/lib/session-issue.ts) mints an HMAC-signed httpOnly cookie for the linked Solana wallet |
| It is a real MCP server, spoken over the real protocol | [`apps/web/lib/mcp/boot.ts`](../apps/web/lib/mcp/boot.ts) — `InMemoryTransport.createLinkedPair()`, so `initialize` / `tools/list` / `tools/call` actually happen |
| The supermarket integration is not a mock | [`packages/mcp/`](../packages/mcp) — four Argentine VTEX chains, written before this app existed (see [§7](#7-prior-work)) |
| The model cannot put a wrong price on screen | [`apps/web/lib/agent/render-tools.ts`](../apps/web/lib/agent/render-tools.ts) — render tools take **identifiers only**. A hallucinated price has no argument to travel in |
| The browser agent cannot complete a purchase | [`services/sandbox`](../services/sandbox): it is never offered *comprar / confirmar / pagar*, and order and payment endpoints are aborted at the network level. See [sandbox.md](sandbox.md) |

## 4. What is real, and what is not

Stated plainly, because a judge finding this out unaided is worse than a judge
being told.

| | Status |
|---|---|
| The supermarket catalogue and cart | **Real.** Día's own API, live prices and stock |
| The escrow, the lock, settle and refund | **Real, on devnet.** Every step is a transaction with a link |
| The USDC | **Our own devnet mint**, handed out by the in-app faucet. Not Circle's USDC, no value |
| Gas | **Fees paid by the resolver** (a server hot key, so it must be kept topped up with devnet SOL). Rent is the buyer's: the faucet also sends 0.01 SOL when the wallet is below 0.006, which covers the ~0.004 SOL of rent for the order and vault accounts |
| **A placed order at Día** | **Not done.** The sandbox walks the real checkout with the basket and **stops at the payment step**. Card entry is out of scope. Settle means "the agent proved it could get this basket to checkout"; the shopper finishes at Día through their own cart link |
| Where settled USDC goes | **To a treasury we hold**, which does not pay Día. The amount is the store's price plus its delivery fee at Belo's USDC rate, confirmed by the shopper before locking. A demo simplification |
| The checkout robot | **Runs on one operator Día account**, one job at a time, jobs held in memory. It adds one unit per line (quantity is recorded, not applied yet) and searches by name |
| Sandbox deployment | **Not deployed to Railway yet.** It runs locally in Docker, and a two-item escrow run against Día reached the payment step (214 s, 0 orders placed) and [settled](https://solscan.io/tx/3akyS29xEdce7Phd7TrVaPoTzxjWaf7Uum5Xn8g9nxgRafJZmvBgN28ahm94Yu8bzoQDtmR2G9L325RSPePearWP?cluster=devnet). On any build without `SANDBOX_URL`, an in-process mock plays the phases (0/4/7/15/20 s). The other settle/refund transactions above were produced against the mock |

### What is not done, as a list

- No order is placed at Día, and no merchant is paid.
- Settle and refund happen only while the checkout dialog is open and polling
  `/api/checkout/status`. Closing it leaves the order Open on chain. The program
  lets the buyer refund after the deadline (default one hour), but there is **no
  button for it and no server-side sweeper** yet.
- A sandbox 5xx or network error keeps polling rather than refunding; only a
  failed job, a job that finished without reaching payment, or a lost job (404)
  refunds.
- Settle returns the vault's rent to the buyer; the Order account (~0.002 SOL)
  stays open as the record.
- The receipt hash stored at settle cannot be re-derived by a third party yet:
  its input includes a settle timestamp that is not returned or stored.
- The receipt card's store link opens Día's order list, where there will be no
  order (see the first point).
- The program has **no Rust test suite**. It is verified by the devnet smoke
  run after each deploy and by `devnet-e2e`.
- Config is one-time: no admin instruction to rotate the resolver or treasury.
  Redeploying with a new mint needs a manual mint creation and edits to
  `scripts/solana-init.mts` (addresses are hard-coded there).
- The Playwright suites under `e2e/` still assert the previous wallet's login
  modal and will fail until they are rewritten for Privy, and some web unit
  tests are stale from the previous build ([§5](#5-verify-it-yourself)).

## 5. Verify it yourself

**Read the chain.** Every link in §3 opens on Solscan. To read an order account
directly, any Solana CLI works:

```bash
solana account BCcorb5CVL86uDQQT4fBusAcobXugFfTTM6ypL4bDBPh --url devnet   # Config: resolver, treasury, mint
solana program show BFa1gZL9kVVo8Mq5gaDRM5RiCG4NDiyHLbpymfXvLz9d --url devnet
```

**Run both checkout paths in five minutes.** Needs Node 22.12+, and the
resolver's keypair (it signs the faucet, settle and refund — ask us, or deploy
your own per [DEPLOY.md](../DEPLOY.md)).

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
# set SOLANA_RESOLVER_SECRET (and ANTHROPIC_API_KEY if you also want the chat)

npm run dev                                                  # terminal 1, http://localhost:3124
node --experimental-strip-types scripts/devnet-e2e.mts      # terminal 2
```

The script generates a throwaway keypair in place of the Privy wallet, mints a
session cookie with the dev secret, then runs **faucet → quote → open → start →
poll status** and prints each Solscan link. The mock sandbox reaches payment in
about 20 seconds and the order settles. Restart the dev server with
`SANDBOX_MOCK_FAIL=1` and run it again for the refund path.

Leave `CHG_SESSION_SECRET` **and** `TURNSTILE_SECRET_KEY` unset in
`.env.local` for this. The script signs its cookie with the dev session secret,
and the dev server falls back to the Turnstile secret before that constant (and
a set Turnstile secret would also put the human gate in front of the routes).
Alternatively export the same `CHG_SESSION_SECRET` in terminal 2.

**The suites:**

```bash
npm test -w @changuito/mcp
npm test -w @changuito/web
npm run typecheck -w @changuito/web
npm run build
```

None needs an API key. Be aware that some web tests are stale: they still
describe the previous build's deposit, card and copy, and fail. They are left
unedited on purpose — tests in this repo are not changed to make a port pass —
and are listed in the PR.

## 6. Questions we expect, answered

**Why settle when no order is placed?**
Because the hard part we can prove today is the last mile: the agent took a
basket chosen in chat, and a browser agent got that exact basket through a real
store's checkout to the payment step, on the shopper's escrowed money. Placing
the order needs a payment instrument Día accepts, which is a card, which is out
of scope for a hackathon. The settle is honest about what it means: the receipt
hash it stores includes `sandbox-reached-payment`, the job id and the store's
cart id.

**Why an escrow rather than a transfer?**
So a failure costs the shopper nothing. Funds sit in a PDA-owned vault until the
outcome is known, and the only two exits are to the treasury for the basket that
was locked, or back to the buyer.

**Why Privy?**
A grocery shopper does not have a wallet. Email or Google login creates one.
The resolver pays the fee for `open`, so the first transaction does not need
SOL bought somewhere else, and it co-signs only the exact message the server
built for that quote. The faucet covers the rent, which stays the buyer's.

**Is the AI load-bearing, or decoration?**
Load-bearing, and constrained: the model decides *which* products to surface and
*what* to say, and it is structurally prevented from deciding what anything
costs. The checkout robot (Jev) answers typed questions — pick one of these, yes
or no, score this — and never generates text; the harness executes its choice.

**Why so much reasoning in comments?**
Because comments sit next to the code that would otherwise be undone.
[`CLAUDE.md`](../CLAUDE.md) is the long-form version for the agent.

## 7. Prior work

- The repository started on 2026-09-12.
- [`packages/mcp`](../packages/mcp) (supermercado-mcp: VTEX search and cart tools
  for Día, Carrefour, Disco and Jumbo) predates the hackathon and was vendored in.
- The app was first built on another chain with a different wallet and payment
  rail. This repository ports it to Solana: the Anchor program,
  the Privy login, the checkout routes, the faucet and the sandbox integration
  are new in it. The chat agent and the MCP layer carried over.
- The sandbox harness in [`services/sandbox`](../services/sandbox) is copied from
  [raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg) and
  credited in `UPSTREAM.md`; this repo added the HTTP service and job runner
  around it.

---

## Reaching us

Issues and pull requests on the repository. If something in this document does
not match what you find, that is a bug in the document and worth filing.
