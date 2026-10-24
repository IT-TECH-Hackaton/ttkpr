#!/usr/bin/env bash
# Daily backup on the server (run as root): a dump of the stack's database and a snapshot of the
# storage volume (panoramas, plans, published bundles, uploaded videos), kept for 7 days.
#
#   bash /opt/ttkpr/infra/deploy/backup.sh          # by hand
#
# Every night at 03:15 — put this line into /etc/cron.d/ttkpr-backup:
#   15 3 * * * root /usr/bin/env bash /opt/ttkpr/infra/deploy/backup.sh >> /var/log/ttkpr-backup.log 2>&1
#
# Media snapshots are hard-linked to the previous day (rsync --link-dest): files never change
# once written, so a day costs only what was added that day. MEDIA=0 skips them.
#
# Restore the database (stack running; replaces the current data):
#   cd /opt/ttkpr && docker compose -f infra/docker-compose.yml --env-file infra/.env exec -T \
#     postgres sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
#     < backups/db/ttk-YYYYMMDD-HHMMSS.dump
# Restore media: rsync -a backups/media/YYYYMMDD-HHMMSS/ "$(docker volume inspect -f \
#   '{{ .Mountpoint }}' ttkpr_storage)/"
set -euo pipefail

DIR="${DIR:-/opt/ttkpr}"
BACKUPS="${BACKUPS:-$DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
MEDIA="${MEDIA:-1}"
VOLUME="${VOLUME:-ttkpr_storage}"
COMPOSE=(docker compose -f "$DIR/infra/docker-compose.yml" --env-file "$DIR/infra/.env")
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUPS/db" "$BACKUPS/media"
chmod 700 "$BACKUPS"
# One run at a time (a slow night must not overlap the next one).
exec 9>"$BACKUPS/.lock"
flock -n 9 || { echo "$(date -Is) backup already running"; exit 0; }

echo "$(date -Is) database"
dump="$BACKUPS/db/ttk-$STAMP.dump"
# Custom format: compressed, restorable table by table. Written under a temporary name and
# checked, so a failed dump never looks like a good one.
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6' \
  > "$dump.part"
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$dump.part" > /dev/null
mv "$dump.part" "$dump"
chmod 600 "$dump"
echo "$(date -Is) database: $(du -h "$dump" | cut -f1)"

if [ "$MEDIA" = "1" ]; then
  if ! command -v rsync > /dev/null; then
    apt-get install -y -q rsync > /dev/null
  fi
  source_dir="$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME")"
  previous="$(find "$BACKUPS/media" -mindepth 1 -maxdepth 1 -type d -name '20*' ! -name '*.part' \
    | sort | tail -n 1)"
  target="$BACKUPS/media/$STAMP"
  echo "$(date -Is) media from $source_dir${previous:+ (unchanged files linked to $previous)}"
  # Half-written temp files of running uploads are left out.
  rsync -a --delete --exclude '.*.tmp' ${previous:+--link-dest="$previous"} \
    "$source_dir/" "$target.part/"
  mv "$target.part" "$target"
  echo "$(date -Is) media: $(du -sh "$target" | cut -f1) on disk for this day"
fi

# Rotation by the date in the name (directory mtimes are copied from the source by rsync).
cutoff="$(date -d "-$((KEEP_DAYS - 1)) days" +%Y%m%d)"
for path in "$BACKUPS"/db/ttk-*.dump "$BACKUPS"/media/20*; do
  [ -e "$path" ] || continue
  name="$(basename "$path")"
  day="${name#ttk-}"
  day="${day:0:8}"
  if [[ "$day" < "$cutoff" ]]; then
    rm -rf -- "$path"
    echo "$(date -Is) removed old $name"
  fi
done
# Leftovers of an interrupted run.
find "$BACKUPS" -maxdepth 2 -name '*.part' -mmin +600 -exec rm -rf -- {} + 2> /dev/null || true
echo "$(date -Is) done: $(du -sh "$BACKUPS" | cut -f1) of backups in $BACKUPS"
