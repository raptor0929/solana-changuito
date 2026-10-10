"""The deterministic half of a run: everything after login that has an API or a stable label.

Jev is good at a Flutter popup it has never seen; it is slow and uncertain at things VTEX already
exposes as JSON. So the cart is emptied and filled through the checkout API by SKU, the shipping
address and delivery window are attached through the same API, and the card form is filled by
label. Each function reports what it could not do, and agent.py hands only that to Jev.

Card rule, the one that matters: nothing here ever logs, returns or raises a card value. A log
line says which FIELD was filled, never with what. The card comes in the job (the web app reads
it from the `shared_card` table), and Pay is pressed only when the job has one; until then the order endpoints stay
aborted at the network layer (sandbox.ORDER_ENDPOINTS).
"""

from __future__ import annotations

import asyncio
import re

from urllib.parse import urlsplit

from playwright.async_api import Frame, Locator, Page

from sandbox import BASE, Sandbox

OF = "/api/checkout/pub/orderForm"

FETCH_JS = """async ([url, method, body]) => {
  const r = await fetch(url, {method, credentials: 'include',
    headers: {'content-type': 'application/json', accept: 'application/json'},
    body: body == null ? undefined : JSON.stringify(body)});
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return {status: r.status, data};
}"""


async def api(sb: Sandbox, path: str, method: str = "GET", body: dict | None = None) -> dict:
    """Call the store's API from the page, with its cookies. Returns {status, data}."""
    try:
        return await sb.main.evaluate(FETCH_JS, [path, method, body])
    except Exception as e:  # page mid-navigation
        return {"status": 0, "data": None, "error": type(e).__name__}


async def order_form(sb: Sandbox) -> dict:
    r = await api(sb, OF)
    return r["data"] or {}


# ---- cart ----------------------------------------------------------------------


async def clear_cart(sb: Sandbox) -> dict:
    of = await order_form(sb)
    if of.get("items"):
        r = await api(sb, f"{OF}/{of['orderFormId']}/items/removeAll", "POST", {})
        print(f"    removeAll -> {r['status']}")
    return await sb.order_form()


async def _seller(sb: Sandbox, sku: str) -> str | None:
    r = await api(sb, f"/api/catalog_system/pub/products/search?fq=skuId:{sku}")
    for product in r["data"] or []:
        for item in product.get("items", []):
            if str(item.get("itemId")) == str(sku):
                sellers = [s for s in item.get("sellers", []) if s.get("commertialOffer", {}).get("AvailableQuantity", 0) > 0]
                chosen = (sellers or item.get("sellers") or [{}])[0]
                return chosen.get("sellerId")
    return None


async def add_skus(sb: Sandbox, lines: list[dict]) -> tuple[list[str], list[dict]]:
    """Add every line that has a SKU in one call. Returns (names added, lines left for Jev)."""
    with_sku = [l for l in lines if l.get("sku")]
    rest = [l for l in lines if not l.get("sku")]
    if not with_sku:
        return [], rest
    of = await order_form(sb)
    order_items = []
    for l in with_sku:
        seller = await _seller(sb, l["sku"])
        if seller is None:
            print(f"    sku {l['sku']} ({l['name'][:40]}): not sold here, leaving it to Jev")
            rest.append(l)
            continue
        order_items.append({"id": str(l["sku"]), "quantity": int(l.get("quantity") or 1), "seller": seller})
    if order_items:
        r = await api(sb, f"{OF}/{of['orderFormId']}/items", "POST", {"orderItems": order_items})
        print(f"    add {len(order_items)} skus -> {r['status']}")
    of = await order_form(sb)
    in_cart = {str(i.get("id")): i for i in of.get("items", [])}
    added = []
    for l in with_sku:
        if l in rest:
            continue
        got = in_cart.get(str(l["sku"]))
        if got and got.get("availability", "available") == "available":
            added.append(l["name"])
        else:
            print(f"    sku {l['sku']} ({l['name'][:40]}): {got.get('availability') if got else 'rejected'}, leaving it to Jev")
            rest.append(l)
    return added, rest


# ---- shipping ------------------------------------------------------------------


def _complete(addr: dict | None) -> bool:
    return bool(addr and addr.get("street") and addr.get("postalCode") and addr.get("number"))


