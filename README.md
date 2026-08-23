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

```bash
npx wrangler login
NOTIFY_EMAIL=your@gmail.com ./scripts/setup-email-and-alerts.sh
```

This adds your inbox as a Cloudflare **verified destination** (check email to verify), deploys the worker, generates an `ADMIN_TOKEN`, and sends a test alert with full booking details.

**Admin panel:** https://j-rides.vip/admin — paste the token → **Send test alert**.

Optional: `export CLOUDFLARE_API_TOKEN=...` before the script to auto-create the `bookings@j-rides.vip` routing rule via API.

## Business cards

- Preview: `/vistaprint.html`
- Export PNGs: `npm run export:vistaprint`

## Operator

- Site: https://j-rides.vip
- Admin: https://j-rides.vip/admin
- Phone: (323) 818-9982
