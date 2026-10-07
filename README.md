# J Rides

Flat-rate private rides for Kansas City metro — [j-rides.vip](https://j-rides.vip)

## Stack

- **Frontend:** static HTML/CSS/JS (`public/`)
- **Backend:** Cloudflare Worker (`src/index.js`)
- **Payments:** Stripe Checkout + webhooks
- **Alerts:** Cloudflare Email Sending (preferred), Resend, Mailchannels, Twilio SMS, ntfy

## Features

- Live route quotes (Photon geocoding + OSRM)
- Pickup/dropoff address suggestions with keyboard and touch selection; manual entry still works
- Uber Premier / Lyft Extra Comfort comparison with savings headline
- Near-live market calibration via admin sample log
- Stripe pay-and-book with 2-hour minimum lead time
- Operator email/SMS/push on successful payment (full booking details)
- Cron reminders 2h and 30m before pickup
- Admin panel at `/admin` — refunds, payouts, webhook setup, test alerts

## Local dev

Use Node.js 22.12 or later (Node 24 is supported). Install the locked development
dependencies with `npm ci` so local tests and deploy tooling use the reviewed versions.

```bash
npm ci
npx wrangler dev
```

Puppeteer 25 removes the vulnerable archive/FTP dependency chain used by version 24.
The version-specific Miniflare override updates `sharp` to 0.35.5 while Wrangler's
Miniflare 5.20261006.0-alpha dependency still pins 0.35.4. Revisit this override when
updating Wrangler. These packages are development tools; they are not bundled into
the Worker or served to site visitors. Run `npm audit` after dependency updates.

### Tests

`npm test` uses Puppeteer with mocked Photon/OSRM responses and synthetic addresses.
No external booking, payment, or notification requests are made. If using an installed
browser instead of Puppeteer's download, set `PUPPETEER_EXECUTABLE_PATH` to its binary.

Address suggestions reuse the existing Photon endpoint after 3 characters and a
400 ms pause. Both fields share a 30-query in-memory cache with a 60-second lifetime
and start at most one suggestion request per second per page. HTTP 429/503 responses
pause new suggestion requests for 30 seconds by default (or a bounded Retry-After).
Requests cancel when the field changes or closes and time out after 6 seconds.
No cache is persisted, and suggestion requests omit credentials and referrers.
Selected coordinates stay in memory for routing; checkout still receives
address strings. Editing either address clears the old quote before booking.
Photon's public server can throttle heavy usage and has no availability guarantee;
manual entry and popular places remain available if suggestions fail.

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
