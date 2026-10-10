"""Sandboxed Playwright browser for Jev on Dia Argentina (VTEX store + Flutter login popup).

The browser acts; it never decides what to buy. Login decisions come from Jev in agent.py,
the rest of checkout is deterministic (checkout.py).
Credentials arrive per job (`Secrets`) and never leave this module: Jev picks a `fill_*`
action, the sandbox types the value, and every known value is redacted from what Jev reads.
"""

from __future__ import annotations

import os
import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from playwright.async_api import Browser, BrowserContext, Page, Playwright

BASE = "https://diaonline.supermercadosdia.com.ar"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# Hosts the store, checkout and login popup need. Trackers, ads and chat widgets are aborted.
ALLOWED_HOSTS = (
    "supermercadosdia.com.ar",
    "diadigital.app",  # Flutter login popup (auth.diadigital.app)
    "vtexassets.com",
    "vteximg.com.br",
    "vtexcommercestable.com.br",
    "io.vtex.com.br",
    "af-origin.vtex.com",  # VTEX anti-fraud fingerprint used by checkout
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "www.gstatic.com",  # Flutter CanvasKit
    "cdnjs.cloudflare.com",
    "maps.googleapis.com", "maps.gstatic.com",  # the delivery-location modal needs Google Maps
    "io2.vtex.com",  # VTEX checkout UI scripts
    "myvtex.com",  # store account host used by checkout (diaio.myvtex.com)
    # The card form: VTEX's card-ui iframe and the gateway that tokenizes the card.
    "vtexpayments.com.br",
    "mercadopago.com", "mlstatic.com",  # Día's card connector loads Mercado Pago's secure fields
    # VTEX checkout asks reCAPTCHA v3 for a token before it creates the transaction; without it
    # POST /transaction answers 403 and the UI retries forever.
    "www.google.com", "recaptcha.net",
)

# Network-level guarantee that no order is placed, whatever gets clicked, until checkout.py
# lifts it on purpose (`allow_payment`) after the card is typed and CARD_PAN is configured.
ORDER_ENDPOINTS = re.compile(r"/transaction|/gatewayCallback|/payments\b|orderPlaced", re.I)

# Never offered to Jev, never clicked.
BLOCKED = re.compile(
    r"comprar ahora|confirmar (la )?(compra|pedido)|realizar pedido|pagar ahora|"
    r"cerrar sesi|salir de|registr|recuperar contrase|olvid|eliminar (mi )?cuenta|repetir pedido",
    re.I,
)
# Product replacement: only the "don't replace" choice may be offered.
REPLACE = re.compile(r"reemplaz|sustitu|cambiar por (otro|similar)", re.I)
NO_REPLACE = re.compile(r"\bno\b.*(reemplaz|sustitu)|sin reemplazo", re.I)

# Built-in fill actions: Jev chooses them, the sandbox types the value from the job's secrets.
SECRET_FIELDS = {
    "fill_dni": ("dni", re.compile(r"\bdni\b|documento", re.I), "account DNI"),
    "fill_email": ("email", re.compile(r"correo|e-?mail", re.I), "account email"),
    "fill_password": ("password", re.compile(r"contrase|password|clave", re.I), "account password"),
    "fill_postcode": ("postcode", re.compile(r"c[oó]digo postal|\bcp\b", re.I), "delivery postcode"),
    "fill_street": ("street", re.compile(r"\bcalle\b|direcci[oó]n", re.I), "delivery street"),
    "fill_number": ("number", re.compile(r"n[uú]mero|altura", re.I), "delivery street number"),
    "fill_phone": ("phone", re.compile(r"tel[eé]fono|celular", re.I), "contact phone"),
}

# Redaction tags, longest-lived values first. Card values are added by checkout.py.
REDACT_TAGS = {"dni": "[DNI]", "email": "[EMAIL]", "postcode": "[CP]", "password": "[PWD]",
               "street": "[STREET]", "phone": "[PHONE]", "pan": "[PAN]", "cvv": "[CVV]", "holder": "[NAME]",
               "card_dni": "[DNI]"}

