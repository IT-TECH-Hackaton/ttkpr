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
cd apps/api && uv run alembic upgrade head && uv run uvicorn api.main:app --host 127.0.0.1 --port 8000 --proxy-headers
```

```bash
uv run --package worker celery -A worker.celery_app worker -Q default,heavy --pool=solo
```

```bash
HTTPS=1 pnpm dev
```

Всё открывается с одного адреса (порт 5173): карта посетителя, студия и API. Один сертификат на телефоне, ссылки и QR всегда совпадают со страницей.
- Студия организатора: https://localhost:5173/studio/ — регистрация, карты, редактор, «Поделиться», статистика.
- Карта посетителя: https://localhost:5173/m/demo (встроенное демо) или `/m/<адрес карты>`.
- С телефона в той же Wi-Fi: `https://<IP компьютера>:5173/...` — студия сама подставляет этот адрес в ссылки и QR.
- Маршрут: выберите место → «Маршрут сюда», или откройте `/m/demo?here=p-stand-a1` (так открывает QR-метка «Вы здесь») и выберите, куда идти; «Пройти по панорамам» ведёт по маршруту в 360°.

Сертификат самоподписанный: браузер один раз попросит подтвердить переход.

## Съёмка панорамы с телефона

1. Телефон и компьютер — в одной сети Wi-Fi.
2. В редакторе: инструмент «Панорама» → клик по месту съёмки → «Снять с телефона».
3. Отсканируйте QR камерой телефона, подтвердите переход на сайт с самоподписанным сертификатом, разрешите камеру и датчики движения.
4. Наводите белый круг на жёлтые цели — кадры снимаются сами. Через несколько секунд после «Завершить» панорама появляется на плане.

Если телефон не открывает ссылку — разрешите Node.js в брандмауэре Windows для частных сетей.

## Весь стек в Docker (развёртывание)

1. `infra/.env`: скопируйте `infra/.env.example`, задайте `SITE_HOST` (домен или IP компьютера в сети, например `10.11.12.101`), `POSTGRES_PASSWORD` и `SECRET_KEY` (`openssl rand -hex 32`). Без ключа API не стартует.
2. Сборка и запуск:

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
```

3. Тестовые аккаунты всех ролей и опубликованная демо-карта (повторный запуск обновляет демо):

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env --profile seed run --rm seed > data/test-accounts.md
```

