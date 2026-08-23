#!/usr/bin/env bash
# One command: email routing + deploy + verify. Run on j-ser (wrangler logged in).
set -euo pipefail
cd "$(dirname "$0")/.."

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-e990188c49f4ff2cb3c91ff2b210e6ce}"
ZONE="j-rides.vip"
INBOX="jeffreysila@gmail.com"
FROM="booking@j-rides.vip"

TOKEN=$(python3 - <<'PY'
import re, pathlib
p = pathlib.Path.home() / '.config/.wrangler/config/default.toml'
text = p.read_text()
m = re.search(r'oauth_token\s*=\s*"([^"]+)"', text)
if not m: raise SystemExit('no wrangler oauth token')
print(m.group(1))
PY
)

cf() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

echo "==> Email destination $INBOX"
ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
cf -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/email/routing/addresses" \
  --data "{\"email\":\"$INBOX\"}" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('  ok' if d.get('success') else (d.get('errors') or d))
"

ZONE_ID=$(cf "https://api.cloudflare.com/client/v4/zones?name=$ZONE" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")
echo "==> Route $FROM -> $INBOX"
cf -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules" \
  --data "{\"name\":\"booking\",\"enabled\":true,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"$FROM\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"$INBOX\"]}]}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ok' if d.get('success') else (d.get('errors') or d))"

echo "==> Deploy worker"
npx wrangler deploy

echo "==> Health"
curl -sS "https://j-rides.vip/api/health" | python3 -m json.tool
echo ""
echo "Done. Verify jeffreysila@gmail.com inbox for Cloudflare destination email if first time."
