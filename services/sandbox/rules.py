"""What the sandbox may reach, click and say. One place, so every driver obeys the same rules.

Two drivers act in the browser: the login loop in agent.py (our CDP client, sandbox.py) and
Jev Ultrafast for checkout (ultrafast.py). Both read these. The network guard in cdp.py
enforces ALLOWED_HOSTS and ORDER_ENDPOINTS for every target either of them opens.
"""

from __future__ import annotations

import os
import re

BASE = "https://diaonline.supermercadosdia.com.ar"

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
)

# Network-level guarantee that no order is placed, whatever gets clicked.
ORDER_ENDPOINTS = re.compile(r"/transaction|/gatewayCallback|/payments\b|orderPlaced", re.I)

# Never offered to a model, never clicked.
BLOCKED = re.compile(
    r"comprar ahora|confirmar (la )?(compra|pedido)|realizar pedido|pagar ahora|"
    r"cerrar sesi|salir de|registr|recuperar contrase|olvid|eliminar (mi )?cuenta|repetir pedido",
    re.I,
)
# Product replacement: only the "don't replace" choice may be offered.
REPLACE = re.compile(r"reemplaz|sustitu|cambiar por (otro|similar)", re.I)
NO_REPLACE = re.compile(r"\bno\b.*(reemplaz|sustitu)|sin reemplazo", re.I)

# Built-in fill actions: Jev chooses them, the sandbox types the value from the environment.
SECRET_FIELDS = {
    "fill_dni": ("DIA_ARG_DNI", re.compile(r"\bdni\b|documento", re.I), "account DNI"),
    "fill_email": ("DIA_ARG_EMAIL", re.compile(r"correo|e-?mail", re.I), "account email"),
    "fill_password": ("DIA_ARG_PWD", re.compile(r"contrase|password|clave", re.I), "account password"),
    "fill_postcode": ("DIA_ARG_POSTCODE", re.compile(r"c[oó]digo postal|\bcp\b", re.I), "delivery postcode"),
}


def offered(label: str) -> bool:
    """Whether a control with this label (plus its href) may be offered to a model at all."""
    if BLOCKED.search(label):
        return False
    return not (REPLACE.search(label) and not NO_REPLACE.search(label))


def redact(text: str) -> str:
    # Known account values never reach a model, even when the page displays them.
    for env, tag in (("DIA_ARG_DNI", "[DNI]"), ("DIA_ARG_EMAIL", "[EMAIL]"),
                     ("DIA_ARG_POSTCODE", "[CP]"), ("DIA_ARG_PWD", "[PWD]")):
        value = os.environ.get(env)
        if value:
            text = text.replace(value, tag)
    return text
