> **This is the upstream README, kept for credit.** Here the sandbox no longer
> uses Playwright: login runs on a CDP layer (`cdp.py`, `sandbox.py`), the cart
> is filled through the store's API, and checkout runs on Jev Ultrafast. See
> [README.md](README.md).

# Jev on Dia Argentina: login → cart → checkout (stops before card details)

Jev (TypeSafe's System One model) drives a sandboxed Playwright browser on
diaonline.supermercadosdia.com.ar using your real account. A run goes through four phases:

| phase | Jev picks | the harness decides it is done when |
|---|---|---|
| `login` | Ingresar, the fill actions, Continuar | the popup has closed and `/api/sessions` reports the user authenticated |
| `empty_cart` | trash / remove buttons | `orderForm` has no items |
| `shop` | search, then `Agregar` on the best-matching card | the `orderForm` item count goes up |
| `checkout` | continue buttons, delivery options and window | the URL reaches `#/payment` |

At each step Jev answers `next_action` (a Choice over the visible controls), `page_kind` (a Choice), `phase_done` (a Noul) and, while shopping, `product_match` (a Score).
Jev never types text. The only typed values are the search terms from `--list` and the secrets the sandbox fills in.

## Setup
```
uv sync
uv run playwright install chromium
```
`../.env` (in `changuito/`, git-ignored) must define `TYPESAFE_API_KEY`, `DIA_ARG_DNI`, `DIA_ARG_EMAIL`, `DIA_ARG_PWD` and `DIA_ARG_POSTCODE`.

## Run
```
uv run --env-file ../.env agent.py --headed                 # watch it (slowed down, with an on-page banner)
uv run --env-file ../.env agent.py --trace                  # headless; saves a trace and a step log
uv run --env-file ../.env agent.py --headed --trace --list "fideos, jamón, queso, nuggets"
uv run playwright show-trace traces/run-<ts>.zip            # replay (starts after login)
```
`traces/run-<ts>.jsonl` has one line per step with the redacted page state, the options, every answer and probability, and the latency.
Other flags: `--max-steps 60`, `--min-confidence`, `--model`, `--hold`.

## Safety
- **No order is placed.**
  - The run stops on the payment step.
  - Buttons like "comprar ahora / confirmar compra / pagar / repetir pedido" are never offered to Jev.
  - Order and payment endpoints (`/transaction`, `/payments`, `gatewayCallback`, `orderPlaced`) are aborted at the network level and counted in the summary.
- **Credentials:**
  - Jev only sees options like "Type the account password into its empty field". The sandbox reads the value from the environment and types it in.
  - Values are redacted from all page text sent to Jev and from the jsonl.
  - The Playwright trace starts only after login, so typed credentials are never recorded.
- **Product replacements:** options that accept a replacement are filtered out, so only "no reemplazar" choices reach Jev.
- **Account actions blocked:** logout, registration, password recovery and account deletion are never offered.
- **Network allowlist:** only the Dia, diadigital (login), VTEX (assets, checkout UI) and Google Maps (delivery-location modal) hosts plus fonts are reachable. Analytics, ads and chat widgets are aborted.
- **Privacy:**
  - your name and street address appear in the page text sent to TypeSafe. The DNI, email and postcode are redacted from everything Jev sees and from the jsonl.
  - the trace zip records Dia's pages and API responses after login, which include your **DNI, email and address**, but never the password.
  - treat traces as personal data: `traces/` is git-ignored, and you shouldn't share a trace zip.

## Harness notes (what Jev needed help with)
- **The login popup is Flutter web** (canvas). The sandbox turns on Flutter's accessibility tree so the fields and the Continuar button become real DOM nodes.
- **Jev has no memory between steps.**
  - Filled fields stop being offered.
  - An action that fails twice, or gets picked three times in six steps, is removed.
  - A `wait` action is always available.
- **VTEX "Agregar" buttons** are modal triggers that all have `aria-label="Modal abierto"`. They are labelled by their text and the product card they sit in.
- **Open modals** (delivery location, delivery method) take over: while one is open, Jev only sees that modal's controls, and its text comes first.
  - The ✕ / "Eliminar" controls on saved addresses are never offered.
- **VTEX adds to the cart asynchronously**, so after Agregar the harness polls the cart for up to 5 s. Otherwise Jev would add a second product for the same item.
- **Login:** the popup sometimes stays open on `oauth/finish?authStatus=Success`. Login is confirmed through `/api/sessions` (via the browser context), not by waiting for the popup to close.

See [docs/dia-navigation.md](docs/dia-navigation.md) for site-navigation learnings (login popup, hosts, modals, checkout) useful to other agents.
