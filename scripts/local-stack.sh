#!/usr/bin/env bash
# Deterministic local stack for UI screenshots and visual regression: built web app + API on :8787,
# MOCK PayPal on :9999 and the recorded Channel3 response on :9998. No AI key (rules-only answers),
# fresh ephemeral database each start. Stop with: scripts/local-stack.sh stop
#   npm run build && scripts/local-stack.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${STACK_DIR:-/tmp/saysafe-stack}
if [ "${1:-}" = "stop" ]; then
  for f in "$DIR"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done; rm -f "$DIR"/*.pid; exit 0
fi
"$0" stop || true
mkdir -p "$DIR"; rm -f "$DIR"/ui.db*
node scripts/mock-paypal.mjs 9999 > "$DIR/paypal.log" 2>&1 & echo $! > "$DIR/paypal.pid"
node scripts/mock-channel3.mjs 9998 > "$DIR/c3.log" 2>&1 & echo $! > "$DIR/c3.pid"
env -u GROQ_API_KEY -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  NODE_ENV=production SAYSAFE_ALLOW_EPHEMERAL_DB=true DATABASE_FILE="$DIR/ui.db" PORT=${PORT:-8787} \
  PAYPAL_API_BASE=http://127.0.0.1:9999 PAYPAL_ALLOW_LIVE=yes PAYPAL_CLIENT_ID=mock PAYPAL_CLIENT_SECRET=mock PAYPAL_DEMO_PLAN_ID=P-MOCKPLAN \
  CHANNEL3_API_BASE=http://127.0.0.1:9998 CHANNEL3_API_KEY=mock TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= \
  npx tsx server/index.ts > "$DIR/api.log" 2>&1 & echo $! > "$DIR/api.pid"
for i in $(seq 1 180); do curl -sf "http://127.0.0.1:${PORT:-8787}/api/config" >/dev/null && { echo "stack up on :${PORT:-8787}"; exit 0; }; sleep 0.5; done
echo "API did not start"; tail -20 "$DIR/api.log"; exit 1
