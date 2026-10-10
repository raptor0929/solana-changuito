# Debian's Chromium, launched by cdp.py with remote debugging on loopback. No Playwright.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev
COPY agent.py cdp.py rules.py sandbox.py selfcheck.py server.py ultrafast.py ./

ENV PORT=8080 \
    CHROME_PATH=/usr/bin/chromium \
    BH_TELEMETRY=0 \
    BH_UPDATE_CHECK=0
CMD ["sh", "-c", "uv run uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
