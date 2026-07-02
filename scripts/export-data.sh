#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
DIST_DIR="$ROOT_DIR/dist"
STAMP="$(date +"%Y%m%d-%H%M%S")"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bookkeeper-data-export.XXXXXX")"
ARCHIVE="$DIST_DIR/bookkeeper-data-$STAMP.tar.gz"
NODE_BIN="${NODE_BIN:-node}"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [[ ! -f "$DATA_DIR/bookkeeper.sqlite" ]]; then
  echo "No data/bookkeeper.sqlite found. Nothing to export." >&2
  exit 1
fi

mkdir -p "$DIST_DIR" "$WORK_DIR/data"

"$NODE_BIN" --input-type=module - "$DATA_DIR/bookkeeper.sqlite" "$WORK_DIR/data/bookkeeper.sqlite" <<'NODE'
import { DatabaseSync } from "node:sqlite";

const [, , source, destination] = process.argv;
const quotedDestination = destination.replaceAll("'", "''");
const db = new DatabaseSync(source);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.exec(`VACUUM INTO '${quotedDestination}'`);
db.close();
NODE

if [[ -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env" "$WORK_DIR/.env"
fi

for legacy_file in simplefin-connections.json simplefin-key; do
  if [[ -f "$DATA_DIR/$legacy_file" ]]; then
    cp "$DATA_DIR/$legacy_file" "$WORK_DIR/data/$legacy_file"
  fi
done

tar -C "$WORK_DIR" -czf "$ARCHIVE" .

echo "$ARCHIVE"
