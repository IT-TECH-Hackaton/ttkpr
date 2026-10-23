# Карта пространства

Сервис интерактивных карт зданий и площадок: 2D-план, панорамы со съёмкой с телефона, навигация внутри зданий и по территории. Архитектура и стек — в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Что поставить

- Node.js 24+, [pnpm](https://pnpm.io) (`npm install -g pnpm`)
- Python 3.12, [uv](https://docs.astral.sh/uv/) (`python -m pip install --user uv`)
- Docker Desktop

## Запуск для разработки

```bash
pnpm install
uv sync
docker compose -f infra/docker-compose.dev.yml up -d
```

В трёх терминалах:

```bash
cd apps/api && uv run alembic upgrade head && uv run uvicorn api.main:app --host 0.0.0.0 --port 8000 --proxy-headers
```

```bash
uv run --package worker celery -A worker.celery_app worker -Q default,heavy --pool=solo
```

```bash
HTTPS=1 pnpm dev
```

- Студия организатора: https://localhost:5174 — регистрация, карты, редактор, «Поделиться».
- Карта посетителя: https://localhost:5173/m/demo (демо) или `/m/<адрес карты>`.
- Маршрут: выберите место → «Маршрут сюда», или откройте `/m/demo?here=p-stand-a1` (так открывает QR-метка «Вы здесь») и выберите, куда идти; «Пройти по панорамам» ведёт по маршруту в 360°.

Сертификат самоподписанный: браузер один раз попросит подтвердить переход.

## Съёмка панорамы с телефона

1. Телефон и компьютер — в одной сети Wi-Fi.
2. В редакторе: инструмент «Панорама» → клик по месту съёмки → «Снять с телефона».
3. Отсканируйте QR камерой телефона, подтвердите переход на сайт с самоподписанным сертификатом, разрешите камеру и датчики движения.
4. Наводите белый круг на жёлтые цели — кадры снимаются сами. Через несколько секунд после «Завершить» панорама появляется на плане.

Если телефон не открывает ссылку — разрешите Node.js в брандмауэре Windows для частных сетей.

## Весь стек в Docker

```bash
docker compose -f infra/docker-compose.yml up --build
```

https://localhost — карта, https://studio.localhost — студия. Команды проверок — в [CLAUDE.md](CLAUDE.md#команды).

## Claude Code

Правила проекта для Claude — в [CLAUDE.md](CLAUDE.md), специализированные субагенты — в [.claude/agents](.claude/agents). Включите плагины из Anthropic Directory: **context7**, **playwright**, **github**, **frontend-design**, **code-review**, **docker-skills**.
