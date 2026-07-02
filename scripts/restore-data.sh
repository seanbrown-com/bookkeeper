#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bookkeeper}"
APP_USER="${APP_USER:-bookkeeper}"
ARCHIVE="${1:-}"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage: $0 /path/to/bookkeeper-data-YYYYMMDD-HHMMSS.tar.gz" >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root inside the LXC." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d /tmp/bookkeeper-restore.XXXXXX)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

systemctl stop bookkeeper.service 2>/dev/null || true

tar -C "$WORK_DIR" -xzf "$ARCHIVE"

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"

if [[ ! -f "$WORK_DIR/data/bookkeeper.sqlite" ]]; then
  echo "Archive does not contain data/bookkeeper.sqlite" >&2
  exit 1
fi

cp "$WORK_DIR/data/bookkeeper.sqlite" "$APP_DIR/data/bookkeeper.sqlite"
rm -f "$APP_DIR/data/bookkeeper.sqlite-wal" "$APP_DIR/data/bookkeeper.sqlite-shm"

for legacy_file in simplefin-connections.json simplefin-key; do
  if [[ -f "$WORK_DIR/data/$legacy_file" ]]; then
    cp "$WORK_DIR/data/$legacy_file" "$APP_DIR/data/$legacy_file"
  fi
done

if [[ -f "$WORK_DIR/.env" ]]; then
  cp "$WORK_DIR/.env" "$APP_DIR/.env"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$APP_DIR/.env" 2>/dev/null || chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"

systemctl start bookkeeper.service

echo "Bookkeeper data restored to $APP_DIR/data/bookkeeper.sqlite"
