/**
 * KC-focused geocoding + driving distance/duration.
 * Uses Photon (Komoot) + public OSRM — no API keys.
 * Falls back to curated presets when network/geocode fails.
 */
(function (global) {
  const KC_BIAS = { lat: 39.0997, lon: -94.5786 };
  // Shared by both fields, scoped to this page only (no persistent address storage).
  const suggestionCache = new Map();
  let lastSuggestionRequest = 0;
  let suggestionsPausedUntil = 0;

  function cachedSuggestions(key) {
    const cached = suggestionCache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.places.map((p) => ({ ...p }));
    suggestionCache.delete(key);
    return null;
  }

  function waitForSuggestionSlot(delay, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Address search cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, delay);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  const PRESETS = {
    hq: {
      id: 'hq',
      label: 'J Rides hub',
      address: '7521 Anderson St, Lenexa, KS 66227',
      lat: 38.9786,
      lon: -94.8075,
      kinds: ['pickup', 'dropoff'],
    },
    mci: {
      id: 'mci',
      label: 'MCI Airport',
      address: 'Kansas City International Airport (MCI)',
      lat: 39.2976,
      lon: -94.7139,
      kinds: ['pickup', 'dropoff'],
    },
    loews: {
      id: 'loews',
      label: 'Loews KC',
      address: 'Loews Kansas City Hotel, downtown',
      lat: 39.0983,
      lon: -94.5836,
      kinds: ['pickup', 'dropoff'],
    },
    plaza: {
      id: 'plaza',
      label: 'Country Club Plaza',
      address: 'Country Club Plaza, Kansas City, MO',
      lat: 39.0409,
      lon: -94.5917,
      kinds: ['pickup', 'dropoff'],
    },
    union: {
      id: 'union',
      label: 'Union Station',
      address: 'Union Station, Kansas City, MO',
      lat: 39.0851,
      lon: -94.5855,
      kinds: ['pickup', 'dropoff'],
    },
    crown: {
      id: 'crown',
      label: 'Crown Center',
      address: 'Crown Center, Kansas City, MO',
      lat: 39.0824,
      lon: -94.5808,
      kinds: ['pickup', 'dropoff'],
    },
    power: {
      id: 'power',
      label: 'Power & Light',
      address: 'Power and Light District, Kansas City, MO',
      lat: 39.0975,
      lon: -94.5817,
      kinds: ['pickup', 'dropoff'],
    },
    legends: {
      id: 'legends',
      label: 'Legends Outlets',
      address: 'Kansas City Legends Outlets, Village West',
      lat: 39.1186,
      lon: -94.8272,
      kinds: ['pickup', 'dropoff'],
    },
    op: {
      id: 'op',
      label: 'Overland Park',
      address: 'Corporate Woods, Overland Park, KS',
      lat: 38.9289,
      lon: -94.6813,
      kinds: ['pickup', 'dropoff'],
    },
    downtown_apt: {
      id: 'downtown_apt',
      label: 'Downtown Airport',
      address: 'Charles B. Wheeler Downtown Airport (MKC)',
      lat: 39.1232,
      lon: -94.5926,
      kinds: ['pickup', 'dropoff'],
    },
  };

  function presetsByKind(kind) {
    return Object.values(PRESETS).filter(
      (p) => !kind || (p.kinds || []).includes(kind)
    );
  }

  function haversineMiles(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 3958.8;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function nearbyPresets(lat, lon, kind, limit) {
    const origin = { lat, lon };
    return presetsByKind(kind)
      .map((p) => Object.assign({}, p, { miles: Math.round(haversineMiles(origin, p) * 10) / 10 }))
      .sort((a, b) => a.miles - b.miles)
      .slice(0, limit || 6);
  }

  async function geocode(query) {
    const q = (query || '').trim();
    if (!q) throw new Error('Enter an address');

    const presetHit = Object.values(PRESETS).find(
      (p) =>
        p.label.toLowerCase() === q.toLowerCase() ||
        p.address.toLowerCase() === q.toLowerCase() ||
        p.id === q.toLowerCase()
    );
    if (presetHit) {
      return { lat: presetHit.lat, lon: presetHit.lon, label: presetHit.address };
    }

    const url =
      'https://photon.komoot.io/api/?' +
      new URLSearchParams({
        q,
        lat: String(KC_BIAS.lat),
        lon: String(KC_BIAS.lon),
        limit: '5',
      });

    const res = await fetch(url);
    if (!res.ok) throw new Error('Geocoding unavailable');
    const data = await res.json();
    const features = (data.features || []).filter((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return lat > 38.4 && lat < 39.7 && lon > -95.3 && lon < -93.9;
    });
    const best = features[0] || (data.features || [])[0];
    if (!best) throw new Error('Could not find that address in the KC area');
    const [lon, lat] = best.geometry.coordinates;
    const props = best.properties || {};
    const label =
      [props.name, props.housenumber, props.street, props.city, props.state]
        .filter(Boolean)
        .join(', ') || q;
    return { lat, lon, label };
  }

  async function suggestAddresses(query, { signal } = {}) {
    const q = (query || '').trim();
    if (q.length < 3 || q.length > 320) return [];
    const key = q.toLowerCase();
    if (signal?.aborted) throw new DOMException('Address search cancelled', 'AbortError');
    const cached = cachedSuggestions(key);
    if (cached) return cached;
    if (Date.now() < suggestionsPausedUntil) throw new Error('Address suggestions temporarily unavailable');
    // Waiting searches do not reserve slots: cancelled edits cannot build a queue.
    while (Date.now() - lastSuggestionRequest < 1000) {
      await waitForSuggestionSlot(1000 - (Date.now() - lastSuggestionRequest), signal);
    }
    if (signal?.aborted) throw new DOMException('Address search cancelled', 'AbortError');
    const cachedWhileWaiting = cachedSuggestions(key);
    if (cachedWhileWaiting) return cachedWhileWaiting;
    if (Date.now() < suggestionsPausedUntil) throw new Error('Address suggestions temporarily unavailable');
    const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({
      q,
      lat: String(KC_BIAS.lat),
      lon: String(KC_BIAS.lon),
      limit: '5',
      bbox: '-95.3,38.4,-93.9,39.7',
    });
    lastSuggestionRequest = Date.now();
    const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 429 || res.status === 503) {
      const retry = res.headers.get('Retry-After');
      const retryMs = retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      suggestionsPausedUntil = Date.now() + (Number.isFinite(retryMs)
        ? Math.max(1000, Math.min(retryMs, 60000)) : 30000);
    }
    if (!res.ok) throw new Error('Address suggestions unavailable');
    const data = await res.json();
    const places = [];
    for (const feature of data.features || []) {
      const [lon, lat] = feature?.geometry?.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
          lat <= 38.4 || lat >= 39.7 || lon <= -95.3 || lon >= -93.9) continue;
      const p = feature.properties || {};
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const region = [p.state, p.postcode].filter(Boolean).join(' ');
      const label = [p.name, street, p.city || p.town || p.village, region]
        .filter(Boolean).join(', ');
      if (!label || places.some((place) => place.label === label)) continue;
      places.push({ lat, lon, label });
      if (places.length === 5) break;
    }
    suggestionCache.set(key, { at: Date.now(), places });
    if (suggestionCache.size > 30) suggestionCache.delete(suggestionCache.keys().next().value);
    return places;
  }

  async function reverseGeocode(lat, lon) {
    const url =
      'https://photon.komoot.io/reverse?' +
      new URLSearchParams({
        lat: String(lat),
        lon: String(lon),
      });
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not read that location');
    const data = await res.json();
    const best = (data.features || [])[0];
    if (!best) {
      return {
        lat,
        lon,
        label: lat.toFixed(5) + ', ' + lon.toFixed(5),
      };
    }
    const props = best.properties || {};
    const label =
      [props.name, props.housenumber, props.street, props.city, props.state]
        .filter(Boolean)
        .join(', ') ||
      lat.toFixed(5) + ', ' + lon.toFixed(5);
    return { lat, lon, label };
  }

  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location is not supported in this browser'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        (err) => {
          if (err && err.code === 1) reject(new Error('Location permission denied'));
          else if (err && err.code === 2) reject(new Error('Location unavailable'));
          else if (err && err.code === 3) reject(new Error('Location timed out'));
          else reject(new Error('Could not get your location'));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
      );
    });
  }

  async function locateMe() {
    const pos = await getCurrentPosition();
    // Soft warn if far outside metro — still allow
    const place = await reverseGeocode(pos.lat, pos.lon);
    place.nearby = nearbyPresets(pos.lat, pos.lon, 'pickup', 5);
    place.inMetro =
      pos.lat > 38.4 && pos.lat < 39.7 && pos.lon > -95.3 && pos.lon < -93.9;
    return place;
  }

  async function routeDrive(from, to) {
    const url =
      'https://router.project-osrm.org/route/v1/driving/' +
      from.lon +
      ',' +
      from.lat +
      ';' +
      to.lon +
      ',' +
      to.lat +
      '?overview=false';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Routing unavailable');
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes[0]) {
      throw new Error('No drive route found');
    }
    const r = data.routes[0];
    const miles = r.distance / 1609.344;
    const minutes = r.duration / 60;
    return {
      miles: Math.round(miles * 10) / 10,
      minutes: Math.max(1, Math.round(minutes)),
      from,
      to,
    };
  }

  async function estimateTrip(pickupQuery, dropoffQuery, selected = {}) {
    const [from, to] = await Promise.all([
      selected.from || geocode(pickupQuery),
      selected.to || geocode(dropoffQuery),
    ]);
    const trip = await routeDrive(from, to);
    return trip;
  }

  global.JRidesRouting = {
    PRESETS,
    presetsByKind,
    nearbyPresets,
    geocode,
    suggestAddresses,
    reverseGeocode,
    locateMe,
    routeDrive,
    estimateTrip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