async def _address_from_secrets(sb: Sandbox) -> dict | None:
    s = sb.secrets
    if not (s.get("postcode") and s.get("street") and s.get("number")):
        return None
    r = await api(sb, f"/api/checkout/pub/postal-code/ARG/{s['postcode']}")
    geo = r["data"] or {}
    return {"addressType": "residential", "country": "ARG", "postalCode": s["postcode"],
            "street": s["street"], "number": s["number"], "complement": s.get("complement"),
            "city": geo.get("city"), "state": geo.get("state"), "neighborhood": geo.get("neighborhood"),
            "geoCoordinates": geo.get("geoCoordinates") or [],
            "receiverName": None}


def _pick_sla(info: dict) -> tuple[dict | None, dict | None]:
    """Home delivery, scheduled when offered, earliest window; else the cheapest delivery SLA."""
    slas = [s for s in info.get("slas", []) if (s.get("deliveryChannel") or "delivery") == "delivery"]
    if not slas:
        return None, None
    windowed = [s for s in slas if s.get("availableDeliveryWindows")]
    if windowed:
        best = min(windowed, key=lambda s: min(w["startDateUtc"] for w in s["availableDeliveryWindows"]))
        window = min(best["availableDeliveryWindows"], key=lambda w: w["startDateUtc"])
        return best, window
    return min(slas, key=lambda s: s.get("price", 0)), None


def shipping_total(of: dict) -> int | None:
    for t in of.get("totalizers", []):
        if t.get("id") == "Shipping":
            return int(t.get("value", 0))
    return None


async def set_shipping(sb: Sandbox) -> dict:
    """Attach an address and a delivery option. The account's saved address wins; the job's
    postcode and street are the fallback. Billing follows delivery (VTEX's default)."""
    of = await order_form(sb)
    sd = of.get("shippingData") or {}
    addr = sd.get("address") if _complete(sd.get("address")) else None
    how = "current address"
    if not addr:
        saved = [a for a in sd.get("availableAddresses", []) if _complete(a)]
        pc = sb.secrets.get("postcode")
        # Prefer a saved address in the postcode the shopper browsed with: that is where prices were quoted.
        addr = next((a for a in saved if pc and a.get("postalCode") == pc), saved[0] if saved else None)
        how = "saved address"
    if not addr:
        addr = await _address_from_secrets(sb)
        how = "job address"
    if not addr:
        return {"ok": False, "how": "no address: account has none saved and the job sent none",
                "shipping_centavos": shipping_total(of)}

    body = {"clearAddressIfPostalCodeNotFound": False, "selectedAddresses": [addr]}
    r = await api(sb, f"{OF}/{of['orderFormId']}/attachments/shippingData", "POST", body)
    of = r["data"] or of
    logistics = []
    chosen = []
    for info in (of.get("shippingData") or {}).get("logisticsInfo", []):
        sla, window = _pick_sla(info)
        if not sla:
            continue
        entry = {"itemIndex": info["itemIndex"], "selectedSla": sla["id"], "selectedDeliveryChannel": "delivery"}
        if window:
            entry["deliveryWindow"] = window
        logistics.append(entry)
        chosen.append(sla["id"] + (f" @ {window['startDateUtc'][:16]}" if window else ""))
    if logistics:
        body["logisticsInfo"] = logistics
        r = await api(sb, f"{OF}/{of['orderFormId']}/attachments/shippingData", "POST", body)
        of = r["data"] or of
    ok = r["status"] == 200 and bool(logistics)
    label = f"{how}, {sorted(set(chosen))[0] if chosen else 'no delivery option'}"
    return {"ok": ok, "how": label + ("" if ok else f" (HTTP {r['status']})"), "shipping_centavos": shipping_total(of)}


async def open_payment(sb: Sandbox) -> bool:
    """Go straight to #/payment. VTEX bounces back to an earlier step when data is missing."""
    await sb.main.goto(f"{BASE}/checkout/#/payment", wait_until="domcontentloaded")
    for _ in range(8):
        await sb.main.wait_for_timeout(750)
        if "#/payment" not in sb.main.url:
            return False
        if await _card_root(sb.main, 150) or await _method_list(sb.main):
            return True
    return "#/payment" in sb.main.url