# Env fallback for the CLI and for jobs that carry no credentials.
ENV_SECRETS = {"dni": "DIA_ARG_DNI", "email": "DIA_ARG_EMAIL", "password": "DIA_ARG_PWD",
               "postcode": "DIA_ARG_POSTCODE", "street": "DIA_ARG_ADDR_STREET", "number": "DIA_ARG_ADDR_NUMBER",
               "phone": "DIA_ARG_ADDR_PHONE", "complement": "DIA_ARG_ADDR_COMPLEMENT"}


class Secrets(dict):
    """Per-job values the sandbox types and redacts. Never printed: `repr` shows keys only."""

    @classmethod
    def build(cls, job: dict | None = None) -> "Secrets":
        job = {k: v for k, v in (job or {}).items() if v}
        # A job that brings the shopper's login brings everything: the operator's env values
        # (account, address) must never be typed into somebody else's account.
        if any(job.get(k) for k in ("dni", "email", "password")):
            return cls({k: str(job[k]) for k in ENV_SECRETS if k in job})
        return cls({k: str(job.get(k) or os.environ[env]) for k, env in ENV_SECRETS.items()
                    if job.get(k) or os.environ.get(env)})

    def __repr__(self) -> str:
        return f"Secrets({sorted(self)})"

    __str__ = __repr__

MAX_ELEMENTS = 120
PAGE_TEXT = 1500  # chars of page text Jev reads per step; the open modal comes first
MODAL_SELECTOR = "[class*=modal-layout-0-x-paper], [role=dialog], [aria-modal=true]"

COLLECT_JS = r"""
(max) => {
  const MODAL_SEL = MODAL_SELECTOR;
  document.querySelectorAll('[data-jev-id]').forEach(e => e.removeAttribute('data-jev-id'));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const sel = 'button, a[href], input:not([type=hidden]), textarea, select, label, [role=button], ' +
              '[role=radio], [role=checkbox], [role=link], div[class*=triggerContainer], flt-semantics[role], ' +
              'flt-semantics[flt-tappable]';
  const out = [], seen = new Set();
  // An open modal captures the user's attention: only its controls are actionable.
  const modal = [...document.querySelectorAll(MODAL_SEL)].find(n => n.getBoundingClientRect().height > 50);
  for (const el of (modal || document).querySelectorAll(sel)) {
    if (out.length >= max) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right < 0 || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.closest('#jev-banner')) continue;
    // Saved-address rows: selecting is fine, deleting an address never is.
    const addr = el.closest('[class*=address-list-item]');
    if (addr && !(el.tagName === 'LABEL' || el.type === 'radio')) continue;
    if (el.tagName === 'FLT-SEMANTICS' && ['group', 'img', 'text'].includes(el.getAttribute('role'))) continue;
    // Flutter container nodes (e.g. the whole-page tappable) wrap the real controls.
    if (el.tagName === 'FLT-SEMANTICS' && el.querySelector('flt-semantics[flt-tappable], flt-semantics[role=button], textarea, input')) continue;
    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    // Field label: <label for>, aria-label, placeholder, or the enclosing Flutter semantics group.
    let fieldLabel = '';
    if (isField) {
      const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const grp = el.closest('flt-semantics[aria-label]');
      // A radio wrapped in its <label> ("Envío programado") is named by that text, not by its
      // group name ("DeliveryType"), or every radio in the group reads the same and dedupes to one.
      const wrap = ['radio', 'checkbox'].includes(el.type) && el.closest('label');
      fieldLabel = clean([lab && lab.innerText, wrap && wrap.innerText, el.getAttribute('aria-label'), el.placeholder,
                          (lab || wrap) ? '' : el.name, grp && grp.getAttribute('aria-label')].filter(Boolean).join(' / '));
    }
    // VTEX modal triggers (e.g. 'Agregar') all share aria-label 'Modal abierto'; their text is the real label.
    const trigger = el.matches('div[class*=triggerContainer]');
    let label = isField ? fieldLabel
      : clean(trigger ? (el.innerText || el.getAttribute('aria-label'))
                      : (el.getAttribute('aria-label') || el.innerText || el.value || el.title));
    if (!label) continue;
    if (isField && el.tagName !== 'SELECT' && !['checkbox', 'radio'].includes(el.type)) label += el.value ? ' (filled)' : ' (empty)';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') label += ' (disabled)';
    const checked = el.checked || el.getAttribute('aria-checked') === 'true' ||
                    (el.tagName === 'LABEL' && el.control && el.control.checked);
    // Product card context so 'Agregar' carries its product name and price.
    let card = null;
    for (let n = el.parentElement, i = 0; n && i < 14; n = n.parentElement, i++) {
      if (n.querySelector && n.querySelector('a[href$="/p"]')) { if (n.innerText.length < 300) card = n; break; }
    }
    const context = card ? clean(card.innerText).slice(0, 120) : '';
    const href = el.getAttribute('href') || '';
    const key = el.tagName + label + context + href;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = 'e' + out.length;
    el.setAttribute('data-jev-id', id);
    out.push({id, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '',
              label: label.slice(0, 100), href, context, checked: !!checked, field: isField,
              options: el.tagName === 'SELECT' ? [...el.options].map(o => clean(o.text)).slice(0, 30) : null,
              selected: el.tagName === 'SELECT' ? el.selectedIndex : null});
  }
  return out;
}
"""

