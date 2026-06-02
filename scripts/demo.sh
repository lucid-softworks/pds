#!/usr/bin/env bash
# scripts/demo.sh — walk the full end-to-end flow against a running PDS.
#
# Usage:
#   scripts/demo.sh                              # uses defaults (alice.test on :3000)
#   PDS=http://localhost:3000 HANDLE=bob.test scripts/demo.sh
#
# What it does, in order:
#   1. describeServer       — confirm the PDS is up
#   2. createAccount        — register a new user
#   3. getSession           — verify the access JWT works
#   4. resolveHandle        — handle -> DID
#   5. createRecord         — write a post (if the records endpoint exists)
#   6. listRecords          — read it back
#   7. refreshSession       — rotate the refresh JWT
#   8. deleteSession        — log out
#
# Idempotent: a fresh handle each run (suffixed with the timestamp). If
# records aren't wired up yet, the script keeps going after the failure.

set -uo pipefail

PDS="${PDS:-http://localhost:3000}"
SUFFIX="${SUFFIX:-$(date +%s)}"
HANDLE="${HANDLE:-alice-${SUFFIX}.test}"
EMAIL="${EMAIL:-alice-${SUFFIX}@example.com}"
PASSWORD="${PASSWORD:-correcthorsebatterystaple}"
POST_TEXT="${POST_TEXT:-hello from scripts/demo.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✗ required command missing: $1" >&2
    exit 1
  fi
}

need curl
need jq

# ─── styling ─────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  bold=$'\033[1m'; dim=$'\033[2m'; reset=$'\033[0m'
  green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'
else
  bold=""; dim=""; reset=""; green=""; yellow=""; red=""
fi

step() { printf '\n%s┌─ %s%s\n' "$bold" "$1" "$reset"; }
ok()   { printf '%s✓%s %s\n' "$green" "$reset" "$1"; }
warn() { printf '%s⚠%s %s\n' "$yellow" "$reset" "$1"; }
fail() { printf '%s✗%s %s\n' "$red" "$reset" "$1"; }

# Run an XRPC call. Args: METHOD NSID [JSON_BODY] [extra_curl_args...]
# Prints the response body, returns the HTTP status as $XRPC_STATUS.
xrpc() {
  local method="$1" nsid="$2" body="${3:-}"; shift 3 || shift $#
  local url="$PDS/xrpc/$nsid"
  local tmp
  tmp=$(mktemp)
  local code
  if [ -n "$body" ]; then
    code=$(curl -sS -o "$tmp" -w '%{http_code}' \
      -X "$method" "$url" \
      -H 'content-type: application/json' \
      -d "$body" "$@")
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' \
      -X "$method" "$url" "$@")
  fi
  XRPC_STATUS="$code"
  cat "$tmp"
  rm -f "$tmp"
  return 0
}

# ─── 1. describeServer ───────────────────────────────────────────────────
step "describeServer"
resp=$(xrpc GET com.atproto.server.describeServer)
if [ "$XRPC_STATUS" = "200" ]; then
  ok "PDS up at $PDS"
  printf '%s%s%s\n' "$dim" "$(printf '%s' "$resp" | jq -c .)" "$reset"
else
  fail "PDS not reachable at $PDS (status $XRPC_STATUS)"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
  exit 1
fi

# ─── 2. createAccount ────────────────────────────────────────────────────
step "createAccount"
body=$(jq -nc \
  --arg h "$HANDLE" --arg e "$EMAIL" --arg p "$PASSWORD" \
  '{handle:$h,email:$e,password:$p}')
resp=$(xrpc POST com.atproto.server.createAccount "$body")
if [ "$XRPC_STATUS" != "200" ]; then
  fail "createAccount failed ($XRPC_STATUS)"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
  exit 1
fi
DID=$(printf '%s' "$resp" | jq -r '.did')
ACCESS=$(printf '%s' "$resp" | jq -r '.accessJwt')
REFRESH=$(printf '%s' "$resp" | jq -r '.refreshJwt')
ok "registered $HANDLE → $DID"

# ─── 3. getSession ───────────────────────────────────────────────────────
step "getSession"
resp=$(xrpc GET com.atproto.server.getSession '' -H "authorization: Bearer $ACCESS")
if [ "$XRPC_STATUS" = "200" ]; then
  ok "session valid for $(printf '%s' "$resp" | jq -r '.did')"
else
  warn "getSession returned $XRPC_STATUS — handler may not be registered yet"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
fi

# ─── 4. resolveHandle ────────────────────────────────────────────────────
step "resolveHandle"
resp=$(xrpc GET "com.atproto.identity.resolveHandle?handle=$HANDLE")
if [ "$XRPC_STATUS" = "200" ]; then
  ok "$HANDLE → $(printf '%s' "$resp" | jq -r '.did')"
else
  warn "resolveHandle returned $XRPC_STATUS"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
fi

# ─── 5. createRecord ─────────────────────────────────────────────────────
step "createRecord (app.bsky.feed.post)"
body=$(jq -nc \
  --arg repo "$DID" --arg text "$POST_TEXT" --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  '{
     repo: $repo,
     collection: "app.bsky.feed.post",
     record: { "$type": "app.bsky.feed.post", text: $text, createdAt: $now }
   }')
resp=$(xrpc POST com.atproto.repo.createRecord "$body" -H "authorization: Bearer $ACCESS")
if [ "$XRPC_STATUS" = "200" ]; then
  URI=$(printf '%s' "$resp" | jq -r '.uri')
  CID=$(printf '%s' "$resp" | jq -r '.cid')
  ok "wrote $URI (cid: $CID)"
else
  warn "createRecord returned $XRPC_STATUS — records subsystem may not be wired yet"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
fi

# ─── 6. listRecords ──────────────────────────────────────────────────────
step "listRecords"
resp=$(xrpc GET "com.atproto.repo.listRecords?repo=$DID&collection=app.bsky.feed.post")
if [ "$XRPC_STATUS" = "200" ]; then
  count=$(printf '%s' "$resp" | jq -r '.records | length')
  ok "found $count record(s)"
  printf '%s' "$resp" | jq '.records[] | { uri, cid, value: .value | {text, createdAt} }'
else
  warn "listRecords returned $XRPC_STATUS"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
fi

# ─── 7. refreshSession ───────────────────────────────────────────────────
step "refreshSession"
resp=$(xrpc POST com.atproto.server.refreshSession '' -H "authorization: Bearer $REFRESH")
if [ "$XRPC_STATUS" = "200" ]; then
  ok "rotated tokens"
  REFRESH=$(printf '%s' "$resp" | jq -r '.refreshJwt')
else
  warn "refreshSession returned $XRPC_STATUS"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
fi

# ─── 8. deleteSession ────────────────────────────────────────────────────
step "deleteSession"
resp=$(xrpc POST com.atproto.server.deleteSession '' -H "authorization: Bearer $REFRESH")
if [ "$XRPC_STATUS" = "200" ]; then
  ok "logged out"
else
  warn "deleteSession returned $XRPC_STATUS"
  printf '%s%s%s\n' "$dim" "$resp" "$reset"
fi

printf '\n%s┌─ summary%s\n' "$bold" "$reset"
ok "account:  $HANDLE ($DID)"
ok "PDS:      $PDS"
echo ""
