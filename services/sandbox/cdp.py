"""A small Chrome DevTools Protocol client, the Chromium it talks to, and the network guard.

The sandbox used to drive Chromium through Playwright. It now launches Chromium itself and
speaks CDP directly over one websocket, because two clients share the browser: this module
(login, the cart APIs, and the guard) and Jev Ultrafast (checkout), which connects through
Browser Harness to the same `--remote-debugging-port`.

The guard is the part that must not regress. Playwright's `context.route` used to abort, for
every page the context opened, any order or payment request and any host off the allowlist.
Here the same rule is enforced from the browser target: `Target.setAutoAttach` with
`waitForDebuggerOnStart` holds every new page, popup and worker before its first request, the
guard enables `Fetch` on it, and only then lets it run. That covers the tab Ultrafast creates
for checkout as well as ours, which is why it lives at the browser level and not on a page.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from urllib.parse import urlparse

import websockets

from rules import ALLOWED_HOSTS, ORDER_ENDPOINTS

Handler = Callable[[dict, str | None], Awaitable[None] | None]


class CDPError(RuntimeError):
    pass


class CDP:
    """One websocket to the browser endpoint, with flattened sessions for pages."""

    def __init__(self) -> None:
        self.ws = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._handlers: dict[str, list[Handler]] = {}
        self._reader: asyncio.Task | None = None

    async def connect(self, ws_url: str) -> None:
        # Large frames: Page.captureScreenshot and big Runtime.evaluate results exceed the default.
        self.ws = await websockets.connect(ws_url, max_size=64 * 1024 * 1024, ping_interval=None)
        self._reader = asyncio.create_task(self._read())

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self.ws:
            await self.ws.close()

    def on(self, event: str, handler: Handler) -> None:
        self._handlers.setdefault(event, []).append(handler)

    async def send(self, method: str, params: dict | None = None, session: str | None = None,
                   timeout: float = 15.0) -> dict:
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        await self.ws.send(json.dumps(msg))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg["id"], None)

    async def _read(self) -> None:
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg:
                fut = self._pending.get(msg["id"])
                if fut and not fut.done():
                    if "error" in msg:
                        fut.set_exception(CDPError(f"{msg['error'].get('message')} ({msg['error'].get('code')})"))
                    else:
                        fut.set_result(msg.get("result", {}))
                continue
            for handler in self._handlers.get(msg.get("method", ""), []):
                try:
                    out = handler(msg.get("params", {}), msg.get("sessionId"))
                    if asyncio.iscoroutine(out):
                        asyncio.create_task(out)
                except Exception:  # noqa: BLE001 — one bad handler must not stop the reader
                    pass


def chromium_path() -> str:
    for candidate in (os.environ.get("CHROME_PATH"), "chromium", "chromium-browser", "google-chrome",
                      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if candidate and (shutil.which(candidate) or os.path.exists(candidate)):
            return candidate
    raise RuntimeError("No Chromium found. Set CHROME_PATH.")


@dataclass
class Chromium:
    """A Chromium with remote debugging on loopback and a profile that dies with it."""

    headed: bool = False
    port: int = 9222
    proc: subprocess.Popen | None = None
    profile: str | None = None
    ws_url: str = ""

    def start(self) -> None:
        self.profile = tempfile.mkdtemp(prefix="sandbox-profile-")
        args = [
            chromium_path(),
            f"--remote-debugging-port={self.port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={self.profile}",
            "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
            "--disable-background-networking", "--disable-sync", "--disable-extensions",
            "--lang=es-AR", "--window-size=1366,900",
        ]
        if not self.headed:
            args.append("--headless=new")
        if os.geteuid() == 0:
            # Containers run as root; Chromium refuses its sandbox there.
            args.append("--no-sandbox")
        self.proc = subprocess.Popen(args + ["about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=1) as r:
                    self.ws_url = json.load(r)["webSocketDebuggerUrl"]
                    return
            except OSError:
                time.sleep(0.1)
        self.stop()
        raise RuntimeError("Chromium did not open its debugging port")

    @property
    def http_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.profile:
            shutil.rmtree(self.profile, ignore_errors=True)
            self.profile = None


def allowed_host(host: str) -> bool:
    return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


def is_order_request(url: str, method: str, navigation: bool) -> bool:
    """The network-level guarantee that no order is placed, whatever gets clicked."""
    return bool(ORDER_ENDPOINTS.search(url)) and (method != "GET" or navigation)


@dataclass
class Guard:
    """Fetch interception on every target the browser opens. Counts what it stops."""

    cdp: CDP
    blocked_requests: list[str] = field(default_factory=list)
    order_attempts: list[str] = field(default_factory=list)
    sessions: dict[str, dict] = field(default_factory=dict)  # sessionId -> targetInfo

    async def install(self) -> None:
        self.cdp.on("Target.attachedToTarget", self._attached)
        self.cdp.on("Target.detachedFromTarget", lambda p, _s: self.sessions.pop(p.get("sessionId"), None))
        self.cdp.on("Fetch.requestPaused", self._paused)
        await self.cdp.send("Target.setDiscoverTargets", {"discover": True})
        await self.cdp.send("Target.setAutoAttach",
                            {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
        # Targets that already exist (the first about:blank tab) are attached explicitly.
        for info in (await self.cdp.send("Target.getTargets"))["targetInfos"]:
            if info["type"] == "page":
                await self.cdp.send("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})

    async def _attached(self, params: dict, _parent: str | None) -> None:
        session, info = params["sessionId"], params["targetInfo"]
        self.sessions[session] = info
        try:
            # Requests from this target pause until the guard answers; pages it opens are held too.
            await self.cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]},
                                session=session)
            await self.cdp.send("Target.setAutoAttach",
                                {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True},
                                session=session)
        except CDPError:
            pass  # a target that cannot intercept (e.g. some workers) keeps running under its parent's guard
        finally:
            if params.get("waitingForDebugger"):
                try:
                    await self.cdp.send("Runtime.runIfWaitingForDebugger", session=session)
                except CDPError:
                    pass

    async def _paused(self, params: dict, session: str | None) -> None:
        req = params["request"]
        url, method = req["url"], req.get("method", "GET")
        navigation = params.get("resourceType") == "Document"
        host = urlparse(url).hostname or ""
        try:
            if url.startswith(("data:", "blob:", "about:", "chrome")):
                await self.cdp.send("Fetch.continueRequest", {"requestId": params["requestId"]}, session=session)
            elif is_order_request(url, method, navigation):
                self.order_attempts.append(f"{method} {url[:120]}")
                await self.cdp.send("Fetch.failRequest",
                                    {"requestId": params["requestId"], "errorReason": "BlockedByClient"},
                                    session=session)
            elif not allowed_host(host):
                self.blocked_requests.append(host)
                await self.cdp.send("Fetch.failRequest",
                                    {"requestId": params["requestId"], "errorReason": "BlockedByClient"},
                                    session=session)
            else:
                await self.cdp.send("Fetch.continueRequest", {"requestId": params["requestId"]}, session=session)
        except CDPError:
            pass  # the target navigated or closed while the request was paused
