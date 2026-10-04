# Checkout sandbox

`services/sandbox` is the part of changuito that goes to the supermarket. After
the shopper's USDC is locked in the escrow, it logs into a Día account in a
headless browser, empties the cart, adds the basket, and walks Día's checkout
**up to the payment step, and stops there**. Reaching that step is what the
resolver settles the escrow on.

**No order is placed.** Card entry is out of scope, the buttons that would
place an order are never offered, and the order/payment endpoints are aborted
at the network level. A settle means "this basket was carried to Día's
checkout". The shopper completes the purchase at Día through their own cart
link (see [Why the handoff link is the shopper's cart](#why-the-handoff-link-is-the-shoppers-cart)).

## Credit

The harness is copied from **[raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg)**
(read-only source). Its README is kept verbatim as
[`services/sandbox/UPSTREAM.md`](../services/sandbox/UPSTREAM.md) and its field
notes as [`services/sandbox/docs/dia-navigation.md`](../services/sandbox/docs/dia-navigation.md).
What changuito added: `run_job()` in `agent.py` (the CLI's run as a callable
returning a dict, with an `on_phase` callback), `server.py` (the job API), the
`Dockerfile` and `railway.json`.

## How it works

**Jev** is TypeSafe's System One model. It never generates text: at each step
the harness asks it typed questions and executes the answer.

| Question | Type | Used for |
|---|---|---|
| `next_action` | Choice over the visible controls | what to click / fill next |
| `page_kind` | Choice | what kind of page this is |
| `phase_done` | Noul | whether the current phase looks finished |
| `product_match` | Score (shop phase) | how well visible products match the item |

**Playwright** runs Chromium, builds the list of visible controls, and does
the clicking. The harness — not the model — decides when a phase is done, from
Día's own APIs:

| Phase | Done when |
|---|---|
| `login` | `/api/sessions` reports the user authenticated |
| `empty_cart` | the `orderForm` has no items |
| `shop` | each requested item raised the `orderForm` item count |
| `checkout` | the URL reaches `#/payment` → reported as phase `payment` |

A full upstream run (login + 4 items + checkout) took ~33 decisions and about
4 minutes of wall time.

## Job API

`server.py` (FastAPI). Every `/jobs` call needs `Authorization: Bearer
$SANDBOX_TOKEN`; without the variable set the server answers 503.

### `POST /jobs`

```http
POST /jobs
Authorization: Bearer <SANDBOX_TOKEN>
Content-Type: application/json

{
  "order_id": "9f2c…e1",                       // 8–128 chars; the escrow order id (hex)
  "items": [                                   // 1–25 items
    { "name": "Fideos Matarazzo 500 g", "quantity": 2, "sku": "123456" },
    { "name": "Leche La Serenísima 1 l", "quantity": 1, "sku": "654321" }
  ]
}
```

```json
{ "job_id": "3b0c8f6e2a…" }
```

Idempotent per `order_id`: a retried start returns the existing job instead of
shopping twice.

### `GET /jobs/{job_id}`

```json
{
  "job_id": "3b0c8f6e2a…",
  "order_id": "9f2c…e1",
  "status": "done",
  "phase": "payment",
  "result": {
    "status": "done",
    "phase": "payment",
    "reached_payment": true,
    "items_added": 2,
    "items_requested": 2,
    "cart": {
      "orderFormId": "a1b2…",
      "value": 6150.0,
      "items": [{ "name": "Fideos …", "qty": 1, "price": 1850.0 }]
    },
    "final_url": "https://diaonline.supermercadosdia.com.ar/checkout/#/payment",
    "wall_s": 231.4,
    "orders_blocked": 0,
    "error": null
  },
  "error": null
}
```

`status` is `queued | running | done | failed`; `phase` is `queued | login |
empty_cart | shop | checkout | payment`. `result` is present once the run
ends. An unknown job id is a 404. Finished jobs are kept for 6 hours.

### `GET /health`

```json
{ "ok": true, "busy": false, "queued": 0 }
```

No auth; Railway's healthcheck uses it.

## How the app uses it

`apps/web/lib/checkout/sandbox.ts` is the client.

| `sandboxMode()` | When | Behaviour |
|---|---|---|
| `remote` | `SANDBOX_URL` is set | real HTTP calls with `Bearer SANDBOX_TOKEN` |
| `mock` | no `SANDBOX_URL`, outside production — or in production with `SANDBOX_MOCK=1` | in-process, stateless mock: the job id encodes its start time; phases `login` 0s → `empty_cart` 4s → `shop` 7s → `checkout` 15s → `payment` 20s, then `reached_payment: true`. `SANDBOX_MOCK_FAIL=1` makes it end `failed` at checkout (the refund path) |
| `off` | production, no `SANDBOX_URL`, no `SANDBOX_MOCK` | `startJob` throws; the order is refunded on the next status poll |

The mapping into the escrow lives in `app/api/checkout/status/route.ts`:

| Sandbox says | App does |
|---|---|
| `running` / `queued` | report the phase; keep polling |
| `done` + `reached_payment` | **settle**; the sandbox `orderFormId` and job id go into the receipt hash |
| `done` without payment, or `failed` | **refund** |
| 404 (worker restarted, job lost) | treated as `failed` → **refund** |
| network error / other non-2xx | not a verdict; keep polling (the buyer can self-refund after the 1h deadline) |

The app sends `name`, `quantity` and `sku` per line; the worker currently uses
only `name` (see [limitations](#limitations)).

## Safety rules

From [`UPSTREAM.md`](../services/sandbox/UPSTREAM.md), enforced in `sandbox.py`:

- **No order is placed.** The run stops on the payment step. Controls matching
  "comprar ahora / confirmar compra / realizar pedido / pagar ahora / repetir
  pedido" are never offered to Jev. `/transaction`, `/payments`,
  `gatewayCallback` and `orderPlaced` requests are aborted at the network level
  and counted (`orders_blocked`).
- **Credentials never reach the model.** Jev sees options like "type the
  account password into its empty field"; the harness reads the value from the
  environment and types it. DNI, email and postcode are redacted from all page
  text sent to Jev and from the step log. The Playwright trace starts only
  after login.
- **No replacements.** Options that accept a substitute product are filtered;
  only "no reemplazar" reaches Jev.
- **No account actions.** Logout, registration, password recovery and account
  deletion are never offered; saved addresses cannot be deleted.
- **Host allowlist.** Only Día, `diadigital.app` (login), VTEX, Google Maps
  (delivery-location modal) and font/CDN hosts are reachable; analytics, ads
  and chat widgets are aborted.
- **Privacy caveat.** The account holder's name and street address do appear in
  page text sent to TypeSafe. Traces (only with `--trace`, CLI) contain Día's
  API responses after login, including DNI, email and address; `traces/` is
  git-ignored.

## Why one job at a time

There is one Día account. `server.py` runs a single asyncio worker over a
queue, so jobs are serialized: a second order waits in `queued` while the first
one shops. The code's stated reason is that concurrent runs on one account
would empty and fill the same cart. (The upstream field notes, §6, observe that
a VTEX cart is bound to the browser cookie rather than the account, so a fresh
context may get its own cart; concurrency on one account has not been tested,
and serializing is the conservative choice.) It also keeps one login session
and one checkout profile in use at a time.

Consequence: throughput is roughly one basket every four minutes. `settle`
has no deadline check, so a late job still settles; but past the one-hour
deadline the buyer may also self-refund, so a queue of more than about a dozen
orders starts to race the two.

## Why the handoff link is the shopper's cart

The sandbox's cart belongs to the operator's Día account. Its `orderFormId`
opens a checkout that shows that account's name, DNI, email and delivery
address. So the app never shows it: it is hashed into the settle receipt as
evidence, and the shopper gets `handoffUrl` instead — the `get_cart_link` URL
of the cart the agent built for **them** through the MCP server
(`…?orderFormId=…#/cart`), which they open and pay for in their own Día
session.

The two carts contain the same basket but are not the same object; nothing
reconciles them after the handoff.

## Limitations

- **Quantity is not applied.** The harness searches each line by name and adds
  one unit; the requested quantity is recorded on the job, not used.
- **Search is by name, not SKU.** Jev picks the best-matching card for the
  text; `product_match` scores it but it can pick a different size or brand.
- **The 15% FX buffer is not reconciled** against the envío or the real total
  seen at checkout; everything locked goes to the treasury on settle.
- **Jobs are in memory.** A restart or redeploy loses running and finished
  jobs; the app then refunds (404 → failed). That is the safe direction, but a
  basket that did reach payment just before the restart is refunded too.
- **One account, one replica.** `railway.json` pins `numReplicas: 1`; scaling
  out would give each replica its own queue on the same account.
- **Not deployed yet.** The Railway service is configured but awaits
  credentials, and the Docker image has not been built locally. The devnet
  e2e evidence in [solana.md](solana.md#evidence-transactions) used the
  in-process mock.
- **Live-site dependency.** Selectors, hosts and the Flutter login popup are
  Día's to change; the field notes are a map, not a contract.

## Deploy on Railway

The service builds from `services/sandbox/Dockerfile`:
`mcr.microsoft.com/playwright/python:v1.63.0-noble` (Chromium system
dependencies included) + `uv`, `uv sync --frozen --no-dev`, `playwright install
chromium`, then `uvicorn server:app` on `$PORT` (default 8080).
`railway.json`: Dockerfile builder, healthcheck `/health`, restart on failure,
1 replica.

1. New Railway service from this repo, root directory `services/sandbox`.
2. Set the environment:

   | Variable | Purpose |
   |---|---|
   | `TYPESAFE_API_KEY` | Jev (TypeSafe) |
   | `DIA_ARG_DNI`, `DIA_ARG_EMAIL`, `DIA_ARG_PWD` | the Día account the sandbox logs into |
   | `DIA_ARG_POSTCODE` | delivery postcode typed at checkout |
   | `SANDBOX_TOKEN` | shared bearer token with the web app (long random string) |

3. Deploy; check `GET https://<service>/health` returns `{"ok": true, …}`.
4. In the web app (Vercel) set `SANDBOX_URL=https://<service>` and the same
   `SANDBOX_TOKEN`. Unset `SANDBOX_MOCK` / `SANDBOX_MOCK_FAIL`.

## Run locally

See [`services/sandbox/README.md`](../services/sandbox/README.md).
