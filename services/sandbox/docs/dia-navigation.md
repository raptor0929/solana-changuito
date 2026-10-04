# Navigating Dia Argentina with Playwright: field notes

What we learned getting a Playwright-driven agent through
`https://diaonline.supermercadosdia.com.ar`: login → empty cart → add products →
checkout up to the payment step. Everything here was observed on the live site
(Oct 2026). Selectors and hosts can change, so treat this as a map, not a contract.
The code that implements all of it lives in `sandbox.py` and `agent.py`.

## 1. The site at a glance

| piece | technology | what it means for automation |
|---|---|---|
| store (home, search, product cards) | **VTEX IO** (React) | normal DOM, but the buttons are modal triggers and the cart updates asynchronously |
| login | **Flutter web** popup on `auth.diadigital.app` | painted to a canvas, with no DOM fields until you turn on Flutter semantics |
| checkout | **VTEX checkout** (`/checkout/#/cart`, `#/shipping`, `#/payment`) | hash routes; UI scripts come from `io2.vtex.com` |
| cart state | VTEX `orderForm` | tied to the **browser cookie**, not the account (see §6) |

## 2. Hosts the browser must be allowed to reach

If you run with a request allowlist (we abort everything else), these are the
ones the flow needs. Each was found by a step that broke without it:

| host | needed for | symptom when blocked |
|---|---|---|
| `supermercadosdia.com.ar` | the store | none of the store loads |
| `diadigital.app` | login popup (`auth.diadigital.app`) | blank popup |
| `www.gstatic.com` | Flutter CanvasKit | login popup never renders |
| `vtexassets.com`, `vteximg.com.br` | images and assets | broken images and styles |
| `vtexcommercestable.com.br`, `io.vtex.com.br` | VTEX APIs | cart and search APIs fail |
| `af-origin.vtex.com` | VTEX anti-fraud fingerprint | checkout misbehaves |
| `io2.vtex.com` | checkout UI scripts | **blank checkout page** |
| `myvtex.com` | store account host used by checkout | **blank checkout page** |
| `maps.googleapis.com`, `maps.gstatic.com` | delivery-location modal | the modal's **Confirmar stays disabled** |
| `fonts.googleapis.com`, `fonts.gstatic.com`, `cdnjs.cloudflare.com` | fonts and libraries | cosmetic |

Blocking analytics, ads and chat widgets (about 20 hosts per run) caused no problems.

## 3. Login (the hard part)

**Flow:** the store's `Ingresar` opens a **popup window**. The popup asks for
**DNI + email**, then `Continuar`. A **second screen asks for the password**,
then `Continuar` again. Going straight to `BASE + "/login"` is the most reliable entry point.

**Flutter web needs its accessibility tree switched on.** The popup is a canvas,
so `page.fill("input")` finds nothing. What works:

```python
popup = context.pages[-1]                      # the popup is the newest page
await popup.wait_for_selector("flt-semantics-placeholder, flt-semantics", state="attached", timeout=15000)
await popup.evaluate("() => document.querySelector('flt-semantics-placeholder')?.click()")
await popup.wait_for_function(
    "() => document.querySelectorAll('flt-semantics textarea, flt-semantics input, flt-semantics[role=button]').length > 0")
```

After that:
- **Text fields** are `<textarea>` or `<input>` elements inside `flt-semantics`. Their label is the `aria-label` of the enclosing `flt-semantics` node or the placeholder.
- **`Continuar` is not a `<button>`.** It is `flt-semantics[flt-tappable]`, so include that selector or the button will never be found.
- **Skip Flutter container nodes**, meaning any `flt-semantics` that wraps other tappables or fields. One of them covers the whole page and clicking it does nothing.
- **Don't `click()` the text fields.** Flutter's glass pane intercepts pointer events and the click times out. Use `locator.focus()`, then `ControlOrMeta+a`, `Backspace`, `keyboard.type(value)`.
- **Popup timing is flaky.** Sometimes it renders in 1 s, sometimes in 10 s. Always wait for the semantics nodes; never use a fixed sleep.

**Detecting success:**
- Don't wait for the popup to close. It often **stays open on `oauth/finish?authStatus=Success`**.
- Don't evaluate JS in the store page either. Right after login it redirects several times and `page.evaluate` fails mid-navigation.
- What works is asking the session API through the **context** (it shares cookies):

  ```python
  r = await context.request.get(BASE + "/api/sessions?items=profile.isAuthenticated")
  ok = (await r.json())["namespaces"]["profile"]["isAuthenticated"]["value"] == "true"
  ```

  Once it returns true, close any leftover popups, wait about 3 s for the redirects to finish, and `goto(BASE + "/")` so the store picks up the session.

