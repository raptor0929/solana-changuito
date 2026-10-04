# changuito sandbox

A Jev + Playwright worker that logs into one Día account, fills the cart with
an escrowed basket, and walks checkout **up to the payment step, then stops**.
No order is placed. The web app starts a job after the shopper's USDC is
locked, polls it, and settles or refunds the escrow on the result.

Design, job API, safety rules, limitations and Railway deploy:
[`docs/sandbox.md`](../../docs/sandbox.md).

## Credit

The harness (`agent.py`, `sandbox.py`) comes from
[raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg). Its README
is kept as [`UPSTREAM.md`](UPSTREAM.md) and its field notes as
[`docs/dia-navigation.md`](docs/dia-navigation.md). changuito added `run_job()`
in `agent.py`, the job API in `server.py`, the `Dockerfile` and `railway.json`.

`sandbox.py` and `agent.py` also differ from upstream by one fix: Día's
delivery modal needs the "Envío programado" radio before `Confirmar` enables,
and upstream labelled radios by their `name` (`DeliveryType`), so both
delivery options collapsed into one and the run looped. Radios and checkboxes
now take their wrapping `<label>` text, and the `shop` instruction says to pick
Envío programado. Details in
[`docs/sandbox.md`](../../docs/sandbox.md#the-delivery-type-radios).

## Run locally

Python 3.12 and [uv](https://docs.astral.sh/uv/).

```sh
cd services/sandbox
uv sync
uv run playwright install chromium
```

Create `services/sandbox/.env` (git-ignored):

```sh
TYPESAFE_API_KEY=…
DIA_ARG_DNI=…
DIA_ARG_EMAIL=…
DIA_ARG_PWD=…
DIA_ARG_POSTCODE=…
SANDBOX_TOKEN=some-long-random-string
```

Job API:

```sh
uv run --env-file .env uvicorn server:app --port 8080
curl localhost:8080/health
curl -X POST localhost:8080/jobs \
  -H "Authorization: Bearer $SANDBOX_TOKEN" -H 'content-type: application/json' \
  -d '{"order_id":"local-test-0001","items":[{"name":"fideos","quantity":1}]}'
curl -H "Authorization: Bearer $SANDBOX_TOKEN" localhost:8080/jobs/<job_id>
```

Point the web app at it with `SANDBOX_URL=http://localhost:8080` and the same
`SANDBOX_TOKEN`. Without `SANDBOX_URL` the web app uses an in-process mock
instead (`apps/web/lib/checkout/sandbox.ts`).

## CLI

The upstream CLI still works:

```sh
uv run --env-file .env agent.py --headed                       # watch it
uv run --env-file .env agent.py --trace --list "fideos, jamón, queso"
uv run playwright show-trace traces/run-<ts>.zip               # replay (starts after login)
```

Traces contain the Día account's personal data after login. Do not share them.
