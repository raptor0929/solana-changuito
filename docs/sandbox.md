# Checkout sandbox

`services/sandbox` is the part of changuito that goes to the supermarket. After
the shopper's USDC is locked in the escrow, it logs into **the shopper's own
Día account** in a headless browser, empties the cart, adds the basket by SKU,
attaches the delivery address and window, opens the payment step, and pays
with **the operator's card** (`CARD_*`). The escrow settles only when Día
places the order; anything else refunds.

**The sandbox can place real orders.** It presses "Finalizar compra" only when
a card is configured (`CARD_PAN` and the rest of `CARD_*`). Without one it
stops at the payment step, the order endpoints stay aborted at the network
level, and the escrow refunds. The gate is the card itself, not a separate
flag: a flag naming a resource can outlive the resource (CLAUDE.md §5).

> **Known blocker (2026-10-10):** Día's checkout answers `POST
> /api/checkout/pub/orderForm/{id}/transaction` with **403 `CHK0082`
> "ReCAPTCHA requerido"**. The card form is filled and Pay is pressed, but the
> transaction is refused before the card is evaluated, so a real card does not
> change the outcome. Headless and headed (Xvfb) runs both got it; no
> reCAPTCHA frame loaded in either, and nothing on the allowlist was aborted
> after Pay except `telemetry.vtex.com`. The run stops after 5 refusals and
> refunds. We do not solve or bypass CAPTCHAs; the way forward is an
> integration Día's checkout accepts.

## Credit

The harness is copied from **[raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg)**
(read-only source). Its README is kept verbatim as
[`services/sandbox/UPSTREAM.md`](../services/sandbox/UPSTREAM.md) and its field
notes as [`services/sandbox/docs/dia-navigation.md`](../services/sandbox/docs/dia-navigation.md).
What changuito added: `run_job()` in `agent.py` (the CLI's run as a callable
returning a dict, with an `on_phase` callback), `server.py` (the job API),
`checkout.py` (the deterministic cart, shipping and card steps), the
`Dockerfile` and `railway.json` — and one fix to the harness itself, for Día's
delivery modal (next section).

### The delivery-type radios

After the first add, Día's delivery modal asks for "Envío a domicilio" and then
requires the **"Envío programado"** radio before `Confirmar` enables. Both
radios share `name="DeliveryType"` and carry their text only in a wrapping
`<label>`. Upstream `sandbox.py` named form fields by `name`, so the two radios
deduped to one option called "DeliveryType", and Jev looped re-clicking
"Envío a domicilio" with 0 items added; the unmodified upstream harness failed
the same way. Now radios and checkboxes take their wrapping `<label>` text as
their label (`COLLECT_JS` in `sandbox.py`), and the `shop` instruction in
`agent.py` says to select Envío programado (never Express or store pickup),
then Confirmar. With that, a two-item escrow run against a local Docker sandbox (2026-10-04)
reached `/checkout/#/payment` in 214 s, with 0 orders placed, and
[settled](https://solscan.io/tx/3akyS29xEdce7Phd7TrVaPoTzxjWaf7Uum5Xn8g9nxgRafJZmvBgN28ahm94Yu8bzoQDtmR2G9L325RSPePearWP?cluster=devnet). The field note is
in [`dia-navigation.md`](../services/sandbox/docs/dia-navigation.md) §4.

## How it works

Jev drives only what has no stable selectors; everything VTEX exposes as an
API or a label is deterministic.

| Phase | Who | How | Done when |
|---|---|---|---|
| `login` | Jev | Flutter login popup; Jev picks `fill_*` actions, the harness types the job's credentials | `/api/sessions` reports the user authenticated |
| `empty_cart` | API | `POST orderForm/{id}/items/removeAll` (Jev only if that leaves items) | the `orderForm` has no items |
| `shop` | API | `POST orderForm/{id}/items` with each line's SKU, quantity and seller (from the catalog API). Lines without a SKU, or that the store rejects, go to Jev's search-by-name loop | every line is in the `orderForm` |
| `checkout` | API | `attachments/shippingData`: the account's current address, else a saved one in the shopper's postcode, else the job's `street`/`number` at its postcode; then home delivery, the scheduled option's earliest window, else the cheapest. Then straight to `#/payment` (Jev only if VTEX bounces back) | the URL stays on `#/payment` |
| `payment` | labels | select **Tarjeta de débito** (`CARD_KIND=credit` for crédito), choose "otra tarjeta" if the account has saved cards, fill the card in VTEX's `card-ui` iframe, tick "Acepto las Políticas de Privacidad", press `#end_payment` | `orderPlaced` URL (placed), a decline message, 5× refused `/transaction`, or 90 s |

Timings from the live runs on 2026-10-10 (one SKU, Docker): login 50–63 s,
empty cart ~1 s, shop ~2.5 s, checkout ~5 s, payment 7–10 s; **66 s wall**
headless. Before this, a two-item run took 214 s and an upstream four-item run
about 4 minutes, almost all of it Jev searching by name.

What made it faster, in order of effect: SKUs through the cart API instead of
search (removes the whole Jev shop loop); shipping through the API instead of
the delivery modal; `networkidle` capped at 2 s (the Flutter popup and VTEX
poll forever, so every step used to wait the full 5 s); and a smaller Jev
payload — 1500 chars of page text instead of 3000, 3 recent actions instead
of 6, at most 120 options instead of 250.

**Jev** is TypeSafe's System One model. It never generates text: at each step
the harness asks it typed questions and executes the answer.

| Question | Type | Used for |
|---|---|---|
| `next_action` | Choice over the visible controls | what to click / fill next |
| `page_kind` | Choice | what kind of page this is |
| `phase_done` | Noul | whether the current phase looks finished |
| `product_match` | Score (shop phase) | how well visible products match the item |

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
    { "name": "Fideos Tirabuzón Favorita 500 Gr.", "quantity": 2, "sku": "61450" }
  ],
  "shopper": {                                 // optional; absent = the operator's DIA_ARG_* account
    "email": "…", "password": "…", "dni": "30123456",
    "postcode": "1425",                        // where the shopper browsed
    "street": "…", "number": "…", "phone": "…" // only used if the account has no saved address
  }
}
```

`shopper` lives on the in-memory job until the run ends and is then deleted.
`GET /jobs/{id}` never returns it, `repr()` of it prints `<redacted>`, and its
values are redacted from everything Jev reads and everything the run prints.
A job that brings a shopper never falls back to any `DIA_ARG_*` value: the
operator's account and address are never typed into somebody else's.

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
  "phase": "placed",
  "result": {
    "status": "done",
    "phase": "placed",
    "reached_payment": true,
    "payment": "placed",                       // placed | declined | not_attempted | error
    "payment_detail": "order placed",          // one redacted line; never card data
    "store_order_id": "1234567890123",         // Día's order number, when placed
    "items_added": 1,
    "items_requested": 1,
    "cart": {
      "orderFormId": "a1b2…",
      "value": 6158.0,
      "shipping_centavos": 499900,
      "items": [{ "name": "Fideos …", "quantity": 2, "price": 1159.0 }]
    },
    "final_url": "https://diaonline.supermercadosdia.com.ar/checkout/orderPlaced/?og=…",
    "wall_s": 66.3,
    "timings": { "login": 50.5, "empty_cart": 0.7, "shop": 2.4, "checkout": 5.0, "payment": 7.0 },
    "orders_blocked": 0,
    "error": null
  },
  "error": null
}
```

