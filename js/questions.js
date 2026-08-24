/* ============================================================================
 * questions.js — Dynamic, data-derived diagnostic questions.
 *
 * The most valuable savings advice needs one thing the meter can't tell us:
 * what's actually running. So instead of a generic form, Wattwise inspects the
 * analysis and asks pointed questions about the specific patterns it found —
 * "~1.6 kW runs 8 AM–noon on weekdays but never weekends, what is that?" — each
 * tagged with the dollars at stake. Answers flow back into the household
 * profile and per-day annotations, which sharpen the tips.
 *
 * Every question is generated only when its pattern is genuinely present, so a
 * flat, unremarkable home won't get nonsense prompts.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var S = App.stats, fmt = App.fmt;
  var OTHER = { value: "other", label: "Something else", free: true };

  function mean(a) { return a.length ? S.mean(a) : 0; }
  function usd0(v) { return fmt.usd(Math.round(v), 0); }

  /* Weekday/weekend usage for a given hour across the period. */
  function hourSplit(daily) {
    var wd = [], we = [];
    for (var h = 0; h < 24; h++) { wd.push([]); we.push([]); }
    daily.forEach(function (d) {
      for (var h = 0; h < 24; h++) {
        if (d.hours[h] == null) continue;
        (d.dow === 0 || d.dow === 6 ? we[h] : wd[h]).push(d.hours[h]);
      }
    });
    return { wd: wd.map(mean), we: we.map(mean) };
  }

  /* Find the strongest contiguous weekday-only (or weekend-only) load window. */
  function recurringWindow(daily, avgHourly) {
    var sp = hourSplit(daily);
    function scan(hi, lo, label) {
      var best = null, run = null;
      for (var h = 0; h < 24; h++) {
        var strong = hi[h] >= Math.max(0.4, avgHourly * 1.15) && hi[h] >= lo[h] * 1.6 + 0.15;
        if (strong) {
          if (!run) run = { start: h, end: h, sum: 0, hiSum: 0 };
          run.end = h; run.sum += hi[h] - lo[h]; run.hiSum += hi[h];
        } else if (run) {
          if (!best || run.sum > best.sum) best = run;
          run = null;
        }
      }
      if (run && (!best || run.sum > best.sum)) best = run;
      if (best && best.sum >= 0.8) {
        best.label = label;
        best.hours = best.end - best.start + 1;
        best.kw = best.hiSum / best.hours;
        return best;
      }
      return null;
    }
    var weekday = scan(sp.wd, sp.we, "weekday");
    var weekend = scan(sp.we, sp.wd, "weekend");
    if (!weekday && !weekend) return null;
    if (weekday && weekend) return weekday.sum >= weekend.sum ? weekday : weekend;
    return weekday || weekend;
  }

  function windowLabel(w) {
    return fmt.hour12(w.start) + "–" + fmt.hour12((w.end + 1) % 24);
  }

  function generate(analysis) {
    var qs = [];
    var unit = analysis.unit;
    var rates = analysis.rates;
    var offRate = rates.offPeakRate || rates.avgRate || 0.3;

    if (analysis.fuel === "electric" && analysis.granularity === "hourly") {
      var avgHourly = analysis.totals.avgDailyUsage / 24;

      /* 1) Recurring weekday/weekend load window. */
      var win = recurringWindow(analysis.daily, avgHourly);
      if (win) {
        var days = win.label === "weekday" ? 252 : 104;
        var annual = win.kw * win.hours * days * offRate;
        var not = win.label === "weekday" ? "never on weekends" : "mainly on weekends";
        qs.push({
          id: "recurring-window",
          category: "pattern",
          title: "Roughly " + fmt.num(win.kw, 1) + " kW runs " + windowLabel(win) + " on " +
            win.label + "s but " + not + ". Best guess what it is?",
          chip: "~" + usd0(annual) + "/yr of energy",
          multi: false,
          options: [
            { value: "ev", label: "EV or plug-in hybrid charging", apply: { profile: { ev: true } } },
            { value: "wfh", label: "Someone's home and running cooling", apply: { profile: { occupancy: "home" } } },
            { value: "laundry", label: "Laundry or dishwasher routine", apply: { profile: { dryer: true } } },
            { value: "none", label: "No idea — that surprises me" }
          ]
        });
      }

      /* 2) The phantom-baseline "$X/yr question". */
      if (analysis.baseline && analysis.baseline.annualCost > 60) {
        qs.push({
          id: "always-on",
          category: "baseline",
          title: "Which of these run continuously at your place?",
          subtitle: "This is the " + usd0(analysis.baseline.annualCost) + "/yr question — that's what your always-on load costs.",
          chip: usd0(analysis.baseline.annualCost) + "/yr always-on",
          multi: true,
          options: [
            { value: "fridge2", label: "Second fridge or freezer (often in a garage)" },
            { value: "pool", label: "Pool, spa, or pond pump", apply: { profile: { pool: true } } },
            { value: "aquarium", label: "Aquarium, reptile tank, or grow light" },
            { value: "well", label: "Well or sump pump" },
            { value: "none", label: "None of these that I know of" }
          ]
        });
      }

      /* 3) Biggest spike — what was running? (ties to the event annotation) */
      var topSpike = analysis.events.filter(function (e) { return e.type === "spike"; })[0];
      if (topSpike) {
        var whenTxt = topSpike.scope === "hour"
          ? "around " + fmt.hour12(topSpike.hour)
          : "across the day";
        qs.push({
          id: "spike-cause",
          category: "spike",
          dateKey: topSpike.dateKey,
          title: "One of your sharpest spikes was " + fmt.dateDow(topSpike.date) + " " + whenTxt + " — " +
            fmt.num(topSpike.usage, 1) + " " + unit +
            (topSpike.baselineUsage ? " (~" + fmt.num(topSpike.usage / topSpike.baselineUsage, 1) + "× normal)" : "") +
            ". What ran then?",
          multi: false,
          options: [
            { value: "ac", label: "Air conditioning", apply: { annotation: { cause: "ac" } } },
            { value: "cooking", label: "Oven / cooking", apply: { annotation: { cause: "cooking" } } },
            { value: "ev", label: "EV charging", apply: { profile: { ev: true }, annotation: { cause: "ev" } } },
            { value: "laundry", label: "Laundry / dryer", apply: { profile: { dryer: true }, annotation: { cause: "laundry" } } },
            { value: "guests", label: "Guests over", apply: { annotation: { cause: "guests" } } },
            { value: "other", label: "Something else", free: true, apply: { annotation: { cause: "other" } } }
          ]
        });
      }

      /* 4) Quiet / possibly-away day. */
      var topDip = analysis.events.filter(function (e) { return e.type === "dip"; })[0];
      if (topDip) {
        qs.push({
          id: "dip-away",
          category: "dip",
          dateKey: topDip.dateKey,
          title: "Usage on " + fmt.dateDow(topDip.date) + " was " +
            fmt.pct(Math.abs(topDip.deltaPct), 0) + " below normal. Were you home?",
          multi: false,
          options: [
            { value: "away", label: "Away / traveling", apply: { annotation: { away: true } } },
            { value: "light", label: "Home, just a light day" },
            { value: "off", label: "An appliance was switched off" },
            { value: "unsure", label: "Not sure" }
          ]
        });
      }

      /* 5) Peak-window occupants. */
      if (rates.detected && analysis.peak && analysis.peak.avgDailyPeakUsage > 1) {
        var premAnnual = (analysis.peak.peakCost - analysis.peak.peakUsage * offRate) *
          (365 / Math.max(1, analysis.dateRange.days));
        qs.push({
          id: "peak-occupants",
          category: "peak",
          title: "About " + fmt.num(analysis.peak.avgDailyPeakUsage, 1) + " " + unit +
            "/day lands in the " + rates.peakWindowLabel + " peak window. What's usually running then?",
          subtitle: "You pay roughly " + usd0(premAnnual) + "/yr extra just because it's in peak hours.",
          chip: "~" + usd0(premAnnual) + "/yr in peak premium",
          multi: true,
          options: [
            { value: "cooking", label: "Cooking dinner" },
            { value: "ac", label: "Air conditioning" },
            { value: "ev", label: "EV charging", apply: { profile: { ev: true } } },
            { value: "laundry", label: "Laundry / dishwasher", apply: { profile: { dryer: true } } },
            { value: "tv", label: "TV / computers / gaming" },
            { value: "stuck", label: "Nothing I can really move" }
          ]
        });
      }

      /* 6) Cooling type (fills the profile if not already known via above). */
      qs.push({
        id: "cooling-type",
        category: "profile",
        title: "How do you cool your home in summer?",
        multi: false,
        options: [
          { value: "central", label: "Central air conditioning", apply: { profile: { acType: "central" } } },
          { value: "heatpump", label: "Heat pump", apply: { profile: { acType: "heatpump" } } },
          { value: "window", label: "Window / portable units", apply: { profile: { acType: "window" } } },
          { value: "none", label: "No AC — fans / open windows", apply: { profile: { acType: "none" } } }
        ]
      });

      /* 7) Trend driver. */
      if (analysis.trend && Math.abs(analysis.trend.changePct) >= 15) {
        var dir = analysis.trend.changePct > 0 ? "rose" : "fell";
        qs.push({
          id: "trend-driver",
          category: "trend",
          title: "Your daily usage " + dir + " " + fmt.pct(Math.abs(analysis.trend.changePct), 0) +
            " over these weeks. Anything change?",
          multi: false,
          options: [
            { value: "weather", label: "Weather got hotter / cooler" },
            { value: "device", label: "New appliance or device" },
            { value: "people", label: "More / fewer people home" },
            { value: "travel", label: "Travel or time away" },
            { value: "none", label: "Nothing I can think of" }
          ]
        });
      }

      /* 8) Which big loads are electric (attribution). */
      qs.push({
        id: "electric-loads",
        category: "profile",
        title: "Which of these are electric (not gas) in your home?",
        multi: true,
        options: [
          { value: "dryer", label: "Clothes dryer", apply: { profile: { dryer: true } } },
          { value: "waterheater", label: "Water heater" },
          { value: "range", label: "Stove / oven" },
          { value: "heat", label: "Heating / furnace" },
          { value: "none", label: "None — mostly gas" }
        ]
      });
    } else if (analysis.fuel === "gas") {
      qs.push({
        id: "gas-uses",
        category: "profile",
        title: "What uses gas in your home?",
        subtitle: "Your gas runs on " + (analysis.gas ? analysis.gas.onDays : 0) + " of " +
          analysis.totals.days + " days — knowing what's connected helps.",
        multi: true,
        options: [
          { value: "water", label: "Water heater" },
          { value: "range", label: "Stove / range" },
          { value: "furnace", label: "Furnace / central heat" },
          { value: "dryer", label: "Clothes dryer" },
          { value: "pool", label: "Pool / spa heater" }
        ]
      });
    }

    // Append the free-text "Something else" to single-select questions that
    // don't already carry it.
    qs.forEach(function (q) {
      if (!q.multi && !q.options.some(function (o) { return o.value === "other"; })) {
        q.options = q.options.concat([OTHER]);
      }
    });

    return qs;
  }

  App.questions = { generate: generate };
})(window.App = window.App || {});
