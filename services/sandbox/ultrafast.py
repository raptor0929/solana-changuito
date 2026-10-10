"""Checkout, driven by Jev Ultrafast in its own tab of the sandbox's Chromium.

Ultrafast (github.com/browser-use/jev-ultrafast, pinned in pyproject.toml) observes the page,
asks Jev for one operation and target per step, and executes it over CDP through Browser
Harness. It is fast because it observes once per step and waits on the page's own frames
instead of on fixed sleeps. It knows nothing about this store, so three of the sandbox's
rules are put back around it here, by wrapping the one method every observation goes through:

- **Redaction.** Ultrafast sends the page text, every control's label and every field's
  current value to Jev on each step, and to its text model when it types. The account's DNI,
  email, postal code and password are replaced by tags first, exactly as for the login loop.
- **Controls a model is never offered** (rules.BLOCKED: close session, delete account, place
  the order...; and any "replace product" option except "don't replace") are removed from
  the observation, so they cannot be chosen.
- **No screenshots.** Nothing here reads them; not taking them is faster and sends less.

What this module does *not* do is block orders: that is the network guard in cdp.py, which
holds Ultrafast's tab before its first request like every other target. And Ultrafast never
logs in: it would type the password through its text model and then send it back to Jev in
its action history. Login stays in agent.py, where the sandbox types secrets itself.
"""

from __future__ import annotations

import os
import time

from rules import offered, redact


def _configure(cdp_http_url: str) -> None:
    """Point Browser Harness at our Chromium, before it is imported, and keep it quiet."""
    os.environ["BU_CDP_URL"] = cdp_http_url
    os.environ.setdefault("BH_TELEMETRY", "0")  # opt-out PostHog telemetry
    os.environ.setdefault("BH_UPDATE_CHECK", "0")
    os.environ.setdefault("BH_TAB_MARKER", "0")  # no cosmetic emoji in the store's tab title


def _guarded_browser_class():
    from jev_ultrafast.browser import Browser

    class GuardedBrowser(Browser):
        def observe(self, screenshot=True):  # noqa: ARG002 — screenshots are never taken
            info = super().observe(screenshot=False)
            info["text"] = redact(info.get("text") or "")
            info["title"] = redact(info.get("title") or "")
            kept = []
            for action in info.get("actions", []):
                if action.get("kind") in {"click", "fill", "select"} and not offered(str(action.get("label", ""))):
                    continue
                for key in ("label", "value", "current_value"):
                    if isinstance(action.get(key), str):
                        action[key] = redact(action[key])
                kept.append(action)
            info["actions"] = kept
            return info

    return GuardedBrowser


def run_checkout(goal: str, start_url: str, cdp_http_url: str, *, max_seconds: float = 180,
                 on_step=None) -> dict:
    """Blocking: run it in a thread. Stops on Día's payment step, which is the success state."""
    _configure(cdp_http_url)
    from jev_ultrafast import agent as uf

    uf.Browser = _guarded_browser_class()
    started = time.monotonic()
    agent = uf.Agent(start_url, goal)
    steps = 0
    try:
        for state in agent.run():
            steps = len(state.get("history", []))
            url = state.get("page", {}).get("url", "")
            if on_step and state.get("history"):
                h = state["history"][-1]
                on_step(steps, h.get("action", ""), h.get("latency_ms", 0), url)
            if "#/payment" in url:
                return {"reached": True, "steps": steps, "url": url}
            if time.monotonic() - started > max_seconds:
                return {"reached": False, "steps": steps, "url": url, "error": "checkout took too long"}
        url = agent.state.get("page", {}).get("url", "")
        if "#/payment" in url:
            return {"reached": True, "steps": steps, "url": url}
        return {"reached": False, "steps": steps, "url": url,
                "error": f"checkout stopped ({agent.state.get('status')}) before the payment step"}
    except Exception as e:  # noqa: BLE001 — any Ultrafast failure is a failed checkout, never a crash
        return {"reached": False, "steps": steps, "url": "", "error": f"{type(e).__name__}: {e}"[:300]}
    finally:
        try:
            agent.close()
        except Exception:  # noqa: BLE001
            pass
