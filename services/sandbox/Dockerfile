# Playwright's image already carries Chromium's system dependencies.
FROM mcr.microsoft.com/playwright/python:v1.63.0-noble

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev && uv run playwright install chromium
COPY agent.py checkout.py sandbox.py server.py ./

ENV PORT=8080
CMD ["sh", "-c", "uv run uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
