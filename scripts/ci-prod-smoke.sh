#!/usr/bin/env bash
# CI smoke test for the production build.
#
# Builds the production artifact, starts it against a fresh PGlite, hits a
# handful of endpoints that exercise distinct subsystems, and fails the
# run if any of them don't serve a 200. The full test suite covers
# behaviour against the source; this script covers "the prod build
# actually starts and serves what it claims to."
#
# Run from the repo root.
set -euo pipefail

# Bundled JSON lexicons + .well-known route + /docs markdown + /xrpc
# dispatcher + /oauth/jwks signing key — one endpoint each is enough to
# catch a regression like the lexicon-bundling miss or the dot-directory
# routing miss that motivated this script.
SMOKE_PATHS=(
  "/"
  "/.well-known/did.json"
  "/.well-known/oauth-authorization-server"
  "/.well-known/oauth-protected-resource"
  "/xrpc/com.atproto.server.describeServer"
  "/docs"
  "/oauth/jwks"
)

DB_DIR="$(mktemp -d -t pds-ci-db-XXXXXX)"
BLOB_DIR="$(mktemp -d -t pds-ci-blobs-XXXXXX)"
LOG_FILE="$(mktemp -t pds-ci-log-XXXXXX)"
trap 'rm -rf "$DB_DIR" "$BLOB_DIR" "$LOG_FILE"' EXIT

export PDS_PUBLIC_URL=${PDS_PUBLIC_URL:-http://localhost:3000}
export PDS_HOSTNAME=${PDS_HOSTNAME:-localhost}
export PDS_JWT_SECRET=${PDS_JWT_SECRET:-0000000000000000000000000000000000000000000000000000000000000000}
export PDS_OAUTH_SIGNING_KEY=${PDS_OAUTH_SIGNING_KEY:-4444444444444444444444444444444444444444444444444444444444444444}
export DATABASE_URL="pglite:${DB_DIR}"
export BLOB_DIR="$BLOB_DIR"
export PDS_LOG_LEVEL=warn
export PDS_LOG_PRETTY=false

echo "==> building (vite + esbuild server)…"
pnpm -s build

echo "==> applying migrations to fresh pglite…"
pnpm -s db:migrate

echo "==> starting prod server…"
pnpm -s start > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
# kill any survivor on early exit
trap 'kill $SERVER_PID 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$DB_DIR" "$BLOB_DIR" "$LOG_FILE"' EXIT

# Wait until the listening line shows up or we time out.
for _ in $(seq 1 30); do
  if grep -q "PDS listening" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "!! server exited before listening"
    cat "$LOG_FILE"
    exit 1
  fi
  sleep 0.5
done

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "!! server did not start in time"
  cat "$LOG_FILE"
  exit 1
fi

echo "==> probing endpoints…"
fail=0
for path in "${SMOKE_PATHS[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:3000${path}" || true)
  if [ "$code" = "200" ]; then
    printf "  \033[32mok\033[0m   %-55s %s\n" "$path" "$code"
  else
    printf "  \033[31mFAIL\033[0m %-55s %s\n" "$path" "$code"
    fail=$((fail + 1))
  fi
done

echo
echo "==> CORS spot-checks (bsky.app and the like fetch us cross-origin)"
# Preflight on the XRPC route.
preflight_headers=$(curl -sI -X OPTIONS \
  -H 'origin: https://bsky.app' \
  -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: authorization' \
  --max-time 5 \
  "http://127.0.0.1:3000/xrpc/com.atproto.server.describeServer")
if grep -qi '^access-control-allow-origin:' <<<"$preflight_headers"; then
  echo "  ok   OPTIONS preflight on /xrpc returns ACAO"
else
  echo "  FAIL OPTIONS preflight on /xrpc missing ACAO"
  echo "$preflight_headers" | sed 's/^/    /'
  fail=$((fail + 1))
fi
# Real request — verify the header survives the response wrap.
real_headers=$(curl -sI \
  -H 'origin: https://bsky.app' \
  --max-time 5 \
  "http://127.0.0.1:3000/.well-known/did.json")
if grep -qi '^access-control-allow-origin:' <<<"$real_headers"; then
  echo "  ok   GET .well-known/did.json returns ACAO"
else
  echo "  FAIL GET .well-known/did.json missing ACAO"
  echo "$real_headers" | sed 's/^/    /'
  fail=$((fail + 1))
fi

if [ "$fail" -gt 0 ]; then
  echo
  echo "!! $fail check(s) failed; server log:"
  echo "----"
  cat "$LOG_FILE"
  echo "----"
  exit 1
fi

echo "==> all checks OK"