`status` is `queued | running | done | failed`; `phase` is `queued | login |
empty_cart | shop | checkout | payment | placed`. `done` means the walk
finished; whether money moved is `payment`. `result` is present once the run
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
| `mock` | no `SANDBOX_URL`, outside production — or in production with `SANDBOX_MOCK=1` | in-process, stateless mock: the job id encodes its start time; phases `login` 0s → `empty_cart` 4s → `shop` 7s → `checkout` 15s → `payment` 20s → `placed` 24s with `payment: "placed"`. `SANDBOX_MOCK_FAIL=1` makes the card come back `declined` (the refund path) |
| `off` | production, no `SANDBOX_URL`, no `SANDBOX_MOCK` | `startJob` throws; the order is refunded on the next status poll |

The mapping into the escrow lives in `app/api/checkout/status/route.ts`:

| Sandbox says | App does |
|---|---|
| `running` / `queued` | report the phase; keep polling |
| `done` + `payment: "placed"` | **settle**; job id, `orderFormId` and Día's order number go into the receipt hash (`basis|sandbox-order-placed`) |
| `done` with any other `payment` (declined, not attempted, error), or `failed` | **refund**, with a reason the modal shows |
| 404 (worker restarted, job lost) | treated as `failed` → **refund** |
| network error / other non-2xx | not a verdict; keep polling (the buyer can self-refund after the 1h deadline) |

The app sends `name`, `quantity` and `sku` per line, and the shopper's Día
login from the checkout modal (`/api/checkout/start`). The login is passed
through and never written to the checkout record or a log.

The quote (`/api/checkout/quote`) prices what the sandbox will be charged:
goods plus the envío from VTEX's simulation at the shopper's postal code,
picked by the same rule as the sandbox (`lib/checkout/shipping.ts` mirrors
`_pick_sla`), at belo's USDC `compra` from dolarapi (`lib/checkout/rate.ts`).

## Safety rules

Enforced in `sandbox.py` and `checkout.py`:

- **No order without a card.** Until the card is typed and `CARD_*` is set,
  `/transaction`, `/payments`, `gatewayCallback` and `orderPlaced` requests are
  aborted at the network level and counted (`orders_blocked`). Jev is never
  offered "comprar ahora / confirmar compra / realizar pedido / pagar ahora";
  only `checkout.pay` presses Pay.
