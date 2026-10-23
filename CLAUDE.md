# Карта пространства — ttkpr

Хакатон-кейс: сервис интерактивных карт зданий и площадок с 2D-планом, панорамами (съёмка с телефона в браузере) и навигацией. Два типа пользователей: **организатор** (studio — редактор, съёмка) и **посетитель** (viewer — карта по ссылке / в iframe). Оценивают: удобство с телефона, стабильность, скорость загрузки карт и панорам, защиту доступа.

Полная архитектура и обоснования: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Перед крупным изменением сверяйся с ним; если решение меняется — обнови документ в том же изменении.

## Стек (зафиксирован)

- **Фронт:** pnpm workspaces + Turborepo, TypeScript, React 19, Vite, TanStack Router/Query, Tailwind v4 + shadcn/ui, Zustand (+ zundo), vite-plugin-pwa.
- **Карта:** MapLibre GL JS + Terra Draw + turf.js. Поиск — MiniSearch. Маршрут на клиенте — ngraph.path (A*).
- **Панорамы:** Photo Sphere Viewer 5 (Markers, VirtualTour, Gyroscope, EquirectangularTilesAdapter).
- **Бэк:** Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 + GeoAlchemy2, Alembic. PostgreSQL 17 + PostGIS, Redis, Celery.
- **CV-воркер:** OpenCV (cv2.detail / `stitching`), numpy/scipy, pyvips, shapely.
- **Хранилище:** S3 (локально SeaweedFS — MinIO больше не публикует образы), российский CDN (не Cloudflare — в РФ режется).
- **Инфра:** Docker Compose, Caddy (HTTPS), GitHub Actions.
- Пакетные менеджеры: `pnpm` для JS, `uv` для Python. Не смешивать с npm/pip.
- Версии: Vite 8, MapLibre 6, TypeScript 7 (нативный компилятор). Исключение — `packages/api-client` держит TypeScript 6: генератору нужен JS API компилятора.

## Структура

```
apps/viewer          PWA посетителя: карта, поиск, шторка, панорама (ленивый чанк)
apps/studio          редактор организатора: рисование плана, точки, undo/redo
apps/api             FastAPI: сессии, карты, черновик с блокировкой, публикация версий
apps/worker          Python: тайлинг панорам (готово), склейка и сборка карты (заглушки задач)
packages/map-schema  Pydantic-схема карты + геометрия — источник правды для OpenAPI
packages/map-core    TS: загрузка бандла, слои MapLibre, геометрия, точки в панорамах
packages/ui          токены Tailwind и общие компоненты
packages/api-client  генерируется `pnpm gen:api` из OpenAPI, руками не править
fixtures/            общие тестовые векторы геометрии и демо-карта
infra/               docker-compose (полный и dev), Caddyfile, SeaweedFS
```

## Команды

- `pnpm dev` — viewer (5173) и studio (5174); `HTTPS=1 pnpm dev` — для проверки с телефона.
- `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` — JS-проверки (Biome, tsc, Vitest).
- `uv run ruff check .` · `uv run mypy packages/map-schema/src apps/api/src apps/worker/src` · `uv run pytest` — Python. Тесты API с базой: `TEST_DATABASE_URL=postgresql+asyncpg://…`, без неё пропускаются.
- `pnpm gen:api` — после любого изменения схемы или ручек API; CI проверяет, что клиент закоммичен.
- `uv run --package worker python -m worker.demo` — пересобрать демо-карту и тестовую панораму-сетку.
- `docker compose -f infra/docker-compose.dev.yml up -d` — Postgres, Redis, S3 для локальной работы; `infra/docker-compose.yml` — весь стек за Caddy.
- Миграции: `cd apps/api && uv run alembic revision --autogenerate -m "…"`, затем проверить файл руками.

## Жёсткие правила

- **Mobile first.** Любой экран viewer проверяется на ширине 375 px и в мобильном превью. Стартовый JS viewer не должен расти выше базы ~465 КБ gzip (~300 КБ из них — MapLibre 6); PSV/three.js — только ленивым чанком.
- **Посетитель читает только статику с CDN** (`manifest.json` → неизменяемый `bundle.json` + тайлы). Не добавлять API-запросы в горячий путь viewer.
- **Панорамы только тайлами.** Никогда не грузить 8K equirect целиком (iOS падает по памяти; лимит canvas ~16.7 Мпикс).
- **HTTPS везде**, включая dev: без него не работают камера и гироскоп.
- iOS: `DeviceOrientationEvent.requestPermission()` и `getUserMedia` — только по жесту пользователя, одной кнопкой.
- Все загружаемые изображения перекодируются на сервере (убрать EXIF/GPS). Загрузка — через presigned URL с ограничением типа и размера.
- Публикация не меняет ссылку: `/m/{slug}` → manifest → версия. Версии неизменяемые.

## Соглашения по координатам (единые для TS и Python)

- Геометрия плана — GeoJSON, WGS84 (lon, lat). Метрические расчёты — в локальной ENU-системе (метры; x — восток, y — север, z — вверх) с началом в якоре площадки; конвертация только через функции `map-core` / `worker.geo`.
- Этаж: `levelId` + `ordinal` (0 — первый этаж, отрицательные — подвал).
- Углы в данных хранятся **в градусах**; в радианы переводим только на границе с PSV/three.js.
- `heading` панорамы — азимут (по часовой от севера) направления, которое соответствует центру equirect-изображения (yaw = 0).
- Точка в панораме: `yaw = normalize(bearing − heading)`, `pitch = atan2(h_точки − h_камеры, расстояние)`. Высота камеры по умолчанию 1.5 м (`cameraHeight` на панораме).
- Ориентация кадра при съёмке: кватернион `[w, x, y, z]` «камера → мир», камера в конвенции OpenCV (x вправо, y вниз, z вперёд), мир — выровнен по гравитации (z вверх), азимут произвольный.

## Субагенты проекта (`.claude/agents/`)

- `viewer-mobile` — интерфейс посетителя, мобильный UX, PWA/офлайн, производительность.
- `studio-editor` — редактор плана, точки, подложки, привязка панорам.
- `panorama-pipeline` — съёмка в браузере + склейка + тайлинг (обе стороны конвейера).
- `geo-routing` — модель данных, граф маршрутов, проекции план↔панорама, этажи.
- `backend-api` — API, авторизация, режимы доступа, публикация версий, S3, очередь.
- `mobile-qa` — проверка на мобильных вьюпортах и WebKit, бюджеты производительности; только отчёт, без правок.

Независимые куски работы — параллельно разным агентам; файлы одного пакета одновременно правит только один агент.

## Язык и стиль

- Общение и UI-тексты — на русском. Идентификаторы, имена файлов — на английском.
- Коммиты — Conventional Commits (`feat(viewer): …`), описание по-русски.
- Перед завершением задачи: тайпчек и линтер затронутых пакетов, для UI — проверка в мобильном превью.
