"""changuito's sandbox job API around agent.run_job.

    POST /jobs        {order_id, items: [{name, quantity, sku?}], shopper, card?}  -> {job_id}
    GET  /jobs/{id}   -> {job_id, status, phase, result?, error?}
    GET  /health      -> {ok, busy, queued}

Auth is `Authorization: Bearer $SANDBOX_TOKEN` on /jobs. The app (apps/web,
lib/checkout/sandbox.ts) starts a job after the shopper's USDC is locked in
the escrow, polls it, and settles or refunds on the result.

`shopper` is the shopper's Día login ({email, password, dni}) plus where to
deliver if their account has no saved address ({postcode, street, number,
phone, complement}), from their encrypted profile in the web app. `card` is
the card to pay with ({pan, cvv, exp_month, exp_year, holder, kind}), from the
web app's `shared_card` row; without it the run stops at the payment step.
Both live on the in-memory job until the run ends and are then deleted;
`GET /jobs/{id}` never returns them and nothing logs them. Nothing here reads a
login or a card from the environment.

One job at a time, on purpose: one browser, one card, and a cart tied to a
session. Jobs live in memory. A restart loses them, and the app reads a 404
for a job it started as a failure and refunds — the safe direction.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import time
import traceback
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from agent import run_job

TOKEN = os.environ.get("SANDBOX_TOKEN", "")
MAX_ITEMS = 25
KEEP_S = 6 * 3600

jobs: dict[str, dict] = {}
queue: asyncio.Queue[str] = asyncio.Queue()
busy = False


class Item(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: int = Field(default=1, ge=1, le=50)
    sku: str | None = None


class Shopper(BaseModel):
    # A 422 must not echo what was sent: for these two models that is a password or a card number.
    model_config = ConfigDict(hide_input_in_errors=True)

    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128, repr=False)
    dni: str = Field(pattern=r"^\d{7,9}$")
    postcode: str | None = Field(default=None, max_length=12)
    street: str | None = Field(default=None, max_length=120)
    number: str | None = Field(default=None, max_length=20)
    phone: str | None = Field(default=None, max_length=30)
    complement: str | None = Field(default=None, max_length=120)

    def __repr__(self) -> str:  # never print a shopper, even in a traceback
        return "Shopper(<redacted>)"

    __str__ = __repr__


class Card(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)

    pan: str = Field(pattern=r"^\d{13,19}$", repr=False)
    cvv: str = Field(pattern=r"^\d{3,4}$", repr=False)
    exp_month: str = Field(pattern=r"^(0?[1-9]|1[0-2])$", repr=False)
    exp_year: str = Field(pattern=r"^(\d{2}|\d{4})$", repr=False)
    holder: str = Field(min_length=1, max_length=80, repr=False)
    kind: Literal["debit", "credit"] = "debit"

    def __repr__(self) -> str:  # never print a card, even in a traceback
        return "Card(<redacted>)"

    __str__ = __repr__


class JobIn(BaseModel):
    # Errors in the nested shopper or card are raised from here, so the setting has to be here too.
    model_config = ConfigDict(hide_input_in_errors=True)

    order_id: str = Field(min_length=8, max_length=128)
    items: list[Item] = Field(min_length=1, max_length=MAX_ITEMS)
    shopper: Shopper
    card: Card | None = None


def auth(authorization: str = Header(default="")) -> None:
    if not TOKEN:
        raise HTTPException(503, "SANDBOX_TOKEN is not set")
    if not hmac.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(401, "bad token")


def view(job: dict) -> dict:
    return {k: job.get(k) for k in ("job_id", "order_id", "status", "phase", "result", "error")}


async def worker() -> None:
    global busy
    while True:
        job_id = await queue.get()
        job = jobs.get(job_id)
        if not job:
            continue
        busy = True
        job.update(status="running", phase="login", started=time.time())

        def on_phase(name: str) -> None:
            job["phase"] = name

        try:
            # Lines with a SKU go into the cart through VTEX's API at their quantity;
            # the rest are searched for by name.
            out = await run_job(job["items"], secrets=job.pop("shopper", None), card=job.pop("card", None),
                                on_phase=on_phase)
            job.update(status=out["status"], phase=out["phase"], result=out, error=out.get("error"))
        except Exception as e:  # noqa: BLE001 — a crashed run is a failed job, never a dead worker
            traceback.print_exc()
            job.update(status="failed", error=f"{type(e).__name__}: {e}"[:300])
        finally:
            job.pop("shopper", None)  # gone however the run ended
            job.pop("card", None)
            job["finished"] = time.time()
            busy = False
            for old in [k for k, v in jobs.items() if v.get("finished", time.time()) < time.time() - KEEP_S]:
                jobs.pop(old, None)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(worker())
    yield
    task.cancel()


app = FastAPI(title="changuito sandbox", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "busy": busy, "queued": queue.qsize()}


@app.post("/jobs", dependencies=[Depends(auth)])
async def create(body: JobIn) -> dict:
    # Idempotent per order: a retried start must not shop twice.
    for j in jobs.values():
        if j["order_id"] == body.order_id:
            return {"job_id": j["job_id"]}
    job_id = uuid.uuid4().hex
    jobs[job_id] = {"job_id": job_id, "order_id": body.order_id, "status": "queued", "phase": "queued",
                    "items": [i.model_dump() for i in body.items], "created": time.time(),
                    "shopper": body.shopper.model_dump(exclude_none=True),
                    "card": body.card.model_dump() if body.card else None}
    await queue.put(job_id)
    return {"job_id": job_id}


@app.get("/jobs/{job_id}", dependencies=[Depends(auth)])
async def read(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return view(job)
