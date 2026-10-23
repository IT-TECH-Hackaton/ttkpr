# Build context: repository root (see infra/docker-compose.yml).
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH
WORKDIR /app

COPY pyproject.toml uv.lock .python-version ./
COPY packages/map-schema packages/map-schema
COPY apps/worker apps/worker
COPY apps/api/pyproject.toml apps/api/pyproject.toml
RUN mkdir -p apps/api/src/api && touch apps/api/src/api/__init__.py \
    && uv sync --frozen --no-dev --package worker

RUN useradd --system --uid 10001 app && mkdir -p /data/storage && chown app /data/storage
USER app
CMD ["celery", "-A", "worker.celery_app", "worker", "-Q", "default,heavy", "--concurrency", "2", "--loglevel", "info"]
