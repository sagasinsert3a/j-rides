/**
 * J Rides pricing + near-live competitor estimates for Kansas City.
 *
 * Customer compare: Uber Premier + Lyft Extra Comfort.
 * Near-live stack: rate models + demand curve + app-sample calibration.
 * Do not call Uber/Lyft APIs for competitor comparison.
 */
(function (global) {
  // Tuned to undercut Uber Premier while keeping margin (not racing Lyft Comfort).
  const JRIDES_RATES = {
    base_fare: 5.0,
    per_mile_rate: 2.05,
    per_minute_rate: 0.42,
    minimum_fare: 12.0,
    booking_fee: 2.0,
  };

  const KC_RATE_CARDS = {
    uber_x: {
      key: 'uber_x',
      label: 'UberX',
      tier: 'economy',
      provider: 'Uber',
      base_fare: 1.7,
      per_mile_rate: 0.87,
      per_minute_rate: 0.16,
      minimum_fare: 6.56,
      booking_fee: 3.1,
      airport_fee: 3.0,
    },
    uber_premier: {
      key: 'uber_premier',
      label: 'Uber Premier',
      tier: 'premier',
      provider: 'Uber',
      // Premier-class model — tighten via admin-samples.html from live app quotes
      base_fare: 5.5,
      per_mile_rate: 2.45,
      per_minute_rate: 0.55,
      minimum_fare: 15.0,
      booking_fee: 3.25,
      airport_fee: 3.0,
    },
    lyft: {
      key: 'lyft',
      label: 'Lyft',
      tier: 'economy',
      provider: 'Lyft',
      base_fare: 1.25,
      per_mile_rate: 1.03,
      per_minute_rate: 0.17,
      minimum_fare: 3.77,
      booking_fee: 2.15,
      airport_fee: 3.0,
    },
    lyft_comfort: {
      key: 'lyft_comfort',
      label: 'Lyft Extra Comfort',
      tier: 'comfort',
      provider: 'Lyft',
      base_fare: 2.61,
      per_mile_rate: 1.15,
      per_minute_rate: 0.28,
      minimum_fare: 10.0,
      booking_fee: 2.9,
      airport_fee: 3.0,
    },
  };

  const COMPETITOR_RATES = {
    uber_premier: KC_RATE_CARDS.uber_premier,
    lyft_comfort: KC_RATE_CARDS.lyft_comfort,
  };

  function roundMoney(n) {
    return Math.round(n * 100) / 100;
  }

  function quoteFromRates(miles, minutes, rates, opts) {
    const o = opts || {};
    const surge = o.surge != null ? o.surge : 1;
    const airport = o.airportFee ? rates.airport_fee || 0 : 0;
    const mileage = rates.per_mile_rate * miles;
    const time = rates.per_minute_rate * minutes;
    const preSurge = rates.base_fare + mileage + time + rates.booking_fee;
    const subtotal = preSurge * surge + airport;
    const floor = (rates.minimum_fare || 0) * Math.max(1, surge * 0.85);
    const appliedMin = subtotal < floor;
    const price = roundMoney(Math.max(subtotal, floor));
    return {
      price,
      appliedMin,
      surge: roundMoney(surge),
      airportFee: airport,
      parts: {
        base_fare: rates.base_fare,
        mileage: roundMoney(mileage),
        time: roundMoney(time),
        booking_fee: rates.booking_fee,
        pre_surge: roundMoney(preSurge),
        subtotal: roundMoney(subtotal),
        minimum_fare: rates.minimum_fare,
      },
    };
  }

  function quoteJRides(miles, minutes, rateOverrides) {
    const rates = Object.assign({}, JRIDES_RATES, rateOverrides || {});
    return quoteFromRates(miles, minutes, rates, { surge: 1, airportFee: false });
  }

  function quoteCompetitor(key, miles, minutes, opts) {
    const rates = KC_RATE_CARDS[key] || COMPETITOR_RATES[key];
    if (!rates) throw new Error('Unknown competitor: ' + key);
    return Object.assign(
      { key: rates.key || key, label: rates.label, provider: rates.provider, tier: rates.tier },
      quoteFromRates(miles, minutes, rates, opts)
    );
  }

  function money(n) {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toFixed(2);
  }

  function compareQuote(miles, minutes, options) {
    const opts = options || {};
    const market = opts.market || {
      uberSurge: 1,
      lyftSurge: 1,
      airportFee: false,
      source: 'rate-card',
      label: 'KC rate card (off-peak)',
    };

    const j = quoteJRides(miles, minutes, opts.jridesRates);
    const uber = quoteCompetitor('uber_premier', miles, minutes, {
      surge: market.uberSurge,
      airportFee: market.airportFee,
    });
    const lyft = quoteCompetitor('lyft_comfort', miles, minutes, {
      surge: market.lyftSurge,
      airportFee: market.airportFee,
    });
    const uberX = quoteCompetitor('uber_x', miles, minutes, {
      surge: market.uberSurge,
      airportFee: market.airportFee,
    });
    const lyftStd = quoteCompetitor('lyft', miles, minutes, {
      surge: market.lyftSurge,
      airportFee: market.airportFee,
    });

    const vsUber = roundMoney(uber.price - j.price);
    const vsLyft = roundMoney(lyft.price - j.price);
    const bestAlt = Math.min(uber.price, lyft.price);
    const avgAlt = roundMoney((uber.price + lyft.price) / 2);
    const saveVsBest = roundMoney(bestAlt - j.price);
    const saveVsAvg = roundMoney(avgAlt - j.price);
    const savePctVsBest =
      bestAlt > 0 ? Math.round((saveVsBest / bestAlt) * 100) : 0;
    const savePctVsAvg =
      avgAlt > 0 ? Math.round((saveVsAvg / avgAlt) * 100) : 0;

    return {
      miles: roundMoney(miles),
      minutes: Math.round(minutes),
      jrides: j,
      uber,
      lyft,
      uberX,
      lyftStd,
      market,
      savings: {
        vsUber,
        vsLyft,
        vsBest: saveVsBest,
        vsAvg: saveVsAvg,
        pctVsBest: savePctVsBest,
        pctVsAvg: savePctVsAvg,
        cheaperThanUber: vsUber > 0,
        cheaperThanLyft: vsLyft > 0,
      },
      disclaimer:
        'Uber Premier & Lyft Extra Comfort are estimates based on local rate models and recent market conditions. App prices can move with demand; your J Rides price stays locked.',
    };
  }

  global.JRidesPricing = {
    JRIDES_RATES,
    KC_RATE_CARDS,
    COMPETITOR_RATES,
    quoteJRides,
    quoteCompetitor,
    compareQuote,
    money,
    quoteFromRates,
  };
})(typeof window !== 'undefined' ? window : globalThis);
