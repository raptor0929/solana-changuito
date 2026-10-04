"""Jev drives a sandboxed browser through Dia Argentina: login -> empty cart -> shop -> checkout.

The run stops on the checkout payment step, before any card detail is entered. Jev never
generates text: each step it answers typed questions and the sandbox executes the choice.
Credentials are typed by the sandbox from the environment; Jev only picks "fill_*" actions.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright
from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score, TypeSafeError

from sandbox import BASE, NO_REPLACE, REPLACE, SECRET_FIELDS, Sandbox, Snapshot

PHASES = ("login", "empty_cart", "shop", "checkout")
PAGE_KINDS = {
    "login_form": "A login form asking for DNI, email or password",
    "store_page": "Store home or category page",
    "search_results": "A grid of product search results",
    "product_modal": "A product, quantity or delivery-choice modal or panel",
    "cart": "The shopping cart",
    "checkout_step": "A checkout step: identification, shipping address, delivery window or substitutions",
    "payment": "The payment step asking for card or payment method",
    "other": "Anything else, including errors",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Jev logs in to Dia Argentina, builds a cart and walks checkout up to payment.")
    p.add_argument("--list", default="fideos, jamón, queso, nuggets", help="comma-separated shopping list")
    p.add_argument("--headed", action="store_true", help="show the browser (slowed down) to watch Jev work")
    p.add_argument("--trace", action="store_true", help="save a Playwright trace (from after login) + per-step Jev jsonl in traces/")
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--min-confidence", type=float, default=0.15,
                   help="in the shop phase, below this confidence fall back to searching the current item")
    p.add_argument("--model", default=None, help="TypeSafe model (default: SDK default, Jev)")
    p.add_argument("--hold", type=float, default=8.0, help="seconds to keep a headed browser open at the end")
    return p.parse_args()


def describe(e: dict) -> str:
    desc = f"{e['tag']} '{e['label']}'"
    if e["checked"]:
        desc += " (selected)"
    if e["context"]:
        desc += f" — product card: {e['context']}"
    elif e["href"]:
        desc += f" -> {e['href'][:80]}"
    return desc


def build_options(snap: Snapshot, phase: str, item: str | None, exclude: frozenset[str],
                  in_popup: bool = False) -> dict[str, str]:
    options: dict[str, str] = {}
    phase_fills = {"login": ("fill_dni", "fill_email", "fill_password"),
                   "checkout": ("fill_dni", "fill_postcode")}.get(phase, ())
    if phase == "login" and not in_popup:
        phase_fills = ()  # on the store page 'email' is the newsletter box; credentials go only into the login popup
    for action in phase_fills:  # in form order: DNI, then email, then password
        if action in snap.fills and not snap.filled.get(action):  # filled fields are not offered again
            options[action] = f"Type the {SECRET_FIELDS[action][2]} into its empty field"
            break
    if phase == "shop" and item:
        options["search"] = f"Search the store for '{item}'"
    if phase in ("empty_cart", "checkout"):
        options["open_cart"] = "Open the cart / checkout page"
    if not in_popup:
        options["back"] = "Go back to the previous page"
    for e in snap.elements:
        if len(options) >= 250:  # Jev's Choice limit is 255
            break
        if e["options"] is not None:  # <select>: one option per choice, replacements filtered
            for i, opt in enumerate(e["options"]):
                if not opt or (REPLACE.search(opt) and not NO_REPLACE.search(opt)):
                    continue
                mark = " (current)" if i == e["selected"] else ""
                options[f"{e['id']}:{i}"] = f"In dropdown '{e['label']}', choose '{opt}'{mark}"
            continue
        if phase == "shop" and e["tag"] == "a" and e["context"]:
            continue  # product-name links only lead away from the Agregar button on the same card
        options[e["id"]] = describe(e)
    options["wait"] = "Wait a moment for the page to finish loading"
    kept = {k: v for k, v in options.items() if v not in exclude}
    return kept or options  # never send Jev an empty Choice


INSTRUCTIONS = {
    "login": ("Log in to the store. Open the login (Ingresar / Entrar con mi cuenta) if needed, fill every empty "
              "field with the matching fill action first, and only when no field is empty press Continuar / Ingresar. Prefer logging in with password."),
    "empty_cart": "Empty the cart: remove every product (trash / Eliminar / quitar). Do not add anything.",
    "shop": ("Add '{item}' to the cart: search for it if it is not on screen, then press Agregar on the product "
             "card that best matches it. Confirm quantity 1 if a modal asks. If a modal asks for the delivery "
             "location or method, select the saved address and confirm, then choose home delivery (Envío a domicilio), "
             "select 'Envío programado' (scheduled delivery, never Express or store pickup) and press Confirmar. "
             "Confirmar stays disabled until a delivery type is selected."),
    "checkout": ("Advance checkout to the payment step: continue from the cart, keep the account's saved address "
                 "with home delivery, pick the earliest available delivery window, and if asked what to do with "
                 "missing products choose NOT to replace them. Never enter payment or card details."),
}
DONE_STATEMENT = {
    "login": "The user is now logged in to the store.",
    "empty_cart": "The cart is empty.",
    "shop": "'{item}' was just added to the cart.",
    "checkout": "The page is the payment step asking for a payment method or card.",
}


def build_questions(phase: str, item: str | None, options: dict[str, str]) -> dict:
    fmt = {"item": item or ""}
    q = {
        "next_action": Choice(instructions=INSTRUCTIONS[phase].format(**fmt), criteria=options),
        "page_kind": Choice(instructions="What kind of page or panel is in front of the user?", criteria=PAGE_KINDS),
        "phase_done": Noul(instructions=DONE_STATEMENT[phase].format(**fmt)),
    }
    if phase == "shop":
        q["product_match"] = Score(
            instructions=f"How well do the products visible on this page match '{item}'?",
            criteria=["No relevant products", "Related but not the same product", "Exact match visible"],
        )
    return q


async def run_job(items: list[str], *, headed: bool = False, trace: bool = False, max_steps: int = 60,
                  min_confidence: float = 0.15, model: str | None = None, hold: float = 8.0,
                  on_phase=None) -> dict:
    """One sandbox run. Returns what changuito's job API reports (services/sandbox/server.py).

    `on_phase(name)` is called on entering each phase so a caller can show progress.
    """
    client = AsyncTypeSafeClient()
    sb = Sandbox(headed=headed)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    trace_dir = Path("traces")
    jsonl = None
    if trace:
        trace_dir.mkdir(exist_ok=True)
        jsonl = open(trace_dir / f"run-{stamp}.jsonl", "w")

    phase_i = 0
    done_items: list[str] = []
    history: list[str] = []
    failures: dict[str, int] = {}
    latencies: list[float] = []
    picks: list[str] = []  # checkout choices Jev made (delivery window etc.)
    form: dict = {"items": [], "value": 0.0}
    t0 = time.perf_counter()
    result = "max steps reached"
    final_url = None
    was_in_popup = False

    def enter(i: int) -> None:
        nonlocal phase_i
        phase_i = i
        failures.clear()
        print(f"\n== phase: {PHASES[i]} ==")
        if on_phase:
            on_phase(PHASES[i])

    async with async_playwright() as pw:
        await sb.start(pw)
        try:
            status = await sb.goto(BASE + "/login")
            if status != 200:
                print(f"store returned HTTP {status}. Try --headed.")
                return {"status": "failed", "phase": "login", "error": f"store returned HTTP {status}",
                        "reached_payment": False, "items_added": 0}
            enter(0)
            print(f"{'#':>2}  {'page_kind':<15} {'done':>5}  {'action':<56} {'p':>5} {'jev ms':>6}")

            for step in range(1, max_steps + 1):
                phase = PHASES[phase_i]

                # Authoritative phase checks come from the store's own APIs, not from Jev.
                # The popup sometimes stays open on oauth/finish?authStatus=Success; the session API is the truth.
                if phase == "login" and await sb.wait_for_login(seconds=4 if was_in_popup else 0):
                    print("    ✓ logged in")
                    if trace:
                        await sb.start_trace()
                    enter(1)
                    await sb.open_cart()
                    continue
                if phase == "empty_cart":
                    form = await sb.order_form()
                    if not form["items"]:
                        print("    ✓ cart is empty")
                        enter(2)
                        continue
                if phase == "shop" and len(done_items) == len(items):
                    enter(3)
                    await sb.open_cart()
                    continue
                if phase == "checkout" and await sb.on_payment_step():
                    result = "reached payment step (stopped before card details)"
                    print(f"    ✓ {result}")
                    break

                was_in_popup = sb.in_popup
                item = items[len(done_items)] if phase == "shop" else None
                before = await sb.order_form() if phase == "shop" else None
                snap = await sb.snapshot()
                exclude = frozenset(lbl for lbl, n in failures.items() if n >= 2)
                options = build_options(snap, phase, item, exclude, sb.in_popup)
                questions = build_questions(phase, item, options)
                state = {
                    "phase": phase,
                    "goal": INSTRUCTIONS[phase].format(item=item or ""),
                    "shopping_list": items, "items_added": done_items,
                    "cart": [f"{i['qty']} x {i['name']}" for i in form["items"]] if phase != "login" else None,
                    "page": {"url": snap.url, "title": snap.title, "text": snap.text},
                    "recent_actions": history[-6:],
                }

                q0 = time.perf_counter()
                try:
                    resp = await client.system_one(state=state, questions=questions, model=model)
                except TypeSafeError as e:
                    print(f"Jev call failed: {e}")
                    return {"status": "failed", "phase": phase, "error": f"Jev call failed: {e}",
                            "reached_payment": False, "items_added": len(done_items)}
                ms = (time.perf_counter() - q0) * 1000
                latencies.append(ms)

                a = resp.answers
                action, conf = a["next_action"].choice, a["next_action"].confidence
                fallback = (phase == "shop" and conf < min_confidence and action != "search"
                            and "search" in options)
                if fallback:
                    action = "search"
                label = options[action]
                el_id = snap.fills.get(action) or action.split(":")[0]
                el = next((e for e in snap.elements if e["id"] == el_id), None)

                await sb.highlight(
                    el_id if el or action in snap.fills else None,
                    f"Jev step {step} · {phase}{f' · {item}' if item else ''} · "
                    f"{action}{' (fallback)' if fallback else ''} p={conf:.2f} · {ms:.0f} ms",
                    f"Jev p={conf:.2f}",
                )
                if headed:
                    await sb.page.wait_for_timeout(700)

                short = label if not el else (el["label"] + (f" [{el['context'][:28]}]" if el["context"] else ""))
                if ":" in action:
                    short = label
                print(f"{step:>2}  {a['page_kind'].choice:<15} {a['phase_done'].noul:>5.2f}  "
                      f"{short[:56]:<56} {conf:>5.2f} {ms:>6.0f}")

                if jsonl:
                    jsonl.write(json.dumps({
                        "step": step, "phase": phase, "url": snap.url, "item": item,
                        "latency_ms": round(ms, 1), "state": state, "options": options,
                        "answers": {k: v.model_dump() for k, v in a.items()}, "fallback": fallback,
                    }, ensure_ascii=False) + "\n")

                try:
                    if action in snap.fills:
                        await sb.fill_secret(action, snap.fills[action])
                    elif action == "search":
                        await sb.search(item)
                    elif action == "open_cart":
                        await sb.open_cart()
                    elif action == "wait":
                        await sb.settle(2500)
                    elif action == "back":
                        await sb.back()
                    elif ":" in action:
                        el_id, idx = action.split(":")
                        await sb.select(el_id, int(idx))
                    else:
                        await sb.click(action)
                except Exception as e:
                    failures[label] = failures.get(label, 0) + 1
                    history.append(f"{label[:90]} -> failed ({type(e).__name__})")
                    continue
                if history[-6:].count(label[:110]) >= 2:  # third pick of the same action recently: Jev is stuck on it
                    failures[label] = 2
                history.append(label[:110])
                if phase == "checkout" and (":" in action or (el and el["type"] in ("radio", "checkbox"))):
                    picks.append(label[:110])

                if phase == "shop":
                    # VTEX adds to the cart asynchronously; give a click time to land before Jev picks again.
                    for _ in range(5 if el and "agregar" in el["label"].lower() else 1):
                        form = await sb.order_form()
                        if len(form["items"]) > len(before["items"]):
                            break
                        await sb.main.wait_for_timeout(1000)
                    if len(form["items"]) > len(before["items"]):
                        new = [i["name"] for i in form["items"] if i["name"] not in {b["name"] for b in before["items"]}]
                        done_items.append(item)
                        failures.clear()
                        print(f"    ✓ added '{item}': {', '.join(new) or '(qty change)'}  (cart $ {form['value']:,.2f})")

            await sb.highlight(None, f"Jev · {result}")
            if headed:
                await sb.main.wait_for_timeout(hold * 1000)
            form = await sb.order_form()
            final_url = sb.main.url
        finally:
            trace_zip = str(trace_dir / f"run-{stamp}.zip") if trace else None
            await sb.stop(trace_zip)
            if jsonl:
                jsonl.close()

    wall = time.perf_counter() - t0
    print("\n— summary —")
    print(f"result: {result}   phase reached: {PHASES[phase_i]}")
    print(f"items added: {len(done_items)}/{len(items)}   cart total: $ {form['value']:,.2f}")
    for i in form["items"]:
        print(f"  • {i['qty']} x {i['name']}  $ {i['price']:,.2f}")
    for p in picks:
        print(f"  checkout choice: {p}")
    if latencies:
        print(f"jev calls: {len(latencies)}   total {sum(latencies) / 1000:.1f} s   "
              f"median {statistics.median(latencies):.0f} ms   wall {wall:.1f} s")
    print(f"sandbox: {len(sb.blocked_requests)} off-allowlist requests aborted "
          f"({len(set(sb.blocked_requests))} hosts); order-placement requests blocked: {len(sb.order_attempts)}")
    if trace:
        print(f"trace (after login): uv run playwright show-trace {trace_zip}\n"
              f"jev log: traces/run-{stamp}.jsonl")
    reached = result.startswith("reached")
    return {
        "status": "done" if reached else "failed",
        "phase": "payment" if reached else PHASES[phase_i],
        "reached_payment": reached,
        "items_added": len(done_items),
        "items_requested": len(items),
        "cart": {"orderFormId": form.get("id"), "value": form.get("value"),
                 "items": [{"name": i["name"], "qty": i["qty"], "price": i["price"]} for i in form["items"]]},
        "final_url": final_url,
        "wall_s": round(wall, 1),
        "orders_blocked": len(sb.order_attempts),
        "error": None if reached else result,
    }


async def run(args: argparse.Namespace) -> int:
    items = [s.strip() for s in args.list.split(",") if s.strip()]
    out = await run_job(items, headed=args.headed, trace=args.trace, max_steps=args.max_steps,
                        min_confidence=args.min_confidence, model=args.model, hold=args.hold)
    return 0 if out["reached_payment"] else (2 if out["phase"] == "login" and out.get("error", "").startswith("store") else 3)


if __name__ == "__main__":
    sys.exit(asyncio.run(run(parse_args())))
