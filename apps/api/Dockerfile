# Build context: repository root (see infra/docker-compose.yml).
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH
WORKDIR /app

COPY pyproject.toml uv.lock .python-version ./
COPY packages/map-schema packages/map-schema
COPY apps/api apps/api
COPY apps/worker/pyproject.toml apps/worker/pyproject.toml
RUN mkdir -p apps/worker/src/worker && touch apps/worker/src/worker/__init__.py \
    && uv sync --frozen --no-dev --package api

WORKDIR /app/apps/api
RUN useradd --system --uid 10001 app && mkdir -p /data/storage && chown app /data/storage
USER app
EXPOSE 8000
# Migrations once, then uvicorn replaces the shell (docker stop reaches it) with one worker per
# core of the 2-core server; rate limits live in Redis, so the workers count together.
# Keep-alive longer than Caddy's idle upstream timeout (2 min): Caddy closes idle connections
# first, so it never sends a request on one uvicorn is closing (a spurious 502).
ENV WEB_CONCURRENCY=2
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY} --timeout-keep-alive 130 --proxy-headers --forwarded-allow-ips='*'"]
