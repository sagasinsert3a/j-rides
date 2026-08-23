/**
 * J Rides — Cloudflare Worker
 * Stripe checkout, operator alerts, booking reminders.
 */

const BOOKINGS_KEY = 'bookings:v1';
const OPERATOR_LOC_KEY = 'operator:location';
const WEBHOOK_SECRET_KEY = 'stripe:webhook_secret';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/checkout' && request.method === 'POST') {
        return json(await createCheckout(request, env));
      }
      if (path === '/api/stripe/webhook' && request.method === 'POST') {
        return await handleStripeWebhook(request, env);
      }
      if (path.startsWith('/api/admin/')) {
        const err = requireAdmin(request, env);
        if (err) return json(err.body, err.status);
        if (path === '/api/admin/status' && request.method === 'GET') {
          return json(await adminStatus(env));
        }
        if (path === '/api/admin/bookings' && request.method === 'GET') {
          return json(await adminBookings(env));
        }
        if (path === '/api/admin/payouts' && request.method === 'GET') {
          return json(await adminPayouts(env));
        }
        if (path === '/api/admin/refund' && request.method === 'POST') {
          return json(await adminRefund(request, env));
        }
        if (path === '/api/admin/payout' && request.method === 'POST') {
          return json(await adminPayout(env));
        }
        if (path === '/api/admin/setup-webhook' && request.method === 'POST') {
          return json(await adminSetupWebhook(env));
        }
        if (path === '/api/admin/recreate-webhook' && request.method === 'POST') {
          return json(await adminRecreateWebhook(env));
        }
        if (path === '/api/admin/test-notify' && request.method === 'POST') {
          return json(await adminTestNotify(env));
        }
        if (path === '/api/admin/location' && request.method === 'POST') {
          return json(await adminLocation(request, env));
        }
        if (path === '/api/admin/resend-alert' && request.method === 'POST') {
          return json(await adminResendAlert(request, env));
        }
        return json({ error: 'not_found' }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('worker error', path, msg);
      return json({ error: msg }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processReminders(env));
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function moneyCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function dollarsFromCents(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < ab.length; i++) out |= ab[i] ^ bb[i];
  return out === 0;
}

async function hmacSha256Hex(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function requireAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!env.ADMIN_TOKEN || !token || token !== env.ADMIN_TOKEN) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  return null;
}

async function stripeForm(env, path, body) {
  const res = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
  return data;
}

async function stripeGet(env, path) {
  const res = await fetch('https://api.stripe.com/v1' + path, {
    headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
  return data;
}

async function getWebhookSecret(env) {
  return (await env.CONFIG.get(WEBHOOK_SECRET_KEY)) || env.STRIPE_WEBHOOK_SECRET || '';
}

async function verifyStripeSignature(request, env) {
  const secret = await getWebhookSecret(env);
  if (!secret) throw new Error('webhook secret not configured');
  const sig = request.headers.get('stripe-signature') || '';
  const body = await request.text();
  const parts = Object.fromEntries(
    sig.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k, v];
    })
  );
  const signed = parts.t + '.' + body;
  const expected = await hmacSha256Hex(secret, signed);
  if (!parts.v1 || !(await timingSafeEqual(parts.v1, expected))) {
    throw new Error('invalid stripe signature');
  }
  return JSON.parse(body);
}

function assessLeadTime(whenIso, env) {
  const minLead = Number(env.MIN_LEAD_MINUTES || 120);
  const tz = env.TIMEZONE || 'America/Chicago';
  const when = new Date(whenIso);
  const now = new Date();
  const leadMin = Math.round((when.getTime() - now.getTime()) / 60000);
  const warnings = [];
  if (!whenIso || Number.isNaN(when.getTime())) {
    warnings.push('Pickup time missing or invalid');
  } else if (leadMin < minLead) {
    warnings.push(`Only ${leadMin} min lead time (minimum ${minLead} min)`);
  }
  return { leadMin, minLead, warnings, timezone: tz };
}