# ---- payment -------------------------------------------------------------------
# Selectors ported from packages/mcp/src/checkout/selectors.ts: label first, CSS last,
# fallback chains rather than single guesses.

# Which card group to pay with: the job card's `kind` (debit unless its brand says credit).
GROUPS = {
    "debit": ("#payment-group-debitCardPaymentGroup", "debitCardPaymentGroup",
              re.compile(r"tarjeta de d[eé]bito|debit card", re.I),
              re.compile(r"cr[eé]dito|cuotas|efectivo|transferencia|mercado ?pago|cuenta dni|modo", re.I)),
    "credit": ("#payment-group-creditCardPaymentGroup", "creditCardPaymentGroup",
               re.compile(r"tarjeta de cr[eé]dito|credit card", re.I),
               re.compile(r"d[eé]bito|efectivo|transferencia|mercado ?pago|cuenta dni|modo", re.I)),
}



CARD_FIELDS = {
    "pan": (re.compile(r"n[uú]mero de (la )?tarjeta|card ?number", re.I),
            ['input[name*="cardNumber" i]', 'input[id*="cardNumber" i]', 'input[autocomplete="cc-number"]']),
    "holder": (re.compile(r"nombre.*(tarjeta|titular)|titular|cardholder|name on card", re.I),
               ['input[name*="holderName" i]', 'input[id*="holderName" i]', 'input[autocomplete="cc-name"]']),
    "month": (re.compile(r"^mes|month", re.I),
              ['select[name*="Month" i]', 'select[id*="Month" i]', 'input[autocomplete="cc-exp-month"]']),
    "year": (re.compile(r"^a[nñ]o|year", re.I),
             ['select[name*="Year" i]', 'select[id*="Year" i]', 'input[autocomplete="cc-exp-year"]']),
    "expiry": (re.compile(r"vencimiento|expira|mm ?/ ?(aa|yy)", re.I),
               ['input[name*="expiration" i]', 'input[id*="expiration" i]', 'input[autocomplete="cc-exp"]']),
    "cvv": (re.compile(r"c[oó]digo de seguridad|cvv|cvc|csc", re.I),
            ['input[name*="securityCode" i]', 'input[id*="securityCode" i]', 'input[autocomplete="cc-csc"]']),
    "document": (re.compile(r"\bdni\b|documento|cuit|cuil", re.I),
                 ['input[name*="document" i]', 'input[id*="document" i]']),
}
PAY_BUTTON = re.compile(r"^\s*(finalizar compra|comprar ahora|pagar|confirmar (la )?compra|realizar pedido)\s*$", re.I)
DECLINED = re.compile(r"no (fue|pudo ser) aprobad|rechazad|no autorizad|denegad|intent[aá] (de nuevo|nuevamente)|"
                      r"verific[aá] los datos|tarjeta inv[aá]lida", re.I)

PAYMENT_TRAFFIC = re.compile(r"/transaction|/gatewayCallback|/payments\b|orderPlaced|/placeOrder|/startTransaction|"
                             r"vtexpayments|mercadopago", re.I)
ALERTS_JS = r"""() => [...document.querySelectorAll('[role=alert], .alert, .error, [class*=error i], [class*=alert i], .vtex-front-messages-template')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
  .map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t.length > 3 && t.length < 400).slice(0, 8)"""

def normalize_card(job_card: dict | None) -> dict | None:
    """The job's card (server.py `Card`, from the web app's `shared_card` row) in the shape the
    form filler uses. None unless every field is there: a half card is no card."""
    if not job_card:
        return None
    card = {"pan": re.sub(r"\D", "", str(job_card.get("pan") or "")),
            "cvv": str(job_card.get("cvv") or "").strip(),
            "month": str(job_card.get("exp_month") or "").strip().zfill(2),
            "year": str(job_card.get("exp_year") or "").strip(),
            "holder": str(job_card.get("holder") or "").strip(),
            "kind": "credit" if job_card.get("kind") == "credit" else "debit"}
    if not all(card[k] for k in ("pan", "cvv", "month", "year", "holder")):
        return None
    if len(card["year"]) == 2:
        card["year"] = "20" + card["year"]
    return card


async def _method_list(page: Page) -> bool:
    return await page.locator("[id^=payment-group-], .payment-group-item").count() > 0


