#!/usr/bin/env bash
# Mobile-friendly: works with CLOUDFLARE_API_TOKEN only (no wrangler login / localhost OAuth).
#
#   NOTIFY_EMAIL=you@gmail.com CLOUDFLARE_API_TOKEN=xxx ./scripts/setup-email-and-alerts.sh
set -euo pipefail

ZONE_NAME="${ZONE_NAME:-j-rides.vip}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"
FROM_EMAIL="${FROM_EMAIL:-bookings@j-rides.vip}"
SITE_URL="${SITE_URL:-https://j-rides.vip}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "$NOTIFY_EMAIL" ]] || [[ "$NOTIFY_EMAIL" == "you@gmail.com" ]]; then
  echo "Set NOTIFY_EMAIL to your real inbox (not the example you@gmail.com)" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] || [[ "$CLOUDFLARE_API_TOKEN" == "paste_token_here" ]]; then
  cat >&2 <<'EOF'
Need CLOUDFLARE_API_TOKEN (works on mobile — no localhost OAuth).

On your phone:
  1. Open https://dash.cloudflare.com/profile/api-tokens
  2. Create Token → "Edit Cloudflare Workers" template (or custom with
     Workers Scripts/KV, Email Routing, Zone Read)
  3. Paste token here and re-run:

     NOTIFY_EMAIL=you@gmail.com CLOUDFLARE_API_TOKEN=xxx ./scripts/setup-email-and-alerts.sh

Or do email routing manually in the dashboard — see README § Mobile setup.
EOF
  exit 1
fi

cf() {
  curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"
}

echo "==> Verify token"
WHOAMI=$(cf "https://api.cloudflare.com/client/v4/user/tokens/verify")
echo "$WHOAMI" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'):
  raise SystemExit('Invalid token: ' + str(d.get('errors')))
print('  token ok')
"

echo "==> Zone + account ($ZONE_NAME)"
ZONE_JSON=$(cf "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME")
ZONE_ID=$(echo "$ZONE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'])")
ACCOUNT_ID=$(echo "$ZONE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['account']['id'])")
echo "  zone=$ZONE_ID account=$ACCOUNT_ID"

echo "==> Destination address: $NOTIFY_EMAIL"
cf -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses" \
  --data "{\"email\":\"$NOTIFY_EMAIL\"}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result') or {}
if d.get('success'):
  print('  ok — verify the email Cloudflare just sent to', r.get('email'))
else:
  print('  note:', (d.get('errors') or [{}])[0].get('message',''))
"

echo "==> Routing rule $FROM_EMAIL -> $NOTIFY_EMAIL"
cf -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules" \
  --data "{\"name\":\"bookings\",\"enabled\":true,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"$FROM_EMAIL\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"$NOTIFY_EMAIL\"]}]}" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  ok' if d.get('success') else '  note: ' + str((d.get('errors') or [{}])[0].get('message','')))
"

ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"
export CLOUDFLARE_API_TOKEN

echo "==> Worker secret ADMIN_TOKEN"
echo "  save for /admin: $ADMIN_TOKEN"
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN

echo "==> Deploy"
npx wrangler deploy

echo "==> Test alert"
sleep 2
RES=$(curl -sS -X POST "$SITE_URL/api/admin/test-notify" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
echo "$RES" | python3 -m json.tool 2>/dev/null || echo "$RES"

cat <<EOF

Done.
  Admin: $SITE_URL/admin
  Token: $ADMIN_TOKEN
  Inbox: $NOTIFY_EMAIL (tap Verify in Cloudflare email first)
EOF
