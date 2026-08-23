/**
 * J Rides worker — payments, alerts, admin.
 * Payment email → jeffreysila@gmail.com · push title shows full ride.
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function moneyCents(n) {
  const dollars = Number(n);
  if (!Number.isFinite(dollars) || dollars < 8 || dollars > 2000) return null;
  return Math.round(dollars * 100);
}

function dollarsFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return (n / 100).toFixed(2);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getWebhookSecret(env) {
  if (env.STRIPE_WEBHOOK_SECRET) return env.STRIPE_WEBHOOK_SECRET;
  if (env.CONFIG) {
    const fromKv = await env.CONFIG.get('STRIPE_WEBHOOK_SECRET');
    if (fromKv) return fromKv;
  }
  return null;
}

function requireAdmin(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) return { ok: false, res: json({ error: 'admin_not_configured' }, 503) };
  const header = request.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const url = new URL(request.url);
  const q = url.searchParams.get('token') || '';
  const provided = bearer || q || request.headers.get('x-admin-token') || '';
  if (!provided || !timingSafeEqual(provided, token)) {
    return { ok: false, res: json({ error: 'unauthorized' }, 401) };
  }
  return { ok: true };
}

async function stripeForm(env, path, params, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : params,
  });
  const data = await res.json();
  return { res, data };
}

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  return { res, data };
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = {};
  for (const item of signatureHeader.split(',')) {
    const [k, v] = item.trim().split('=');
    if (k && v) {
      if (!parts[k]) parts[k] = [];
      parts[k].push(v);
    }
  }
  const timestamp = parts.t && parts.t[0];
  const v1s = parts.v1 || [];
  if (!timestamp || !v1s.length) return false;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || age > 300 || age < -30) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return v1s.some((sig) => timingSafeEqual(sig, expected));
}

function parseWhen(when) {
  if (!when || when === '—') return null;
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? null : d;
}

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function calendarExtras(when, pickup, dropoff, text) {
  const start = parseWhen(when);
  if (!start) return { link: null };
  const end = new Date(start.getTime() + 90 * 60 * 1000);
  const title = encodeURIComponent(`J Rides: ${pickup} → ${dropoff}`);
  const details = encodeURIComponent(text);
  const location = encodeURIComponent(pickup);
  const dates = `${icsDate(start)}/${icsDate(end)}`;
  const link =
    `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}` +
    `&dates=${dates}&details=${details}&location=${location}`;
  return { link };
}

function bookingSummary(session) {
  const meta = session.metadata || {};
  const amount = dollarsFromCents(session.amount_total);
  const name = meta.rider_name || 'Rider';
  const phone = meta.rider_phone || session.customer_details?.phone || '—';
  const when = meta.when || '—';
  const pickup = meta.pickup || '—';
  const dropoff = meta.dropoff || '—';
  const miles = meta.miles || '';
  const minutes = meta.minutes || '';
  const routeExtra = miles || minutes ? ` (${miles || '?'} mi · ${minutes || '?'} min)` : '';
  const whenShort = when !== '—' ? when.replace('T', ' ') : '—';

  const lines = [
    amount ? `Paid $${amount}` : 'New booking',
    `${name} · ${phone}`,
    `When: ${whenShort}`,
    `${pickup} → ${dropoff}${routeExtra}`,
  ];
  const text = lines.join('\n');
  const title = amount
    ? `$${amount} · ${whenShort} · ${pickup} → ${dropoff}`
    : `J Rides · ${pickup} → ${dropoff}`;
  const pushTitle = title.length > 180 ? title.slice(0, 177) + '…' : title;
  const cal = calendarExtras(when, pickup, dropoff, text);
  const html =
    `<h2>J Rides booking${amount ? ` — $${esc(amount)}` : ''}</h2>` +
    `<p><b>Rider:</b> ${esc(name)}<br><b>Phone:</b> ${esc(phone)}<br>` +
    `<b>When:</b> ${esc(whenShort)}<br><b>Pickup:</b> ${esc(pickup)}<br>` +
    `<b>Dropoff:</b> ${esc(dropoff)}${routeExtra ? esc(routeExtra) : ''}</p>` +
    (cal.link ? `<p><a href="${cal.link}">Add to Google Calendar</a></p>` : '');

  return { title, pushTitle, text, html, link: cal.link, amount, name, phone, when, pickup, dropoff };
}

function emailConfigured(env) {
  return Boolean(env.NOTIFY_EMAIL && env.EMAIL);
}

async function notifyEmail(env, summary) {
  const to = env.NOTIFY_EMAIL;
  if (!to) return { ok: false, skip: 'email_not_configured' };

  const fromEmail = env.NOTIFY_FROM_EMAIL || 'booking@j-rides.vip';
  const text = summary.text + (summary.link ? `\n\nCalendar: ${summary.link}` : '');
  const html = summary.html || `<pre>${esc(summary.text)}</pre>`;

  if (env.EMAIL?.send) {
    try {
      await env.EMAIL.send({
        from: { email: fromEmail, name: 'J Rides' },
        to: [{ email: to }],
        subject: summary.title,
        text,
        html,
      });
      return { ok: true, channel: 'email' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!env.RESEND_API_KEY) return { ok: false, error: msg };
    }
  }

  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || `J Rides <${fromEmail}>`,
        to: [to],
        subject: summary.title,
        text,
        html,
      }),
    });
    if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
    return { ok: true, channel: 'resend' };
  }

  return { ok: false, skip: 'email_not_configured' };
}

async function notifyTwilio(env, text) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  const to = env.BOOKING_PHONE || '+13238189982';
  if (!sid || !token || !from) return { ok: false, skip: 'twilio_not_configured' };
  const body = new URLSearchParams({ To: to, From: from, Body: text.slice(0, 1500) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
  return { ok: true, channel: 'sms' };
}

async function notifyWebhook(env, summary) {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) return { ok: false, skip: 'webhook_not_configured' };
  const isNtfy = /ntfy\.(sh|net)\b/i.test(url) || env.NOTIFY_WEBHOOK_MODE === 'ntfy';
  const isDiscord = /discord(?:app)?\.com\/api\/webhooks\//i.test(url);
  let res;
  if (isNtfy) {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Title: summary.pushTitle || summary.title,
        Priority: 'high',
        Tags: 'car,moneybag',
      },
      body: summary.text,
    });
  } else if (isDiscord) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: summary.text.slice(0, 1900) }),
    });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: summary.text, title: summary.title, booking: summary }),
    });
  }
  if (!res.ok) return { ok: false, error: (await res.text()).slice(0, 300) };
  return { ok: true, channel: isNtfy ? 'ntfy' : isDiscord ? 'discord' : 'webhook' };
}

async function notifyOperator(env, session) {
  const summary = bookingSummary(session);
  const results = await Promise.all([
    notifyEmail(env, summary),
    notifyWebhook(env, summary),
    notifyTwilio(env, summary.text),
  ]);
  const sent = results.filter((r) => r.ok);
  return { summary, results, sent: sent.length > 0, channels: sent.map((r) => r.channel) };
}

async function createCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'stripe_not_configured', message: 'Stripe not configured.' }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const amount = moneyCents(body.amount);
  if (amount == null) return json({ error: 'invalid_amount' }, 400);
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const when = String(body.when || '').trim().slice(0, 40);
  const pickup = String(body.pickup || '').trim().slice(0, 200);
  const dropoff = String(body.dropoff || '').trim().slice(0, 200);
  if (!name || !phone || !pickup || !dropoff) return json({ error: 'missing_fields' }, 400);

  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${site}/#book`);
  params.set('customer_creation', 'always');
  params.set('phone_number_collection[enabled]', 'true');
  params.set('submit_type', 'book');
  params.set('payment_intent_data[description]', `J Rides: ${pickup} → ${dropoff}`);
  params.set('payment_intent_data[metadata][booking_phone]', env.BOOKING_PHONE || '+13238189982');
  params.set('payment_intent_data[metadata][rider_name]', name);
  params.set('payment_intent_data[metadata][rider_phone]', phone);
  params.set('payment_intent_data[metadata][when]', when);
  params.set('payment_intent_data[metadata][pickup]', pickup);
  params.set('payment_intent_data[metadata][dropoff]', dropoff);
  params.set('payment_intent_data[metadata][miles]', String(body.miles || ''));
  params.set('payment_intent_data[metadata][minutes]', String(body.minutes || ''));
  params.set('metadata[rider_name]', name);
  params.set('metadata[rider_phone]', phone);
  params.set('metadata[when]', when);
  params.set('metadata[pickup]', pickup);
  params.set('metadata[dropoff]', dropoff);
  params.set('metadata[miles]', String(body.miles || ''));
  params.set('metadata[minutes]', String(body.minutes || ''));
  params.set('metadata[amount_dollars]', (amount / 100).toFixed(2));
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(amount));
  params.set('line_items[0][price_data][product_data][name]', 'J Rides — flat-rate ride');
  params.set(
    'line_items[0][price_data][product_data][description]',
    `${pickup} → ${dropoff}${when ? ` · ${when}` : ''}`
  );

  const { res: stripeRes, data } = await stripeForm(env, '/checkout/sessions', params);
  if (!stripeRes.ok) {
    return json({ error: 'stripe_error', message: data.error?.message || 'Checkout failed' }, 502);
  }
  return json({ url: data.url, id: data.id });
}

async function handleStripeWebhook(request, env) {
  const secret = await getWebhookSecret(env);
  if (!secret) return json({ error: 'webhook_not_configured' }, 503);
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!(await verifyStripeSignature(rawBody, signature, secret))) {
    return json({ error: 'invalid_signature' }, 400);
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    if (!session) return json({ error: 'missing_session' }, 400);
    if (
      session.payment_status &&
      session.payment_status !== 'paid' &&
      session.payment_status !== 'no_payment_required'
    ) {
      return json({ ok: true, skipped: 'not_paid' });
    }
    const notify = await notifyOperator(env, session);
    return json({
      ok: true,
      notified: notify.sent,
      channels: notify.channels,
      results: notify.results,
    });
  }
  return json({ ok: true, ignored: event.type });
}

function notifyStatus(env) {
  return {
    sms: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM),
    email: emailConfigured(env),
    webhook: Boolean(env.NOTIFY_WEBHOOK_URL),
  };
}

async function adminSetupWebhook(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  if (!env.STRIPE_SECRET_KEY || !env.CONFIG) return json({ error: 'not_configured' }, 503);
  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const endpointUrl = `${site}/api/stripe-webhook`;
  const existing = await stripeGet(env, '/webhook_endpoints?limit=100');
  if (!existing.res.ok) return json({ error: 'stripe_error', message: existing.data.error?.message }, 502);
  const found = (existing.data.data || []).find((w) => w.url === endpointUrl && w.status !== 'disabled');
  if (found) {
    return json({ ok: true, note: 'Webhook already exists.', endpoints: [{ url: endpointUrl, existing: true }] });
  }
  const params = new URLSearchParams();
  params.set('url', endpointUrl);
  params.append('enabled_events[]', 'checkout.session.completed');
  params.set('description', 'J Rides payment notify');
  const { res, data } = await stripeForm(env, '/webhook_endpoints', params);
  if (!res.ok) return json({ error: 'stripe_error', message: data.error?.message }, 502);
  if (data.secret) {
    await env.CONFIG.put('STRIPE_WEBHOOK_SECRET', data.secret);
    await env.CONFIG.put('STRIPE_WEBHOOK_ENDPOINT', endpointUrl);
  }
  return json({ ok: true, webhookSecretStored: Boolean(data.secret) });
}

async function adminRecreateWebhook(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  if (!env.STRIPE_SECRET_KEY || !env.CONFIG) return json({ error: 'not_configured' }, 503);
  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const endpointUrl = `${site}/api/stripe-webhook`;
  const existing = await stripeGet(env, '/webhook_endpoints?limit=100');
  for (const w of existing.data.data || []) {
    if (w.url === endpointUrl || w.url.includes('/api/stripe-webhook')) {
      await fetch(`https://api.stripe.com/v1/webhook_endpoints/${w.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
    }
  }
  const params = new URLSearchParams();
  params.set('url', endpointUrl);
  params.append('enabled_events[]', 'checkout.session.completed');
  const { res, data } = await stripeForm(env, '/webhook_endpoints', params);
  if (!res.ok) return json({ error: 'stripe_error', message: data.error?.message }, 502);
  await env.CONFIG.put('STRIPE_WEBHOOK_SECRET', data.secret);
  return json({ ok: true, webhookSecretStored: true });
}

async function adminBookings(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  const { res, data } = await stripeGet(env, '/checkout/sessions?limit=20&expand[]=data.payment_intent');
  if (!res.ok) return json({ error: 'stripe_error', message: data.error?.message }, 502);
  const bookings = (data.data || []).map((s) => {
    const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
    return {
      id: s.id,
      created: s.created,
      amount: dollarsFromCents(s.amount_total),
      paymentStatus: s.payment_status,
      paymentIntentId: pi ? pi.id : s.payment_intent || null,
      refunded: pi ? (pi.amount_refunded || 0) > 0 : false,
      name: s.metadata?.rider_name || s.customer_details?.name || null,
      phone: s.metadata?.rider_phone || s.customer_details?.phone || null,
      when: s.metadata?.when || null,
      pickup: s.metadata?.pickup || null,
      dropoff: s.metadata?.dropoff || null,
    };
  });
  return json({ ok: true, bookings });
}

async function adminRefund(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const paymentIntent = String(body.paymentIntentId || '').trim();
  if (!paymentIntent) return json({ error: 'missing_payment_intent' }, 400);
  const params = new URLSearchParams({ payment_intent: paymentIntent });
  const { res, data } = await stripeForm(env, '/refunds', params);
  if (!res.ok) return json({ error: 'stripe_error', message: data.error?.message }, 502);
  return json({ ok: true, amount: dollarsFromCents(data.amount), status: data.status });
}

async function adminPayouts(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  const bal = await stripeGet(env, '/balance');
  const payouts = await stripeGet(env, '/payouts?limit=10');
  return json({
    ok: true,
    available: (bal.data.available || []).map((b) => ({ currency: b.currency, amount: dollarsFromCents(b.amount) })),
    pending: (bal.data.pending || []).map((b) => ({ currency: b.currency, amount: dollarsFromCents(b.amount) })),
    payouts: (payouts.data.data || []).map((p) => ({
      amount: dollarsFromCents(p.amount),
      status: p.status,
      method: p.method,
    })),
  });
}

async function adminInstantPayout(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  const bal = await stripeGet(env, '/balance');
  const usd = (bal.data.available || []).find((b) => b.currency === 'usd');
  const amount = usd?.amount || 0;
  if (amount < 100) return json({ error: 'insufficient_balance' }, 400);
  const params = new URLSearchParams({ amount: String(amount), currency: 'usd' });
  const { res, data } = await stripeForm(env, '/payouts', params);
  if (!res.ok) return json({ error: 'stripe_error', message: data.error?.message }, 502);
  return json({ ok: true, amount: dollarsFromCents(data.amount), status: data.status, method: data.method });
}

async function adminStatus(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  return json({
    ok: true,
    stripe: Boolean(env.STRIPE_SECRET_KEY),
    stripeWebhook: Boolean(await getWebhookSecret(env)),
    notify: notifyStatus(env),
    notifyEmail: env.NOTIFY_EMAIL || null,
    site: env.SITE_URL || null,
  });
}

async function adminTestNotify(request, env) {
  const gate = requireAdmin(request, env);
  if (!gate.ok) return gate.res;
  const summary = bookingSummary({
    amount_total: 6675,
    metadata: {
      rider_name: 'Test Rider',
      rider_phone: '(555) 555-0100',
      when: new Date(Date.now() + 86400000).toISOString().slice(0, 16),
      pickup: '7521 Anderson St, Lenexa, KS',
      dropoff: 'MCI Airport',
      miles: '28',
      minutes: '35',
    },
  });
  const results = await Promise.all([
    notifyEmail(env, summary),
    notifyWebhook(env, summary),
    notifyTwilio(env, summary.text),
  ]);
  const sent = results.filter((r) => r.ok);
  return json({ ok: true, sent: sent.length > 0, channels: sent.map((r) => r.channel), results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        stripe: Boolean(env.STRIPE_SECRET_KEY),
        stripeWebhook: Boolean(await getWebhookSecret(env)),
        notify: notifyStatus(env),
        notifyEmail: env.NOTIFY_EMAIL || null,
        site: env.SITE_URL || null,
        bookingPhone: env.BOOKING_PHONE || null,
      });
    }
    if (url.pathname === '/api/checkout' && request.method === 'POST') {
      return createCheckout(request, env);
    }
    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === '/api/admin/status') return adminStatus(request, env);
    if (url.pathname === '/api/admin/setup-webhook' && request.method === 'POST') return adminSetupWebhook(request, env);
    if (url.pathname === '/api/admin/recreate-webhook' && request.method === 'POST') return adminRecreateWebhook(request, env);
    if (url.pathname === '/api/admin/bookings') return adminBookings(request, env);
    if (url.pathname === '/api/admin/refund' && request.method === 'POST') return adminRefund(request, env);
    if (url.pathname === '/api/admin/payouts') return adminPayouts(request, env);
    if (url.pathname === '/api/admin/payout' && request.method === 'POST') return adminInstantPayout(request, env);
    if (url.pathname === '/api/admin/test-notify' && request.method === 'POST') return adminTestNotify(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