async def _visible(loc: Locator, timeout: int = 400) -> Locator | None:
    # Playwright reads timeout=0 as "wait forever": never pass it through.
    timeout = max(timeout, 100)
    try:
        one = loc.first
        await one.wait_for(state="visible", timeout=timeout)
        return one
    except Exception:
        return None


async def _first_visible(cands: list[Locator]) -> Locator | None:
    """The first candidate on screen right now. No waiting: callers poll."""
    for loc in cands:
        try:
            n = await loc.count()
            for i in range(min(n, 4)):
                if await loc.nth(i).is_visible():
                    return loc.nth(i)
        except Exception:
            continue
    return None


def _cands(root: Page | Frame, key: str) -> list[Locator]:
    label, css = CARD_FIELDS[key]
    return [*(root.locator(c) for c in css), root.get_by_label(label), root.get_by_placeholder(label)]


async def _find(root: Page | Frame, key: str, timeout: int = 400) -> Locator | None:
    found = await _first_visible(_cands(root, key))
    waited = 0
    while not found and waited < timeout:
        await asyncio.sleep(0.2)
        waited += 200
        found = await _first_visible(_cands(root, key))
    return found


def _card_frames(page: Page, kind: str = "debit") -> list[Frame]:
    """Only the iframe of the card group we pay with (VTEX renders one per group), then the page.
    Typing into the other group's hidden iframe would fill a form nobody submits."""
    group = GROUPS[kind][1]
    frames = [f for f in page.frames if f is not page.main_frame and group in (f.url or "")]
    return [*frames, page.main_frame]


async def _card_root(page: Page, timeout: int = 400, kind: str = "debit") -> Page | Frame | None:
    """The page or iframe holding the card number. On Día it is VTEX's card-ui iframe."""
    waited = 0
    while True:
        for frame in _card_frames(page, kind):
            if await _first_visible(_cands(frame, "pan")):
                return frame
        if waited >= timeout:
            return None
        await asyncio.sleep(0.25)
        waited += 250


NEW_CARD = re.compile(r"(usar|pagar con|agregar|ingresar|nueva|otra) (otra |una )?(nueva )?tarjeta|otra tarjeta|nueva tarjeta|"
                      r"new card|another card", re.I)


async def _use_new_card(page: Page, kind: str) -> bool:
    """A Día account with saved cards shows them as radios and only asks for a CVV. The card we pay
    with is always the job's (the operator's shared card), never one saved in somebody's account,
    so ask for the new-card form."""
    for frame in _card_frames(page, kind):
        for loc in (frame.get_by_role("link", name=NEW_CARD), frame.get_by_role("button", name=NEW_CARD),
                    frame.get_by_text(NEW_CARD), frame.locator("#use-another-card, .new-card, [id*=newCard i]")):
            el = await _first_visible([loc])
            if el:
                await el.click()
                print("    chose a new card over the account's saved ones")
                return True
    return False


async def _select_group(page: Page, kind: str) -> bool:
    css, _, label, avoid = GROUPS[kind]
    for loc in (page.locator(css), page.get_by_role("link", name=label), page.get_by_text(label)):
        n = await loc.count()
        for i in range(n):
            el = loc.nth(i)
            try:
                text = await el.inner_text(timeout=500)
            except Exception:
                text = ""
            if avoid.search(text):
                continue
            if await el.is_visible():
                await el.click()
                await page.wait_for_timeout(800)
                print(f"    payment method: {text.strip()[:40] or kind}")
                return True
    return False


async def _type(loc: Locator, value: str) -> None:
    await loc.click()
    await loc.fill("")
    await loc.press_sequentially(value, delay=20)


async def _pick(loc: Locator, *values: str) -> bool:
    for v in values:
        for kw in ({"value": v}, {"label": v}):
            try:
                await loc.select_option(**kw, timeout=1500)
                return True
            except Exception:
                pass
    return False


DESCRIBE_JS = r"""() => [...document.querySelectorAll('input, select, button, a, [role=button]')].filter(e => {
  const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; }).slice(0, 40).map(e =>
  [e.tagName, e.type || '', e.id, e.name || '', e.autocomplete || '', e.placeholder || '',
   e.getAttribute('aria-label') || '', (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText || '').trim().slice(0, 40),
   ['BUTTON', 'A'].includes(e.tagName) || e.getAttribute('role') === 'button' ? (e.innerText || '').trim().slice(0, 40) : '']
  .join(' | ').replace(/\s+/g, ' ').replace(/\d{3,}/g, '#'))"""


