(function () {
  const { compareQuote, money } = window.JRidesPricing;
  const {
    PRESETS,
    estimateTrip,
    locateMe,
    presetsByKind,
    nearbyPresets,
  } = window.JRidesRouting;
  const { snapshot, addSample } = window.JRidesLiveMarket;

  const form = document.getElementById('quoteForm');
  const bookForm = document.getElementById('bookForm');
  const pickup = document.getElementById('pickup');
  const dropoff = document.getElementById('dropoff');
  const quoteBtn = document.getElementById('quoteBtn');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('quoteResult');
  const pickupChips = document.getElementById('pickupChips');
  const dropoffChips = document.getElementById('dropoffChips');
  const useMyLocation = document.getElementById('useMyLocation');

  let lastQuote = null;
  let lastTrip = null;
  let userCoords = null;

  const DEFAULT_DROPOFFS = ['mci', 'loews', 'plaza', 'union', 'power', 'legends'];
  const DEFAULT_PICKUPS = ['hq', 'mci', 'plaza', 'op', 'union', 'crown'];

  function fillDatalist(id, presets) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    presets.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.address;
      opt.label = p.label;
      el.appendChild(opt);
    });
  }

  function renderChips(container, presets, targetInput, activeId) {
    if (!container) return;
    container.innerHTML = '';
    presets.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = p.id;
      if (p.id === activeId) btn.classList.add('is-active');
      btn.innerHTML =
        p.label +
        (p.miles != null
          ? '<small>' + p.miles + ' mi</small>'
          : '');
      btn.addEventListener('click', () => {
        targetInput.value = p.address;
        container.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
      });
      container.appendChild(btn);
    });
  }

  function bootChips() {
    const pickups = DEFAULT_PICKUPS.map((id) => PRESETS[id]).filter(Boolean);
    const dropoffs = DEFAULT_DROPOFFS.map((id) => PRESETS[id]).filter(Boolean);
    fillDatalist('popular-pickups', presetsByKind('pickup'));
    fillDatalist('popular-drops', presetsByKind('dropoff'));
    renderChips(pickupChips, pickups, pickup, 'hq');
    renderChips(dropoffChips, dropoffs, dropoff, null);
  }

  bootChips();

  if (useMyLocation) {
    useMyLocation.addEventListener('click', async () => {
      useMyLocation.disabled = true;
      useMyLocation.textContent = 'Finding you…';
      setStatus('Getting your location…');
      try {
        const place = await locateMe();
        userCoords = { lat: place.lat, lon: place.lon };
        pickup.value = place.label;
        const nearby = place.nearby && place.nearby.length
          ? place.nearby
          : nearbyPresets(place.lat, place.lon, 'pickup', 6);
        renderChips(pickupChips, nearby, pickup, null);
        // Also refresh dropoffs sorted by distance from user
        const drops = nearbyPresets(place.lat, place.lon, 'dropoff', 6);
        renderChips(dropoffChips, drops, dropoff, null);
        setStatus(
          place.inMetro
            ? 'Pickup set to your location. Nearby spots updated.'
            : 'Got your location (outside usual KC box) — you can still book.',
          'ok'
        );
      } catch (err) {
        console.error(err);
        setStatus(
          (err && err.message) ||
            'Could not get location. Pick a nearby chip or type an address.',
          'error'
        );
      } finally {
        useMyLocation.disabled = false;
        useMyLocation.textContent = 'Use my location';
      }
    });
  }

  function setStatus(msg, kind) {
    if (!msg) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.className = 'status';
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' is-' + kind : '');
  }

  function deltaLabel(diff) {
    if (diff > 0) return 'You save ' + money(diff);
    if (diff < 0) return money(Math.abs(diff)) + ' more';
    return 'Same price';
  }

  function renderQuote(q) {
    lastQuote = q;
    resultEl.hidden = false;

    document.getElementById('jPrice').textContent = money(q.jrides.price);
    document.getElementById('jPriceRow').textContent = money(q.jrides.price);
    document.getElementById('tripMeta').textContent =
      q.miles + ' miles · about ' + q.minutes + ' min drive';

    document.getElementById('marketPill').textContent = 'Price locked · no surge';

    const pill = document.getElementById('savePill');
    // Lead with Uber Premier savings — that's the money story.
    const headlineSave = q.savings.vsUber;
    const headlinePct =
      q.uber.price > 0 ? Math.round((headlineSave / q.uber.price) * 100) : 0;
    if (headlineSave > 0) {
      pill.textContent =
        'You save ' + money(headlineSave) + ' (' + headlinePct + '%) vs Uber Premier';
      pill.classList.remove('is-over');
    } else if (headlineSave < 0) {
      pill.textContent = 'Price check: slightly above Uber Premier estimate right now';
      pill.classList.add('is-over');
    } else {
      pill.textContent = 'Matched to Uber Premier — with no surge';
      pill.classList.remove('is-over');
    }

    document.getElementById('uberPrice').textContent = money(q.uber.price);
    document.getElementById('lyftPrice').textContent = money(q.lyft.price);
    document.getElementById('uberMeta').textContent = 'Estimated app price';
    document.getElementById('lyftMeta').textContent = 'Estimated app price';

    const uberDelta = document.getElementById('uberDelta');
    const lyftDelta = document.getElementById('lyftDelta');
    uberDelta.textContent = deltaLabel(q.savings.vsUber);
    uberDelta.className = 'delta ' + (q.savings.vsUber >= 0 ? 'is-save' : 'is-over');
    // Don't advertise when Lyft Comfort looks cheaper — keep focus on Premier win
    if (q.savings.vsLyft >= 0) {
      lyftDelta.textContent = deltaLabel(q.savings.vsLyft);
      lyftDelta.className = 'delta is-save';
    } else {
      lyftDelta.textContent = 'Premium alternative';
      lyftDelta.className = 'delta';
    }

    document.getElementById('disclaimer').textContent = q.disclaimer;

    const verify = document.getElementById('verifyApps');
    if (q.savings.vsUber > 0) {
      verify.textContent =
        'That’s real money back in your pocket — and your J Rides price won’t jump with surge.';
    } else {
      verify.textContent = 'Your J Rides price is locked either way — no surge.';
    }

    document.getElementById('quoteJson').value = JSON.stringify({
      pickup: pickup.value,
      dropoff: dropoff.value,
      miles: q.miles,
      minutes: q.minutes,
      jrides: q.jrides.price,
      uber_premier_est: q.uber.price,
      lyft_extra_comfort_est: q.lyft.price,
      save_vs_uber_premier: q.savings.vsUber,
      save_vs_lyft_comfort: q.savings.vsLyft,
      market: q.market,
    });

    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    resultEl.hidden = true;
    setStatus('Calculating live route + near-live market prices…');
    quoteBtn.disabled = true;

    try {
      const trip = await estimateTrip(pickup.value, dropoff.value);
      if (trip.miles < 0.5) {
        throw new Error('That trip looks too short — check pickup and dropoff.');
      }
      lastTrip = trip;
      const market = snapshot({ trip });
      const quote = compareQuote(trip.miles, trip.minutes, { market });
      setStatus(
        'Route ready: ' + trip.from.label + ' → ' + trip.to.label,
        'ok'
      );
      renderQuote(quote);
    } catch (err) {
      console.error(err);
      setStatus(
        (err && err.message) ||
          'Could not price that trip. Try a popular dropoff button or a fuller KC address.',
        'error'
      );
    } finally {
      quoteBtn.disabled = false;
    }
  });

  function smsFallback(data) {
    const summary =
      'J Rides booking request%0A' +
      'Name: ' + encodeURIComponent(data.get('name')) + '%0A' +
      'Phone: ' + encodeURIComponent(data.get('phone')) + '%0A' +
      'When: ' + encodeURIComponent(data.get('when')) + '%0A' +
      'Pickup: ' + encodeURIComponent(pickup.value) + '%0A' +
      'Dropoff: ' + encodeURIComponent(dropoff.value) + '%0A' +
      'J Rides: ' + money(lastQuote.jrides.price) + '%0A' +
      'Uber Premier est: ' + money(lastQuote.uber.price) + '%0A' +
      'Lyft Extra Comfort est: ' + money(lastQuote.lyft.price) + '%0A' +
      'Save vs Uber Premier: ' + money(lastQuote.savings.vsUber);
    window.location.href = 'sms:+13238189982&body=' + summary;
  }

  const MIN_LEAD_MS = 2 * 60 * 60 * 1000;

  function minPickupInput() {
    const d = new Date(Date.now() + MIN_LEAD_MS);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      'T' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  bookForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!lastQuote) return;

    const data = new FormData(bookForm);
    const whenLocal = data.get('when');
    const whenDate = whenLocal ? new Date(whenLocal) : null;
    if (!whenDate || Number.isNaN(whenDate.getTime())) {
      setStatus('Pick a valid pickup time.', 'error');
      return;
    }
    if (whenDate.getTime() - Date.now() < MIN_LEAD_MS) {
      setStatus('Bookings need at least 2 hours notice.', 'error');
      return;
    }

    const bookBtn = document.getElementById('bookBtn');
    const note = document.getElementById('bookNote');
    if (bookBtn) {
      bookBtn.disabled = true;
      bookBtn.textContent = 'Starting checkout…';
    }

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: data.get('name'),
          phone: data.get('phone'),
          when: whenLocal,
          whenIso: whenDate.toISOString(),
          pickup: pickup.value,
          dropoff: dropoff.value,
          amount: lastQuote.jrides.price,
          miles: lastQuote.miles,
          minutes: lastQuote.minutes,
          uberPremier: lastQuote.uber.price,
          lyftComfort: lastQuote.lyft.price,
          saveVsPremier: lastQuote.savings.vsUber,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok && payload.error === 'lead_time') {
        setStatus(payload.message || 'Bookings need at least 2 hours notice.', 'error');
        return;
      }
      if (res.ok && payload.url) {
        window.location.href = payload.url;
        return;
      }
      // Local static server or missing Stripe → SMS handoff
      if (note) {
        note.textContent = 'Opening text booking…';
      }
      smsFallback(data);
    } catch (err) {
      console.error(err);
      smsFallback(data);
    } finally {
      if (bookBtn) {
        bookBtn.disabled = false;
        bookBtn.textContent = 'Pay & book';
      }
    }
  });

  // Quick-calibrate helper: if user types prices into session after a quote
  // (exposed for console / future UI)
  window.JRidesQuickCalibrate = function (uberPrice, lyftPrice) {
    if (!lastTrip || !lastQuote) return;
    addSample({
      miles: lastTrip.miles,
      minutes: lastTrip.minutes,
      uberPrice: uberPrice != null ? Number(uberPrice) : null,
      lyftPrice: lyftPrice != null ? Number(lyftPrice) : null,
      airport: !!lastQuote.market.airportFee,
      note: 'from booking session',
      route: 'session',
    });
    const market = snapshot({ trip: lastTrip });
    renderQuote(compareQuote(lastTrip.miles, lastTrip.minutes, { market }));
  };

  const whenInput = bookForm.querySelector('[name="when"]');
  if (whenInput) {
    whenInput.min = minPickupInput();
    whenInput.value = whenInput.min;
  }
})();
