#!/usr/bin/env bash
set -euo pipefail

# Automate Cloudflare email for j-rides.vip
# Requires: CLOUDFLARE_API_TOKEN (Zone:Edit + Account settings) and wrangler logged in

ZONE_NAME="${ZONE_NAME:-j-rides.vip}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-j@j-ser.com}"
FROM_EMAIL="${FROM_EMAIL:-bookings@j-rides.vip}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Set CLOUDFLARE_API_TOKEN first."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Zone lookup for $ZONE_NAME"
ZONE_ID=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['id'])")

echo "Zone ID: $ZONE_ID"

echo "==> Mailchannels SPF (if missing)"
# Workers can send via Mailchannels when domain has SPF include
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"TXT","name":"@","content":"v=spf1 include:relay.mailchannels.net ~all","ttl":1}' \
  || true

echo "==> Email routing: $FROM_EMAIL -> $NOTIFY_EMAIL"
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/addresses" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"email\":\"$FROM_EMAIL\"}" || true

echo "==> Deploy worker"
npx wrangler deploy

echo "Done. Test from /admin → Send test alert."
