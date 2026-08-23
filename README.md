# J Rides

Flat-rate private rides for Kansas City metro — [j-rides.vip](https://j-rides.vip)

## Stack

- **Frontend:** static HTML/CSS/JS (`public/`)
- **Backend:** Cloudflare Worker (`src/index.js`)
- **Payments:** Stripe Checkout + webhooks
- **Alerts:** Cloudflare Email Sending (preferred), Resend, Mailchannels, Twilio SMS, ntfy

## Features

- Live route quotes (Photon geocoding + OSRM)
- Uber Premier / Lyft Extra Comfort comparison with savings headline
- Near-live market calibration via admin sample log
- Stripe pay-and-book with 2-hour minimum lead time
- Operator email/SMS/push on successful payment (full booking details)
- Cron reminders 2h and 30m before pickup
- Admin panel at `/admin` — refunds, payouts, webhook setup, test alerts

## Local dev

```bash
npm install
npx wrangler dev
```

## Deploy

```bash
# Secrets (one-time)
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put ADMIN_TOKEN
# optional: RESEND_API_KEY, TWILIO_*, NTFY_TOPIC

npm run deploy
```

## Email + booking alerts

### Mobile (no localhost link)

**Option A — paste token, I run it:** Create a Cloudflare API token on your phone (steps below), paste it in chat with your inbox address. I'll finish setup.

**Option B — phone dashboard only:**

1. [Cloudflare → Email Routing → Destination addresses](https://dash.cloudflare.com/?to=/:account/email-service/routing) — add your Gmail/iCloud, tap **Verify** in the email they send.
2. Same page → **Routing rules** → Create: `bookings@j-rides.vip` → forward to your inbox.
3. [Workers → j-rides → Settings → Variables](https://dash.cloudflare.com/) — set `NOTIFY_EMAIL` to your verified inbox.
4. Open https://j-rides.vip/admin → if you have an admin token, **Send test alert**.

**Create API token on phone:**

1. https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → use **Edit Cloudflare Workers** template
3. Include permissions: Email Routing, Email Sending (if offered)
4. Copy token → run (or paste to agent):

```bash
NOTIFY_EMAIL=you@gmail.com CLOUDFLARE_API_TOKEN=xxx ./scripts/setup-email-and-alerts.sh
```

Generates `ADMIN_TOKEN`, deploys worker, sends test booking email with full details.

## Business cards

- Preview: `/vistaprint.html`
- Export PNGs: `npm run export:vistaprint`

## Operator

- Site: https://j-rides.vip
- Admin: https://j-rides.vip/admin
- Phone: (323) 818-9982
