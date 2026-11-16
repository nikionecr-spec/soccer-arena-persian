#!/usr/bin/env bash
# Soccer Arena Persian — restore a backup into the running PostgreSQL container
# Usage: ./restore.sh /opt/soccer/backups/soccer_YYYYMMDD_HHMMSS.sql.gz
set -euo pipefail

FILE="${1:-}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/soccer}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: $0 <path-to-soccer_*.sql.gz>" >&2
  exit 1
fi

echo "Restoring $FILE into the 'soccer' database..."
echo "Press Ctrl+C within 5 seconds to cancel."
sleep 5

cd "$COMPOSE_DIR"
gunzip -c "$FILE" | docker compose exec -T postgres psql -U soccer -d soccer

echo "Done. Verify with: docker compose exec postgres psql -U soccer -d soccer -c 'SELECT count(*) FROM users;'"
