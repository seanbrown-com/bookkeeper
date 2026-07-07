#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-bookkeeper}"
APP_DIR="${APP_DIR:-/opt/bookkeeper}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-bookkeeper.service}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root inside the LXC." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR is not a git checkout. Run scripts/install-lxc.sh first." >&2
  exit 1
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

systemctl stop "$SERVICE_NAME" 2>/dev/null || true

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$REPO_BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$REPO_BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only origin "$REPO_BRANCH"

sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"

if sudo -u "$APP_USER" node -e "const p=require('$APP_DIR/package.json'); process.exit(p.scripts?.build ? 0 : 1)" 2>/dev/null; then
  sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run build"
fi

systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=20 status "$SERVICE_NAME"
