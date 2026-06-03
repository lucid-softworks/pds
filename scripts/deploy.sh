#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 / 26.04 VPS into a working PDS install.
#
# Run as root on the target box, after pointing your DNS at it. The script
# is idempotent — safe to re-run; it skips work that's already done. It is
# *also* opinionated: one box, one PDS, Postgres + Caddy + systemd, no
# Docker. For multi-machine or k8s deploys see chapter 18.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lucid-softworks/pds/main/scripts/deploy.sh \
#     | DOMAIN=pds.example.com ADMIN_EMAIL=you@example.com bash
#
# Environment knobs (those without defaults are required):
#   DOMAIN              public hostname, e.g. wickwork.cafe
#   ADMIN_EMAIL         contact email Caddy uses for Let's Encrypt
#   ADMIN_HANDLE        operator's account handle (defaults to luna.$DOMAIN)
#   PDS_REPO            git remote to clone   (default: lucid-softworks/pds)
#   PDS_BRANCH          branch to deploy      (default: main)
#   RESEND_API_KEY      Resend API key for outbound email (optional;
#                       if unset, the email backend falls back to the
#                       'console' logger and verification mail goes to
#                       stdout — fine for first boot, set this before
#                       inviting anyone)
#   RESEND_FROM         from-address for transactional mail
#                       (default: noreply@$DOMAIN)
#   INVITE_REQUIRED     true (default) or false
#
# What the script does, in order:
#   1. apt update + upgrade + base packages
#   2. 2 GB swap (so vite build doesn't OOM on 2 GB VPSes)
#   3. Node 24 via NodeSource, pnpm 9
#   4. PostgreSQL (whatever ships in the distro) + a `pds` role + `pds` db
#   5. Caddy (stable, from cloudsmith repo)
#   6. A `pds` system user with /home/pds/pds as the working tree
#   7. Clone the repo, install deps, run `pnpm build`
#   8. /etc/pds/.env with all secrets (generated on the box, never logged)
#   9. db:migrate against the real Postgres
#  10. systemd unit for the PDS, listening on 127.0.0.1:3000
#  11. Caddyfile that fronts $DOMAIN with HTTP-01 TLS
#  12. ufw allowing 22, 80, 443
#
# Anything secret (Postgres password, JWT secret, repo signing key, OAuth
# signing key, admin password) is generated *on the box* and only written
# to /etc/pds/.env (mode 0640, root:pds). The plaintext admin XRPC
# password is echoed once at the end — write it down.
#
# See docs/18-production.md for what each knob does, and docs/19-moderation.md
# for the admin surface.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "deploy.sh must run as root" >&2
  exit 1
fi

: "${DOMAIN:?DOMAIN env var is required (e.g. DOMAIN=wickwork.cafe)}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL env var is required (used for Lets Encrypt)}"
ADMIN_HANDLE="${ADMIN_HANDLE:-luna.${DOMAIN}}"
PDS_REPO="${PDS_REPO:-https://github.com/lucid-softworks/pds.git}"
PDS_BRANCH="${PDS_BRANCH:-main}"
RESEND_API_KEY="${RESEND_API_KEY:-}"
RESEND_FROM="${RESEND_FROM:-noreply@${DOMAIN}}"
INVITE_REQUIRED="${INVITE_REQUIRED:-true}"

export DEBIAN_FRONTEND=noninteractive

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }

log "1/12 — apt update + upgrade"
apt-get update -qq
apt-get upgrade -y -qq

log "2/12 — base packages"
apt-get install -y -qq \
  curl ca-certificates gnupg lsb-release ufw git build-essential \
  debian-keyring debian-archive-keyring apt-transport-https \
  unattended-upgrades

dpkg-reconfigure -plow -fnoninteractive unattended-upgrades >/dev/null 2>&1 || true
timedatectl set-timezone UTC

if [[ ! -f /swapfile ]]; then
  log "3/12 — 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q "/swapfile" /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
