#!/usr/bin/env bash
# Ships the working tree to the server and (re)starts the whole stack there.
#
#   bash infra/deploy/deploy.sh                 # default server below
#   HOST=1.2.3.4 SITE_HOST=map.example.ru bash infra/deploy/deploy.sh
#
# Needs SSH access by key (ssh root@HOST works without a password). SSH_BIND=<local IP> sends SSH
# straight through that network card — needed when a VPN tunnel (e.g. Happ/xray) swallows port 22.
# The first run also prepares
# the server (infra/deploy/server-setup.sh) and creates infra/.env there with random secrets;
# secrets never leave the server. Test accounts are written to data/test-accounts-server.md here.
set -euo pipefail

HOST="${HOST:-217.144.184.43}"
# A real certificate without buying a domain: <ip-with-dashes>.sslip.io resolves to the IP and
# Caddy gets it from Let's Encrypt. Phones then allow camera, motion sensors and offline mode.
SITE_HOST="${SITE_HOST:-${HOST//./-}.sslip.io}"
KEY="${KEY:-$HOME/.ssh/ttkpr_deploy}"
DIR=/opt/ttkpr
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
[ -n "${SSH_BIND:-}" ] && SSH+=(-o "BindAddress=$SSH_BIND")
SSH+=("root@$HOST")
COMPOSE="docker compose -f infra/docker-compose.yml --env-file infra/.env"

cd "$(git rev-parse --show-toplevel)"

echo "==> server setup (idempotent)"
"${SSH[@]}" "bash -s" < infra/deploy/server-setup.sh

echo "==> uploading the working tree (tracked and new files, nothing ignored)"
git ls-files -z --cached --others --exclude-standard \
  | tar --null -T - -czf - \
  | "${SSH[@]}" "mkdir -p $DIR && tar -xzf - -C $DIR"

echo "==> secrets (created once, on the server)"
"${SSH[@]}" "cd $DIR && if [ ! -f infra/.env ]; then cat > infra/.env <<EOF
SITE_HOST=$SITE_HOST
PUBLIC_URL=
POSTGRES_USER=ttk
POSTGRES_PASSWORD=\$(openssl rand -hex 16)
POSTGRES_DB=ttk
SECRET_KEY=\$(openssl rand -hex 32)
EOF
chmod 600 infra/.env; fi
sed -i 's/^SITE_HOST=.*/SITE_HOST=$SITE_HOST/' infra/.env"

echo "==> build and start (a few minutes on the first run)"
"${SSH[@]}" "cd $DIR && $COMPOSE --profile seed build && $COMPOSE up -d --remove-orphans"

echo "==> waiting for the API"
"${SSH[@]}" "cd $DIR && for i in \$(seq 1 60); do $COMPOSE ps api | grep -q healthy && exit 0; sleep 3; done; $COMPOSE logs --tail=50 api; exit 1"

echo "==> test accounts and the demo map"
mkdir -p data
if "${SSH[@]}" "test -f $DIR/data/test-accounts.md"; then
  # Re-publish the demo from the current fixture, keep the passwords people already use.
  "${SSH[@]}" "cd $DIR && $COMPOSE --profile seed run --rm seed python -m api.seed --keep-passwords >/dev/null"
else
  "${SSH[@]}" "cd $DIR && mkdir -p data && $COMPOSE --profile seed run --rm seed > data/test-accounts.md && chmod 600 data/test-accounts.md"
fi
"${SSH[@]}" "cat $DIR/data/test-accounts.md" > data/test-accounts-server.md

echo "==> checks"
for path in / /studio/ /m/demo-ploschadka-hakatona /api/health; do
  printf '%-36s %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 ${SSH_BIND:+--interface "$SSH_BIND"} "https://$SITE_HOST$path" || echo fail)"
done

cat <<EOF

Готово:
  Карта посетителя   https://$SITE_HOST/m/demo-ploschadka-hakatona
  Встроенное демо    https://$SITE_HOST/m/demo
  Студия             https://$SITE_HOST/studio/
  Аккаунты           data/test-accounts-server.md (пароли — только у вас)
EOF
