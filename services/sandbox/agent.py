"""A sandboxed browser through Dia Argentina: login -> empty cart -> shop -> checkout -> payment.

Jev drives the login (a Flutter popup with no stable selectors) and is the fallback for any
step the deterministic path in checkout.py cannot finish. Jev never generates text: each step
it answers typed questions and the sandbox executes the choice. Credentials are typed by the
sandbox from the job's shopper; Jev only picks "fill_*" actions. The card is never Jev's:
checkout.py types the job's card (the web app's `shared_card` row) and presses Pay only
when the job has one. Nothing here reads a credential or a card from the environment.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright
from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, Score, TypeSafeError

import checkout
from sandbox import BASE, NO_REPLACE, REPLACE, SECRET_FIELDS, Sandbox, Secrets, Snapshot

PHASES = ("login", "empty_cart", "shop", "checkout", "payment")
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
    p.add_argument("--job", help="JSON file with the job's `shopper` and optional `card`, the same shapes as"
                                 " POST /jobs (keep it out of git: traces/ is ignored)")
    p.add_argument("--skus", default="", help="comma-separated VTEX SKU ids, aligned with --list (blank = search by name)")
    p.add_argument("--headed", action="store_true", help="show the browser (slowed down) to watch Jev work")
    p.add_argument("--trace", action="store_true", help="save a Playwright trace (from after login) + per-step Jev jsonl in traces/")
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--min-confidence", type=float, default=0.15,
                   help="in the shop phase, below this confidence fall back to searching the current item")
    p.add_argument("--model", default=None, help="TypeSafe model (default: SDK default, Jev)")
    p.add_argument("--hold", type=float, default=8.0, help="seconds to keep a headed browser open at the end")
    p.add_argument("--record", action="store_true",
                   help="save a video of the whole run to traces/ (SHOWS THE CARD BEING TYPED: test cards only)")
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
                   "checkout": ("fill_dni", "fill_postcode", "fill_street", "fill_number", "fill_phone")}.get(phase, ())
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
        if len(options) >= 120:  # Jev's Choice limit is 255; fewer options is a faster, surer pick
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
                 "with home delivery (or type the postcode and address with the fill actions if none is saved), "
                 "pick the earliest available delivery window, and if asked what to do with "
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


@dataclass
class Run:
    """What one job's Jev loops share: history, failures and the per-step log."""
    sb: Sandbox
    client: AsyncTypeSafeClient
    headed: bool = False
    model: str | None = None
    min_confidence: float = 0.15
    jsonl: object = None
    step: int = 0
    max_steps: int = 60
    history: list[str] = field(default_factory=list)
    failures: dict[str, int] = field(default_factory=dict)
    latencies: list[float] = field(default_factory=list)
    picks: list[str] = field(default_factory=list)  # checkout choices Jev made (delivery window etc.)
    form: dict = field(default_factory=lambda: {"items": [], "value": 0.0})
    error: str | None = None


