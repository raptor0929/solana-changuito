# End-to-end

Playwright. Unit tests stay on `npm test` and do not open a browser.

| Project | Target |
|---|---|
| `landing` | `LANDING_BASE_URL`, default `https://www.changuito.me` |
| `app` | `APP_BASE_URL`, default `https://app.changuito.me` |

Both are smokes, and production is their target on purpose. A local run needs
Privy, Turnstile and the model keys the app already has on Vercel; CI does not
have those. Neither smoke signs in to completion, locks USDC, or presses
**Cargar 50 USDC de prueba**.

**The checkout is not covered here.** The browser checkout (Privy login, the
resolver-paid lock, the sandbox phases, settle or refund) has no Playwright spec.
It is exercised without a browser by `scripts/devnet-e2e.mts`, which drives the
same routes against a dev server on devnet — see
[judges.md](judges.md#5-verify-it-yourself).

**State of the suite after the Solana port.** The previous frame-checkout spec
was deleted with the flow it tested. Three things still refer to it and are
stale: the `checkout` project in `playwright.config.ts`, the `checkout` choice
in `.github/workflows/e2e.yml`, and `e2e/support/checkout-fixtures.ts`.
`app-guest.spec.ts` and `app-auth.spec.ts` still assert the previous wallet's
login modal (`e2e/support/pollar-copy.ts`), so their login steps will fail
against a Privy build until they are rewritten. The descriptions below say what
each spec asserts today, not what it should.

## Run locally

Node is `22.12.0` (`.nvmrc`). From the repo root, after `npm ci`:

```bash
npx playwright install chromium
npm run test:e2e
npm run test:e2e:ui
```

`test:e2e:ui` opens Playwright's runner. Optional overrides live in
`e2e/.env` (copy `e2e/.env.example`). Values already exported in the shell
win over that file.

## What the specs assert

- **Landing.** The home page renders, the three nav anchors (`#como-funciona`,
  `#pagos`, `#faq`) scroll into view, **Probar Changuito** and **Sumate a la beta**
  go to `/whitelist`, and one FAQ item expands.
- **Whitelist.** An empty submit shows the name and email errors. A name plus
  `no-es-un-email` shows `Revisá tu email.` The test does not submit a real
  signup.
- **App, guest.** The masthead and **Empezá a comprar** render, and the page
  throws no uncaught error. It then expects the previous wallet's login modal
  and will fail there on the Privy build (see above). The part that still
  holds: chat is behind Turnstile; if the check passes, the spec clicks a
  starter chip (or types a short prompt), waits for the reply that asks for the
  postal code, and stops. If Turnstile stays up, the verification screen is the
  pass: CI must not depend on Cloudflare letting a bot through. Product search
  is not asserted: a search can take a minute. The postal-code reply is,
  because a guest stuck before it was the blocker in issue #51; the server now
  answers it without a model hop.
- **App, auth.** Skipped unless both `CHANGUTO_E2E_EMAIL` and
  `CHANGUTO_E2E_PASSWORD` are non-empty, so it skips in a run without secrets.
  When it does run, it drives the previous wallet's modal and is stale. Privy's
  email login is a one-time code as well, so a standing secret will not keep a
  signed-in assertion green without a Privy test account. Traces and
  screenshots are off for this spec so a public Actions artifact cannot keep
  the inbox or the code.

## GitHub Actions

Two workflows. They do not share a trigger.

| Workflow | When |
|---|---|
| `.github/workflows/unit.yml` | Every pull request, and every push to `main`. Runs `npm test` only. |
| `.github/workflows/e2e.yml` | A **merge to `main`** whose diff touches a backend path, or **Actions → E2E → Run workflow**. |

E2E does not run on pull requests, and it does not run on a push that only
touches the UI, docs, or the specs themselves. There is no schedule.

A backend merge runs the two smokes (`landing` and `app`). A manual run asks
which suite: `landing`, `app` or `both` (the default). The workflow still
offers `checkout`, whose spec no longer exists. Each project is its own job, so
one failure does not cancel the other.

The E2E job installs Node from `.nvmrc`, runs `npm ci`, installs Chromium,
then `npm run test:e2e -- --project=<landing|app>`. It does not repeat
`npm test`. On failure it uploads `playwright-report` and `test-results`
for 7 days, one artifact per project. The auth spec writes neither
screenshots nor traces.

### What counts as backend

The path filter is the list in `e2e.yml`: `packages/mcp`, `deployments.json`
and the module writer, `apps/web/app/api`, `middleware.ts`, `next.config.ts`,
`lib/agent`, `lib/mcp`, `lib/server`, a list of named server modules, the
landing's API and waitlist code, and the root `package.json` / lockfile.

It predates the port and has not been updated: it still lists removed paths
(`contracts`, the bindings packages, `lib/stellar.ts`, `lib/pollar.ts` and
others), and it does not list `anchor/`, `services/sandbox`,
`apps/web/lib/checkout`, `lib/escrow.ts` or `lib/solana.ts`. A change there
needs a manual run if you want the smoke.

Left out on purpose: `apps/web/components`, `apps/landing/components`, the
page files, `apps/branding`, `docs`, and `e2e/`. `packages/trust` is shared
footer copy rendered in the browser, not a server.

### Add the secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**.

| Name | Value |
|---|---|
| `CHANGUTO_E2E_EMAIL` | An inbox for the login step |
| `CHANGUTO_E2E_PASSWORD` | Required by the skip check; only useful if it is the 6-digit code |

Optional, same screen: `CHANGUTO_E2E_OTP` for the code when the password
secret should stay a password. The E2E workflow passes it through when the
secret exists. These secrets are read on `main` and on a manual run. A pull
request does not start the E2E workflow, so a fork never sees them.

Never commit `e2e/.env` or a real inbox.