else
  log "3/12 — swap already present, skipping"
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node --version | sed 's/^v//' | cut -d. -f1)" -lt 24 ]]; then
  log "4/12 — Node 24 via NodeSource"
  rm -f /etc/apt/sources.list.d/nodesource.list
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
else
  log "4/12 — Node 24 already installed"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log "    pnpm 9"
  npm i -g pnpm@9 >/dev/null 2>&1
fi
node --version
pnpm --version

if ! command -v psql >/dev/null 2>&1; then
  log "5/12 — PostgreSQL"
  apt-get install -y -qq postgresql postgresql-contrib
  systemctl enable --now postgresql
else
  log "5/12 — PostgreSQL already installed"
fi

if ! command -v caddy >/dev/null 2>&1; then
  log "6/12 — Caddy"
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
else
  log "6/12 — Caddy already installed"
fi

if ! id pds >/dev/null 2>&1; then
  log "7/12 — pds system user"
  adduser --system --group --home /home/pds --shell /bin/bash pds
fi
mkdir -p /etc/pds
chown root:pds /etc/pds
chmod 0750 /etc/pds

log "8/12 — clone / update the repo"
if [[ ! -d /home/pds/pds/.git ]]; then
  sudo -iu pds bash -c "cd && git clone --branch ${PDS_BRANCH} ${PDS_REPO} pds"
else
  sudo -iu pds bash -c "cd ~/pds && git fetch origin && git checkout ${PDS_BRANCH} && git reset --hard origin/${PDS_BRANCH}"
fi

log "9/12 — Postgres role + database"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='pds'" | grep -q 1; then
  PG_PW="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE ROLE pds LOGIN PASSWORD '${PG_PW}';
CREATE DATABASE pds OWNER pds;
SQL
  echo "$PG_PW" > /etc/pds/.pgpw
  chown root:pds /etc/pds/.pgpw
  chmod 0640 /etc/pds/.pgpw
else
  PG_PW="$(cat /etc/pds/.pgpw 2>/dev/null || true)"
  if [[ -z "$PG_PW" ]]; then
    echo "pds role exists but /etc/pds/.pgpw is missing — cannot recover password" >&2
    echo "either drop the role manually and re-run, or paste the password into /etc/pds/.pgpw" >&2
    exit 1
  fi
  log "    role/db already exist"
fi

log "10/12 — write /etc/pds/.env"
if [[ ! -f /etc/pds/.env ]]; then
  # Use openssl for the symmetric secrets — keeps the script's parser
  # state simple (no nested quoting). Node generates equivalent bytes,
  # but the bash parser stumbles on quotes inside `"$(node -e '…')"`.
  JWT_SECRET=$(openssl rand -hex 64)
  REPO_KEY=$(openssl rand -hex 32)
  OAUTH_KEY=$(openssl rand -hex 32)
  ADMIN_PLAIN=$(openssl rand -base64 18 | tr -d '=+/' | head -c 24)
  # ADMIN_PLAIN is base64url-safe (no whitespace, no shell metacharacters),
  # so unquoted is fine here. Avoids the nested-double-quote parse trap
  # bash hits with `"$(... "$var")"`.
  ADMIN_HASH=$(cd /home/pds/pds && sudo -u pds pnpm -s admin:hash $ADMIN_PLAIN)

  if [[ -n "$RESEND_API_KEY" ]]; then
    EMAIL_BACKEND=http-json
    EMAIL_HTTP_URL=https://api.resend.com/emails
    EMAIL_HTTP_TOKEN=$RESEND_API_KEY
    EMAIL_HTTP_FLAVOR=generic
    EMAIL_FROM=$RESEND_FROM
  else
    warn "RESEND_API_KEY is unset — verification email goes to journalctl"
    EMAIL_BACKEND=console
    EMAIL_HTTP_URL=
    EMAIL_HTTP_TOKEN=
    EMAIL_HTTP_FLAVOR=
    EMAIL_FROM=
  fi

  cat > /etc/pds/.env <<ENV
