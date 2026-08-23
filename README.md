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

## Email setup

Run on a machine with Cloudflare API access:

```bash
./scripts/setup-cloudflare-email.sh
```

This configures Mailchannels DNS, Email Routing, Email Sending, and deploys the worker.

## Business cards

- Preview: `/vistaprint.html`
- Export PNGs: `npm run export:vistaprint`

## Operator

- Site: https://j-rides.vip
- Admin: https://j-rides.vip/admin
- Phone: (323) 818-9982