COLLECT_JS = COLLECT_JS.replace("MODAL_SELECTOR", json.dumps(MODAL_SELECTOR))

HIGHLIGHT_JS = r"""
({id, banner, tag}) => {
  document.getElementById('jev-banner')?.remove();
  document.querySelectorAll('.jev-tag').forEach(e => e.remove());
  document.querySelectorAll('[data-jev-hl]').forEach(e => { e.style.outline = ''; e.removeAttribute('data-jev-hl'); });
  const b = document.createElement('div');
  b.id = 'jev-banner';
  b.textContent = banner;
  Object.assign(b.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: 2147483647,
    background: '#111827', color: '#f9fafb', font: '600 14px/1.4 ui-monospace, monospace',
    padding: '8px 14px', borderBottom: '3px solid #22c55e', pointerEvents: 'none',
  });
  document.body.appendChild(b);
  if (!id) return;
  const el = document.querySelector(`[data-jev-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({block: 'center'});
  el.setAttribute('data-jev-hl', '1');
  el.style.outline = '4px solid #22c55e';
  el.style.outlineOffset = '2px';
  const r = el.getBoundingClientRect();
  const t = document.createElement('div');
  t.className = 'jev-tag';
  t.textContent = tag;
  Object.assign(t.style, {
    position: 'fixed', top: Math.max(r.top - 26, 40) + 'px', left: r.left + 'px', zIndex: 2147483647,
    background: '#22c55e', color: '#052e16', font: '700 12px/1 ui-monospace, monospace',
    padding: '5px 7px', borderRadius: '4px', pointerEvents: 'none',
  });
  document.body.appendChild(t);
}
"""

ORDERFORM_JS = """async () => {
  const r = await fetch('/api/checkout/pub/orderForm', {credentials: 'include'});
  const f = await r.json();
  return {id: f.orderFormId, value: (f.value || 0) / 100,
          items: (f.items || []).map(i => ({name: i.name, qty: i.quantity, price: (i.sellingPrice || i.price) / 100}))};
}"""

SESSION_JS = """async () => {
  const r = await fetch('/api/sessions?items=profile.isAuthenticated', {credentials: 'include'});
  const s = await r.json();
  return s?.namespaces?.profile?.isAuthenticated?.value === 'true';
}"""


@dataclass
class Snapshot:
    url: str
    title: str
    text: str
    elements: list[dict]
    fills: dict[str, str]  # built-in fill action -> element id it targets
    filled: dict[str, bool]  # whether that field already has a value


