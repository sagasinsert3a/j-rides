#!/usr/bin/env bash
# Set j-rides worker secrets via Cloudflare API (no wrangler login).
# Usage:
#   CLOUDFLARE_API_TOKEN=xxx RESEND_API_KEY=re_xxx NOTIFY_EMAIL=you@gmail.com ./scripts/set-worker-secrets.sh
set -euo pipefail

SCRIPT_NAME="${SCRIPT_NAME:-j-rides}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"
RESEND_API_KEY="${RESEND_API_KEY:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Set CLOUDFLARE_API_TOKEN" >&2
  exit 1
fi

cf() {
  curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"
}

echo "==> Verify token"
cf "https://api.cloudflare.com/client/v4/user/tokens/verify" | python3 -c "
import sys,json; d=json.load(sys.stdin)
if not d.get('success'): raise SystemExit('bad token: '+str(d.get('errors')))
print('  ok')
"

ACCOUNT_ID=$(cf "https://api.cloudflare.com/client/v4/accounts" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(d['result'][0]['id'])
")
echo "  account=$ACCOUNT_ID"

put_secret() {
  local name="$1" value="$2"
  cf -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/secrets" \
    --data "{\"name\":\"$name\",\"text\":\"$value\",\"type\":\"secret_text\"}" | python3 -c "
import sys,json; d=json.load(sys.stdin)
if d.get('success'): print('  secret', '$name', 'ok')
else: print('  secret', '$name', 'fail:', (d.get('errors') or [{}])[0].get('message'))
"
}

if [[ -n "$RESEND_API_KEY" ]]; then
  echo "==> RESEND_API_KEY"
  put_secret "RESEND_API_KEY" "$RESEND_API_KEY"
fi

if [[ -n "$ADMIN_TOKEN" ]]; then
  echo "==> ADMIN_TOKEN"
  put_secret "ADMIN_TOKEN" "$ADMIN_TOKEN"
elif [[ -z "${SKIP_ADMIN_TOKEN:-}" ]]; then
  ADMIN_TOKEN=$(openssl rand -hex 24)
  echo "==> ADMIN_TOKEN (new): $ADMIN_TOKEN"
  put_secret "ADMIN_TOKEN" "$ADMIN_TOKEN"
fi

if [[ -n "$NOTIFY_EMAIL" ]]; then
  echo "==> NOTIFY_EMAIL var"
  # Merge with existing settings — fetch first
  SETTINGS=$(cf "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/settings")
  python3 <<PY
import json, subprocess, os
settings = json.loads('''$SETTINGS''')
if not settings.get('success'):
    raise SystemExit(str(settings.get('errors')))
result = settings['result']
vars = {v['name']: v['value'] for v in (result.get('vars') or []) if v.get('name')}
vars['NOTIFY_EMAIL'] = '$NOTIFY_EMAIL'
vars.setdefault('NOTIFY_FROM', 'J Rides <onboarding@resend.dev>')
payload = {
  'vars': [{'name': k, 'value': v, 'type': 'plain_text'} for k, v in vars.items()],
  'bindings': result.get('bindings') or [],
}
import urllib.request
req = urllib.request.Request(
  'https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/settings',
  data=json.dumps(payload).encode(),
  headers={'Authorization': 'Bearer $CLOUDFLARE_API_TOKEN', 'Content-Type': 'application/json'},
  method='PATCH'
)
with urllib.request.urlopen(req) as r:
  out = json.load(r)
print('  NOTIFY_EMAIL ok' if out.get('success') else out.get('errors'))
PY
fi

echo ""
echo "Health check:"
curl -sS "https://j-rides.vip/api/health" | python3 -m json.tool
echo ""
echo "Admin: https://j-rides.vip/admin"
[[ -n "${ADMIN_TOKEN:-}" ]] && echo "Token: $ADMIN_TOKEN"
