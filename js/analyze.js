/* ============================================================================
 * analyze.js — The analytics / "AI" engine.
 *
 * Everything here runs locally in the browser. Given a parsed dataset it:
 *   1. Builds daily & hour-of-day aggregates.
 *   2. Auto-detects the Time-of-Use (TOU) rate structure from the cost column.
 *   3. Estimates the always-on ("phantom") baseline load.
 *   4. Detects daily and hourly anomalies with robust (median/MAD) statistics.
 *   5. Measures the trend across the period and weekday/weekend behaviour.
 *   6. Turns all of the above into ranked events, plain-English insights, and
 *      concrete dollar-savings opportunities.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var S = App.stats;

  /* ---- helpers ---------------------------------------------------------- */

  function round(v, d) {
    var m = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * m) / m;
  }

  var idCounter = 0;
  function nextId() { return "evt-" + (++idCounter); }

  /* ---- daily & hour-of-day aggregation ---------------------------------- */

  function buildDaily(dataset, peakHours) {
    var byDate = {};
    var order = [];
    dataset.rows.forEach(function (r) {
      var d = byDate[r.dateKey];
      if (!d) {
        d = byDate[r.dateKey] = {
          dateKey: r.dateKey,
          date: new Date(r.ts.getFullYear(), r.ts.getMonth(), r.ts.getDate()),
          dow: r.dow,
          usage: 0, cost: 0,
          estimated: false,
          hours: new Array(24).fill(null),
          hourCost: new Array(24).fill(null),
          peakUsage: 0, offPeakUsage: 0,
          peakCost: 0, offPeakCost: 0
        };
        order.push(r.dateKey);
      }
      d.usage += r.usage;
      d.cost += r.cost;
      if (r.estimated) d.estimated = true;
      if (dataset.granularity === "hourly" && r.hour != null) {
        d.hours[r.hour] = (d.hours[r.hour] || 0) + r.usage;
        d.hourCost[r.hour] = (d.hourCost[r.hour] || 0) + r.cost;
        if (peakHours && peakHours.indexOf(r.hour) !== -1) {
          d.peakUsage += r.usage; d.peakCost += r.cost;
        } else {
          d.offPeakUsage += r.usage; d.offPeakCost += r.cost;
        }
      }
    });
    return order.map(function (k) {
      var d = byDate[k];
      // Per-day baseline = quietest hour of the day (proxy for always-on load).
      if (dataset.granularity === "hourly") {
        var present = d.hours.filter(function (h) { return h != null; });
        d.minHour = present.length ? S.min(present) : 0;
        d.maxHour = present.length ? S.max(present) : 0;
      }
      return d;
    });
  }

  /* ---- TOU rate detection ---------------------------------------------- */
  /*
   * We infer the rate schedule straight from the data: implied $/unit for each
   * interval is cost / usage. If certain hours are systematically pricier, that
   * is the peak window — no hard-coded assumptions about the customer's plan.
   */
  function detectRates(dataset) {
    var result = {
      detected: false, peakHours: [], peakWindowLabel: "",
      peakRate: 0, offPeakRate: 0, avgRate: 0, premiumPct: 0
    };
    if (dataset.granularity !== "hourly") {
      // Still expose a flat average rate for gas.
      var allR = [];
      dataset.rows.forEach(function (r) { if (r.usage > 0) allR.push(r.cost / r.usage); });
      result.avgRate = allR.length ? S.median(allR) : 0;
      return result;
    }

    var ratesByHour = [];
    for (var h = 0; h < 24; h++) ratesByHour.push([]);
    var all = [];
    dataset.rows.forEach(function (r) {
      if (r.usage > 0.001 && r.hour != null) {
        var rate = r.cost / r.usage;
        ratesByHour[r.hour].push(rate);
        all.push(rate);
      }
    });
    if (all.length < 24) return result;

    var overall = S.median(all);
    result.avgRate = overall;

    var peakHours = [];
    for (var hr = 0; hr < 24; hr++) {
      if (ratesByHour[hr].length >= 3) {
        var m = S.median(ratesByHour[hr]);
        if (m >= overall * 1.12) peakHours.push(hr);
      }
    }

    if (peakHours.length) {
      var peakR = [], offR = [];
      for (var q = 0; q < 24; q++) {
        var isPeak = peakHours.indexOf(q) !== -1;
        ratesByHour[q].forEach(function (v) { (isPeak ? peakR : offR).push(v); });
      }
      var peakRate = peakR.length ? S.median(peakR) : overall;
      var offRate = offR.length ? S.median(offR) : overall;
      var premium = offRate > 0 ? (peakRate / offRate - 1) * 100 : 0;
      if (premium >= 8) {
        result.detected = true;
        result.peakHours = peakHours;
        result.peakRate = peakRate;
        result.offPeakRate = offRate;
        result.premiumPct = premium;
        result.peakWindowLabel = App.fmt.hour12(peakHours[0]) + "–" +
          App.fmt.hour12((peakHours[peakHours.length - 1] + 1) % 24);
      }
    }
    return result;
  }

  /* ---- hour-of-day profile --------------------------------------------- */

  function buildHodProfile(dataset) {
    if (dataset.granularity !== "hourly") return null;
    var byHod = [];
    for (var h = 0; h < 24; h++) byHod.push({ hod: h, values: [] });
    dataset.rows.forEach(function (r) {
      if (r.hour != null) byHod[r.hour].values.push(r.usage);
    });
    byHod.forEach(function (b) {
      b.desc = S.describe(b.values);
      b.mean = b.desc.mean;
      b.median = b.desc.median;
      b.p25 = b.desc.p25;
      b.p75 = b.desc.p75;
      b.p95 = b.desc.p95;
    });
    return byHod;
  }

  function buildDowProfile(daily) {
    var acc = [];
    for (var i = 0; i < 7; i++) acc.push({ dow: i, usage: [], cost: [] });
    daily.forEach(function (d) {
      acc[d.dow].usage.push(d.usage);
      acc[d.dow].cost.push(d.cost);
    });
    return acc.map(function (a) {
      return {
        dow: a.dow,
        count: a.usage.length,
        meanUsage: S.mean(a.usage),
        meanCost: S.mean(a.cost)
      };
    });
  }

  /* ---- anomaly / event detection --------------------------------------- */

  function detectDailyEvents(dataset, daily, usageDesc, rates) {
    var events = [];
    var med = usageDesc.median;
    daily.forEach(function (d) {
      var z = S.modifiedZ(d.usage, usageDesc);
      var deltaPct = med > 0 ? (d.usage / med - 1) * 100 : 0;

      // High-usage day: robust z OR a distribution extreme (top days / IQR fence),
      // so the genuinely biggest days always surface even in a tight spread.
      // The extreme triggers require a non-degenerate scale (mad > 0); this
      // stops a bimodal series like summer gas (mostly 0, a steady "on" level)
      // from flagging every ordinary active day as a spike.
      var extremeHigh = usageDesc.mad > 0 && (d.usage >= usageDesc.p95 || d.usage > usageDesc.fenceHigh);
      if ((z >= 2.5 && d.usage > usageDesc.p75) || extremeHigh) {
        var sev = (z >= 4 || (usageDesc.mad > 0 && d.usage > usageDesc.fenceHigh)) ? "high" : (z >= 3 ? "medium" : "low");
        var extra = d.usage - med;
        events.push({
          id: nextId(), scope: "day", type: "spike", severity: sev,
          date: d.date, dateKey: d.dateKey, hour: null,
          usage: d.usage, cost: d.cost, baselineUsage: med, z: z,
          deltaPct: deltaPct,
          costImpact: extra * (rates.avgRate || (d.usage > 0 ? d.cost / d.usage : 0)),
          title: "High-usage day",
          detail: App.fmt.dateDow(d.date) + " used " + App.fmt.num(d.usage) + " " +
            dataset.unit + " — " + App.fmt.signedPct(deltaPct) + " vs a typical day (" +
            App.fmt.num(med) + " " + dataset.unit + ").",
          tip: dataset.fuel === "electric"
            ? "Scan this day's hourly heatmap row to see which hours drove the spike."
            : "Check whether heating or hot-water use was unusually high that day."
        });
      }

      // Unusually low / likely-away day (electric only; gas is legitimately 0
      // most days so a 'dip' there is not meaningful).
      var extremeLow = usageDesc.mad > 0 && (d.usage <= usageDesc.p05 || d.usage < usageDesc.fenceLow);
      if (dataset.fuel === "electric" && med > 0 && (z <= -2.5 || extremeLow)) {
        var sevL = (z <= -3.5 || (usageDesc.mad > 0 && d.usage < usageDesc.fenceLow)) ? "medium" : "low";
        events.push({
          id: nextId(), scope: "day", type: "dip", severity: sevL,
          date: d.date, dateKey: d.dateKey, hour: null,
          usage: d.usage, cost: d.cost, baselineUsage: med, z: z,
          deltaPct: deltaPct, costImpact: 0,
          title: "Unusually quiet day",
          detail: App.fmt.dateDow(d.date) + " used only " + App.fmt.num(d.usage) + " " +
            dataset.unit + " — " + App.fmt.signedPct(deltaPct) +
            " vs typical. Possibly travel, or an appliance switched off.",
          tip: "Low days are a chance to learn your true baseline — what still runs when you're away?"
        });
      }

      // Estimated reading (data-quality note).
      if (d.estimated) {
        events.push({
          id: nextId(), scope: "day", type: "estimated", severity: "low",
          date: d.date, dateKey: d.dateKey, hour: null,
          usage: d.usage, cost: d.cost, baselineUsage: med, z: 0,
          deltaPct: deltaPct, costImpact: 0,
          title: "Estimated reading",
          detail: App.fmt.dateDow(d.date) + " was estimated by PG&E rather than " +
            "metered, so its usage may not reflect reality.",
          tip: "Estimated days are excluded when you judge real spikes."
        });
      }
    });
    return events;
  }

  function detectHourlyEvents(dataset, daily, byHod, rates) {
    if (dataset.granularity !== "hourly" || !byHod) return [];
    // Global size gate so we only flag hours that are actually large, not just
    // large relative to a normally-tiny hour.
    var allHourly = [];
    dataset.rows.forEach(function (r) { if (r.hour != null) allHourly.push(r.usage); });
    var globalDesc = S.describe(allHourly);
    var sizeGate = Math.max(globalDesc.p75, globalDesc.median + globalDesc.sigmaRobust);

    var events = [];
    daily.forEach(function (d) {
      // Find flagged hours for this day.
      var flagged = [];
      for (var h = 0; h < 24; h++) {
        var u = d.hours[h];
        if (u == null) continue;
        var z = S.modifiedZ(u, byHod[h].desc);
        if (z >= 4 && u >= sizeGate) {
          flagged.push({ h: h, u: u, z: z, base: byHod[h].median });
        }
      }
      if (!flagged.length) return;

      // Collapse consecutive hours into a single window event.
      flagged.sort(function (a, b) { return a.h - b.h; });
      var groups = [];
      var cur = [flagged[0]];
      for (var i = 1; i < flagged.length; i++) {
        if (flagged[i].h - flagged[i - 1].h <= 1) cur.push(flagged[i]);
        else { groups.push(cur); cur = [flagged[i]]; }
      }
      groups.push(cur);

      groups.forEach(function (g) {
        var peak = g[0];
        var totalDelta = 0;
        g.forEach(function (x) {
          if (x.z > peak.z) peak = x;
          totalDelta += Math.max(0, x.u - x.base);
        });
        var startH = g[0].h, endH = g[g.length - 1].h;
        var rate = rates.detected && rates.peakHours.indexOf(peak.h) !== -1
          ? rates.peakRate : (rates.avgRate || 0.3);
        var sev = peak.z >= 6 ? "high" : (peak.z >= 5 ? "medium" : "low");
        var when = startH === endH
          ? App.fmt.hourRange(startH)
          : (App.fmt.hour12(startH) + "–" + App.fmt.hour12((endH + 1) % 24));
        events.push({
          id: nextId(), scope: "hour", type: "spike", severity: sev,
          date: d.date, dateKey: d.dateKey, hour: peak.h, hourStart: startH, hourEnd: endH,
          usage: peak.u, cost: 0, baselineUsage: peak.base, z: peak.z,
          deltaPct: peak.base > 0 ? (peak.u / peak.base - 1) * 100 : 0,
          costImpact: totalDelta * rate,
          title: "Hourly spike",
          detail: App.fmt.dateShort(d.date) + ", " + when + ": " +
            App.fmt.num(peak.u) + " " + dataset.unit + " in the peak hour — about " +
            App.fmt.num(peak.base ? peak.u / peak.base : 0, 1) + "× the usual " +
            App.fmt.hour12(peak.h) + " level.",
          tip: rates.detected && rates.peakHours.indexOf(peak.h) !== -1
            ? "This lands inside the " + rates.peakWindowLabel +
              " peak window, so it costs extra — consider shifting it later."
            : "A short, sharp draw like this usually means a big appliance (AC, oven, EV, dryer)."
        });
      });
    });

    // Keep the most significant hourly events so the feed stays readable.
    events.sort(function (a, b) { return b.costImpact - a.costImpact || b.z - a.z; });
    return events.slice(0, 24);
  }

  function severityRank(s) { return s === "high" ? 3 : s === "medium" ? 2 : 1; }

  /* ---- narrative insights ---------------------------------------------- */

  function buildInsights(dataset, ctx) {
    var out = [];
    var unit = dataset.unit;
    var fuel = dataset.fuel;
    var t = ctx.totals;

    if (fuel === "electric") {
      // 1. Peak-window cost exposure (the headline savings lever).
      if (ctx.rates.detected && ctx.peak) {
        var save = ctx.savings.peakShift;
        out.push({
          icon: "⚡", tone: "warn", title: "You're paying a peak-hour premium",
          savings: save,
          text: App.fmt.pct(ctx.peak.peakCostShare) + " of your electricity spend (" +
            App.fmt.usd(ctx.peak.peakCost) + " of " + App.fmt.usd(t.cost) + ") falls in the " +
            ctx.rates.peakWindowLabel + " peak window, where power runs about " +
            App.fmt.pct(ctx.rates.premiumPct) + " more (" +
            App.fmt.usd(ctx.rates.peakRate, 2) + " vs " + App.fmt.usd(ctx.rates.offPeakRate, 2) +
            " /kWh). Shifting flexible loads — dishwasher, laundry, EV charging — to after " +
            App.fmt.hour12((ctx.rates.peakHours[ctx.rates.peakHours.length - 1] + 1) % 24) +
            " could save roughly " + App.fmt.usd(save) + "/yr."
        });
      }

      // 2. When you use power.
      if (ctx.busiestHour) {
        out.push({
          icon: "🕘", tone: "info", title: "Your power curve peaks in the " +
            (ctx.busiestHour.hod < 12 ? "morning" : ctx.busiestHour.hod < 17 ? "afternoon" : "evening"),
          text: "Usage is highest around " + App.fmt.hour12(ctx.busiestHour.hod) +
            ", averaging " + App.fmt.num(ctx.busiestHour.mean, 2) + " " + unit + "/hr — " +
            App.fmt.signedPct(ctx.busiestHour.vsAvgPct) + " vs your all-hours average of " +
            App.fmt.num(ctx.avgHourly, 2) + " " + unit + "/hr."
        });
      }

      // 3. Always-on / phantom load.
      if (ctx.baseline && ctx.baseline.overnight > 0) {
        out.push({
          icon: "🔌", tone: "info", title: "Always-on load is costing you every hour",
          savings: ctx.savings.phantom,
          text: "Even at its quietest your home draws about " +
            App.fmt.num(ctx.baseline.overnight, 2) + " " + unit +
            "/hr around the clock — roughly " + App.fmt.usd(ctx.baseline.monthlyCost) +
            "/month (" + App.fmt.usd(ctx.baseline.annualCost) + "/yr) in standby devices. " +
            "Trimming phantom loads could recover about " + App.fmt.usd(ctx.savings.phantom) + "/yr."
        });
      }

      // 4. Biggest day.
      if (ctx.peakDay) {
        out.push({
          icon: "📈", tone: "info", title: "Your single biggest day",
          text: App.fmt.dateDow(ctx.peakDay.date) + " topped the chart at " +
            App.fmt.num(ctx.peakDay.usage) + " " + unit + " (" + App.fmt.usd(ctx.peakDay.cost) +
            ") — " + App.fmt.num(ctx.peakDay.usage / (ctx.usageDesc.median || 1), 1) +
            "× a typical day." +
            (ctx.peakDayHour != null ? " The peak hour was around " +
              App.fmt.hour12(ctx.peakDayHour) + "." : "")
        });
      }

      // 5. Trend across the period.
      if (ctx.trend && Math.abs(ctx.trend.changePct) >= 12) {
        var rising = ctx.trend.changePct > 0;
        out.push({
          icon: rising ? "🌡️" : "🍃", tone: rising ? "warn" : "good",
          title: rising ? "Usage is trending up" : "Usage is trending down",
          text: "Daily use " + (rising ? "rose " : "fell ") +
            App.fmt.pct(Math.abs(ctx.trend.changePct)) + " from the start to the end of this " +
            "period (" + App.fmt.num(ctx.trend.firstMean) + " → " + App.fmt.num(ctx.trend.lastMean) +
            " " + unit + "/day)" +
            (rising ? " — consistent with hotter days and heavier cooling." :
                      " — nice work trimming consumption.")
        });
      }

      // 6. Weekend vs weekday.
      if (ctx.weekday && Math.abs(ctx.weekday.diffPct) >= 10) {
        var more = ctx.weekday.diffPct > 0;
        out.push({
          icon: "📅", tone: "info", title: (more ? "Weekends" : "Weekdays") + " are your heavier days",
          text: "You use " + App.fmt.pct(Math.abs(ctx.weekday.diffPct)) + " " +
            (more ? "more" : "less") + " electricity on weekends (" +
            App.fmt.num(ctx.weekday.weekendMean) + " " + unit + "/day) than weekdays (" +
            App.fmt.num(ctx.weekday.weekdayMean) + " " + unit + "/day)."
        });
      }
    } else {
      // Gas insights.
      var onDays = ctx.gas ? ctx.gas.onDays : 0;
      var totalDays = ctx.totals.days;
      out.push({
        icon: "🔥", tone: "info", title: "Your gas runs in an on/off rhythm",
        text: onDays + " of " + totalDays + " days show gas use, averaging about " +
          App.fmt.num(ctx.gas ? ctx.gas.onLevel : 0, 2) + " " + unit +
          " on active days — a pattern typical of water heating or cooking. Summer gas is " +
          "light, averaging " + App.fmt.usd(ctx.totals.avgDailyCost) + "/day."
      });
      if (ctx.peakDay) {
        out.push({
          icon: "📈", tone: "info", title: "Highest gas day",
          text: App.fmt.dateDow(ctx.peakDay.date) + " was your top gas day at " +
            App.fmt.num(ctx.peakDay.usage) + " " + unit + " (" + App.fmt.usd(ctx.peakDay.cost) + ")."
        });
      }
    }

    // Data quality (both fuels).
    if (dataset.estimatedCount > 0) {
      out.push({
        icon: "⚠️", tone: "warn", title: "Some readings were estimated",
        text: dataset.estimatedCount + " reading" + (dataset.estimatedCount > 1 ? "s were" : " was") +
          " estimated by PG&E rather than metered. They're flagged in the event feed so you can " +
          "discount them when judging real spikes."
      });
    }

    // Event summary (both fuels).
    var spikes = ctx.events.filter(function (e) { return e.type === "spike"; }).length;
    var dips = ctx.events.filter(function (e) { return e.type === "dip"; }).length;
    out.push({
      icon: "🔎", tone: "info", title: "What we flagged",
      text: "Across " + ctx.totals.days + " days we surfaced " + ctx.events.length +
        " notable event" + (ctx.events.length === 1 ? "" : "s") + " — " + spikes + " spike" +
        (spikes === 1 ? "" : "s") + (dips ? ", " + dips + " quiet day" + (dips === 1 ? "" : "s") : "") +
        ". Open the event feed to inspect each one."
    });

    return out;
  }

  /* ---- main entry point ------------------------------------------------- */

  function analyze(dataset) {
    var rates = detectRates(dataset);
    var daily = buildDaily(dataset, rates.detected ? rates.peakHours : null);
    var dailyUsage = daily.map(function (d) { return d.usage; });
    var dailyCost = daily.map(function (d) { return d.cost; });
    var usageDesc = S.describe(dailyUsage);
    var costDesc = S.describe(dailyCost);
    var byHod = buildHodProfile(dataset);
    var byDow = buildDowProfile(daily);

    var totalUsage = S.sum(dailyUsage);
    var totalCost = S.sum(dailyCost);
    var days = daily.length;
    var totals = {
      usage: totalUsage, cost: totalCost, days: days,
      avgDailyUsage: days ? totalUsage / days : 0,
      avgDailyCost: days ? totalCost / days : 0,
      projMonthlyUsage: days ? (totalUsage / days) * 30.44 : 0,
      projMonthlyCost: days ? (totalCost / days) * 30.44 : 0
    };

    // Peak-window summary (electric, TOU detected).
    var peak = null;
    if (rates.detected && byHod) {
      var pu = 0, ou = 0, pc = 0, oc = 0;
      daily.forEach(function (d) {
        pu += d.peakUsage; ou += d.offPeakUsage; pc += d.peakCost; oc += d.offPeakCost;
      });
      peak = {
        peakUsage: pu, offPeakUsage: ou, peakCost: pc, offPeakCost: oc,
        peakShare: totalUsage > 0 ? (pu / totalUsage) * 100 : 0,
        peakCostShare: totalCost > 0 ? (pc / totalCost) * 100 : 0,
        avgDailyPeakUsage: days ? pu / days : 0
      };
    }

    // Phantom / always-on baseline (electric).
    var baseline = null;
    if (byHod) {
      var mins = daily.map(function (d) { return d.minHour || 0; });
      var overnight = S.median(mins);
      var monthlyCost = overnight * 24 * 30.44 * (rates.offPeakRate || rates.avgRate || 0);
      baseline = {
        overnight: overnight,
        monthlyCost: monthlyCost,
        annualCost: monthlyCost * 12
      };
    }

    // Trend (first third vs last third of the daily series).
    var trend = null;
    if (days >= 6) {
      var third = Math.max(1, Math.floor(days / 3));
      var firstMean = S.mean(dailyUsage.slice(0, third));
      var lastMean = S.mean(dailyUsage.slice(days - third));
      var changePct = firstMean > 0 ? (lastMean / firstMean - 1) * 100 : 0;
      trend = {
        firstMean: firstMean, lastMean: lastMean, changePct: changePct,
        direction: Math.abs(changePct) < 12 ? "steady" : (changePct > 0 ? "rising" : "falling")
      };
    }

    // Weekday vs weekend (electric-oriented but computed for both).
    var wdU = [], weU = [];
    daily.forEach(function (d) {
      if (d.dow === 0 || d.dow === 6) weU.push(d.usage); else wdU.push(d.usage);
    });
    var weekday = {
      weekdayMean: S.mean(wdU), weekendMean: S.mean(weU),
      diffPct: S.mean(wdU) > 0 ? (S.mean(weU) / S.mean(wdU) - 1) * 100 : 0
    };

    // Busiest hour of day.
    var busiestHour = null;
    if (byHod) {
      var best = byHod[0];
      byHod.forEach(function (b) { if (b.mean > best.mean) best = b; });
      var avgHourly = totals.avgDailyUsage / 24;
      busiestHour = {
        hod: best.hod, mean: best.mean,
        vsAvgPct: avgHourly > 0 ? (best.mean / avgHourly - 1) * 100 : 0
      };
    }

    // Gas on/off characterisation.
    var gas = null;
    if (dataset.fuel === "gas") {
      var onVals = dailyUsage.filter(function (v) { return v > 0.01; });
      gas = {
        onDays: onVals.length,
        offDays: days - onVals.length,
        onLevel: onVals.length ? S.median(onVals) : 0
      };
    }

    // Peak day.
    var peakDay = daily[0];
    daily.forEach(function (d) { if (d.usage > peakDay.usage) peakDay = d; });
    var peakDayHour = null;
    if (byHod && peakDay.hours) {
      var mx = -1, mh = null;
      for (var h = 0; h < 24; h++) {
        if (peakDay.hours[h] != null && peakDay.hours[h] > mx) { mx = peakDay.hours[h]; mh = h; }
      }
      peakDayHour = mh;
    }

    // Events.
    var events = []
      .concat(detectDailyEvents(dataset, daily, usageDesc, rates))
      .concat(detectHourlyEvents(dataset, daily, byHod, rates));
    events.sort(function (a, b) {
      return severityRank(b.severity) - severityRank(a.severity) ||
             b.costImpact - a.costImpact ||
             Math.abs(b.z) - Math.abs(a.z);
    });

    // Savings estimates.
    var savings = { peakShift: 0, phantom: 0, total: 0, items: [] };
    if (peak && rates.detected) {
      // Conservative: assume ~35% of peak-window usage is shiftable to off-peak.
      var shiftable = peak.peakUsage * 0.35;
      var perPeriod = shiftable * (rates.peakRate - rates.offPeakRate);
      savings.peakShift = round(perPeriod * (365 / Math.max(1, days)), 0);
      if (savings.peakShift > 0) {
        savings.items.push({
          label: "Shift flexible loads out of peak hours",
          amount: savings.peakShift,
          detail: "Move ~35% of your " + rates.peakWindowLabel +
            " usage to off-peak and pocket the " + App.fmt.pct(rates.premiumPct) + " rate difference."
        });
      }
    }
    if (baseline && baseline.overnight > 0) {
      // Assume a quarter of always-on load is recoverable standby waste.
      savings.phantom = round(baseline.annualCost * 0.25, 0);
      if (savings.phantom > 0) {
        savings.items.push({
          label: "Cut always-on / phantom load",
          amount: savings.phantom,
          detail: "Smart power strips and unplugging idle electronics typically reclaim ~25% of standby draw."
        });
      }
    }
    savings.total = savings.items.reduce(function (s, x) { return s + x.amount; }, 0);

    var ctx = {
      totals: totals, usageDesc: usageDesc, costDesc: costDesc,
      rates: rates, peak: peak, baseline: baseline, trend: trend,
      weekday: weekday, busiestHour: busiestHour, avgHourly: totals.avgDailyUsage / 24,
      gas: gas, peakDay: peakDay, peakDayHour: peakDayHour, events: events, savings: savings
    };
    var insights = buildInsights(dataset, ctx);

    return {
      fuel: dataset.fuel,
      unit: dataset.unit,
      granularity: dataset.granularity,
      intervalMinutes: dataset.intervalMinutes,
      meta: dataset.meta,
      fileName: dataset.fileName,
      dateRange: { start: daily[0].date, end: daily[daily.length - 1].date, days: days },
      daily: daily,
      dailyUsageMA: S.movingAverage(dailyUsage, 7),
      usageDesc: usageDesc,
      costDesc: costDesc,
      byHod: byHod,
      byDow: byDow,
      totals: totals,
      rates: rates,
      peak: peak,
      baseline: baseline,
      trend: trend,
      weekday: weekday,
      busiestHour: busiestHour,
      gas: gas,
      peakDay: peakDay,
      peakDayHour: peakDayHour,
      maxHourlyUsage: byHod ? S.max(dataset.rows.map(function (r) { return r.usage; })) : 0,
      events: events,
      insights: insights,
      savings: savings,
      estimatedCount: dataset.estimatedCount
    };
  }

  App.analyze = { analyze: analyze };
})(window.App = window.App || {});