async def describe_frames(page: Page) -> None:
    """Field attributes per frame (never values), printed when the card form is not where we expect."""
    for frame in page.frames:
        try:
            rows = await frame.evaluate(DESCRIBE_JS)
        except Exception:
            continue
        print(f"    frame {(frame.url or '')[:90]}")
        for r in rows:
            print(f"      {r}")


async def fill_card(sb: Sandbox, card: dict) -> dict:
    """Type the card. Returns {filled, missing}: field names only, never values."""
    page = sb.main
    for key, secret in (("pan", "pan"), ("cvv", "cvv"), ("holder", "holder")):
        if card.get(key):
            sb.secrets[secret] = card[key]  # redacted from anything Jev or a log could read from here on
    # Always choose the group explicitly: the page may open on whatever the account used last.
    await _select_group(page, card["kind"])
    root = await _card_root(page, 3000, card["kind"])
    if not root and await _use_new_card(page, card["kind"]):
        root = await _card_root(page, 4000, card["kind"])
    if not root:
        await describe_frames(page)
        return {"filled": [], "missing": ["pan"], "where": "no card form found"}
    where = "page" if root is page.main_frame else f"iframe {(root.url or '')[:60]}"
    filled, missing = [], []

    async def put(key: str, value: str, optional: bool = False) -> bool:
        el = await _find(root, key)
        if not el:
            if not optional:
                missing.append(key)
            return False
        await _type(el, value)
        filled.append(key)
        return True

    await put("pan", card["pan"])
    # The card number triggers a BIN lookup that re-renders the rest of the form.
    await page.wait_for_timeout(1200)
    await put("holder", card["holder"])
    yy = card["year"][-2:]
    month, year = await _find(root, "month"), await _find(root, "year")
    if month and year:
        ok_m = await _pick(month, card["month"], str(int(card["month"])))
        ok_y = await _pick(year, yy, card["year"])
        (filled if ok_m else missing).append("month")
        (filled if ok_y else missing).append("year")
    else:
        await put("expiry", f"{card['month']}/{yy}")
    await put("cvv", card["cvv"])
    # The cardholder document is the shopper's profile DNI, the one they log in with.
    if sb.secrets.get("dni"):
        await put("document", sb.secrets["dni"], optional=True)
    # Single-payment installment: VTEX preselects one; leave it.
    print(f"    card form in {where}: filled {', '.join(filled) or 'nothing'}"
          + (f"; missing {', '.join(missing)}" if missing else ""))
    if missing:
        await describe_frames(page)
    return {"filled": filled, "missing": missing, "where": where}


async def _accept_terms(page: Page) -> None:
    """Día's payment step will not submit without 'Acepto las Políticas de Privacidad'."""
    box = page.locator("#polPriv")
    try:
        if await box.count() and not await box.is_checked():
            await box.check()
            print("    accepted the privacy policy checkbox")
    except Exception:
        pass


async def _billing_same_as_delivery(page: Page) -> None:
    """Keep VTEX's 'same billing address as delivery' ticked, when the form shows one."""
    for frame in page.frames:
        box = frame.locator('input[type=checkbox][id*="ddress" i], input[type=checkbox][name*="ddress" i]')
        for i in range(await box.count()):
            el = box.nth(i)
            try:
                if await el.is_visible() and not await el.is_checked():
                    await el.check()
                    print("    billing: same as delivery")
            except Exception:
                pass


async def _pay_button(page: Page) -> Locator | None:
    for loc in (page.locator("#end_payment, #payment-data-submit, .payment-submit-wrap button"),
                page.get_by_role("button", name=PAY_BUTTON)):
        if el := await _visible(loc, 1500):
            return el
    return None