Адреса: `https://SITE_HOST/` — посетитель, `https://SITE_HOST/studio/` — студия, `https://SITE_HOST/m/demo-ploschadka-hakatona` — опубликованная демо-карта. Сертификат по IP выдаёт внутренний CA Caddy — браузер один раз попросит подтвердить. Для доступа из интернета нужен домен (Caddy сам получит сертификат) или туннель: тогда задайте `PUBLIC_URL`, чтобы ссылки и QR вели на него. Команды проверок — в [CLAUDE.md](CLAUDE.md#команды).

## Развёртывание на сервер (одной командой)

Нужен Ubuntu-сервер с root-доступом. Всё собирается и работает на сервере, с компьютера только загружается код. Команды — для PowerShell.
1. Ключ для деплоя (один раз):

```powershell
ssh-keygen -t ed25519 -N '""' -f $env:USERPROFILE\.ssh\ttkpr_deploy -C ttkpr-deploy
```

2. Добавьте ключ на сервер — пароль root вводите сами, один раз. `-b <IP сетевой карты>` отправляет SSH напрямую, мимо VPN (Happ/xray и подобные рвут соединения на порт 22):

```powershell
type $env:USERPROFILE\.ssh\ttkpr_deploy.pub | ssh -b 10.11.12.101 root@217.144.184.43 "mkdir -p ~/.ssh && tr -d '\r' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

3. Выкладка (первый раз ~10 минут, дальше быстрее):

```powershell
.\infra\deploy\deploy.ps1
```

Скрипт запускает `infra/deploy/deploy.sh` в Git Bash (обычный `bash` в PowerShell — это WSL), сам берёт IP сетевой карты в обход VPN, ставит на сервер Docker, файрвол (22, 80, 443) и swap, загружает рабочую копию, создаёт на сервере `infra/.env` со случайными секретами, собирает и запускает стек, заводит тестовые аккаунты и демо-карту. Адрес — `https://217-144-184-43.sslip.io` с сертификатом Let's Encrypt: на телефонах работают камера, гироскоп и офлайн. Пароли аккаунтов — в `data/test-accounts-server.md` (не в git). Другой сервер или домен: `.\infra\deploy\deploy.ps1 -Server … -SiteHost …`.

Ещё аккаунт для студии (на сервере, пароль печатается один раз):

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env exec api python -m api.accounts create name@example.com "Имя" --role owner --map demo-ploschadka-hakatona
```

Стек рассчитан на сервер 2 ядра / 4 ГБ: у каждого контейнера лимит памяти (воркер склейки — 2,5 ГБ и 1,5 ядра, API — 700 МБ на два процесса uvicorn, Postgres — 700 МБ), логи контейнеров ротируются. Caddy сам отдаёт тайлы, подложки и опубликованные бандлы из тома хранилища (`/media/panos`, `/media/maps`, кэш «навсегда»), сырые кадры, видео и сканы комнат наружу не попадают.

### Бэкапы

`infra/deploy/backup.sh` (на сервере, от root) делает дамп базы (`pg_dump -Fc`, проверяется `pg_restore --list`) и снимок тома хранилища в `/opt/ttkpr/backups`, хранит 7 дней. Снимки файлов связаны жёсткими ссылками с предыдущим днём, поэтому место занимает только новое за день; `MEDIA=0` — только база.

```bash
bash /opt/ttkpr/infra/deploy/backup.sh
# каждую ночь в 03:15:
echo '15 3 * * * root /usr/bin/env bash /opt/ttkpr/infra/deploy/backup.sh >> /var/log/ttkpr-backup.log 2>&1' > /etc/cron.d/ttkpr-backup
```

Восстановить базу (заменяет текущие данные):

```bash
cd /opt/ttkpr && docker compose -f infra/docker-compose.yml --env-file infra/.env exec -T postgres \
  sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < backups/db/ttk-<дата>.dump
```

Файлы: `rsync -a backups/media/<дата>/ "$(docker volume inspect -f '{{ .Mountpoint }}' ttkpr_storage)/"`.

### Защита сервера

`infra/deploy/harden-server.sh` включает автоматические обновления безопасности (без автоперезагрузки и без обновления Docker посреди показа) и fail2ban для SSH (адрес, с которого запускали скрипт, не банится). Запуск с компьютера (если мешает VPN — добавьте `-b <IP сетевой карты>`, как в шаге 2):

```powershell
type infra\deploy\harden-server.sh | ssh -i $env:USERPROFILE\.ssh\ttkpr_deploy root@217.144.184.43 "tr -d '\r' | bash -s"
```

Вход по SSH только по ключу — отдельным шагом и **только после того**, как во втором окне проверили, что `ssh -i $env:USERPROFILE\.ssh\ttkpr_deploy root@217.144.184.43` пускает без пароля (иначе можно потерять доступ к серверу). Не закрывайте текущую сессию, пока не проверите новый вход:

```powershell
type infra\deploy\harden-server.sh | ssh -i $env:USERPROFILE\.ssh\ttkpr_deploy root@217.144.184.43 "tr -d '\r' | bash -s -- --disable-password-login"
```

Скрипт откажется, если в `/root/.ssh/authorized_keys` нет ключей, и проверяет конфигурацию `sshd -t` перед применением. Разбанить адрес: `fail2ban-client set sshd unbanip <ip>`.

## Что умеет

Подробно по пунктам ТЗ — [docs/TZ.md](docs/TZ.md).
- **Посетитель:** план с этажами, 3D-видом и 3D-макетом этажа по фотографиям, поиск, карточки мест, маршрут «откуда → куда» (двери, лестницы, лифты, «без ступенек», дорожки между зданиями), проход маршрута по панорамам, маршруты организатора (экскурсии), QR «Вы здесь», офлайн, светлая и тёмная тема, раскладка для телефона и для широкого экрана.
- **Организатор:** редактор плана (комнаты, контуры, двери, лестницы, точки, дорожки, панорамы, точки прямо в панораме), распознавание комнат по картинке плана, проверка связности маршрутов, экскурсии со ссылкой, съёмка панорам с телефона, публикация без смены ссылки, команда и роли, статистика посещений (места, маршруты, поиски без результата).

## Claude Code

Правила проекта для Claude — в [CLAUDE.md](CLAUDE.md), специализированные субагенты — в [.claude/agents](.claude/agents). Включите плагины из Anthropic Directory: **context7**, **playwright**, **github**, **frontend-design**, **code-review**, **docker-skills**.
