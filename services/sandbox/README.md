# changuito sandbox

A Jev + Playwright worker that logs into the shopper's Día account, fills the
cart with an escrowed basket by SKU, picks the delivery, and pays with the
operator's card. The service holds neither: each job brings the shopper's
login (their encrypted profile in the web app) and the card (the web app's
`shared_card` row). A job without a card stops at the payment step. The web
app starts a job after the shopper's USDC is locked, polls it, and settles
the escrow only when Día places the order.

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

Copy [`.env.example`](.env.example) to `.env` (git-ignored) and fill in the two
variables there: the TypeSafe key and `SANDBOX_TOKEN`.

The usual way to drive it is the web app: point it at the service with
`SANDBOX_URL=http://localhost:8080` and the same `SANDBOX_TOKEN`, turn the mock
off (`npm run config -- set sandbox_mock false`), and every checkout sends the
shopper's profile and the `shared_card` row.

Docker is the simplest way to run it: the image carries Chromium, so nothing
browser-related is installed on your machine.

```sh
cd services/sandbox
docker build -t changuito-sandbox .
docker run --rm --env-file .env -p 8080:8080 changuito-sandbox
```

## CLI

For a run without the web app, write the job's `shopper` and optional `card`
to a JSON file, in the same shapes as `POST /jobs`, and keep it out of git
(`traces/` is ignored):

```json
{
  "shopper": { "email": "…", "password": "…", "dni": "30123456", "postcode": "1425" },
  "card": { "pan": "…", "cvv": "…", "exp_month": "07", "exp_year": "29", "holder": "…", "kind": "debit" }
}
```

```sh
docker run --rm --env-file .env -e PYTHONUNBUFFERED=1 -v "$PWD/traces:/app/traces" \
  -v "$PWD/agent.py:/app/agent.py" -v "$PWD/checkout.py:/app/checkout.py" -v "$PWD/sandbox.py:/app/sandbox.py" \
  changuito-sandbox uv run python agent.py --job traces/job.json --list "Fideos Tirabuzón Favorita 500 Gr." --skus 61450
```

Headed on a virtual display, with a video in `traces/video/`. The video shows
the card being typed, so use it with test cards only and delete it after
(`*.webm` is git-ignored repo-wide). Start Xvfb yourself: `xvfb-run` hangs as
a container's PID 1.

```sh
docker run --rm --init --env-file .env -e PYTHONUNBUFFERED=1 -v "$PWD/traces:/app/traces" changuito-sandbox \
  sh -c 'Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/dev/null 2>&1 & export DISPLAY=:99; sleep 1;
         uv run python agent.py --job traces/job.json --headed --record --list "…" --skus …'
```

`--trace` saves a Playwright trace from login to the payment step, never the
card (`uv run playwright show-trace traces/run-<ts>.zip`). Traces contain the
Día account's personal data after login. Do not share them.

Without Docker: Python 3.12 and [uv](https://docs.astral.sh/uv/), then
`uv sync && uv run playwright install chromium`.
