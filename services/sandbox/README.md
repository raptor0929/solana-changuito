# changuito sandbox

A Jev + Playwright worker that logs into the shopper's Día account, fills the
cart with an escrowed basket by SKU, picks the delivery, and pays with the
operator's card (`CARD_*`). Without a card it stops at the payment step. The
web app starts a job after the shopper's USDC is locked, polls it, and
settles the escrow only when Día places the order.

Design, job API, safety rules, limitations and Railway deploy:
[`docs/sandbox.md`](../../docs/sandbox.md).

## Credit

The harness (`agent.py`, `sandbox.py`) comes from
[raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg). Its README
is kept as [`UPSTREAM.md`](UPSTREAM.md) and its field notes as
[`docs/dia-navigation.md`](docs/dia-navigation.md). changuito added `run_job()`
in `agent.py`, the job API in `server.py`, the deterministic cart, shipping
and card steps in `checkout.py`, the `Dockerfile` and `railway.json`.

`sandbox.py` and `agent.py` also differ from upstream by one fix: Día's
delivery modal needs the "Envío programado" radio before `Confirmar` enables,
and upstream labelled radios by their `name` (`DeliveryType`), so both
delivery options collapsed into one and the run looped. Radios and checkboxes
now take their wrapping `<label>` text, and the `shop` instruction says to pick
Envío programado. Details in
[`docs/sandbox.md`](../../docs/sandbox.md#the-delivery-type-radios).

## Run locally

Copy [`.env.example`](.env.example) to `.env` (git-ignored) and fill it in:
the TypeSafe key, `SANDBOX_TOKEN`, the card, and a Día account for local
runs. Every variable is annotated there.

Docker is the simplest way: the image carries Chromium, so nothing
browser-related is installed on your machine. The code is mounted, so edits
need no rebuild.

```sh
cd services/sandbox
docker build -t changuito-sandbox .
docker run --rm --env-file .env -e PYTHONUNBUFFERED=1 \
  -v "$PWD/agent.py:/app/agent.py" -v "$PWD/checkout.py:/app/checkout.py" -v "$PWD/sandbox.py:/app/sandbox.py" \
  changuito-sandbox uv run python agent.py --list "Fideos Tirabuzón Favorita 500 Gr." --skus 61450
```

Headed on a virtual display, with a video in `traces/video/`. The video shows
the card being typed, so use it with test cards only and delete it after
(`*.webm` is git-ignored repo-wide). Start Xvfb yourself: `xvfb-run` hangs as
a container's PID 1.

```sh
docker run --rm --init --env-file .env -e PYTHONUNBUFFERED=1 -v "$PWD/traces:/app/traces" changuito-sandbox \
  sh -c 'Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/dev/null 2>&1 & export DISPLAY=:99; sleep 1;
         uv run python agent.py --headed --record --list "…" --skus …'
```

Without Docker: Python 3.12 and [uv](https://docs.astral.sh/uv/), then
`uv sync && uv run playwright install chromium`.

Job API:

```sh
uv run --env-file .env uvicorn server:app --port 8080
curl localhost:8080/health
curl -X POST localhost:8080/jobs \
  -H "Authorization: Bearer $SANDBOX_TOKEN" -H 'content-type: application/json' \
  -d '{"order_id":"local-test-0001","items":[{"name":"fideos","quantity":2,"sku":"61450"}]}'
curl -H "Authorization: Bearer $SANDBOX_TOKEN" localhost:8080/jobs/<job_id>
```

A job without `shopper` logs into the `DIA_ARG_*` account. Point the web app
at it with `SANDBOX_URL=http://localhost:8080` and the same `SANDBOX_TOKEN`.
Without `SANDBOX_URL` the web app uses an in-process mock instead
(`apps/web/lib/checkout/sandbox.ts`).

## CLI

```sh
uv run --env-file .env agent.py --list "fideos" --skus 61450   # by SKU: the fast path
uv run --env-file .env agent.py --headed                       # watch it
uv run --env-file .env agent.py --trace --list "fideos, jamón, queso"
uv run playwright show-trace traces/run-<ts>.zip               # replay: login to payment step, never the card
```

Traces contain the Día account's personal data after login. Do not share them.
