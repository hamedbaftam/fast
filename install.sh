#!/usr/bin/env bash
# Fast Clone — installer for Linux servers (Ubuntu/Debian/CentOS/RHEL/Rocky/Alma/Fedora).
#
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/hamedbaftam/fast/main/install.sh)
#   bash <(curl -Ls https://raw.githubusercontent.com/hamedbaftam/fast/main/install.sh) --port 80 --location "Tehran"
#   bash <(curl -Ls https://raw.githubusercontent.com/hamedbaftam/fast/main/install.sh) --uninstall
set -euo pipefail

APP_NAME="fast-clone"
APP_DIR="/opt/${APP_NAME}"
APP_USER="fastclone"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
PORT=""
LOCATION=""
UNINSTALL=0
REPO="hamedbaftam/fast"
BRANCH="main"
INSTALL_CMD="bash <(curl -Ls https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh)"
NODE_MIN_MAJOR=14

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
die()   { red "Error: $*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)      PORT="${2:-}"; shift 2 ;;
    --location)  LOCATION="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --branch)    BRANCH="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: ${INSTALL_CMD} [--port N] [--location NAME] [--uninstall]"
      exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root (sudo -i first)."

# On update, keep the port/location from the existing install unless overridden.
if [[ -f "$SERVICE_FILE" ]]; then
  [[ -z "$PORT" ]] && PORT="$(sed -nE 's/^Environment=PORT=([0-9]+).*/\1/p' "$SERVICE_FILE")"
  [[ -z "$LOCATION" ]] && LOCATION="$(sed -nE 's/^Environment="SERVER_LOCATION=(.*)"$/\1/p' "$SERVICE_FILE" | sed 's/\\"/"/g')"
fi
PORT="${PORT:-3000}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "Invalid port: $PORT"
command -v systemctl >/dev/null || die "systemd is required."

# ---------- uninstall ----------
if (( UNINSTALL )); then
  info "Removing ${APP_NAME}..."
  systemctl disable --now "${APP_NAME}" 2>/dev/null || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  rm -rf "$APP_DIR"
  id "$APP_USER" >/dev/null 2>&1 && userdel "$APP_USER" 2>/dev/null || true
  green "Uninstalled."
  exit 0
fi

# ---------- package manager ----------
if command -v apt-get >/dev/null; then PM=apt
elif command -v dnf >/dev/null; then PM=dnf
elif command -v yum >/dev/null; then PM=yum
else die "Unsupported distro (need apt, dnf or yum)."
fi

pkg_install() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null ;;
    *)   "$PM" install -y -q "$@" >/dev/null ;;
  esac
}

[[ "$PM" == apt ]] && apt-get update -qq >/dev/null
pkg_install curl ca-certificates tar

# ---------- Node.js ----------
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

if ! command -v node >/dev/null || (( $(node_major) < NODE_MIN_MAJOR )); then
  info "Installing Node.js 20..."
  if [[ "$PM" == apt ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
  fi
  pkg_install nodejs
fi
command -v node >/dev/null || die "Node.js installation failed."
NODE_BIN="$(command -v node)"
info "Using Node.js $(node -v) at ${NODE_BIN}"

# ---------- app files ----------
info "Installing app to ${APP_DIR}..."
id "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
  || useradd -r -M -s /sbin/nologin "$APP_USER"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "${TMP_DIR}/src.tar.gz" \
  || die "Could not download https://github.com/${REPO} (check internet / GitHub access)."
tar -xzf "${TMP_DIR}/src.tar.gz" -C "$TMP_DIR" --strip-components=1 --no-same-owner
[[ -f "${TMP_DIR}/server.js" && -d "${TMP_DIR}/public" ]] || die "Downloaded archive is missing app files."

rm -rf "${APP_DIR}.new"
mkdir -p "${APP_DIR}.new"
cp -r "${TMP_DIR}/server.js" "${TMP_DIR}/package.json" "${TMP_DIR}/public" "${APP_DIR}.new/"
rm -rf "$APP_DIR"
mv "${APP_DIR}.new" "$APP_DIR"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

# ---------- systemd service ----------
info "Creating systemd service..."
CAP_LINE=""
(( PORT < 1024 )) && CAP_LINE="AmbientCapabilities=CAP_NET_BIND_SERVICE"
LOCATION_ESCAPED="${LOCATION//\"/\\\"}"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Fast Clone internet speed test
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Environment=PORT=${PORT}
$( [[ -n "$LOCATION" ]] && echo "Environment=\"SERVER_LOCATION=${LOCATION_ESCAPED}\"" )
${CAP_LINE}
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null 2>&1
systemctl restart "${APP_NAME}"

# ---------- firewall ----------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Opening port ${PORT} in ufw..."
  ufw allow "${PORT}/tcp" >/dev/null
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  info "Opening port ${PORT} in firewalld..."
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
fi

# ---------- check ----------
ok=0
for _ in $(seq 1 20); do
  if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/api/ping" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
(( ok )) || { journalctl -u "${APP_NAME}" -n 20 --no-pager; die "Service did not start. Logs are above."; }

PUBLIC_IP=$(curl -fs --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
URL="http://${PUBLIC_IP:-<server-ip>}"
[[ "$PORT" != 80 ]] && URL="${URL}:${PORT}"

echo
green "✔ Fast Clone is running: ${URL}"
echo "  Status:    systemctl status ${APP_NAME}"
echo "  Logs:      journalctl -u ${APP_NAME} -f"
echo "  Update:    ${INSTALL_CMD}"
echo "  Uninstall: ${INSTALL_CMD} --uninstall"
echo "  Note: if your cloud provider has its own firewall, open TCP port ${PORT} there too."