@dataclass
class Sandbox:
    headed: bool = False
    blocked_requests: list[str] = field(default_factory=list)
    order_attempts: list[str] = field(default_factory=list)
    browser: Browser | None = None
    context: BrowserContext | None = None
    main: Page | None = None
    tracing: bool = False
    secrets: Secrets = field(default_factory=Secrets)
    allow_payment: bool = False
    # CLI debugging only (agent.py --record). A video cannot skip the card step, so it shows the
    # card being typed: never with a real card, and never from the job API.
    record_dir: str | None = None

    async def start(self, pw: Playwright) -> None:
        self.browser = await pw.chromium.launch(
            headless=not self.headed, channel="chromium", slow_mo=250 if self.headed else 0
        )
        video = {"record_video_dir": self.record_dir, "record_video_size": {"width": 1366, "height": 900}} \
            if self.record_dir else {}
        self.context = await self.browser.new_context(
            locale="es-AR", user_agent=UA, viewport={"width": 1366, "height": 900}, accept_downloads=False, **video
        )
        await self.context.route("**/*", self._guard)
        self.main = await self.context.new_page()

    async def start_trace(self) -> None:
        # Called only after login: traces record typed values, credentials must not be in them.
        await self.context.tracing.start(screenshots=True, snapshots=True, sources=False)
        self.tracing = True

    async def stop_trace(self, trace_path: str | None = None) -> None:
        # Also called before the card is typed: a trace with a PAN in it must never exist.
        if self.tracing:
            self.tracing = False
            await self.context.tracing.stop(path=trace_path)

    async def stop(self, trace_path: str | None = None) -> None:
        await self.stop_trace(trace_path)
        if self.browser:
            await self.browser.close()

    async def _guard(self, route) -> None:
        req = route.request
        host = urlparse(req.url).hostname or ""
        if (not self.allow_payment and ORDER_ENDPOINTS.search(req.url)
                and (req.method != "GET" or req.is_navigation_request())):
            self.order_attempts.append(f"{req.method} {req.url[:120]}")
            await route.abort()
        elif not any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS):
            self.blocked_requests.append(host)
            await route.abort()
        else:
            await route.continue_()

    @property
    def page(self) -> Page:
        # The login opens a popup window; act on the newest open page.
        open_pages = [p for p in self.context.pages if not p.is_closed()]
        return open_pages[-1] if open_pages else self.main

    @property
    def in_popup(self) -> bool:
        return self.page is not self.main

    async def goto(self, url: str) -> int:
        resp = await self.main.goto(url, wait_until="domcontentloaded")
        await self.settle()
        return resp.status if resp else 0

    async def settle(self, ms: int = 500) -> None:
        # The Flutter popup and VTEX checkout keep polling, so networkidle often never comes:
        # a short cap keeps a step from costing 5 s of nothing.
        try:
            await self.page.wait_for_load_state("networkidle", timeout=2000)
        except Exception:
            pass
        await self.page.wait_for_timeout(ms)

    async def _enable_flutter_semantics(self) -> None:
        # Flutter web paints to a canvas; its accessibility tree gives us real, clickable nodes.
        page = self.page
        try:
            if self.in_popup:
                await page.wait_for_load_state("domcontentloaded")
                await page.wait_for_selector("flt-semantics-placeholder, flt-semantics", state="attached", timeout=15000)
            elif not await page.evaluate("() => !!document.querySelector('flutter-view, flt-glass-pane')"):
                return
            await page.evaluate("() => document.querySelector('flt-semantics-placeholder')?.click()")
            # Wait until the semantics tree has interactive nodes (Flutter builds it lazily).
            await page.wait_for_function(
                "() => document.querySelectorAll('flt-semantics textarea, flt-semantics input, flt-semantics[role=button]').length > 0",
                timeout=8000,
            )
            await page.wait_for_timeout(400)
        except Exception:
            pass

    async def snapshot(self) -> Snapshot:
        await self._enable_flutter_semantics()
        raw = await self.page.evaluate(COLLECT_JS, MAX_ELEMENTS * 2)
        elements = []
        for e in raw:
            # Labels reach Jev and the logs too (e.g. saved addresses), so they get the same redaction as page text.
            e["label"], e["context"] = self.redact(e["label"]), self.redact(e["context"])
            if e["options"]:
                e["options"] = [self.redact(o) for o in e["options"]]
            text = f"{e['label']} {e['href']}"
            if BLOCKED.search(text):
                continue
            if REPLACE.search(text) and not NO_REPLACE.search(text):
                continue
            elements.append(e)
        fills: dict[str, str] = {}
        for action, (key, pattern, _) in SECRET_FIELDS.items():
            target = next((e for e in elements if e["field"] and pattern.search(e["label"])), None)
            if target and self.secrets.get(key):
                fills[action] = target["id"]
        # Fields that take secrets are reachable only through the fill_* actions.
        filled = {a: next(e for e in elements if e["id"] == i)["label"].endswith("(filled)") for a, i in fills.items()}
        secret_ids = set(fills.values())
        elements = [e for e in elements if e["id"] not in secret_ids][:MAX_ELEMENTS]
        try:
            text = re.sub(r"\s+", " ", await self.page.inner_text("body"))
            modal = await self.page.evaluate(
                "(sel) => { const m = [...document.querySelectorAll(sel)].find(n => n.getBoundingClientRect().height > 50);"
                " return m ? m.innerText : ''; }", MODAL_SELECTOR)
            if modal:
                text = "[OPEN MODAL] " + re.sub(r"\s+", " ", modal) + " [PAGE BEHIND] " + text
        except Exception:
            text = ""
        return Snapshot(self.page.url, await self.page.title(), self.redact(text)[:PAGE_TEXT], elements, fills, filled)

    async def highlight(self, el_id: str | None, banner: str, tag: str = "") -> None:
        try:
            await self.page.evaluate(HIGHLIGHT_JS, {"id": el_id, "banner": banner, "tag": tag})
        except Exception:
            pass  # page navigated or closed mid-inject; next step re-injects

    async def click(self, el_id: str) -> None:
        page = self.page
        await page.locator(f'[data-jev-id="{el_id}"]').first.click(timeout=6000)
        await self.settle()

    async def select(self, el_id: str, index: int) -> None:
        await self.page.locator(f'[data-jev-id="{el_id}"]').first.select_option(index=index, timeout=6000)
        await self.settle()

    async def fill_secret(self, action: str, el_id: str) -> None:
        key, _, _ = SECRET_FIELDS[action]
        page = self.page
        loc = page.locator(f'[data-jev-id="{el_id}"]').first
        # Flutter's glass pane intercepts pointer clicks on its text fields; focusing works everywhere.
        await loc.focus(timeout=6000)
        await page.keyboard.press("ControlOrMeta+a")
        await page.keyboard.press("Backspace")
        await page.keyboard.type(self.secrets[key], delay=40 if self.headed else 0)
        await page.wait_for_timeout(600)

    async def search(self, query: str) -> None:
        await self.main.goto(f"{BASE}/{query}?_q={query}&map=ft", wait_until="domcontentloaded")
        await self.settle(1500)

    async def open_cart(self) -> None:
        await self.main.goto(f"{BASE}/checkout/#/cart", wait_until="domcontentloaded")
        await self.settle(1500)

    async def back(self) -> None:
        await self.page.go_back(wait_until="domcontentloaded")
        await self.settle()

    async def order_form(self) -> dict:
        try:
            return await self.main.evaluate(ORDERFORM_JS)
        except Exception:
            return {"id": None, "value": 0.0, "items": []}

    async def logged_in(self) -> bool:
        # Ask the session API through the context (same cookies), not the page: right after login
        # the store page redirects several times and in-page evaluation fails mid-navigation.
        try:
            r = await self.context.request.get(BASE + "/api/sessions?items=profile.isAuthenticated")
            s = await r.json()
            return s.get("namespaces", {}).get("profile", {}).get("isAuthenticated", {}).get("value") == "true"
        except Exception:
            return False

    async def wait_for_login(self, seconds: float = 12) -> bool:
        """After the login popup closes the store needs a reload to pick up the new session."""
        for i in range(max(1, int(seconds / 2))):
            if await self.logged_in():
                for p in self.context.pages:
                    if p is not self.main:
                        await p.close()
                await self.main.wait_for_timeout(3000)  # let the post-login redirects finish
                await self.goto(BASE + "/")
                return True
            if i < int(seconds / 2) - 1:
                await self.main.wait_for_timeout(2000)
        return False

    async def on_payment_step(self) -> bool:
        return "#/payment" in self.main.url

    def redact(self, text: str) -> str:
        # Known account and card values never reach Jev or a log, even when the page displays them.
        for key, tag in REDACT_TAGS.items():
            value = self.secrets.get(key)
            if value and len(value) >= 3:
                text = text.replace(value, tag)
        return text
