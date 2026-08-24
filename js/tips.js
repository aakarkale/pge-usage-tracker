/* ============================================================================
 * tips.js — Actionable, quantified saving tips.
 *
 * analyze.js produces the raw numbers and generic insights; tips.js turns them
 * into specific, hour-aware recommendations, and gets sharper when optional
 * signals are present:
 *   • weather  — hourly temperature joined to usage (from weather.js)
 *   • profile  — what the household actually has (AC, EV, pool pump, …)
 *   • annotations — user labels on days/events ("away", "EV charging", …)
 *   • billing  — the billing cycle, for bill projection
 *
 * Everything is recomputed cheaply, so the UI can regenerate tips instantly
 * whenever the user adds weather or answers a question.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var fmt = App.fmt;
  var S = App.stats;

  function round0(v) { return Math.round(v); }
  function peakSaving(shiftKwhPerDay, rates) {
    if (!rates || !rates.detected) return 0;
    return round0(shiftKwhPerDay * (rates.peakRate - rates.offPeakRate) * 365);
  }

  /* Off-peak hours = complement of detected peak hours. */
  function offPeakWindowLabel(rates) {
    if (!rates.detected || !rates.peakHours.length) return "overnight hours";
    var end = (rates.peakHours[rates.peakHours.length - 1] + 1) % 24;
    return "after " + fmt.hour12(end);
  }

  /* ---- weather-derived helpers ----------------------------------------- */

  function weatherTips(analysis, weather, tips) {
    if (!weather || !weather.daily || !weather.daily.length) return;
    var rates = analysis.rates;
    var unit = analysis.unit;

    // Correlation of daily usage with daily high temperature.
    var us = [], tmax = [];
    weather.daily.forEach(function (w) {
      if (w.usage != null && w.tMax != null) { us.push(w.usage); tmax.push(w.tMax); }
    });
    var corr = S.correlation(tmax, us);

    // Split days into hot vs mild by the 70th percentile of daily highs.
    var highs = weather.daily.map(function (w) { return w.tMax; }).filter(function (v) { return v != null; });
    var hotThresh = S.quantile(highs, 0.7);
    var hot = weather.daily.filter(function (w) { return w.tMax != null && w.tMax >= hotThresh; });
    var mild = weather.daily.filter(function (w) { return w.tMax != null && w.tMax < hotThresh; });
    var hotPeak = S.mean(hot.map(function (w) { return w.peakUsage || 0; }));
    var mildPeak = S.mean(mild.map(function (w) { return w.peakUsage || 0; }));
    var hotDayMean = S.mean(hot.map(function (w) { return w.usage; }));
    var mildDayMean = S.mean(mild.map(function (w) { return w.usage; }));

    if (corr >= 0.45) {
      // Cooling-driven home.
      var extraPerHotDay = Math.max(0, hotDayMean - mildDayMean);
      tips.push({
        icon: "🌡️", category: "weather", priority: 1,
        title: "Your usage is cooling-driven — pre-cool before the peak",
        savings: rates.detected ? peakSaving(Math.max(0, (hotPeak - mildPeak) * 0.5), rates) : 0,
        body: "Daily use tracks the outdoor high (correlation " + fmt.num(corr, 2) + "). On the hottest days (≥ " +
          fmt.num(hotThresh, 0) + "°F) you use about " + fmt.num(extraPerHotDay, 1) + " " + unit +
          " more than on mild days" +
          (rates.detected && hotPeak > mildPeak
            ? ", and your " + rates.peakWindowLabel + " peak-window usage jumps from " +
              fmt.num(mildPeak, 1) + " to " + fmt.num(hotPeak, 1) + " " + unit
            : "") +
          ". Pre-cool the house to ~68°F before " + (rates.detected ? fmt.hour12(rates.peakHours[0]) : "4 PM") +
          ", then let the thermostat drift up to 78°F during peak hours. You get the same comfort but move the " +
          "heavy AC draw into cheaper time."
      });

      // Bay-Area night flush — cool nights are a free resource.
      var nightLow = S.mean(weather.daily.map(function (w) { return w.tMin; }).filter(function (v) { return v != null; }));
      if (nightLow != null && nightLow <= 65) {
        tips.push({
          icon: "🪟", category: "weather", priority: 2,
          title: "Cool nights are free air-conditioning",
          body: "Overnight lows average about " + fmt.num(nightLow, 0) + "°F. Open windows or run a whole-house / " +
            "box fan overnight to flush heat, then close up and draw the shades by mid-morning. Homes that do this " +
            "often cut afternoon AC runtime substantially with zero equipment cost."
        });
      }
    } else if (corr <= 0.2) {
      tips.push({
        icon: "🔌", category: "weather", priority: 2,
        title: "Cooling isn't your main lever",
        body: "Your usage barely tracks the weather (correlation " + fmt.num(corr, 2) + "), so air conditioning " +
          "isn't the big story here. Focus your effort on the always-on baseline and specific appliance spikes " +
          "below rather than thermostat tweaks."
      });
    }
  }

  /* ---- context / profile-derived helpers ------------------------------- */

  function profileTips(analysis, profile, tips) {
    if (!profile) return;
    var rates = analysis.rates;
    var unit = analysis.unit;
    var peakUsage = analysis.peak ? analysis.peak.avgDailyPeakUsage : 0;

    if (profile.ev) {
      var lateSpike = (analysis.byHod || []).some(function (b) {
        return (b.hod >= 22 || b.hod <= 1) && b.mean > analysis.totals.avgDailyUsage / 24 * 1.6;
      });
      tips.push({
        icon: "🚗", category: "appliance", priority: 1,
        title: lateSpike ? "Your EV charging looks well-timed" : "Schedule EV charging after peak",
        savings: rates.detected && !lateSpike ? peakSaving(6, rates) : 0,
        body: lateSpike
          ? "You reported an EV, and there are recurring late-night spikes — that's charging landing in the " +
            "cheapest window. Nicely done. Just confirm your charger/app is set to start after " +
            (rates.detected ? fmt.hour12((rates.peakHours[rates.peakHours.length - 1] + 1) % 24) : "9 PM") + "."
          : "You reported an EV. Set your charger or car to start charging " + offPeakWindowLabel(rates) +
            ". A typical EV adds 6–10 " + unit + "/day; keeping that out of the " +
            (rates.detected ? rates.peakWindowLabel + " peak" : "peak window") +
            " is one of the biggest single savings you can lock in."
      });
    }

    if (profile.pool) {
      tips.push({
        icon: "🏊", category: "appliance", priority: 2,
        title: "Run the pool pump off-peak",
        savings: rates.detected ? peakSaving(2.5, rates) : 0,
        body: "Pool pumps are pure flexible load. Set the timer to run entirely " + offPeakWindowLabel(rates) +
          " and consider trimming total runtime to 6–8 hrs/day in summer — a variable-speed pump on a low setting " +
          "uses a fraction of the energy of a single-speed pump."
      });
    }

    if (profile.acType === "central" || profile.acType === "heatpump") {
      tips.push({
        icon: "❄️", category: "appliance", priority: 2,
        title: "Get a smart thermostat schedule going",
        body: "With central " + (profile.acType === "heatpump" ? "heat-pump " : "") + "cooling, a scheduled " +
          "setback is the highest-leverage change: pre-cool before peak, ease to 78°F during " +
          (rates.detected ? rates.peakWindowLabel : "4–9 PM") + ", and let it rise while you're out. Also swap the " +
          "filter — a clogged filter makes the system run longer for the same comfort."
      });
    } else if (profile.acType === "window") {
      tips.push({
        icon: "❄️", category: "appliance", priority: 3,
        title: "Cool only the room you're in",
        body: "Window units are cheapest when zoned: cool the occupied room, close its door, and use a timer so it " +
          "isn't running against an empty room during the pricey " +
          (rates.detected ? rates.peakWindowLabel + " window" : "late afternoon") + "."
      });
    }

    if (profile.dryer) {
      tips.push({
        icon: "🧺", category: "appliance", priority: 3,
        title: "Batch laundry into off-peak blocks",
        savings: rates.detected ? peakSaving(1.5, rates) : 0,
        body: "An electric dryer is a big, brief load. Run it (and the dishwasher's heated-dry cycle) " +
          offPeakWindowLabel(rates) + " and dry loads back-to-back to reuse residual drum heat."
      });
    }
  }

  function annotationTips(analysis, annotations, tips) {
    if (!annotations) return;
    var away = [];
    Object.keys(annotations).forEach(function (k) {
      if (annotations[k] && annotations[k].away) away.push(k);
    });
    if (away.length) {
      // Estimate the true always-on floor from away days.
      var awayUsage = analysis.daily
        .filter(function (d) { return annotations[d.dateKey] && annotations[d.dateKey].away; })
        .map(function (d) { return d.usage; });
      if (awayUsage.length) {
        var floor = S.median(awayUsage);
        var rate = analysis.rates.offPeakRate || analysis.rates.avgRate || 0;
        tips.push({
          icon: "🧳", category: "phantom", priority: 1,
          title: "Your true baseline (measured while you were away)",
          savings: round0(floor * rate * 365 * 0.4),
          body: "On the " + away.length + " day" + (away.length > 1 ? "s" : "") + " you marked as away, the home still " +
            "drew about " + fmt.num(floor, 1) + " " + analysis.unit + "/day — roughly " +
            fmt.usd(floor * rate * 30.44) + "/month with nobody home. That's your phantom floor: fridge, networking " +
            "gear, and standby electronics. Smart power strips on entertainment and office clusters can typically " +
            "reclaim ~40% of it."
        });
      }
    }
  }

  /* ---- billing projection ---------------------------------------------- */

  function billingTips(analysis, billing, tips) {
    if (!billing || !billing.cycles || !billing.cycles.length) return;
    var current = billing.cycles[billing.cycles.length - 1];
    if (current && current.partial && current.daysElapsed >= 2) {
      var projected = current.projectedCost;
      tips.push({
        icon: "🧾", category: "billing", priority: 1,
        title: "Projected bill for your current cycle",
        body: "You're " + current.daysElapsed + " days into the cycle that began " +
          fmt.dateMed(current.start) + " (" + fmt.usd(current.costToDate) + " so far). At your current run-rate, " +
          "this cycle is tracking toward about " + fmt.usd(projected) + ". Trimming peak-window use in the days " +
          "left is the fastest way to bend that number down."
      });
    }
  }

  /* ---- data-only, hour-aware core tips --------------------------------- */

  function coreTips(analysis, tips) {
    var rates = analysis.rates;
    var unit = analysis.unit;
    var byHod = analysis.byHod;

    if (analysis.fuel === "gas") {
      tips.push({
        icon: "🚿", category: "behavior", priority: 2,
        title: "Summer gas is mostly hot water",
        body: "With daily gas this low, your therms are almost entirely water heating. Turning the tank down to " +
          "120°F, insulating the first few feet of hot-water pipe, and shorter showers are the levers here — small " +
          "in summer, but they compound once winter heating starts."
      });
      return;
    }

    if (!byHod) return;
    var avgHourly = analysis.totals.avgDailyUsage / 24;

    // The single biggest lever: peak-window load-shifting.
    if (rates.detected && analysis.peak) {
      var shiftable = analysis.peak.avgDailyPeakUsage * 0.35;
      tips.push({
        icon: "⏰", category: "peak", priority: 1,
        title: "Shift flexible loads out of the " + rates.peakWindowLabel + " window",
        savings: peakSaving(shiftable, rates),
        body: "Peak power costs " + fmt.usd(rates.peakRate, 2) + "/" + unit + " vs " + fmt.usd(rates.offPeakRate, 2) +
          " off-peak — a " + fmt.pct(rates.premiumPct) + " premium. You currently average " +
          fmt.num(analysis.peak.avgDailyPeakUsage, 1) + " " + unit + " during peak each day. Moving even the " +
          "flexible third of it (dishwasher, laundry, EV, pool pump) to " + offPeakWindowLabel(rates) +
          " is worth roughly " + fmt.usd(peakSaving(shiftable, rates)) + "/yr — no comfort lost."
      });
    }

    // Phantom / always-on baseline.
    if (analysis.baseline && analysis.baseline.overnight > 0) {
      tips.push({
        icon: "👻", category: "phantom", priority: 1,
        title: "Hunt down always-on \"phantom\" load",
        savings: analysis.savings.phantom,
        body: "Your quietest hours still pull about " + fmt.num(analysis.baseline.overnight, 2) + " " + unit +
          "/hr — roughly " + fmt.usd(analysis.baseline.monthlyCost) + "/month that runs whether you're awake or not. " +
          "Walk the house at night: look for glowing standby lights, an old second fridge in the garage, a " +
          "always-on gaming console or cable box, and put clusters on smart power strips."
      });
    }

    // Identify cheapest run-window.
    if (rates.detected) {
      tips.push({
        icon: "💡", category: "load-shift", priority: 2,
        title: "Your cheapest hours to run anything heavy",
        body: "Any time " + offPeakWindowLabel(rates) + " (through the next afternoon) you pay the lower " +
          fmt.usd(rates.offPeakRate, 2) + "/" + unit + " rate. Put timers on the water heater, dishwasher, and any " +
          "charging so they do their work then instead of during the 4–9 PM crunch."
      });
    }

    // Late-evening spike pattern (very common in this data set).
    var eveningPeak = null;
    for (var h = 21; h <= 23; h++) {
      if (byHod[h] && byHod[h].mean > avgHourly * 1.8) { eveningPeak = byHod[h]; break; }
    }
    if (eveningPeak) {
      tips.push({
        icon: "🌙", category: "behavior", priority: 3,
        title: "Big late-evening ramp around " + fmt.hour12(eveningPeak.hod),
        body: "Usage climbs to about " + fmt.num(eveningPeak.mean, 2) + " " + unit + "/hr near " +
          fmt.hour12(eveningPeak.hod) + " — well above your " + fmt.num(avgHourly, 2) + " " + unit +
          "/hr average. That's after peak pricing, so it's not costing you a premium, but if it's the dryer or " +
          "dishwasher you could push it slightly later and let it run overnight on the cheapest rate."
      });
    }
  }

  /*
   * Compose the full tip list. `ctx` fields are all optional.
   */
  function generate(analysis, ctx) {
    ctx = ctx || {};
    var tips = [];
    coreTips(analysis, tips);
    weatherTips(analysis, ctx.weather, tips);
    profileTips(analysis, ctx.profile, tips);
    annotationTips(analysis, ctx.annotations, tips);
    billingTips(analysis, ctx.billing, tips);

    // De-dup by title, keep the richest (with savings) first, then by priority.
    var seen = {};
    tips = tips.filter(function (t) {
      if (seen[t.title]) return false;
      seen[t.title] = true;
      return true;
    });
    tips.sort(function (a, b) {
      var sa = a.savings || 0, sb = b.savings || 0;
      if ((sb > 0) !== (sa > 0)) return (sb > 0) - (sa > 0);
      if (a.priority !== b.priority) return a.priority - b.priority;
      return sb - sa;
    });
    return tips;
  }

  App.tips = { generate: generate, peakSaving: peakSaving };
})(window.App = window.App || {});
