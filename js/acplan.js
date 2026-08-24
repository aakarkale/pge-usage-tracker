/* ============================================================================
 * acplan.js — The AC playbook: a concrete thermostat schedule for this house,
 * this rate plan, and this week's weather.
 *
 * The idea in one line: your house is a cooler. Chill it while power is cheap,
 * then keep the lid shut while power is expensive. Same comfort, lower bill.
 *
 * Three inputs decide the numbers:
 *   1. The peak window + rate spread detected from the user's own cost column.
 *   2. The upcoming daily highs — how hard the house has to be pre-cooled.
 *   3. The upcoming overnight lows — whether outside air is free cooling.
 *
 * Setpoints are per-band rather than a formula so the advice stays inside
 * temperatures people will actually tolerate; an aggressive "optimum" that
 * gets overridden on day two saves nothing.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var fmt = App.fmt, S = App.stats;

  /* Comfort bands keyed on the day's forecast high (°F). */
  var BANDS = [
    { key: "off", max: 78, name: "Under 78°",
      precool: null, peak: null, wake: 78, sleep: 76,
      action: "Skip AC entirely — the night flush handles it.",
      meaning: "Windows do the work — leave the AC off" },
    { key: "standard", max: 88, name: "78° to 88°",
      precool: 72, peak: 78, wake: 76, sleep: 74,
      action: "Standard schedule — 72° pre-cool, 78° through peak.",
      meaning: "Your default — most days land here" },
    { key: "hot", max: 95, name: "88° to 95°",
      precool: 70, peak: 77, wake: 75, sleep: 74,
      action: "Pre-cool harder — 70° pre-cool, 77° through peak.",
      meaning: "Chill deeper early, hold higher at peak" },
    { key: "extreme", max: Infinity, name: "Above 95°",
      precool: 68, peak: 76, wake: 74, sleep: 73,
      action: "Heat event — 68° pre-cool, 76° through peak.",
      meaning: "Comfort first — the bill will run higher" }
  ];

  function bandFor(high) {
    // A non-finite high must not fall through to the hottest band.
    if (typeof high !== "number" || !isFinite(high)) return BANDS[1];
    for (var i = 0; i < BANDS.length; i++) {
      if (high < BANDS[i].max) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  function hoursBefore(hour, n) { return ((hour - n) % 24 + 24) % 24; }

  /*
   * Estimate what a season of load-shifting is worth. We only count the peak
   * window usage that plausibly belongs to cooling: the gap between what the
   * house draws on hot days versus mild days. That is far more honest than
   * assuming a flat share of the whole bill is shiftable.
   */
  function estimateSavings(analysis, weather) {
    var rates = analysis.rates;
    if (!rates.detected || !analysis.peak) return 0;
    var spread = rates.peakRate - rates.offPeakRate;
    if (spread <= 0) return 0;

    var coolingPeakKwh = analysis.peak.avgDailyPeakUsage * 0.4; // fallback share
    if (weather && weather.available && weather.daily && weather.daily.length && weather.hotThresh != null) {
      var hot = [], mild = [];
      weather.daily.forEach(function (d) {
        if (d.tMax == null) return;
        (d.tMax >= weather.hotThresh ? hot : mild).push(d.peakUsage || 0);
      });
      if (hot.length >= 2 && mild.length >= 2) {
        var delta = S.mean(hot) - S.mean(mild);
        if (delta > 0) coolingPeakKwh = delta;
      }
    }
    // Pre-cooling moves most, not all, of that load out of the peak window.
    var shifted = coolingPeakKwh * 0.7;
    return Math.round(shifted * spread * 120); // ~120 cooling days a year
  }

  /*
   * Build the playbook. Returns { available:false, reason } when there is not
   * enough information, so the UI can show a precise prompt instead of guesses.
   */
  function generate(analysis, weather, profile) {
    if (analysis.fuel !== "electric" || analysis.granularity !== "hourly") {
      return { available: false, reason: "The AC playbook works from hourly electricity data." };
    }
    if (!weather || !weather.forecast || !weather.forecast.length) {
      return { available: false, reason: "Add your ZIP code to pull the local forecast." };
    }
    if (profile && profile.acType === "none") {
      return { available: false, reason: "no-ac", place: weather.place };
    }

    var rates = analysis.rates;
    var peakStart = rates.detected ? rates.peakHours[0] : 16;
    var peakEndHour = rates.detected
      ? (rates.peakHours[rates.peakHours.length - 1] + 1) % 24
      : 21;
    var precoolHour = hoursBefore(peakStart, 3);
    var wakeHour = 6;

    var days = weather.forecast.filter(function (d) {
      return typeof d.tMax === "number" && isFinite(d.tMax) &&
             typeof d.tMin === "number" && isFinite(d.tMin);
    });
    if (!days.length) {
      return { available: false, reason: "The forecast came back without usable temperatures." };
    }
    var highs = days.map(function (d) { return d.tMax; });
    var lows = days.map(function (d) { return d.tMin; });
    var medHigh = S.median(highs);
    var avgLow = S.mean(lows);

    // The headline schedule follows the band most of the week falls into.
    var counts = {};
    days.forEach(function (d) {
      var k = bandFor(d.tMax).key;
      counts[k] = (counts[k] || 0) + 1;
    });
    // BANDS runs coolest -> hottest, so ">=" breaks count ties toward the hotter
    // band. Folding over BANDS (not Object.keys) also keeps the result
    // independent of the order the days happen to appear in the forecast.
    var typicalKey = BANDS.reduce(function (a, b) {
      return (counts[b.key] || 0) >= (counts[a.key] || 0) ? b : a;
    }).key;
    var typical = BANDS.filter(function (b) { return b.key === typicalKey; })[0] || bandFor(medHigh);
    // A week of genuinely mild days still needs a fallback schedule to show.
    var scheduleBand = typical.precool == null ? BANDS[1] : typical;

    var schedule = [
      { period: "Wake", hour: wakeHour, temp: scheduleBand.wake,
        note: "Coast on last night's cool air" },
      { period: "Pre-cool", hour: precoolHour, temp: scheduleBand.precool, key: true,
        note: "Chill the house while power is cheap" },
      { period: "Peak", hour: peakStart, temp: scheduleBand.peak, key: true,
        note: "Keep the lid shut — AC mostly rests" },
      { period: "Evening", hour: peakEndHour, temp: scheduleBand.sleep,
        note: "Cheap power returns" }
    ];

    // Night flush: outside air colder than the setpoint is free air conditioning.
    var flushGap = scheduleBand.sleep - avgLow;
    var nightFlush = {
      applicable: flushGap >= 6,
      gap: flushGap,
      avgLow: avgLow,
      minLow: S.min(lows),
      maxLow: S.max(lows),
      // Applicability is judged on the mean (a mostly-cool week is still worth
      // flushing), but the copy must not claim a range it doesn't have.
      allUnder: S.max(lows) < scheduleBand.sleep,
      setpoint: scheduleBand.sleep,
      openHour: peakEndHour,
      closeHour: 8
    };

    // Does their own data show morning cooling the night flush could erase?
    var morningLoad = null;
    if (analysis.byHod) {
      var avgHourly = analysis.totals.avgDailyUsage / 24;
      var m = [];
      for (var h = 8; h <= 11; h++) if (analysis.byHod[h]) m.push(analysis.byHod[h].mean);
      var mMean = S.mean(m);
      if (mMean > avgHourly * 1.15) {
        morningLoad = { mean: mMean, vsAvgPct: (mMean / avgHourly - 1) * 100 };
      }
    }

    var dayRows = days.map(function (d) {
      var b = bandFor(d.tMax);
      return {
        date: d.date, tMax: d.tMax, tMin: d.tMin, code: d.code,
        band: b.key, bandName: b.name, action: b.action,
        precool: b.precool, peak: b.peak
      };
    });

    var hotDays = dayRows.filter(function (r) { return r.band === "hot" || r.band === "extreme"; });
    var offDays = dayRows.filter(function (r) { return r.band === "off"; });

    return {
      available: true,
      place: weather.place,
      unit: weather.unit || "°F",
      current: weather.current,
      rates: {
        detected: rates.detected,
        peakRate: rates.peakRate, offPeakRate: rates.offPeakRate,
        premiumPct: rates.premiumPct,
        windowLabel: rates.peakWindowLabel ||
          (fmt.hour12(peakStart) + "–" + fmt.hour12(peakEndHour))
      },
      peakStart: peakStart, peakEnd: peakEndHour, precoolHour: precoolHour,
      scheduleBand: scheduleBand,
      schedule: schedule,
      days: days,
      dayRows: dayRows,
      bands: BANDS,
      medHigh: medHigh, avgLow: avgLow,
      hotDayCount: hotDays.length, offDayCount: offDays.length,
      nightFlush: nightFlush,
      morningLoad: morningLoad,
      savings: estimateSavings(analysis, weather),
      habits: [
        { icon: "🪟", text: "Close blinds on west and south windows by noon. Afternoon sun through glass is a big share of what you pay to remove at 5 PM." },
        { icon: "🌀", text: "Leave the fan switch on Auto. Air stopping between cycles is correct — On runs the blower all day for nothing." }
      ],
      caution: "Going from a steady " + (scheduleBand.peak - 4) + "° to " + scheduleBand.peak +
        "° for the peak hours is a real comfort change, not a rounding error. If " + scheduleBand.peak +
        "° is too warm, use " + (scheduleBand.peak - 1) + "° and keep most of the benefit — this only " +
        "works if you actually stick with it."
    };
  }

  App.acplan = { generate: generate, bandFor: bandFor, BANDS: BANDS };
})(window.App = window.App || {});