async def pay(sb: Sandbox, job_card: dict | None) -> dict:
    """Fill the card and, when one is configured, press Pay. Outcome:
    placed | declined | not_attempted | error, plus a detail line safe to show."""
    page = sb.main
    card = normalize_card(job_card)
    if not card:
        return {"payment": "not_attempted", "detail": "the job carried no card (shared_card has no row?)"}
    try:
        filled = await fill_card(sb, card)
    except Exception as e:
        return {"payment": "error", "detail": f"filling the card failed ({type(e).__name__})"}
    if filled["missing"]:
        return {"payment": "error", "detail": f"card form fields not found: {', '.join(filled['missing'])}"}
    await _billing_same_as_delivery(page)
    await _accept_terms(page)
    button = await _pay_button(page)
    if not button:
        await describe_frames(page)
        return {"payment": "error", "detail": "pay button not found"}

    sb.allow_payment = True  # from here the order endpoints are meant to be reached

    seen: dict[str, int] = {}
    errors: list[str] = []

    async def error_of(resp) -> None:
        # A failed checkout call answers {error: {code, message}}; that, never the body, is logged.
        try:
            err = (await resp.json()).get("error") or {}
            line = sb.redact(f"{err.get('code')} {err.get('message')}"[:200])
        except Exception:
            line = "(no JSON error body)"
        if line not in errors:
            errors.append(line)
            print(f"      error: {line}")

    def on_response(resp) -> None:
        # Path and status only: query strings and bodies can carry tokens and card data.
        if not PAYMENT_TRAFFIC.search(resp.url):
            return
        key = f"{resp.request.method} {urlsplit(resp.url).netloc}{urlsplit(resp.url).path[:90]} {resp.status}"
        seen[key] = seen.get(key, 0) + 1
        if seen[key] in (1, 10, 50):  # the UI retries a refused transaction in a loop
            print(f"    ← {key}" + (f"  (x{seen[key]})" if seen[key] > 1 else ""))
        if resp.status >= 400 and "/api/checkout/" in resp.url and seen[key] == 1:
            asyncio.ensure_future(error_of(resp))

    def on_failed(req) -> None:
        if PAYMENT_TRAFFIC.search(req.url):
            print(f"    ✗ {req.method} {urlsplit(req.url).netloc}{urlsplit(req.url).path[:90]} ({req.failure})")

    sb.context.on("response", on_response)
    sb.context.on("requestfailed", on_failed)
    blocked_before = len(sb.blocked_requests)
    await button.click()
    print("    pressed pay")
    last_url, seen_alerts = page.url, set()
    for _ in range(90):
        await page.wait_for_timeout(1000)
        url = page.url
        if url != last_url:
            print(f"    url → {urlsplit(url).path}{('#' + urlsplit(url).fragment) if urlsplit(url).fragment else ''}")
            last_url = url
        if "orderPlaced" in url:
            m = re.search(r"og=(\d+)", url)
            return {"payment": "placed", "order_id": m.group(1) if m else None, "detail": "order placed"}
        refused = sum(n for k, n in seen.items() if "/transaction" in k and k.endswith((" 403", " 401")))
        if refused >= 5:
            hosts = sorted(set(sb.blocked_requests[blocked_before:]))
            print(f"    hosts aborted after pay: {', '.join(hosts) or 'none'}")
            print(f"    recaptcha frames: {sum('recaptcha' in (f.url or '') for f in page.frames)}")
            return {"payment": "error",
                    "detail": f"the store refused to start the payment ({refused}× 403 on /transaction)"
                              + (f": {errors[0]}" if errors else "")}
        for alert in await _alerts(page):
            alert = sb.redact(alert)
            if alert not in seen_alerts:
                seen_alerts.add(alert)
                print(f"    store says: {alert[:160]}")
            if DECLINED.search(alert):
                return {"payment": "declined", "detail": alert[:200]}
        try:
            text = sb.redact(re.sub(r"\s+", " ", await page.inner_text("body")))
        except Exception:
            continue
        if m := DECLINED.search(text):
            start = max(0, m.start() - 60)
            return {"payment": "declined", "detail": text[start:m.end() + 80].strip()}
    hosts = sorted(set(sb.blocked_requests[blocked_before:]))
    print(f"    hosts aborted after pay: {', '.join(hosts) or 'none'}")
    await describe_frames(page)
    return {"payment": "error", "detail": "no answer from the store 90 s after pressing pay"}


async def _alerts(page: Page) -> list[str]:
    """Visible error and alert text in every frame: where VTEX and the card-ui say what went wrong."""
    out = []
    for frame in page.frames:
        try:
            out += await frame.evaluate(ALERTS_JS)
        except Exception:
            pass
    return out
