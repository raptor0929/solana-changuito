"""One sandbox run on Día Argentina: login -> empty cart -> shop -> checkout, stopping at payment.

Each phase uses the cheapest thing that is still trustworthy:

- **login**: Jev picks, the sandbox types. Día's login is a Flutter popup; Jev chooses which
  field or button comes next, and secrets are typed by sandbox.py from the environment, never
  by a model. The store's session API, not Jev, decides when login is done.
- **empty_cart** and **shop**: no model at all. The cart is emptied and filled through the
  store's own orderForm API, by SKU and with the real quantities, in the logged-in page so its
  cookies apply. Only a line with no SKU (an older caller) falls back to Ultrafast searching
  for it by name.
- **checkout**: Jev Ultrafast walks from the cart to the payment step (ultrafast.py). Success
  is the URL reaching `#/payment`, read from the browser, not anything a model says.

The run never enters card details: nothing is offered that could, and cdp.py fails any order
or payment request at the network layer whatever is clicked.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time

from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, TypeSafeError

from rules import BASE, SECRET_FIELDS
from sandbox import Sandbox, Snapshot
from ultrafast import run_checkout

PHASES = ("login", "empty_cart", "shop", "checkout")
LOGIN_MAX_STEPS = 20
CHECKOUT_MAX_S = 180
SHOP_MAX_S = 90

PAGE_KINDS = {
    "login_form": "A login form asking for DNI, email or password",
    "store_page": "Store home or category page",
    "other": "Anything else, including errors",
}

LOGIN = ("Log in to the store. Open the login (Ingresar / Entrar con mi cuenta) if needed, fill every empty "
         "field with the matching fill action first, and only when no field is empty press Continuar / Ingresar. "
         "Prefer logging in with password.")

CHECKOUT = ("Advance this supermarket checkout to the payment step. Continue from the cart, keep the account's "
            "saved address with home delivery (Envío a domicilio), choose 'Envío programado' (scheduled delivery, "
            "never Express or store pickup), pick the earliest available delivery window, and if asked what to do "
            "with missing products choose NOT to replace them. Stop as soon as the page asks for a payment method "
            "or card. Never enter payment or card details and never place the order.")

SEARCH_ADD = ("Add '{name}' to the shopping cart with quantity {quantity}: press Agregar on the product card that "
              "best matches it, confirm the quantity if a modal asks, and if a modal asks for the delivery method "
              "choose home delivery with 'Envío programado'. Stop once it is in the cart.")


def describe(e: dict) -> str:
    desc = f"{e['tag']} '{e['label']}'"
    if e["checked"]:
        desc += " (selected)"
    if e["context"]:
        desc += f" — product card: {e['context']}"
    elif e["href"]:
        desc += f" -> {e['href'][:80]}"
    return desc


def login_options(snap: Snapshot, in_popup: bool, exclude: frozenset[str]) -> dict[str, str]:
    options: dict[str, str] = {}
    # On the store page 'email' is the newsletter box; credentials go only into the login popup.
    if in_popup:
        for action in ("fill_dni", "fill_email", "fill_password"):  # in form order
            if action in snap.fills and not snap.filled.get(action):  # filled fields are not offered again
                options[action] = f"Type the {SECRET_FIELDS[action][2]} into its empty field"
                break
    else:
        options["back"] = "Go back to the previous page"
    for e in snap.elements:
        if len(options) >= 250:  # Jev's Choice limit is 255
            break
        if e["options"] is None:
            options[e["id"]] = describe(e)
    options["wait"] = "Wait a moment for the page to finish loading"
    kept = {k: v for k, v in options.items() if v not in exclude}
    return kept or options  # never send Jev an empty Choice


async def login(sb: Sandbox, client: AsyncTypeSafeClient, model: str | None, log) -> tuple[bool, list[float], str]:
    """Jev picks, the sandbox types. Returns (logged_in, Jev latencies in ms, error)."""
    latencies: list[float] = []
    history: list[str] = []
    failures: dict[str, int] = {}
    was_in_popup = False
    for step in range(1, LOGIN_MAX_STEPS + 1):
        if await sb.wait_for_login(seconds=4 if was_in_popup else 0):
            return True, latencies, ""
        was_in_popup = sb.in_popup
        snap = await sb.snapshot()
        options = login_options(snap, sb.in_popup, frozenset(k for k, n in failures.items() if n >= 2))
        questions = {
            "next_action": Choice(instructions=LOGIN, criteria=options),
            "page_kind": Choice(instructions="What kind of page or panel is in front of the user?", criteria=PAGE_KINDS),
            "phase_done": Noul(instructions="The user is now logged in to the store."),
        }
        state = {"phase": "login", "goal": LOGIN, "recent_actions": history[-6:],
                 "page": {"url": snap.url, "title": snap.title, "text": snap.text}}
        q0 = time.perf_counter()
        try:
            resp = await client.system_one(state=state, questions=questions, model=model)
        except TypeSafeError as e:
            return False, latencies, f"Jev call failed: {e}"
        latencies.append((time.perf_counter() - q0) * 1000)
        action = resp.answers["next_action"].choice
        label = options[action]
        log(f"{step:>2}  login  {label[:60]:<60} {latencies[-1]:>6.0f} ms")
        try:
            if action in snap.fills:
                await sb.fill_secret(action, snap.fills[action])
            elif action == "wait":
                await sb.ready(timeout=3, quiet_ms=500)
            elif action == "back":
                await sb.back()
            else:
                await sb.click(action)
        except Exception as e:  # noqa: BLE001
            failures[label] = failures.get(label, 0) + 1
            history.append(f"{label[:90]} -> failed ({type(e).__name__})")
            continue
        if history[-6:].count(label[:110]) >= 2:  # third pick of the same action recently: stuck on it
            failures[label] = 2
        history.append(label[:110])
    if await sb.wait_for_login(seconds=4):
        return True, latencies, ""
    return False, latencies, "login did not complete"


async def run_job(items: list[dict] | list[str], *, headed: bool = False, model: str | None = None,
                  on_phase=None, log=print) -> dict:
    """One sandbox run. Returns what changuito's job API reports (services/sandbox/server.py).

    `items` are `{name, quantity, sku?}`; plain strings are names with quantity 1 (the CLI).
    `on_phase(name)` is called on entering each phase so a caller can show progress.
    """
    items = [{"name": i, "quantity": 1, "sku": None} if isinstance(i, str) else i for i in items]
    t0 = time.perf_counter()
    timings: dict[str, float] = {}
    phase = "login"

    def enter(name: str) -> None:
        nonlocal phase
        timings[phase] = round(time.perf_counter() - t0 - sum(timings.values()), 1)
        phase = name
        log(f"\n== phase: {name} ==")
        if on_phase:
            on_phase(name)

    def result(reached: bool, error: str | None, form: dict, checkout: dict | None = None) -> dict:
        timings[phase] = round(time.perf_counter() - t0 - sum(timings.values()), 1)
        wall = round(time.perf_counter() - t0, 1)
        log(f"\n— summary —\nresult: {'reached payment' if reached else error}   phase: {phase}   wall {wall} s   "
            f"timings {timings}\nsandbox: {len(sb.blocked_requests)} off-allowlist requests aborted; "
            f"order-placement requests blocked: {len(sb.order_attempts)}")
        return {
            "status": "done" if reached else "failed",
            "phase": "payment" if reached else phase,
            "reached_payment": reached,
            "items_added": len(form.get("items", [])),
            "items_requested": len(items),
            "cart": {"orderFormId": form.get("id"), "value": form.get("value"),
                     "items": [{"name": i["name"], "qty": i["qty"], "price": i["price"]} for i in form.get("items", [])]},
            "final_url": (checkout or {}).get("url"),
            "wall_s": wall,
            "timings": timings,
            "checkout_steps": (checkout or {}).get("steps"),
            "orders_blocked": len(sb.order_attempts),
            "error": None if reached else error,
        }

    client = AsyncTypeSafeClient()
    sb = Sandbox(headed=headed)
    await sb.start()
    try:
        if on_phase:
            on_phase("login")
        log("== phase: login ==")
        await sb.goto(BASE + "/login")
        ok, latencies, error = await login(sb, client, model, log)
        if latencies:
            log(f"jev: {len(latencies)} calls, median {statistics.median(latencies):.0f} ms")
        if not ok:
            return result(False, error, await sb.order_form())

        enter("empty_cart")
        await sb.empty_cart()
        form = await sb.order_form()
        if form["items"]:
            return result(False, "the cart did not empty", form)

        enter("shop")
        by_sku = [i for i in items if i.get("sku")]
        by_name = [i for i in items if not i.get("sku")]
        if by_sku:
            added = await sb.add_items(by_sku)
            if added.get("messages"):
                log(f"store messages: {added['messages']}")
        for item in by_name:
            # Older callers send names only: Ultrafast searches for each, in its own tab.
            out = await asyncio.to_thread(
                run_checkout, SEARCH_ADD.format(name=item["name"], quantity=item["quantity"]),
                f"{BASE}/{item['name']}?_q={item['name']}&map=ft", sb.chromium.http_url, max_seconds=SHOP_MAX_S)
            log(f"search-add '{item['name']}': {out.get('error') or 'done'} ({out.get('steps')} steps)")
        form = await sb.order_form()
        for line in form["items"]:
            log(f"    ✓ {line['qty']} x {line['name']}  $ {line['price']:,.2f}")
        if not form["items"]:
            return result(False, "no product could be added", form)

        enter("checkout")
        await sb.open_cart()

        def step(n, action, ms, url):
            log(f"{n:>2}  checkout  {action[:60]:<60} {ms:>6.0f} ms  {url[-40:]}")

        checkout = await asyncio.to_thread(run_checkout, CHECKOUT, f"{BASE}/checkout/#/cart",
                                           sb.chromium.http_url, max_seconds=CHECKOUT_MAX_S, on_step=step)
        form = await sb.order_form()
        return result(bool(checkout.get("reached")), checkout.get("error"), form, checkout)
    finally:
        await sb.stop()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Log in to Día Argentina, build a cart and walk checkout up to payment.")
    p.add_argument("--list", default="fideos, jamón, queso", help="comma-separated names (searched, quantity 1)")
    p.add_argument("--sku", action="append", default=[], help="SKU:QUANTITY, added by id (repeatable)")
    p.add_argument("--headed", action="store_true", help="show the browser")
    p.add_argument("--model", default=None, help="TypeSafe model for the login loop (default: SDK default, Jev)")
    return p.parse_args()


async def run(args: argparse.Namespace) -> int:
    items: list[dict] = [{"name": f"sku {s.split(':')[0]}", "sku": s.split(":")[0],
                          "quantity": int(s.split(":")[1]) if ":" in s else 1} for s in args.sku]
    if not items:
        items = [{"name": s.strip(), "quantity": 1, "sku": None} for s in args.list.split(",") if s.strip()]
    out = await run_job(items, headed=args.headed, model=args.model)
    return 0 if out["reached_payment"] else 3


if __name__ == "__main__":
    sys.exit(asyncio.run(run(parse_args())))