async function geocodeAddress(q) {
  const url =
    'https://photon.komoot.io/api/?q=' +
    encodeURIComponent(q) +
    '&lat=39.0997&lon=-94.5786&limit=1';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const data = await res.json();
  const f = data.features?.[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  const label = f.properties.name || q;
  return { lat, lon, label };
}

async function driveMinutes(from, to) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const res = await fetch(url);
  const data = await res.json();
  const sec = data.routes?.[0]?.duration;
  return sec ? Math.ceil(sec / 60) : null;
}

async function getOperatorLocation(env) {
  const raw = await env.CONFIG.get(OPERATOR_LOC_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function bookingSummary(booking, env, extras = {}) {
  const amount = booking.amount || dollarsFromCents(booking.amountCents);
  const lead = assessLeadTime(booking.when, env);
  const lines = [
    `J Rides booking — $${amount}`,
    '',
    `Rider: ${booking.name || '—'}`,
    `Phone: ${booking.phone || '—'}`,
    `When: ${booking.when || '—'} (${env.TIMEZONE || 'America/Chicago'})`,
    `Pickup: ${booking.pickup || '—'}`,
    `Dropoff: ${booking.dropoff || '—'}`,
    `Trip: ${booking.miles || '—'} mi · ~${booking.minutes || '—'} min`,
  ];
  if (booking.saveVsPremier) lines.push(`Save vs Uber Premier: $${booking.saveVsPremier}`);
  if (lead.warnings.length) lines.push('', '⚠ ' + lead.warnings.join('; '));
  if (extras.travelMin != null) {
    lines.push('', `Drive to pickup: ~${extras.travelMin} min`);
    if (extras.leaveNow) lines.push('🚨 Leave now to make pickup on time');
  }
  if (booking.sessionId) lines.push('', `Stripe session: ${booking.sessionId}`);

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">
    <h2>J Rides booking — $${esc(amount)}</h2>
    <p><strong>Rider:</strong> ${esc(booking.name)}<br>
    <strong>Phone:</strong> ${esc(booking.phone)}<br>
    <strong>When:</strong> ${esc(booking.when)} (${esc(env.TIMEZONE)})<br>
    <strong>Pickup:</strong> ${esc(booking.pickup)}<br>
    <strong>Dropoff:</strong> ${esc(booking.dropoff)}<br>
    <strong>Trip:</strong> ${esc(booking.miles)} mi · ~${esc(booking.minutes)} min</p>
    ${lead.warnings.length ? `<p style="color:#b42318"><strong>Warning:</strong> ${esc(lead.warnings.join('; '))}</p>` : ''}
    ${extras.travelMin != null ? `<p><strong>Drive to pickup:</strong> ~${extras.travelMin} min${extras.leaveNow ? ' — <span style="color:#b42318">leave now</span>' : ''}</p>` : ''}
  </body></html>`;

  return {
    title: `J Rides booking — $${amount}`,
    text: lines.join('\n'),
    html,
    lead,
  };
}

async function sendViaMailchannels(fromEmail, to, summary) {
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: 'J Rides Bookings' },
      subject: summary.title,
      content: [
        { type: 'text/plain', value: summary.text },
        { type: 'text/html', value: summary.html },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: 'mailchannels ' + res.status + ': ' + t.slice(0, 200) };
  }
  return { ok: true, channel: 'mailchannels' };
}

async function sendOperatorEmail(env, summary) {
  const to = env.NOTIFY_EMAIL;
  const fromEmail = env.NOTIFY_FROM_EMAIL || 'bookings@j-rides.vip';
  if (!to) return { ok: false, error: 'NOTIFY_EMAIL not set' };

  if (env.EMAIL?.send) {
    try {
      await env.EMAIL.send({
        from: { email: fromEmail, name: 'J Rides Bookings' },
        to: [{ email: to }],
        subject: summary.title,
        text: summary.text,
        html: summary.html,
      });
      return { ok: true, channel: 'cf-email' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!env.RESEND_API_KEY) {
        const mc = await sendViaMailchannels(fromEmail, to, summary);
        if (!mc.ok) return { ok: false, error: `${msg}; ${mc.error || 'mailchannels failed'}` };
        return mc;
      }
    }
  }

  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.RESEND_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: 'J Rides <' + fromEmail + '>',
        to: [to],
        subject: summary.title,
        text: summary.text,
        html: summary.html,
      }),
    });
    if (res.ok) return { ok: true, channel: 'resend' };
    const t = await res.text();
    return { ok: false, error: 'resend ' + res.status + ': ' + t.slice(0, 200) };
  }

  return await sendViaMailchannels(fromEmail, to, summary);
}

async function notifyTwilio(env, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM || !env.NOTIFY_SMS_TO) {
    return { ok: false, error: 'twilio not configured' };
  }
  const url =
    'https://api.twilio.com/2010-04-01/Accounts/' +
    env.TWILIO_ACCOUNT_SID +
    '/Messages.json';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization:
        'Basic ' + btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: env.NOTIFY_SMS_TO,
      From: env.TWILIO_FROM,
      Body: body.slice(0, 1500),
    }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.message || 'twilio failed' };
  return { ok: true, channel: 'sms' };
}

async function notifyWebhook(env, title, body) {
  if (!env.NTFY_TOPIC) return { ok: false, error: 'ntfy not configured' };
  const res = await fetch('https://ntfy.sh/' + env.NTFY_TOPIC, {
    method: 'POST',
    headers: { title, priority: 'high' },
    body,
  });
  if (!res.ok) return { ok: false, error: 'ntfy ' + res.status };
  return { ok: true, channel: 'ntfy' };
}

async function notifyOperator(env, booking, extras = {}) {
  const summary = bookingSummary(booking, env, extras);
  const results = [];
  const email = await sendOperatorEmail(env, summary);
  if (email.ok) results.push(email.channel);
  const sms = await notifyTwilio(env, summary.text);
  if (sms.ok) results.push(sms.channel);
  const push = await notifyWebhook(env, summary.title, summary.text);
  if (push.ok) results.push(push.channel);
  return { sent: results.length > 0, channels: results, summary };
}

async function loadBookings(env) {
  const raw = await env.CONFIG.get(BOOKINGS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveBookings(env, list) {
  await env.CONFIG.put(BOOKINGS_KEY, JSON.stringify(list.slice(0, 200)));
}

async function createCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe not configured');
  const body = await request.json();
  const cents = moneyCents(body.amount);
  if (!cents) return { error: 'invalid_amount' };

  const lead = assessLeadTime(body.when, env);
  if (lead.warnings.some((w) => w.includes('minimum'))) {
    return { error: 'lead_time', message: `Bookings need at least ${lead.minLead} minutes notice.` };
  }

  const site = env.SITE_URL || 'https://j-rides.vip';
  const meta = {
    name: body.name || '',
    phone: body.phone || '',
    when: body.when || '',
    pickup: body.pickup || '',
    dropoff: body.dropoff || '',
    miles: String(body.miles || ''),
    minutes: String(body.minutes || ''),
    uberPremier: String(body.uberPremier || ''),
    lyftComfort: String(body.lyftComfort || ''),
    saveVsPremier: String(body.saveVsPremier || ''),
  };

  const session = await stripeForm(env, '/checkout/sessions', {
    mode: 'payment',
    success_url: site + '/?paid=1',
    cancel_url: site + '/?cancel=1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': 'J Rides flat-rate ride',
    'line_items[0][price_data][product_data][description]':
      (body.pickup || '') + ' → ' + (body.dropoff || ''),
    'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][quantity]': '1',
    customer_email: body.email || undefined,
    'metadata[name]': meta.name,
    'metadata[phone]': meta.phone,
    'metadata[when]': meta.when,
    'metadata[pickup]': meta.pickup,
    'metadata[dropoff]': meta.dropoff,
    'metadata[miles]': meta.miles,
    'metadata[minutes]': meta.minutes,
    'metadata[uberPremier]': meta.uberPremier,
    'metadata[lyftComfort]': meta.lyftComfort,
    'metadata[saveVsPremier]': meta.saveVsPremier,
  });

  const list = await loadBookings(env);
  list.unshift({
    sessionId: session.id,
    created: session.created,
    amount: dollarsFromCents(cents),
    amountCents: cents,
    paymentStatus: 'pending',
    ...meta,
  });
  await saveBookings(env, list);

  return { url: session.url, id: session.id };
}

async function handleStripeWebhook(request, env) {
  const event = await verifyStripeSignature(request, env);
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const list = await loadBookings(env);
    const idx = list.findIndex((b) => b.sessionId === s.id);
    const booking = {
      sessionId: s.id,
      paymentIntentId: s.payment_intent,
      paymentStatus: 'paid',
      amount: dollarsFromCents(s.amount_total),
      amountCents: s.amount_total,
      name: s.metadata?.name,
      phone: s.metadata?.phone,
      when: s.metadata?.when,
      pickup: s.metadata?.pickup,
      dropoff: s.metadata?.dropoff,
      miles: s.metadata?.miles,
      minutes: s.metadata?.minutes,
      uberPremier: s.metadata?.uberPremier,
      lyftComfort: s.metadata?.lyftComfort,
      saveVsPremier: s.metadata?.saveVsPremier,
      paidAt: Date.now(),
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...booking };
    else list.unshift(booking);
    await saveBookings(env, list);

    const opLoc = await getOperatorLocation(env);
    let extras = {};
    if (opLoc && booking.pickup) {
      const pickup = await geocodeAddress(booking.pickup);
      if (pickup) {
        const travelMin = await driveMinutes(opLoc, pickup);
        if (travelMin != null) {
          const lead = assessLeadTime(booking.when, env);
          extras = { travelMin, leaveNow: lead.leadMin != null && lead.leadMin <= travelMin + 10 };
        }
      }
    }
    await notifyOperator(env, booking, extras);
  }
  return json({ received: true });
}

async function adminStatus(env) {
  const secret = await getWebhookSecret(env);
  return {
    stripe: !!env.STRIPE_SECRET_KEY,
    stripeWebhook: !!secret,
    notify: {
      email: !!(env.NOTIFY_EMAIL && (env.EMAIL || env.RESEND_API_KEY || true)),
      sms: !!(env.TWILIO_ACCOUNT_SID && env.NOTIFY_SMS_TO),
      webhook: !!env.NTFY_TOPIC,
    },
    operatorLocation: await getOperatorLocation(env),
    site: env.SITE_URL,
    minLeadMinutes: Number(env.MIN_LEAD_MINUTES || 120),
  };
}

async function adminBookings(env) {
  const list = await loadBookings(env);
  const opLoc = await getOperatorLocation(env);
  const bookings = [];
  for (const b of list.slice(0, 50)) {
    const lead = assessLeadTime(b.when, env);
    let travelMin = null;
    let leaveNow = false;
    if (opLoc && b.pickup) {
      const pickup = await geocodeAddress(b.pickup);
      if (pickup) {
        travelMin = await driveMinutes(opLoc, pickup);
        leaveNow = travelMin != null && lead.leadMin != null && lead.leadMin <= travelMin + 10;
      }
    }
    bookings.push({
      ...b,
      leadMinutes: lead.leadMin,
      warnings: lead.warnings,
      travelMin,
      leaveNow,
    });
  }
  return { bookings };
}

async function adminPayouts(env) {
  const bal = await stripeGet(env, '/balance');
  const payouts = await stripeGet(env, '/payouts?limit=10');
  return {
    available: (bal.available || []).map((a) => ({
      amount: dollarsFromCents(a.amount),
      currency: a.currency,
    })),
    pending: (bal.pending || []).map((a) => ({
      amount: dollarsFromCents(a.amount),
      currency: a.currency,
    })),
    payouts: (payouts.data || []).map((p) => ({
      amount: dollarsFromCents(p.amount),
      status: p.status,
      method: p.method,
      automatic: p.automatic,
      arrival: p.arrival_date,
    })),
    note: 'Standard payouts go to your linked bank on Stripe.',
  };
}

async function adminRefund(request, env) {
  const { paymentIntentId } = await request.json();
  if (!paymentIntentId) throw new Error('paymentIntentId required');
  const refund = await stripeForm(env, '/refunds', { payment_intent: paymentIntentId });
  const list = await loadBookings(env);
  const b = list.find((x) => x.paymentIntentId === paymentIntentId);
  if (b) {
    b.refunded = true;
    b.amountRefunded = dollarsFromCents(refund.amount);
    await saveBookings(env, list);
  }
  return { amount: dollarsFromCents(refund.amount), status: refund.status };
}

async function adminPayout(env) {
  const bal = await stripeGet(env, '/balance');
  const usd = (bal.available || []).find((a) => a.currency === 'usd');
  const amount = usd?.amount || 0;
  if (amount < 100) throw new Error('Less than $1.00 available');
  try {
    const p = await stripeForm(env, '/payouts', { amount: String(amount), currency: 'usd', method: 'instant' });
    return { amount: dollarsFromCents(p.amount), status: p.status, method: p.method, fallback: false };
  } catch {
    const p = await stripeForm(env, '/payouts', { amount: String(amount), currency: 'usd' });
    return { amount: dollarsFromCents(p.amount), status: p.status, method: p.method, fallback: true };
  }
}

async function adminSetupWebhook(env) {
  const site = env.SITE_URL || 'https://j-rides.vip';
  const endpoint = site + '/api/stripe/webhook';
  const existing = await stripeGet(env, '/webhook_endpoints?limit=20');
  const found = (existing.data || []).find((w) => w.url === endpoint);
  if (found) {
    await env.CONFIG.put(WEBHOOK_SECRET_KEY, found.secret || '');
    return { ok: true, note: 'Webhook already exists; secret stored if available.' };
  }
  const wh = await stripeForm(env, '/webhook_endpoints', {
    url: endpoint,
    'enabled_events[0]': 'checkout.session.completed',
  });
  await env.CONFIG.put(WEBHOOK_SECRET_KEY, wh.secret);
  return { ok: true, note: 'Webhook created at ' + endpoint };
}

async function adminRecreateWebhook(env) {
  const site = env.SITE_URL || 'https://j-rides.vip';
  const endpoint = site + '/api/stripe/webhook';
  const existing = await stripeGet(env, '/webhook_endpoints?limit=20');
  for (const w of existing.data || []) {
    if (w.url === endpoint) {
      await fetch('https://api.stripe.com/v1/webhook_endpoints/' + w.id, {
        method: 'DELETE',
        headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
      });
    }
  }
  const wh = await stripeForm(env, '/webhook_endpoints', {
    url: endpoint,
    'enabled_events[0]': 'checkout.session.completed',
  });
  await env.CONFIG.put(WEBHOOK_SECRET_KEY, wh.secret);
  return { ok: true };
}

async function adminTestNotify(env) {
  const booking = {
    name: 'Test Rider',
    phone: '(555) 555-0100',
    when: new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 16),
    pickup: '7521 Anderson St, Lenexa, KS',
    dropoff: 'MCI Airport',
    miles: '28',
    minutes: '35',
    amount: '66.75',
    saveVsPremier: '33.25',
    sessionId: 'cs_test_notify',
  };
  const r = await notifyOperator(env, booking, { travelMin: 22 });
  return { sent: r.sent, channels: r.channels };
}

async function adminLocation(request, env) {
  const body = await request.json();
  const loc = { lat: Number(body.lat), lon: Number(body.lon), at: Date.now(), label: body.label || '' };
  await env.CONFIG.put(OPERATOR_LOC_KEY, JSON.stringify(loc));
  return { ok: true, location: loc };
}

async function adminResendAlert(request, env) {
  const { sessionId } = await request.json();
  const list = await loadBookings(env);
  const booking = list.find((b) => b.sessionId === sessionId);
  if (!booking) throw new Error('booking not found');
  const r = await notifyOperator(env, booking);
  return { sent: r.sent, channels: r.channels };
}

async function processReminders(env) {
  const list = await loadBookings(env);
  const now = Date.now();
  let changed = false;
  for (const b of list) {
    if (b.paymentStatus !== 'paid' || !b.when) continue;
    const when = new Date(b.when).getTime();
    if (Number.isNaN(when)) continue;
    const minsUntil = Math.round((when - now) / 60000);
    const flags = b.reminders || {};
    if (minsUntil <= 120 && minsUntil > 105 && !flags.h2) {
      await notifyOperator(env, b, { travelMin: null });
      flags.h2 = true;
      changed = true;
    }
    if (minsUntil <= 30 && minsUntil > 15 && !flags.m30) {
      await notifyOperator(env, b, { travelMin: null });
      flags.m30 = true;
      changed = true;
    }
    b.reminders = flags;
  }
  if (changed) await saveBookings(env, list);
}