- **The card is never Jev's and never logged.** `checkout.py` reads `CARD_*`
  at the moment it types and logs only which *fields* it filled. Card values
  join the redaction list, the Playwright trace is stopped before the payment
  step, and the jsonl step log follows the trace. `--record` (CLI only) is the
  one exception and says so: a video cannot skip the card form, so it is for
  test cards, and `*.webm`/`*.mp4` are git-ignored repo-wide.
- **Always the operator's card.** If the shopper's account has saved cards,
  the run asks for the new-card form; it never pays with a card saved in
  somebody's account. The cardholder document is `CARD_DNI`, not the
  shopper's DNI (falls back to the account DNI, with a log line, when unset).
- **Credentials never reach the model.** Jev sees options like "type the
  account password into its empty field"; the harness types the job's value.
  DNI, email, password, postcode, street, phone and card values are redacted
  from all page text sent to Jev and from every printed line.
- **No replacements.** Options that accept a substitute product are filtered;
  only "no reemplazar" reaches Jev.
- **No account actions.** Logout, registration, password recovery and account
  deletion are never offered; saved addresses cannot be deleted.
- **Host allowlist.** Día, `diadigital.app` (login), VTEX, Google Maps, the
  payment iframe (`vtexpayments.com.br`), Mercado Pago's secure fields and
  reCAPTCHA (`www.google.com`, `recaptcha.net`) are reachable; analytics, ads
  and chat widgets are aborted.
- **Privacy caveat.** The account holder's name and street address appear in
  page text sent to TypeSafe during login. Traces (`--trace`, CLI) contain
  Día's API responses after login; `traces/` is git-ignored.

## Why one job at a time

`server.py` runs a single asyncio worker over a queue, so jobs are
serialized: a second order waits in `queued` while the first one shops. With
shopper accounts the cart is no longer shared, but there is still one browser
and one card. The original reason was that concurrent runs on one account
would empty and fill the same cart. (The upstream field notes, §6, observe that
a VTEX cart is bound to the browser cookie rather than the account, so a fresh
context may get its own cart; concurrency on one account has not been tested,
and serializing is the conservative choice.) It also keeps one login session
and one checkout profile in use at a time.

Consequence: throughput is roughly one basket a minute or two. `settle`
has no deadline check, so a late job still settles; but past the one-hour
deadline the buyer may also self-refund, so a queue of more than about a dozen
orders starts to race the two.

## Why the order is in the shopper's account

The first version bought in the operator's Día account and handed the shopper
a link to their own cart to pay for themselves. Now the sandbox logs into the
shopper's account, so the order, its delivery address and its tracking are
theirs, and the operator's card pays for it. The shopper's cart link
(`handoffUrl`) is still recorded but no longer shown after a purchase: once
Día places the order there is nothing left to finish.

## Limitations

- **reCAPTCHA blocks the transaction** (`CHK0082`); see the note at the top.
  Until that is resolved no order is placed and every run refunds.
- **The quote is a quote.** The envío and prices can move between quote and
  run; the card pays what Día charges then. `QUOTE_BUFFER` (web) adds slack.
  Pricing at belo's `compra` means the treasury absorbs the compra/venta
  spread (about 1.6%).
- **Día login can ask for more.** An OTP or a CAPTCHA on login fails the job
  (refund).
- **Name search is a fallback only.** Lines without a SKU still go through
  Jev's search, which adds one unit and can pick a different size or brand.
- **Jobs are in memory.** A restart or redeploy loses running and finished
  jobs; the app then refunds (404 → failed). That is the safe direction, but a
  basket that did reach payment just before the restart is refunded too.
- **One account, one replica.** `railway.json` pins `numReplicas: 1`; scaling
  out would give each replica its own queue on the same account.
- **Not deployed to Railway yet.** The service is configured but awaits
  credentials; it runs locally in Docker, where a one-item run reached the
  payment step. Larger baskets have not been run live. The devnet e2e
  evidence in [solana.md](solana.md#evidence-transactions) used the
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
   | `SANDBOX_TOKEN` | shared bearer token with the web app (long random string) |
   | `CARD_PAN`, `CARD_EXPIRY_MONTH`, `CARD_EXPIRY_YEAR`, `CARD_CVV`, `CARD_NAME` | the card every order is paid with. All five or none: none means no order is ever placed |
   | `CARD_DNI` | the cardholder's document, asked by Día's card form |
   | `CARD_KIND` | `debit` (default) or `credit`: which payment group to use |
   | `DIA_ARG_DNI`, `DIA_ARG_EMAIL`, `DIA_ARG_PWD`, `DIA_ARG_POSTCODE` | optional: the account a job without `shopper` uses (local testing) |

3. Deploy; check `GET https://<service>/health` returns `{"ok": true, …}`.
4. In the web app (Vercel) set `SANDBOX_URL=https://<service>` and the same
   `SANDBOX_TOKEN`. Unset `SANDBOX_MOCK` / `SANDBOX_MOCK_FAIL`.

## Run locally

See [`services/sandbox/README.md`](../services/sandbox/README.md).
