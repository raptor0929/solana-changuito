# changuito sandbox

A worker that logs into one Día account, fills the cart with an escrowed basket,
and walks checkout **up to the payment step, then stops**. No order is placed.
The web app starts a job after the shopper's USDC is locked, polls it, and
settles or refunds the escrow on the result.

Design, job API, safety rules, limitations and Railway deploy:
[`docs/sandbox.md`](../../docs/sandbox.md).

## How a run works

| Phase | Driver | Done when |
|---|---|---|
| `login` | Jev picks the next field or button; **the sandbox types the secrets** (`sandbox.py`) | the store's session API says authenticated |
| `empty_cart` | the store's orderForm API, no model | the orderForm has no items |
| `shop` | the orderForm API, **by SKU and quantity**, no model. A line without a SKU is searched by name with Jev Ultrafast | the orderForm holds the lines |
| `checkout` | [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) in its own tab (`ultrafast.py`) | the URL reaches `#/payment` |

One Chromium (Debian's, no Playwright) runs with remote debugging on loopback.
`cdp.py` launches it and talks CDP for login and the cart APIs. Ultrafast
connects to the same port through Browser Harness.

Three guarantees hold whatever any model chooses:

- **No order is placed.** `cdp.py` attaches to every target the browser opens,
  including Ultrafast's tab and the login popup, before its first request, and
  fails order or payment requests and any host off the allowlist
  (`rules.py`). `selfcheck.py` proves it against a real Chromium.
- **No model sees or types a credential.** Login never goes through Ultrafast:
  it would type the password with its text model and then send it back to Jev
  in its action history. The DNI, email, postal code and password are redacted
  from everything Ultrafast observes.
- **Some controls are never offered** (close session, delete account, place the
  order, replace a product). `rules.offered` filters them out of both drivers'
  observations.

Each job returns `wall_s` and per-phase `timings`, so a run's speed is measured
rather than estimated.

## Credit

The login loop and the page scripts in `sandbox.py` come from
[raptor0929/jev-dia-arg](https://github.com/raptor0929/jev-dia-arg). Its README
is kept as [`UPSTREAM.md`](UPSTREAM.md) and its field notes as
[`docs/dia-navigation.md`](docs/dia-navigation.md). Checkout runs on
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT),
pinned to one commit in `pyproject.toml`. changuito added the job API in
`server.py`, the CDP layer and guard in `cdp.py`, the Ultrafast wrapper, the
`Dockerfile` and `railway.json`.

The radios fix from upstream stays: Día's delivery modal needs the "Envío
programado" radio before `Confirmar` enables, radios are labelled by their
wrapping `<label>`, and both drivers are told to pick Envío programado.

## Run locally

Python 3.12, [uv](https://docs.astral.sh/uv/) and a Chromium or Chrome
(`CHROME_PATH` if it is not on the PATH). Or use Docker, below.

```sh
cd services/sandbox
uv sync
```

Copy [`.env.example`](.env.example) to `.env` (git-ignored) and fill it in.
Every variable is annotated there.

Check the guard first. It needs no credentials:

```sh
uv run python selfcheck.py        # "guard OK"
```

Job API:

```sh
uv run --env-file .env uvicorn server:app --port 8080
curl localhost:8080/health
curl -X POST localhost:8080/jobs \
  -H "Authorization: Bearer $SANDBOX_TOKEN" -H 'content-type: application/json' \
  -d '{"order_id":"local-test-0001","items":[{"name":"Leche Entera DIA Larga Vida 1 Lt.","quantity":1,"sku":"608"}]}'
curl -H "Authorization: Bearer $SANDBOX_TOKEN" localhost:8080/jobs/<job_id>
```

Point the web app at it with `SANDBOX_URL=http://localhost:8080` and the same
`SANDBOX_TOKEN`. Without `SANDBOX_URL` the web app uses an in-process mock
instead (`apps/web/lib/checkout/sandbox.ts`).

### Docker

```sh
docker build -t changuito-sandbox services/sandbox
docker run --rm --ipc=host changuito-sandbox uv run python selfcheck.py
docker run --rm -p 8080:8080 --ipc=host --env-file services/sandbox/.env changuito-sandbox
```

## CLI

```sh
uv run --env-file .env agent.py --sku 608:1 --sku 285597:2   # by SKU:QUANTITY
uv run --env-file .env agent.py --list "fideos, jamón"       # by name, searched
uv run --env-file .env agent.py --headed --sku 608:1         # watch it
```

The step log prints Jev's login choices and Ultrafast's checkout steps with
their latency, then the per-phase timings.
