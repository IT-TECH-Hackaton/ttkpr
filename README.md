# Карта пространства

Сервис интерактивных карт зданий и площадок: 2D-план, панорамы со съёмкой с телефона, навигация внутри зданий и по территории. Архитектура и стек — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Что поставить

- Node.js 24+, [pnpm](https://pnpm.io) (`npm install -g pnpm`)
- Python 3.12, [uv](https://docs.astral.sh/uv/) (`python -m pip install --user uv`)
- Docker Desktop

## Быстрый старт

```bash
pnpm install
uv sync
pnpm dev
```

- Карта посетителя: http://localhost:5173/m/demo
- Редактор: http://localhost:5174

Для API нужны Postgres и Redis:

```bash
docker compose -f infra/docker-compose.dev.yml up -d
cd apps/api && uv run alembic upgrade head && uv run uvicorn api.main:app --reload
```

Весь стек за HTTPS (https://localhost и https://studio.localhost):

```bash
docker compose -f infra/docker-compose.yml up --build
```

Остальные команды — в [CLAUDE.md](CLAUDE.md#команды).

## Claude Code

Правила проекта для Claude — в [CLAUDE.md](CLAUDE.md), специализированные субагенты — в [.claude/agents](.claude/agents). Чтобы работать с тем же набором инструментов, включите плагины из Anthropic Directory: **context7** (актуальная документация библиотек), **playwright** (проверка в WebKit/iPhone), **github**, **frontend-design**, **code-review**, **docker-skills**.
