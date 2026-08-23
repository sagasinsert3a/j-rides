#!/usr/bin/env bash
# One-shot: Cloudflare email destination + worker secrets + deploy + test alert.
# Usage:
#   npx wrangler login
#   NOTIFY_EMAIL=you@gmail.com ./scripts/setup-email-and-alerts.sh
set -euo pipefail

ZONE_NAME="${ZONE_NAME:-j-rides.vip}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-j@j-ser.com}"
FROM_EMAIL="${FROM_EMAIL:-bookings@j-rides.vip}"
SITE_URL="${SITE_URL:-https://j-rides.vip}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cf() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"
  else
    echo "Need CLOUDFLARE_API_TOKEN or wrangler login (wrangler uses OAuth, not this helper)." >&2
    exit 1
  fi
}

echo "==> Checking wrangler auth"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Run: npx wrangler login"
  echo "Then re-run this script."
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Tip: export CLOUDFLARE_API_TOKEN for routing-rule API calls, or create rules in dashboard."
fi

ZONE_ID=""
ACCOUNT_ID=""
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "==> Zone + account lookup ($ZONE_NAME)"
  ZONE_JSON=$(cf "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME")
  ZONE_ID=$(echo "$ZONE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'])")
  ACCOUNT_ID=$(echo "$ZONE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['account']['id'])")
  echo "Zone: $ZONE_ID  Account: $ACCOUNT_ID"

  echo "==> Add destination address: $NOTIFY_EMAIL"
  cf -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses" \
    --data "{\"email\":\"$NOTIFY_EMAIL\"}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('success'):
  r=d.get('result') or {}
  print('  added/ok:', r.get('email'), 'verified:', r.get('verified') or 'pending — check inbox')
else:
  print('  note:', (d.get('errors') or [{}])[0].get('message','unknown'))
"

  echo "==> Routing rule: $FROM_EMAIL -> $NOTIFY_EMAIL"
  cf -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules" \
    --data "{\"name\":\"bookings\",\"enabled\":true,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"$FROM_EMAIL\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"$NOTIFY_EMAIL\"]}]}" \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('success'):
  print('  routing rule created')
else:
  print('  note:', (d.get('errors') or [{}])[0].get('message','unknown'))
"
fi

ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"
echo "==> Worker secrets"
echo "  ADMIN_TOKEN (save this for /admin): $ADMIN_TOKEN"
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
echo "  NOTIFY_EMAIL is set in wrangler.toml vars — update there if needed."

echo "==> Deploy worker"
npx wrangler deploy

echo "==> Test alert"
sleep 2
RES=$(curl -sS -X POST "$SITE_URL/api/admin/test-notify" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
echo "$RES" | python3 -m json.tool 2>/dev/null || echo "$RES"

echo ""
echo "Done."
echo "  Admin:  $SITE_URL/admin"
echo "  Token:  $ADMIN_TOKEN"
echo "  Inbox:  $NOTIFY_EMAIL (verify Cloudflare destination email if first time)"
echo "  From:   $FROM_EMAIL (outbound booking alerts)"
