#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-bookkeeper}"
APP_DIR="${APP_DIR:-/opt/bookkeeper}"
PORT="${PORT:-8000}"
REPO_URL="${REPO_URL:-https://github.com/seanbrown-com/bookkeeper.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root inside the LXC." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required. Install it with: apt-get install -y git" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it first, then rerun this script." >&2
  echo "Debian/Ubuntu example:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -" >&2
  echo "  apt-get install -y nodejs" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "Node.js 22+ is required. Found: $(node --version)" >&2
  exit 1
fi

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

systemctl stop bookkeeper.service 2>/dev/null || true

if [[ -d "$APP_DIR/.git" ]]; then
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$REPO_BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$REPO_BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only origin "$REPO_BRANCH"
else
  if [[ -e "$APP_DIR" && -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "$APP_DIR exists and is not an empty git checkout target." >&2
    echo "Install code first, then copy/restore .env and data/ separately." >&2
    exit 1
  fi
  install -d -o "$APP_USER" -g "$APP_USER" "$(dirname "$APP_DIR")"
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"

cat >/etc/systemd/system/bookkeeper.service <<UNIT
[Unit]
Description=Bookkeeper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now bookkeeper.service

echo "Bookkeeper installed at $APP_DIR"
echo "Service: systemctl status bookkeeper"
echo "URL: http://$(hostname -I | awk '{print $1}'):$PORT"
