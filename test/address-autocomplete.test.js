import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve('public');
const feature = (name, lat = 39.09, lon = -94.58) => ({
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { name, housenumber: '100', street: 'Test Avenue', city: 'Kansas City', state: 'Missouri', postcode: '64108' },
});
const response = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});
let server, browser, context, page, origin, calls, errors;

before(async () => {
  server = createServer(async (req, res) => {
    const path = resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/'
      ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream');
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
});

beforeEach(async () => {
  calls = [];
  errors = [];
  context = await browser.createBrowserContext();
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (err) => errors.push(err.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    try {
      if (url.hostname === 'photon.komoot.io') {
        calls.push({ type: 'photon', q: url.searchParams.get('q'), url: req.url() });
        const q = url.searchParams.get('q') || '';
        if (q.includes('Unavailable')) await req.respond(response({}, 503));
        else if (q.includes('Missing')) await req.respond(response({ features: [] }));
        else await req.respond(response({ features: [feature('Test Museum'), feature('Test Gallery', 39.1, -94.59)] }));
      } else if (url.hostname === 'router.project-osrm.org') {
        calls.push({ type: 'route', url: req.url() });
        await req.respond(response({ code: 'Ok', routes: [{ distance: 16093.44, duration: 1200 }] }));
      } else if (url.origin === origin && url.pathname.startsWith('/api/')) {
        calls.push({ type: 'checkout', body: JSON.parse(req.postData() || '{}') });
        // Stop locally before checkout navigation or SMS fallback.
        await req.respond(response({ error: 'lead_time', message: 'Local test intercepted checkout' }, 400));
      } else if (url.origin === origin) await req.continue();
      else await req.abort(); // Block fonts, images, analytics, and every other external request.
    } catch (err) {
      if (!/already handled|Invalid InterceptionId|Target closed/.test(err.message)) throw err;
    }
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  // Keep browser automation from clicking an element midway through smooth scrolling.
  await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' });
});

afterEach(async () => {
  await context?.close();
  assert.deepEqual(errors, [], 'No uncaught application errors');
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((done) => server?.close(done));
});

async function enter(selector, value) {
  await page.$eval(selector, (input, text) => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function suggestions(selector = '#dropoff-suggestions') {
  await page.waitForFunction((sel) => {
    const list = document.querySelector(sel);
    return !list.hidden && list.children.length === 2 && !document.querySelector(sel.replace('-suggestions', '')).hasAttribute('aria-busy');
  }, {}, selector);
}

test('both fields are labelled comboboxes; debounce skips short input and uses the KC bounds', async () => {
  assert.equal(await page.$eval('label[for="pickup"]', (el) => el.textContent), 'Pickup');
  assert.equal(await page.$eval('label[for="dropoff"]', (el) => el.textContent), 'Dropoff');
  for (const field of ['pickup', 'dropoff']) {
    assert.equal(await page.$eval('#' + field, (el) => el.getAttribute('role')), 'combobox');
  }
  await enter('#dropoff', '10');
  await new Promise((done) => setTimeout(done, 450));
  assert.equal(calls.length, 0);
  await enter('#dropoff', '100');
  await new Promise((done) => setTimeout(done, 100));
  await enter('#dropoff', '100 Test');
  await suggestions();
  assert.deepEqual(calls.map((call) => call.q), ['100 Test']);
  assert.equal(new URL(calls[0].url).searchParams.get('bbox'), '-95.3,38.4,-93.9,39.7');
});

test('arrows and Enter select canonical address and retain coordinates for routing', async () => {
  await enter('#dropoff', '100 Test');
  await suggestions();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.$eval('#dropoff', (el) => el.getAttribute('aria-activedescendant')), 'dropoff-suggestions-0');
  await page.keyboard.press('Enter');
  const address = 'Test Museum, 100 Test Avenue, Kansas City, Missouri 64108';
  assert.equal(await page.$eval('#dropoff', (el) => el.value), address);
  assert.equal(await page.$eval('#dropoff', (el) => el.getAttribute('aria-expanded')), 'false');
  assert.equal(calls.filter((call) => call.type === 'route').length, 0, 'Choosing a suggestion does not submit the form');
  await page.click('#quoteBtn');
  await page.waitForSelector('#quoteResult:not([hidden])');
  assert.equal(calls.filter((call) => call.type === 'photon').length, 1, 'Selected address is not geocoded again');
  assert.ok(calls.find((call) => call.type === 'route').url.includes(';-94.58,39.09'));
  assert.equal(JSON.parse(await page.$eval('#quoteJson', (el) => el.value)).dropoff, address);
});

test('edited or cleared selection removes the old quote and falls back to manual geocoding', async () => {
  await enter('#dropoff', '100 Test');
  await suggestions();
  await page.click('#dropoff-suggestions li');
  await page.click('#quoteBtn');
  await page.waitForSelector('#quoteResult:not([hidden])');
  await enter('#dropoff', '200 Manual Avenue');
  assert.equal(await page.$eval('#quoteResult', (el) => el.hidden), true);
  assert.equal(await page.$eval('#quoteJson', (el) => el.value), '');
  await page.click('#quoteBtn'); // Close the debounce before it sends suggestions.
  await page.waitForSelector('#quoteResult:not([hidden])');
  assert.ok(calls.some((call) => call.q === '200 Manual Avenue'));
  await enter('#dropoff', '');
  assert.equal(await page.$eval('#quoteResult', (el) => el.hidden), true);
  assert.equal(await page.$eval('#dropoff', (el) => el.getAttribute('aria-expanded')), 'false');
});

test('errors and empty results keep manual entry usable; Escape and Tab dismiss', async () => {
  await enter('#dropoff', 'Unavailable address');
  await page.waitForFunction(() => document.querySelector('#dropoff-suggestion-status').textContent.includes('unavailable'));
  assert.equal(await page.$eval('#dropoff', (el) => el.value), 'Unavailable address');
  await page.click('#quoteBtn');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Geocoding unavailable'));
  await enter('#dropoff', 'Missing address');
  await page.waitForFunction(() => document.querySelector('#dropoff-suggestion-status').textContent.includes('No KC'));
  await enter('#dropoff', '100 Test');
  await suggestions();
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#dropoff', (el) => el.getAttribute('aria-expanded')), 'false');
  await enter('#dropoff', '100 Test again');
  await suggestions();
  await page.keyboard.press('Tab');
  assert.equal(await page.$eval('#dropoff', (el) => el.getAttribute('aria-expanded')), 'false');
  assert.equal(calls.filter((call) => call.type === 'checkout').length, 0);
});

test('stale responses cannot replace newer results or reopen after Escape', async () => {
  await page.evaluate(() => {
    const wrapper = document.createElement('div');
    wrapper.className = 'address-autocomplete';
    wrapper.innerHTML = '<input id="race">';
    document.body.append(wrapper);
    window.pendingSuggestions = [];
    window.JRidesAddressAutocomplete.attach(wrapper.firstChild, {
      search: (q, { signal }) => new Promise((resolve) => window.pendingSuggestions.push({ q, signal, resolve })),
    });
  });
  await enter('#race', 'Older query');
  await page.waitForFunction(() => window.pendingSuggestions.length === 1);
  await enter('#race', 'Newer query');
  await page.waitForFunction(() => window.pendingSuggestions.length === 2);
  assert.equal(await page.evaluate(() => window.pendingSuggestions[0].signal.aborted), true);
  await page.evaluate(() => window.pendingSuggestions[1].resolve([{ label: 'New result', lat: 39, lon: -94.5 }]));
  await page.waitForFunction(() => document.querySelector('#race-suggestions').textContent === 'New result');
  await page.evaluate(() => window.pendingSuggestions[0].resolve([{ label: 'Old result', lat: 39, lon: -94.5 }]));
  assert.equal(await page.$eval('#race-suggestions', (el) => el.textContent), 'New result');
  await enter('#race', 'Dismissed query');
  await page.waitForFunction(() => window.pendingSuggestions.length === 3);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.pendingSuggestions[2].resolve([{ label: 'Late result', lat: 39, lon: -94.5 }]));
  assert.equal(await page.$eval('#race', (el) => el.getAttribute('aria-expanded')), 'false');
});

test('provider normalization filters malformed/out-of-area data and renders text safely', async () => {
  const places = await page.evaluate(async (features) => {
    const fetchBefore = window.fetch;
    window.fetch = async () => ({ ok: true, json: async () => ({ features }) });
    try { return await window.JRidesRouting.suggestAddresses('Test query'); }
    finally { window.fetch = fetchBefore; }
  }, [null, {}, feature('Out of area', 40.7, -74), feature('Test Museum'), feature('Test Museum'), feature('<img src=x onerror=alert(1)>')]);
  assert.equal(places.length, 2);
  await page.evaluate((places) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<input id="safe">';
    document.body.append(wrapper);
    window.JRidesAddressAutocomplete.attach(wrapper.firstChild, { search: async () => places });
  }, places);
  await enter('#safe', 'Test query');
  await page.waitForSelector('#safe-suggestions:not([hidden])');
  assert.equal(await page.$eval('#safe-suggestions', (el) => el.querySelectorAll('img').length), 0);
  assert.ok(await page.$eval('#safe-suggestions', (el) => el.textContent.includes('<img')));
});

test('mobile touch selection fits the field, and popular-place chips cancel pending searches', async () => {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await enter('#dropoff', '100 Test');
  await suggestions();
  await page.$eval('#dropoff', (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const bounds = await page.$eval('#dropoff-suggestions', (el) => {
    const { left, right } = el.getBoundingClientRect();
    return { left, right, width: document.documentElement.clientWidth };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width);
  if (process.env.JRIDES_TEST_ARTIFACT_DIR) {
    await mkdir(process.env.JRIDES_TEST_ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.JRIDES_TEST_ARTIFACT_DIR, 'address-suggestions-mobile.png') });
  }
  const option = await page.$('#dropoff-suggestions li');
  const box = await option.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  assert.ok(await page.$eval('#dropoff', (el) => el.value.startsWith('Test Museum')), 'A touch tap chooses the address');
  await enter('#dropoff', 'Pending address');
  await page.click('#dropoffChips [data-id="mci"]');
  await new Promise((done) => setTimeout(done, 450));
  assert.equal(await page.$eval('#dropoff', (el) => el.value), 'Kansas City International Airport (MCI)');
  assert.equal(calls.some((call) => call.q === 'Pending address'), false);
});

test('checkout contract stays unchanged after selection (intercepted local request only)', async () => {
  await enter('#dropoff', '100 Test');
  await suggestions();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.click('#quoteBtn');
  await page.waitForSelector('#quoteResult:not([hidden])');
  await page.evaluate(() => {
    document.querySelector('[name="name"]').value = 'Synthetic Test';
    document.querySelector('[name="phone"]').value = '202-555-0100';
    const when = new Date(Date.now() + 86400000);
    document.querySelector('[name="when"]').value = when.toISOString().slice(0, 16);
    document.querySelector('#bookForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Local test intercepted checkout');
  const booking = calls.find((call) => call.type === 'checkout').body;
  assert.equal(booking.dropoff, 'Test Museum, 100 Test Avenue, Kansas City, Missouri 64108');
  assert.deepEqual(Object.keys(booking).sort(), [
    'name', 'phone', 'when', 'whenIso', 'pickup', 'dropoff', 'amount', 'miles', 'minutes', 'uberPremier', 'lyftComfort', 'saveVsPremier',
  ].sort());
});

test('pickup suggestions and current-location coordinates both feed routing without another geocode', async () => {
  await enter('#pickup', '100 Test');
  await suggestions('#pickup-suggestions');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.click('#dropoffChips [data-id="mci"]');
  await page.click('#quoteBtn');
  await page.waitForSelector('#quoteResult:not([hidden])');
  assert.equal(calls.filter((call) => call.type === 'photon').length, 1);
  assert.ok(calls.find((call) => call.type === 'route').url.includes('/-94.58,39.09;'));

  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (success) => success({
      coords: { latitude: 39.1, longitude: -94.6, accuracy: 10 },
    });
  });
  await page.click('#useMyLocation');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Pickup set'));
  assert.equal(await page.$eval('#quoteResult', (el) => el.hidden), true);
  const countBeforeQuote = calls.filter((call) => call.type === 'photon').length;
  await page.click('#quoteBtn');
  await page.waitForSelector('#quoteResult:not([hidden])');
  assert.equal(calls.filter((call) => call.type === 'photon').length, countBeforeQuote);
  assert.ok(calls.filter((call) => call.type === 'route').at(-1).url.includes('/-94.6,39.1;'));
});

test('timed-out suggestions preserve the manually entered address', async () => {
  await page.evaluate(() => {
    const originalTimeout = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) => originalTimeout(fn, delay === 6000 ? 50 : delay, ...args);
    const wrapper = document.createElement('div');
    wrapper.className = 'address-autocomplete';
    wrapper.innerHTML = '<input id="timeout">';
    document.body.append(wrapper);
    window.JRidesAddressAutocomplete.attach(wrapper.firstChild, {
      search: (q, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')));
      }),
    });
  });
  await enter('#timeout', 'Test timeout');
  await page.waitForFunction(() => document.querySelector('#timeout-suggestion-status').textContent.includes('unavailable'));
  assert.equal(await page.$eval('#timeout', (el) => el.value), 'Test timeout');
});

test('an address edit during routing cannot leave a stale quote', async () => {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.fetch = (url, ...args) => String(url).includes('router.project-osrm.org')
      ? new Promise((resolve) => { window.finishRoute = () => resolve(new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 16093, duration: 1200 }] }))); })
      : originalFetch(url, ...args);
  });
  await page.click('#dropoffChips [data-id="mci"]');
  await page.click('#quoteBtn');
  assert.equal(await page.$eval('#dropoff', (el) => el.value), 'Kansas City International Airport (MCI)');
  await page.waitForFunction(() => !!window.finishRoute);
  await enter('#dropoff', 'Changed destination');
  await page.evaluate(() => window.finishRoute());
  assert.equal(await page.$eval('#quoteResult', (el) => el.hidden), true);
  assert.equal(await page.$eval('#quoteJson', (el) => el.value), '');
});
