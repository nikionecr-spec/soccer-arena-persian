#!/usr/bin/env bash
# Soccer Arena Persian — nightly PostgreSQL backup (7-day retention)
# Install on the VPS: crontab entry  "0 3 * * * /opt/soccer/scripts/backup.sh >> /var/log/sap_backup.log 2>&1"
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/soccer/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/soccer}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/soccer_$STAMP.sql.gz"

cd "$COMPOSE_DIR"
docker compose exec -T postgres pg_dump -U soccer -d soccer | gzip > "$FILE"

# verify the archive is not empty/corrupt
if [ ! -s "$FILE" ]; then
  echo "[$(date)] ERROR: backup file is empty: $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

# retention
find "$BACKUP_DIR" -name 'soccer_*.sql.gz' -mtime +"$KEEP_DAYS" -delete

echo "[$(date)] OK: $FILE ($(du -h "$FILE" | cut -f1))"
