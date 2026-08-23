/**
 * Near-live market layer for competitor estimates.
 * Combines:
 *  - America/Chicago time-of-day demand curve
 *  - Airport fee flag
 *  - EMA calibration from manual Uber/Lyft app samples
 */
(function (global) {
  const STORAGE_KEY = 'jrides.liveSamples.v1';
  const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const TZ = 'America/Chicago';

  function chicagoParts(date) {
    const d = date || new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const weekday = parts.find((p) => p.type === 'weekday').value;
    let hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    if (hour === 24) hour = 0;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { day: dayMap[weekday], hour };
  }

  /**
   * Baseline demand multiplier for KC metro (proxy for surge / upfront markup).
   * Tuned for typical patterns; samples override via EMA.
   */
  function baseDemandMultiplier(date) {
    const { day, hour } = chicagoParts(date);
    const weekend = day === 0 || day === 6;
    let m = 1;

    // Weekday commute
    if (!weekend && ((hour >= 7 && hour < 9) || (hour >= 16 && hour < 19))) m = 1.25;
    // Friday evening
    else if (day === 5 && hour >= 17 && hour < 22) m = 1.35;
    // Sat night / Sun early
    else if ((day === 5 || day === 6) && (hour >= 21 || hour < 2)) m = 1.55;
    // Weekend daytime
    else if (weekend && hour >= 10 && hour < 18) m = 1.12;
    // Late night midweek
    else if (!weekend && (hour >= 22 || hour < 5)) m = 1.18;
    // Lunch
    else if (!weekend && hour >= 11 && hour < 14) m = 1.08;

    return Math.round(m * 100) / 100;
  }

  function loadSamples() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      const cutoff = Date.now() - MAX_AGE_MS;
      return (list || []).filter((s) => s && s.at >= cutoff);
    } catch (e) {
      return [];
    }
  }

  function saveSamples(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 200)));
  }

  function addSample(sample) {
    const list = loadSamples();
    list.unshift(
      Object.assign(
        {
          id: 's_' + Date.now().toString(36),
          at: Date.now(),
        },
        sample
      )
    );
    saveSamples(list);
    return list;
  }

  function clearSamples() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function predictedBase(providerKey, miles, minutes, airportFee) {
    const { quoteCompetitor } = global.JRidesPricing;
    const q = quoteCompetitor(providerKey, miles, minutes, {
      surge: 1,
      airportFee: !!airportFee,
    });
    return q.price;
  }

  /**
   * EMA of observed/predicted for Uber Premier + Lyft Extra Comfort.
   */
  function calibration(samples) {
    const now = Date.now();
    let uberNum = 0,
      uberDen = 0,
      lyftNum = 0,
      lyftDen = 0;
    let newest = 0;

    samples.forEach((s) => {
      const ageH = (now - s.at) / 3600000;
      const w = Math.exp(-ageH / 36); // half-life ~25h emphasis on last day
      if (s.at > newest) newest = s.at;

      if (s.uberPrice > 0 && s.miles > 0) {
        const pred = predictedBase('uber_premier', s.miles, s.minutes, s.airport);
        if (pred > 0) {
          uberNum += w * (s.uberPrice / pred);
          uberDen += w;
        }
      }
      if (s.lyftPrice > 0 && s.miles > 0) {
        const pred = predictedBase('lyft_comfort', s.miles, s.minutes, s.airport);
        if (pred > 0) {
          lyftNum += w * (s.lyftPrice / pred);
          lyftDen += w;
        }
      }
    });

    const clamp = (x) => Math.min(2.8, Math.max(0.85, x));
    return {
      uberFactor: uberDen ? clamp(uberNum / uberDen) : 1,
      lyftFactor: lyftDen ? clamp(lyftNum / lyftDen) : 1,
      sampleCount: samples.length,
      newestAt: newest || null,
    };
  }

  function looksLikeAirport(trip) {
    if (!trip) return false;
    const blob = JSON.stringify(trip).toLowerCase();
    return (
      blob.includes('mci') ||
      blob.includes('airport') ||
      blob.includes('international') ||
      (trip.to && trip.to.lat > 39.25 && trip.to.lat < 39.35 && trip.to.lon > -94.76 && trip.to.lon < -94.68) ||
      (trip.from && trip.from.lat > 39.25 && trip.from.lat < 39.35 && trip.from.lon > -94.76 && trip.from.lon < -94.68)
    );
  }

  function snapshot(options) {
    const opts = options || {};
    const when = opts.when || new Date();
    const samples = loadSamples();
    const cal = calibration(samples);
    const demand = baseDemandMultiplier(when);
    const airportFee = opts.airportFee != null ? opts.airportFee : looksLikeAirport(opts.trip);

    // Blend: time-of-day demand × sample calibration
    // If no samples, demand alone is the near-live signal.
    const uberSurge = Math.round(demand * cal.uberFactor * 100) / 100;
    const lyftSurge = Math.round(demand * cal.lyftFactor * 100) / 100;

    let source = 'rate-card+demand';
    let label = 'Near-live · KC rate card + ' + demand.toFixed(2) + '× demand now';
    if (cal.sampleCount > 0) {
      source = 'rate-card+demand+samples';
      const mins = Math.max(1, Math.round((Date.now() - cal.newestAt) / 60000));
      const age =
        mins < 60 ? mins + 'm ago' : Math.round(mins / 60) + 'h ago';
      label =
        'Near-live · calibrated from ' +
        cal.sampleCount +
        ' app sample' +
        (cal.sampleCount === 1 ? '' : 's') +
        ' (latest ' +
        age +
        ')';
    }

    return {
      uberSurge,
      lyftSurge,
      demand,
      airportFee,
      calibration: cal,
      source,
      label,
      asOf: when.toISOString(),
      timezone: TZ,
    };
  }

  global.JRidesLiveMarket = {
    STORAGE_KEY,
    baseDemandMultiplier,
    loadSamples,
    saveSamples,
    addSample,
    clearSamples,
    calibration,
    snapshot,
    looksLikeAirport,
  };
})(typeof window !== 'undefined' ? window : globalThis);
