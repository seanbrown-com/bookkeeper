# Deploy Bookkeeper to a Proxmox LXC

This guide assumes a Debian 12 or Ubuntu LXC on your home network.

## 1. Create the LXC

In Proxmox, create an unprivileged Debian 12 container with roughly:

- 1 CPU
- 512 MB to 1 GB RAM
- 4 GB+ disk
- Static DHCP lease or static IP

Start the container and open its console.

## 2. Install system dependencies in the LXC

```bash
apt-get update
apt-get install -y curl ca-certificates git rsync sudo
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
```

Bookkeeper requires Node.js 22 or newer because it uses Node's built-in SQLite support.

## 3. Pull the app from GitHub

Inside the LXC:

```bash
git clone https://github.com/seanbrown-com/bookkeeper.git /opt/bookkeeper
cd /opt/bookkeeper
bash scripts/install-lxc.sh
```

The git checkout contains only app code. Runtime files such as `.env` and `data/` are ignored and should be copied or restored separately.

After installation:

```bash
systemctl status bookkeeper
```

The app should be available at:

```text
http://LXC_IP:8000
```

## 4. Export local data from your Mac

From your local Bookkeeper checkout:

```bash
cd /path/to/bookkeeper
bash scripts/export-data.sh
```

The script prints an archive path like:

```text
dist/bookkeeper-data-20260702-143000.tar.gz
```

This archive contains:

- a consistent backup of `data/bookkeeper.sqlite`
- `.env`, if present
- legacy SimpleFIN files, if present

The SQLite contents are still protected by Bookkeeper's app-level encryption, but the archive should still be treated as sensitive.

## 5. Restore data into the LXC

From your Mac:

```bash
scp dist/bookkeeper-data-YYYYMMDD-HHMMSS.tar.gz root@LXC_IP:/tmp/
```

Inside the LXC:

```bash
bash /opt/bookkeeper/scripts/restore-data.sh /tmp/bookkeeper-data-YYYYMMDD-HHMMSS.tar.gz
systemctl status bookkeeper
```

Open `http://LXC_IP:8000` and log in with the same Bookkeeper username/password you used locally.

## Updating Later

Inside the LXC, pull the latest code and restart:

```bash
cd /opt/bookkeeper
bash scripts/install-lxc.sh
```

This updates the git checkout and dependencies. It preserves ignored runtime files such as `/opt/bookkeeper/.env` and `/opt/bookkeeper/data/`.

## Useful Commands

```bash
systemctl status bookkeeper
journalctl -u bookkeeper -f
systemctl restart bookkeeper
```