**Other login gotchas:**
- Only fill credential fields **inside the popup**. The store page has a newsletter email field that matches "email" too.
- Never re-fill a field that already has a value. An agent without memory will loop on it otherwise. Mark fields `(filled)` / `(empty)` and only offer empty ones.
- Never let the agent near "olvidé / recuperar contraseña", "registrarse" or "cerrar sesión".
- **Start Playwright tracing only after login.** Traces record typed values.

## 4. Search and add to cart

- **Search URL:** `BASE + f"/{q}?_q={q}&map=ft"`. This is the standard VTEX full-text search and is more reliable than typing into the search box.
- **Product cards:** each card contains a link ending in `/p`. To give a button its product context, climb from the button to the nearest ancestor (up to about 14 levels) that contains `a[href$="/p"]` and has short `innerText`.
- **`Agregar` buttons are VTEX modal triggers** (`div[class*=triggerContainer]`), and **all of them have `aria-label="Modal abierto"`**. If you label elements by aria-label, every Agregar looks identical and dedupes down to one. Label them by `innerText` instead.
- **The first add opens modals** (they are only shown once per session):
  1. **"Ingresá tu ubicación" (delivery location):** pick the saved-address radio, then `Confirmar`. This modal needs Google Maps (§2). Each saved-address row also has ✕ / "Eliminar" controls, so only offer the label or radio inside `[class*=address-list-item]`.
  2. **Delivery method:** "Envío a domicilio (express o programado)" → "Envío programado" → `Confirmar`.
     *(changuito, 2026-10-04.)* `Confirmar` stays disabled until a delivery-type radio is selected. Both radios share `name="DeliveryType"` and are named only by their wrapping `<label>`, so a collector that labels radios by `name` turns them into one meaningless option, and the agent loops re-clicking "Envío a domicilio". Label radios and checkboxes by their wrapping `<label>` text, and pick "Envío programado" (never Express or store pickup).
- **Modal detection:** `[class*=modal-layout-0-x-paper], [role=dialog], [aria-modal=true]` with height > 50 px. While a modal is open, only collect controls inside it. Otherwise an agent clicks the page behind it and nothing happens.
- **The cart updates asynchronously.** The orderForm reflects an Agregar 1–3 s later. Poll the cart API (we use up to 5 × 1 s) before deciding the add failed. Without polling, the agent adds a second product for the same item. That really happened with nuggets.
- **Cart API** (from inside a store page):

  ```js
  await (await fetch('/api/checkout/pub/orderForm', {credentials: 'include'})).json()
  // .orderFormId, .value (cents), .items[].{name, quantity, sellingPrice (cents)}
  ```

## 5. Checkout

- **Cart:** `BASE + "/checkout/#/cart"`. Removing items (trash icons) is how to empty it, and the orderForm `items` going to `[]` confirms it.
- **Replacement prompt:** the cart asks what to do with missing products. Choose **"No reemplazar"**. We filter out every option matching `reemplaz|sustitu` unless it also matches `no …reemplaz` or `sin reemplazo`.
- **"Finalizar Compra" on the cart page does not place an order.** It only moves to the shipping/identification step. Next comes **"Ir Para El Pago"**, which leads to `#/payment`. The shipping step reused the saved address with no extra input.
- **Stop condition:** `"#/payment" in page.url`. Nothing is charged until a card is entered and the order is confirmed.
- **Belt and braces:** abort non-GET requests matching `/transaction|/gatewayCallback|/payments\b|orderPlaced` at the network level, and never offer buttons matching `comprar ahora|confirmar compra/pedido|realizar pedido|pagar ahora|repetir pedido`. In our runs the network guard never fired, because we stopped before any of those requests.
- The checkout page may also ask for DNI or postcode. Fill them from env like the login fields.

## 6. The cart lives in the cookie, not the account

The VTEX cart is bound to the `checkout.vtex.com` cookie (`__ofid=<orderFormId>`).
A fresh Playwright context that logs into the same account gets its **own** cart:
- products added by the automation **do not show up** in the user's normal browser
- "emptying the cart" in the automation does **not** empty the user's real cart

To hand the cart over, either reuse the user's browser profile or cookies, or give the
user the `orderFormId` (VTEX supports `/checkout/cart/add?...` and orderForm-linked URLs).
Neither option is implemented here yet.

## 7. Patterns that made an LLM-driven agent reliable

- **Build an element list in the page.** Visible controls only, each tagged with `data-jev-id`, then clicked by that id. That beats asking the model for selectors.
- **Redact known personal values** (DNI, email, postcode) from page text **and** element labels. Saved addresses show the postcode in labels.
- **Always offer a `wait` action.** Pages load slowly and an empty choice list breaks the API call.
- **Stuck guard:** drop an action after it fails twice, or after it is picked twice in the last six steps.
- **Give each phase its own instructions and done-check.** The harness, not the model, decides "done" from APIs: the session API for login, orderForm item counts for the cart, the URL hash for payment.
- A full run (login + 4 items + checkout) took about 33 decisions and about 4 minutes of wall time.