# Auto-generated by scripts/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Do not commit. mode 0640 root:pds.

DATABASE_URL=postgres://pds:${PG_PW}@127.0.0.1:5432/pds

PDS_PUBLIC_URL=https://${DOMAIN}
PDS_HOSTNAME=${DOMAIN}

PDS_JWT_SECRET=${JWT_SECRET}
PDS_REPO_SIGNING_KEY=${REPO_KEY}
PDS_OAUTH_SIGNING_KEY=${OAUTH_KEY}
PDS_ADMIN_PASSWORD_HASH=${ADMIN_HASH}

PDS_ADMIN_HANDLE=${ADMIN_HANDLE}
PDS_LOCAL_PLC=false
PDS_INVITE_REQUIRED=${INVITE_REQUIRED}
PDS_METRICS=true

BLOB_DIR=/home/pds/blobs

PDS_EMAIL_BACKEND=${EMAIL_BACKEND}
PDS_EMAIL_HTTP_URL=${EMAIL_HTTP_URL}
PDS_EMAIL_HTTP_TOKEN=${EMAIL_HTTP_TOKEN}
PDS_EMAIL_HTTP_FLAVOR=${EMAIL_HTTP_FLAVOR}
PDS_EMAIL_FROM=${EMAIL_FROM}
ENV
  chown root:pds /etc/pds/.env
  chmod 0640 /etc/pds/.env

  echo "$ADMIN_PLAIN" > /etc/pds/.admin-xrpc-password
  chown root:root /etc/pds/.admin-xrpc-password
  chmod 0600 /etc/pds/.admin-xrpc-password
else
  log "    /etc/pds/.env already exists, leaving it alone"
  ADMIN_PLAIN="(unchanged; see /etc/pds/.admin-xrpc-password from a previous run)"
fi

mkdir -p /home/pds/blobs
chown pds:pds /home/pds/blobs

log "11/12 — install deps, build, migrate"
sudo -iu pds bash -c "cd ~/pds && pnpm install --frozen-lockfile"
sudo -iu pds bash -c "cd ~/pds && pnpm build"
sudo -iu pds bash -c "set -a; . /etc/pds/.env; set +a; cd ~/pds && pnpm db:migrate"

log "12/12 — systemd + Caddy + ufw"

cat > /etc/systemd/system/pds.service <<UNIT
[Unit]
Description=Personal Data Server (${DOMAIN})
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=pds
Group=pds
WorkingDirectory=/home/pds/pds
EnvironmentFile=/etc/pds/.env
ExecStart=/usr/bin/node /home/pds/pds/dist/start.mjs
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
{
    email ${ADMIN_EMAIL}
}

${DOMAIN}, ${ADMIN_HANDLE} {
    reverse_proxy 127.0.0.1:3000
}
CADDY

systemctl daemon-reload
systemctl enable pds
# `restart` covers both first-boot (was stopped → start) and re-runs
# (already running → pick up the freshly-built dist/start.mjs).
systemctl restart pds
systemctl restart caddy

ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw --force enable >/dev/null

echo
echo "============================================================"
echo "  PDS is up at https://${DOMAIN}"
echo "============================================================"
echo
echo "  Admin handle (web UI):   ${ADMIN_HANDLE}"
echo "  Admin XRPC password:     ${ADMIN_PLAIN}"
echo "                           (also at /etc/pds/.admin-xrpc-password)"
echo
echo "  Next steps:"
echo "    journalctl -u pds -f                # watch the logs"
echo "    cd /home/pds/pds && pnpm pds-admin createInviteCode --uses 1"
echo "    register an account at"
echo "      curl https://${DOMAIN}/xrpc/com.atproto.server.createAccount"
echo "      with the invite code, then visit https://${DOMAIN}/admin"
echo
echo "  TLS issuance happens on first request; if the cert is not yet"
echo "  visible, hit the URL once and Caddy will run the HTTP-01 dance."
echo
