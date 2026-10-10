"""The network guard, checked against a real Chromium. No credentials, no order, no model.

    uv run python selfcheck.py

Opens the store in the sandbox's own tab and in a second tab created over a *separate* CDP
connection — the way Browser Harness opens Jev Ultrafast's — and from each fires a POST to an
order endpoint and a request to a host off the allowlist. Both must fail in the page and be
counted by the guard. Exit 0 when they are, 1 when anything got through.
"""

from __future__ import annotations

import asyncio
import json
import sys

from cdp import CDP
from rules import BASE
from sandbox import Sandbox

PROBE = """async () => {
  const out = {};
  try { await fetch('/api/checkout/pub/orderForm/00000000000000000000000000000000/transaction',
                    {method: 'POST', body: '{}', headers: {'content-type': 'application/json'}});
        out.order = 'reached'; } catch (e) { out.order = 'blocked'; }
  try { await fetch('https://example.com/', {mode: 'no-cors'}); out.offlist = 'reached'; }
  catch (e) { out.offlist = 'blocked'; }
  return out;
}"""


async def main() -> int:
    sb = Sandbox()
    await sb.start()
    failures = []
    try:
        await sb.goto(BASE + "/")
        own = await sb.evaluate(f"({PROBE})()", sb.main_target)
        print("own tab:", own)

        other = CDP()  # a second client, like Browser Harness
        await other.connect(sb.chromium.ws_url)
        target = (await other.send("Target.createTarget", {"url": BASE + "/", "background": True}))["targetId"]
        session = (await other.send("Target.attachToTarget", {"targetId": target, "flatten": True}))["sessionId"]
        for _ in range(100):
            res = await other.send("Runtime.evaluate", {"expression": "document.readyState", "returnByValue": True},
                                   session=session)
            if res.get("result", {}).get("value") == "complete":
                break
            await asyncio.sleep(0.1)
        res = await other.send("Runtime.evaluate", {"expression": f"({PROBE})()", "awaitPromise": True,
                                                    "returnByValue": True}, session=session, timeout=30)
        theirs = res.get("result", {}).get("value")
        print("second client's tab:", theirs)
        await other.close()

        for name, probe in (("own", own), ("second", theirs)):
            if not probe or probe.get("order") != "blocked":
                failures.append(f"{name}: order request was not blocked")
            if not probe or probe.get("offlist") != "blocked":
                failures.append(f"{name}: off-allowlist request was not blocked")
        if len(sb.order_attempts) < 2:
            failures.append(f"guard counted {len(sb.order_attempts)} order attempts, expected 2")
        print(json.dumps({"order_attempts": sb.order_attempts, "blocked_hosts": sorted(set(sb.blocked_requests))},
                         indent=2))
    finally:
        await sb.stop()
    for f in failures:
        print("FAIL", f)
    print("guard OK" if not failures else "guard FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