async def jev_loop(run: Run, phase: str, items: list[str], done_items: list[str], until) -> bool:
    """Let Jev drive `phase` until `until()` holds. Returns whether it did within the step budget.

    `until` is the harness's own check (session API, orderForm, URL), never Jev's opinion.
    """
    sb = run.sb
    run.failures.clear()
    was_in_popup = False
    print(f"\n== jev: {phase} ==")
    print(f"{'#':>2}  {'page_kind':<15} {'done':>5}  {'action':<56} {'p':>5} {'jev ms':>6}")
    while run.step < run.max_steps:
        if await until(was_in_popup):
            return True
        run.step += 1
        step = run.step
        was_in_popup = sb.in_popup
        item = items[len(done_items)] if phase == "shop" and len(done_items) < len(items) else None
        before = await sb.order_form() if phase == "shop" else None
        snap = await sb.snapshot()
        exclude = frozenset(lbl for lbl, n in run.failures.items() if n >= 2)
        options = build_options(snap, phase, item, exclude, sb.in_popup)
        questions = build_questions(phase, item, options)
        state = {
            "phase": phase,
            "goal": INSTRUCTIONS[phase].format(item=item or ""),
            "page": {"url": snap.url, "title": snap.title, "text": snap.text},
            "recent_actions": run.history[-3:],
        }
        if phase == "shop":
            state["items_added"] = done_items
            state["cart"] = [f"{i['qty']} x {i['name']}" for i in run.form["items"]]

        q0 = time.perf_counter()
        try:
            resp = await run.client.system_one(state=state, questions=questions, model=run.model)
        except TypeSafeError as e:
            print(f"Jev call failed: {e}")
            run.error = f"Jev call failed: {e}"
            return False
        ms = (time.perf_counter() - q0) * 1000
        run.latencies.append(ms)

        a = resp.answers
        action, conf = a["next_action"].choice, a["next_action"].confidence
        fallback = (phase == "shop" and conf < run.min_confidence and action != "search"
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
        if run.headed:
            await sb.page.wait_for_timeout(700)

        short = label if not el else (el["label"] + (f" [{el['context'][:28]}]" if el["context"] else ""))
        if ":" in action:
            short = label
        print(f"{step:>2}  {a['page_kind'].choice:<15} {a['phase_done'].noul:>5.2f}  "
              f"{short[:56]:<56} {conf:>5.2f} {ms:>6.0f}")

        if run.jsonl and sb.tracing:  # the jsonl follows the trace: nothing before login, nothing near a card
            run.jsonl.write(json.dumps({
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
                await sb.settle(1500)
            elif action == "back":
                await sb.back()
            elif ":" in action:
                el_id, idx = action.split(":")
                await sb.select(el_id, int(idx))
            else:
                await sb.click(action)
        except Exception as e:
            run.failures[label] = run.failures.get(label, 0) + 1
            run.history.append(f"{label[:90]} -> failed ({type(e).__name__})")
            continue
        if run.history[-6:].count(label[:110]) >= 2:  # third pick of the same action recently: Jev is stuck on it
            run.failures[label] = 2
        run.history.append(label[:110])
        if phase == "checkout" and (":" in action or (el and el["type"] in ("radio", "checkbox"))):
            run.picks.append(label[:110])

        if phase == "shop":
            # VTEX adds to the cart asynchronously; give a click time to land before Jev picks again.
            for _ in range(5 if el and "agregar" in el["label"].lower() else 1):
                run.form = await sb.order_form()
                if len(run.form["items"]) > len(before["items"]):
                    break
                await sb.main.wait_for_timeout(1000)
            if len(run.form["items"]) > len(before["items"]):
                new = [i["name"] for i in run.form["items"] if i["name"] not in {b["name"] for b in before["items"]}]
                done_items.append(item)
                run.failures.clear()
                print(f"    ✓ added '{item}': {', '.join(new) or '(qty change)'}  (cart $ {run.form['value']:,.2f})")
    return await until(was_in_popup)


async def run_job(items: list[dict | str], *, secrets: dict | None = None, card: dict | None = None,
                  headed: bool = False,
                  trace: bool = False, max_steps: int = 60, min_confidence: float = 0.15,
                  model: str | None = None, hold: float = 8.0, record: bool = False, on_phase=None) -> dict:
    """One sandbox run. Returns what changuito's job API reports (services/sandbox/server.py).

    `items` are `{name, quantity, sku?}` (a bare string is a name to search for). Lines with a SKU
    are added through VTEX's cart API; only the rest are shopped by Jev.
    `secrets` are the shopper's login and address (sandbox.Secrets); `card` is what to pay with
    (server.py `Card`). Both come from the job only. No card: the run stops at the payment step.
    `on_phase(name)` is called on entering each phase so a caller can show progress.
    """
    lines = [{"name": i, "quantity": 1, "sku": None} if isinstance(i, str) else i for i in items]
    sb = Sandbox(headed=headed, secrets=Secrets.build(secrets), record_dir="traces/video" if record else None)
    if record:
        print("!! --record: the video shows the card form as it is typed. Use a test card, delete the file after.")
    run = Run(sb=sb, client=AsyncTypeSafeClient(), headed=headed, model=model,
              min_confidence=min_confidence, max_steps=max_steps)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    trace_dir = Path("traces")
    trace_zip = str(trace_dir / f"run-{stamp}.zip") if trace else None
    if trace:
        trace_dir.mkdir(exist_ok=True)
        run.jsonl = open(trace_dir / f"run-{stamp}.jsonl", "w")

    phase = "login"
    timings: dict[str, float] = {}
    done_items: list[str] = []
    pay: dict = {"payment": "not_attempted"}
    shipping_centavos = None
    t0 = time.perf_counter()
    mark = t0
    result = "max steps reached"
    final_url = None

    def enter(name: str) -> None:
        nonlocal phase, mark
        now = time.perf_counter()
        timings[phase] = round(now - mark, 1)
        phase, mark = name, now
        print(f"\n== phase: {name} ==")
        if on_phase:
            on_phase(name)

    async with async_playwright() as pw:
        await sb.start(pw)
        try:
            status = await sb.goto(BASE + "/login")
            if status != 200:
                print(f"store returned HTTP {status}. Try --headed.")
                return {"status": "failed", "phase": "login", "error": f"store returned HTTP {status}",
                        "reached_payment": False, "payment": "not_attempted", "items_added": 0}
            if on_phase:
                on_phase("login")

            async def logged_in(was_in_popup: bool) -> bool:
                # The popup sometimes stays open on oauth/finish?authStatus=Success; the session API is the truth.
                return await sb.wait_for_login(seconds=4 if was_in_popup else 0)

            if not await jev_loop(run, "login", [], [], logged_in):
                result = run.error or "could not log in"
                raise _Stop
            print("    ✓ logged in")
            if trace:
                await sb.start_trace()

            enter("empty_cart")
            run.form = await checkout.clear_cart(sb)
            if run.form["items"]:
                await sb.open_cart()

                async def emptied(_: bool) -> bool:
                    run.form = await sb.order_form()
                    return not run.form["items"]

                if not await jev_loop(run, "empty_cart", [], [], emptied):
                    result = run.error or "could not empty the cart"
                    raise _Stop
            print("    ✓ cart is empty")

            enter("shop")
            added, rest = await checkout.add_skus(sb, lines)
            done_items.extend(added)
            run.form = await sb.order_form()
            print(f"    ✓ by SKU: {len(added)}/{len(lines)} lines  (cart $ {run.form['value']:,.2f})")
            if rest:
                names = [l["name"] for l in rest]
                shopped: list[str] = []

                async def all_added(_: bool) -> bool:
                    return len(shopped) == len(names)

                await jev_loop(run, "shop", names, shopped, all_added)
                done_items.extend(shopped)
            if not done_items:
                result = run.error or "no item could be added"
                raise _Stop

            enter("checkout")
            ship = await checkout.set_shipping(sb)
            shipping_centavos = ship.get("shipping_centavos")
            print(f"    shipping: {ship['how']}" + (f"  (envío $ {shipping_centavos / 100:,.2f})"
                                                   if shipping_centavos is not None else ""))
            if not await checkout.open_payment(sb):
                await sb.open_cart()

                async def at_payment(_: bool) -> bool:
                    return await sb.on_payment_step()

                if not await jev_loop(run, "checkout", [], [], at_payment):
                    result = run.error or "could not reach the payment step"
                    raise _Stop
            result = "reached payment step"
            print(f"    ✓ {result}")

            enter("payment")
            await sb.stop_trace(trace_zip)  # never record the card form
            pay = await checkout.pay(sb, card)
            print(f"    payment: {pay['payment']}" + (f" — {pay['detail']}" if pay.get("detail") else ""))
        except _Stop:
            pass
        finally:
            timings[phase] = round(time.perf_counter() - mark, 1)
            try:
                await sb.highlight(None, f"Jev · {result} · payment {pay['payment']}")
                if headed:
                    await sb.main.wait_for_timeout(hold * 1000)
                run.form = await sb.order_form()
                final_url = sb.main.url
            except Exception:
                pass
            await sb.stop(trace_zip)
            if run.jsonl:
                run.jsonl.close()

    wall = time.perf_counter() - t0
    reached = result.startswith("reached")
    print("\n— summary —")
    print(f"result: {result}   phase reached: {phase}   payment: {pay['payment']}")
    print(f"items added: {len(done_items)}/{len(lines)}   cart total: $ {run.form['value']:,.2f}")
    for i in run.form["items"]:
        print(f"  • {i['qty']} x {i['name']}  $ {i['price']:,.2f}")
    for p in run.picks:
        print(f"  checkout choice: {p}")
    print("timings: " + "  ".join(f"{k} {v:.1f}s" for k, v in timings.items()) + f"   wall {wall:.1f}s")
    if run.latencies:
        print(f"jev calls: {len(run.latencies)}   total {sum(run.latencies) / 1000:.1f} s   "
              f"median {statistics.median(run.latencies):.0f} ms")
    print(f"sandbox: {len(sb.blocked_requests)} off-allowlist requests aborted "
          f"({len(set(sb.blocked_requests))} hosts); order-placement requests blocked: {len(sb.order_attempts)}")
    print(f"aborted hosts: {', '.join(sorted(set(sb.blocked_requests)))}")
    if trace:
        print(f"trace (login to payment step, never the card): uv run playwright show-trace {trace_zip}\n"
              f"jev log: traces/run-{stamp}.jsonl")
    placed = pay["payment"] == "placed"
    return {
        # `done` means the run finished its walk; whether money moved is `payment`.
        "status": "done" if reached else "failed",
        "phase": phase if not reached else ("placed" if placed else "payment"),
        "reached_payment": reached,
        "payment": pay["payment"],
        "payment_detail": pay.get("detail"),
        "store_order_id": pay.get("order_id"),
        "items_added": len(done_items),
        "items_requested": len(lines),
        "cart": {"orderFormId": run.form.get("id"), "value": run.form.get("value"),
                 "shipping_centavos": shipping_centavos,
                 "items": [{"name": i["name"], "quantity": i["qty"], "price": i["price"]} for i in run.form["items"]]},
        "final_url": final_url,
        "wall_s": round(wall, 1),
        "timings": timings,
        "orders_blocked": len(sb.order_attempts),
        "error": None if reached else result,
    }


class _Stop(Exception):
    """Ends a run early; `result` already says why."""


async def run(args: argparse.Namespace) -> int:
    names = [s.strip() for s in args.list.split(",") if s.strip()]
    skus = [s.strip() for s in args.skus.split(",")] if args.skus else []
    items = [{"name": n, "quantity": 1, "sku": skus[i] if i < len(skus) and skus[i] else None}
             for i, n in enumerate(names)]
    job = json.loads(Path(args.job).read_text()) if args.job else {}
    if not job.get("shopper"):
        print("--job <file.json> with a `shopper` (email, password, dni, postcode) is required: the sandbox"
              " reads no credentials from the environment. Add a `card` to pay; without one it stops at payment.")
        return 2
    out = await run_job(items, secrets=job["shopper"], card=job.get("card"), headed=args.headed, trace=args.trace,
                        max_steps=args.max_steps, min_confidence=args.min_confidence, model=args.model,
                        hold=args.hold, record=args.record)
    return 0 if out["reached_payment"] else (2 if out["phase"] == "login" and (out.get("error") or "").startswith("store") else 3)


if __name__ == "__main__":
    sys.exit(asyncio.run(run(parse_args())))
