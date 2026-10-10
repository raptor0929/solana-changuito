"""The sandboxed Chromium for Día Argentina (VTEX store + Flutter login popup), over CDP.

The browser acts; it never decides. Every decision during login comes from Jev in agent.py,
and checkout is driven by Jev Ultrafast (ultrafast.py) in its own tab of the same browser.
Credentials are read from the environment here and never leave this module: they are typed
by this code, never by a model, and redacted from everything a model is shown.

This used to be Playwright. It is now a thin layer on cdp.py, so that Ultrafast can share the
browser over the same debugging port and the network guard covers both.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field

from cdp import CDP, CDPError, Chromium, Guard
from rules import BASE, SECRET_FIELDS, offered, redact

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)


MAX_ELEMENTS = 240
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


def _call(fn: str, arg=None) -> str:
    """A page-side function and its argument as one Runtime.evaluate expression."""
    return f"({fn})({json.dumps(arg)})"


@dataclass
class Sandbox:
    headed: bool = False
    chromium: Chromium | None = None
    cdp: CDP | None = None
    guard: Guard | None = None
    main_target: str = ""
    pages: list[str] = field(default_factory=list)  # page target ids, oldest first

    # ---- lifecycle -------------------------------------------------------------------------

    async def start(self) -> None:
        self.chromium = Chromium(headed=self.headed, port=int(os.environ.get("CHROME_DEBUG_PORT", "9222")),
                                 user_agent=UA)
        self.chromium.start()
        self.cdp = CDP()
        await self.cdp.connect(self.chromium.ws_url)
        self.cdp.on("Target.targetCreated", self._created)
        self.cdp.on("Target.targetDestroyed", lambda p, _s: self._gone(p["targetId"]))
        self.guard = Guard(self.cdp)
        await self.guard.install()
        for info in (await self.cdp.send("Target.getTargets"))["targetInfos"]:
            if info["type"] == "page" and info["targetId"] not in self.pages:
                self.pages.append(info["targetId"])
        self.main_target = self.pages[0]
        main = await self._session(self.main_target)
        await self.cdp.send("Emulation.setUserAgentOverride",
                            {"userAgent": UA, "acceptLanguage": "es-AR,es;q=0.9"}, session=main)

    async def stop(self) -> None:
        if self.cdp:
            await self.cdp.close()
        if self.chromium:
            self.chromium.stop()

    @property
    def blocked_requests(self) -> list[str]:
        return self.guard.blocked_requests if self.guard else []

    @property
    def order_attempts(self) -> list[str]:
        return self.guard.order_attempts if self.guard else []

    # ---- targets ---------------------------------------------------------------------------

    def _created(self, params: dict, _s) -> None:
        info = params["targetInfo"]
        if info["type"] == "page" and info["targetId"] not in self.pages:
            self.pages.append(info["targetId"])

    def _gone(self, target_id: str) -> None:
        if target_id in self.pages and target_id != self.main_target:
            self.pages.remove(target_id)

    async def _session(self, target_id: str) -> str:
        """The guard attaches to every page; reuse its flattened session for that target."""
        for _ in range(100):
            for sid, info in self.guard.sessions.items():
                if info.get("targetId") == target_id:
                    return sid
            await asyncio.sleep(0.05)
        raise CDPError(f"no session for target {target_id}")

    @property
    def page_target(self) -> str:
        # The login opens a popup window; act on the newest open page.
        return self.pages[-1] if self.pages else self.main_target

    @property
    def in_popup(self) -> bool:
        return self.page_target != self.main_target

    async def evaluate(self, expression: str, target: str | None = None, timeout: float = 15.0):
        session = await self._session(target or self.page_target)
        res = await self.cdp.send("Runtime.evaluate",
                                  {"expression": expression, "awaitPromise": True, "returnByValue": True},
                                  session=session, timeout=timeout)
        if res.get("exceptionDetails"):
            raise CDPError(res["exceptionDetails"].get("text", "evaluation failed"))
        return res.get("result", {}).get("value")

    async def url(self, target: str | None = None) -> str:
        try:
            return await self.evaluate("location.href", target) or ""
        except CDPError:
            return ""

    # ---- waiting: for the thing that should happen, not for a fixed time -------------------

    async def ready(self, target: str | None = None, timeout: float = 8.0, quiet_ms: int = 250) -> None:
        """Document complete, then a short quiet beat for client-side rendering. Bounded."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            try:
                if await self.evaluate("document.readyState", target, timeout=3) == "complete":
                    break
            except (CDPError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(0.1)
        await asyncio.sleep(quiet_ms / 1000)

    async def goto(self, url: str) -> None:
        session = await self._session(self.main_target)
        await self.cdp.send("Page.navigate", {"url": url}, session=session)
        await asyncio.sleep(0.2)  # let the old document start unloading before polling readyState
        await self.ready(self.main_target)

    # ---- the login loop's view of the page --------------------------------------------------

    async def _enable_flutter_semantics(self) -> None:
        # Flutter web paints to a canvas; its accessibility tree gives us real, clickable nodes.
        try:
            if not self.in_popup and not await self.evaluate(
                    "!!document.querySelector('flutter-view, flt-glass-pane')"):
                return
            for _ in range(150):  # up to ~15s for the popup's Flutter app to attach its placeholder
                if await self.evaluate("!!document.querySelector('flt-semantics-placeholder, flt-semantics')"):
                    break
                await asyncio.sleep(0.1)
            await self.evaluate("document.querySelector('flt-semantics-placeholder')?.click()")
            for _ in range(80):  # Flutter builds the semantics tree lazily
                if await self.evaluate("document.querySelectorAll('flt-semantics textarea, flt-semantics input, "
                                       "flt-semantics[role=button]').length > 0"):
                    break
                await asyncio.sleep(0.1)
            await asyncio.sleep(0.3)
        except CDPError:
            pass

    async def snapshot(self) -> Snapshot:
        await self._enable_flutter_semantics()
        raw = await self.evaluate(_call(COLLECT_JS, MAX_ELEMENTS * 2)) or []
        elements = []
        for e in raw:
            # Labels reach Jev and the logs too (e.g. saved addresses), so they get the same redaction as page text.
            e["label"], e["context"] = redact(e["label"]), redact(e["context"])
            if e["options"]:
                e["options"] = [redact(o) for o in e["options"]]
            if not offered(f"{e['label']} {e['href']}"):
                continue
            elements.append(e)
        fills: dict[str, str] = {}
        for action, (env, pattern, _) in SECRET_FIELDS.items():
            target = next((e for e in elements if e["field"] and pattern.search(e["label"])), None)
            if target and os.environ.get(env):
                fills[action] = target["id"]
        # Fields that take secrets are reachable only through the fill_* actions.
        filled = {a: next(e for e in elements if e["id"] == i)["label"].endswith("(filled)") for a, i in fills.items()}
        secret_ids = set(fills.values())
        elements = [e for e in elements if e["id"] not in secret_ids][:MAX_ELEMENTS]
        try:
            text = re.sub(r"\s+", " ", await self.evaluate("document.body ? document.body.innerText : ''") or "")
            modal = await self.evaluate(_call(
                "(sel) => { const m = [...document.querySelectorAll(sel)].find(n => n.getBoundingClientRect().height > 50);"
                " return m ? m.innerText : ''; }", MODAL_SELECTOR))
            if modal:
                text = "[OPEN MODAL] " + re.sub(r"\s+", " ", modal) + " [PAGE BEHIND] " + text
        except CDPError:
            text = ""
        title = await self.evaluate("document.title") or ""
        return Snapshot(await self.url(), title, redact(text)[:3000], elements, fills, filled)

    async def highlight(self, el_id: str | None, banner: str, tag: str = "") -> None:
        try:
            await self.evaluate(_call(HIGHLIGHT_JS, {"id": el_id, "banner": banner, "tag": tag}))
        except CDPError:
            pass  # page navigated or closed mid-inject; next step re-injects

    async def _point(self, el_id: str) -> tuple[float, float]:
        box = await self.evaluate(_call(
            "(id) => { const e = document.querySelector(`[data-jev-id=\"${id}\"]`); if (!e) return null;"
            " e.scrollIntoView({block: 'center'}); const r = e.getBoundingClientRect();"
            " return r.width && r.height ? [r.x + r.width / 2, r.y + r.height / 2] : null; }", el_id))
        if not box:
            raise CDPError(f"element {el_id} is gone or has no box")
        return box[0], box[1]

    async def click(self, el_id: str) -> None:
        x, y = await self._point(el_id)
        session = await self._session(self.page_target)
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            await self.cdp.send("Input.dispatchMouseEvent",
                                {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}, session=session)
        await asyncio.sleep(0.15)
        await self.ready()

    async def select(self, el_id: str, index: int) -> None:
        await self.evaluate(_call(
            "([id, i]) => { const e = document.querySelector(`[data-jev-id=\"${id}\"]`); e.selectedIndex = i;"
            " e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); }",
            [el_id, index]))
        await self.ready()

    async def fill_secret(self, action: str, el_id: str) -> None:
        env, _, _ = SECRET_FIELDS[action]
        # Flutter's glass pane intercepts pointer clicks on its text fields; focusing works everywhere.
        await self.evaluate(_call("(id) => document.querySelector(`[data-jev-id=\"${id}\"]`)?.focus()", el_id))
        session = await self._session(self.page_target)
        mod = 4 if os.uname().sysname == "Darwin" else 2  # Meta on macOS, Ctrl elsewhere
        await self.cdp.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "a", "code": "KeyA",
                                                       "modifiers": mod, "commands": ["selectAll"]}, session=session)
        await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "code": "KeyA", "modifiers": mod},
                            session=session)
        for kind in ("rawKeyDown", "keyUp"):
            await self.cdp.send("Input.dispatchKeyEvent",
                                {"type": kind, "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8},
                                session=session)
        # Character by character, as a keyboard would: Flutter's text fields listen for key events.
        for ch in os.environ[env]:
            await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "text": ch, "key": ch}, session=session)
            await self.cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch}, session=session)
        await asyncio.sleep(0.3)

    async def back(self) -> None:
        await self.evaluate("history.back()")
        await asyncio.sleep(0.2)
        await self.ready()

    # ---- the store's own APIs, in the logged-in page so its cookies apply ---------------------

    async def order_form(self) -> dict:
        try:
            return await self.evaluate(_call(ORDERFORM_JS), self.main_target) or {"id": None, "value": 0.0, "items": []}
        except (CDPError, asyncio.TimeoutError):
            return {"id": None, "value": 0.0, "items": []}

    async def empty_cart(self) -> None:
        await self.evaluate(_call(
            "async () => { const f = await (await fetch('/api/checkout/pub/orderForm', {credentials: 'include'})).json();"
            " await fetch(`/api/checkout/pub/orderForm/${f.orderFormId}/items/removeAll`,"
            " {method: 'POST', credentials: 'include', headers: {'content-type': 'application/json'}, body: '{}'}); }"),
            self.main_target)

    async def add_items(self, items: list[dict]) -> dict:
        """Add by SKU, in one call. Returns the store's own error messages, if any."""
        return await self.evaluate(_call(
            "async (items) => { const f = await (await fetch('/api/checkout/pub/orderForm', {credentials: 'include'})).json();"
            " const r = await fetch(`/api/checkout/pub/orderForm/${f.orderFormId}/items`,"
            " {method: 'POST', credentials: 'include', headers: {'content-type': 'application/json'},"
            "  body: JSON.stringify({orderItems: items})});"
            " const o = await r.json().catch(() => ({}));"
            " return {status: r.status, messages: (o.messages || []).map(m => m.text).filter(Boolean)}; }",
            [{"id": i["sku"], "quantity": i["quantity"], "seller": i.get("seller") or "1"} for i in items]),
            self.main_target)

    async def logged_in(self) -> bool:
        try:
            return bool(await self.evaluate(_call(SESSION_JS), self.main_target, timeout=5))
        except (CDPError, asyncio.TimeoutError):
            return False  # mid-navigation right after login; the caller asks again

    async def wait_for_login(self, seconds: float = 12) -> bool:
        """After the login popup closes the store needs a reload to pick up the new session."""
        for i in range(max(1, int(seconds / 2))):
            if await self.logged_in():
                for target in [t for t in self.pages if t != self.main_target]:
                    try:
                        await self.cdp.send("Target.closeTarget", {"targetId": target})
                    except CDPError:
                        pass
                await asyncio.sleep(1.5)  # the post-login redirects
                await self.goto(BASE + "/")
                return True
            if i < int(seconds / 2) - 1:
                await asyncio.sleep(2)
        return False

    async def where(self) -> list[str]:
        """Each open page as host + path, never the query (login redirects carry tokens there)."""
        out = []
        for target in list(self.pages):
            try:
                loc = await self.evaluate(
                    "[location.host, location.pathname, document.title, "
                    "!!document.querySelector('#main-frame-error, .neterror, #sub-frame-error')]", target, timeout=3)
                host, path, title, neterror = loc
                out.append(f"{'POPUP ' if target != self.main_target else ''}{host}{path}"
                           f"{'  [browser error page: ' + title + ']' if neterror else ''}")
            except (CDPError, asyncio.TimeoutError):
                out.append("(page not readable)")
        return out

    async def open_cart(self) -> None:
        await self.goto(f"{BASE}/checkout/#/cart")
