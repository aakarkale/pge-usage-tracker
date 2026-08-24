/* ============================================================================
 * app.js — Orchestration, UI rendering, and persistence.
 *
 * Ties the modules together: ingest CSVs → analyze → (billing cycle prompt) →
 * render the dashboard → react to weather enrichment, profile answers, event
 * annotations, and control toggles. All user settings persist to localStorage,
 * keyed by account, so they survive reloads.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var fmt = App.fmt, charts = App.charts;

  /* ---- state ------------------------------------------------------------ */

  var State = {
    data: { electric: null, gas: null },   // { dataset, analysis } per fuel
    weather: { electric: null, gas: null },
    weatherStatus: { electric: "", gas: "" },
    tips: { electric: [], gas: [] },
    questions: { electric: null, gas: null },
    activeFuel: null,
    metric: "usage",
    selectedDay: null,
    eventFilter: "all",
    accountKey: "default",
    settings: {}                            // per-account persisted settings
  };

  var SETTINGS_KEY = "wattwise.settings.v2";
  var THEME_KEY = "wattwise.theme";

  /* ---- persistence ------------------------------------------------------ */

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      State.settings = raw ? JSON.parse(raw) : {};
    } catch (e) { State.settings = {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(State.settings)); } catch (e) {}
  }
  function acctSettings() {
    var s = State.settings[State.accountKey];
    if (!s) {
      s = State.settings[State.accountKey] = { billing: null, profile: null, annotations: { electric: {}, gas: {} } };
    }
    if (!s.annotations) s.annotations = { electric: {}, gas: {} };
    if (!s.annotations[State.activeFuel]) s.annotations[State.activeFuel] = {};
    if (!s.answers) s.answers = { electric: {}, gas: {} };
    if (!s.answers[State.activeFuel]) s.answers[State.activeFuel] = {};
    return s;
  }

  function activeQuestions() {
    if (!State.questions[State.activeFuel]) {
      State.questions[State.activeFuel] =
        App.questions.generate(State.data[State.activeFuel].analysis);
    }
    return State.questions[State.activeFuel];
  }

  /* Recompute the household profile from the current question answers across
   * BOTH fuels (AC/EV/pool are household-level), so toggling an answer off
   * cleanly removes its effect and answering gas questions never wipes an
   * electric-derived profile. */
  function deriveProfile() {
    var p = {};
    ["electric", "gas"].forEach(function (fuel) {
      if (!State.data[fuel]) return;
      if (!State.questions[fuel]) State.questions[fuel] = App.questions.generate(State.data[fuel].analysis);
      var s = State.settings[State.accountKey];
      var ans = (s && s.answers && s.answers[fuel]) || {};
      State.questions[fuel].forEach(function (q) {
        var a = ans[q.id];
        if (a == null) return;
        var vals = q.multi ? (a || []) : [a];
        q.options.forEach(function (o) {
          if (o.apply && o.apply.profile && vals.indexOf(o.value) !== -1) {
            Object.keys(o.apply.profile).forEach(function (k) { p[k] = o.apply.profile[k]; });
          }
        });
      });
    });
    return p;
  }

  /* Keep per-day annotations in sync with a spike/dip question's answer. */
  function applyQuestionAnnotation(q, ans) {
    if (!q.dateKey) return;
    var an = acctSettings().annotations[State.activeFuel];
    var cur = an[q.dateKey] = an[q.dateKey] || {};
    var vals = q.multi ? (ans || []) : (ans == null ? [] : [ans]);
    var controlsAway = q.options.some(function (o) { return o.apply && o.apply.annotation && "away" in o.apply.annotation; });
    var controlsCause = q.options.some(function (o) { return o.apply && o.apply.annotation && "cause" in o.apply.annotation; });
    if (controlsAway) cur.away = false;
    if (controlsCause) cur.cause = "";
    q.options.forEach(function (o) {
      if (o.apply && o.apply.annotation && vals.indexOf(o.value) !== -1) {
        if ("away" in o.apply.annotation) cur.away = o.apply.annotation.away;
        if ("cause" in o.apply.annotation) cur.cause = o.apply.annotation.cause;
      }
    });
  }

  function setAnswer(q, value) {
    var ans = acctSettings().answers[State.activeFuel];
    ans[q.id] = value;
    acctSettings().profile = deriveProfile();
    applyQuestionAnnotation(q, value);
    saveSettings();
    regenTips();
    renderKpis(); renderInsights(); renderSavings(); renderTips(); renderAcPlan();
    renderEventFilters(); renderEvents(); renderContext();
  }

  /* ---- date helpers ----------------------------------------------------- */

  function isoToDate(iso) {
    if (!iso) return null;
    var p = iso.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function dateToIso(d) {
    return d.getFullYear() + "-" + fmt.pad2(d.getMonth() + 1) + "-" + fmt.pad2(d.getDate());
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function diffDays(a, b) { return Math.round((b - a) / 86400000); }

  /* ---- billing cycle computation --------------------------------------- */

  function computeBilling(analysis, startISO, endISO) {
    var cStart = isoToDate(startISO), cEnd = isoToDate(endISO);
    if (!cStart || !cEnd || cEnd < cStart) return null;
    var len = diffDays(cStart, cEnd) + 1;
    var dataStart = analysis.daily[0].date;
    var dataEnd = analysis.daily[analysis.daily.length - 1].date;
    var today = new Date(); today.setHours(0, 0, 0, 0);

    // Anchor the tiling so the first cycle covers dataStart.
    var start = new Date(cStart);
    while (start > dataStart) start = addDays(start, -len);
    while (addDays(start, len - 1) < dataStart) start = addDays(start, len);

    var byKey = {};
    analysis.daily.forEach(function (d) { byKey[d.dateKey] = d; });

    var cycles = [];
    var guard = 0;
    while (start <= dataEnd && guard++ < 400) {
      var end = addDays(start, len - 1);
      var usage = 0, cost = 0, daysWithData = 0;
      var cur = new Date(start);
      while (cur <= end) {
        var k = dateToIso(cur);
        if (byKey[k]) { usage += byKey[k].usage; cost += byKey[k].cost; daysWithData++; }
        cur = addDays(cur, 1);
      }
      var fullyCovered = end <= dataEnd;
      var elapsed = Math.min(diffDays(start, dataEnd) + 1, len);
      var projCost = daysWithData > 0 ? (cost / daysWithData) * len : cost;
      var projUsage = daysWithData > 0 ? (usage / daysWithData) * len : usage;
      cycles.push({
        start: new Date(start), end: end, lenDays: len,
        usage: usage, cost: cost, daysWithData: daysWithData,
        partial: !fullyCovered, daysElapsed: elapsed,
        costToDate: cost, usageToDate: usage,
        projectedCost: projCost, projectedUsage: projUsage,
        isCurrent: false
      });
      start = addDays(end, 1);
    }
    if (cycles.length) cycles[cycles.length - 1].isCurrent = true;
    return { cycleStart: cStart, cycleEnd: cEnd, lenDays: len, cycles: cycles };
  }

  function activeBilling() {
    var s = State.settings[State.accountKey];
    if (!s || !s.billing) return null;
    var a = State.data[State.activeFuel];
    if (!a) return null;
    return computeBilling(a.analysis, s.billing.startISO, s.billing.endISO);
  }

  /* ---- tips context ----------------------------------------------------- */

  function buildCtx() {
    var s = acctSettings();
    return {
      weather: State.weather[State.activeFuel],
      profile: s.profile,
      annotations: s.annotations[State.activeFuel],
      billing: activeBilling()
    };
  }
  function regenTips() {
    var a = State.data[State.activeFuel];
    if (a) State.tips[State.activeFuel] = App.tips.generate(a.analysis, buildCtx());
  }

  /* ---- ingestion -------------------------------------------------------- */

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("Could not read " + file.name)); };
      r.readAsText(file);
    });
  }

  function ingestText(text, fileName) {
    var dataset = App.parse.parse(text, fileName);
    var analysis = App.analyze.analyze(dataset);
    State.data[dataset.fuel] = { dataset: dataset, analysis: analysis };
    return dataset.fuel;
  }

  function ingestFiles(files) {
    hideError();
    var arr = Array.prototype.slice.call(files);
    var csvs = arr.filter(function (f) { return /\.csv$/i.test(f.name) || f.type === "text/csv"; });
    if (!csvs.length) { showError("Please choose a .csv file exported from PG&E."); return; }
    Promise.all(csvs.map(function (f) {
      return readFile(f).then(function (t) {
        try { return ingestText(t, f.name); }
        catch (e) { showError(f.name + ": " + e.message); return null; }
      });
    })).then(function (fuels) {
      var loaded = fuels.filter(Boolean);
      if (!loaded.length) return;
      afterLoad(loaded[0]);
    });
  }

  function loadSample() {
    hideError();
    try {
      ingestText(App.sampleData.electric, "electric-sample.csv");
      ingestText(App.sampleData.gas, "gas-sample.csv");
      afterLoad("electric");
    } catch (e) { showError(e.message); }
  }

  function afterLoad(firstFuel) {
    State.activeFuel = State.data.electric ? "electric" : (State.data.gas ? "gas" : firstFuel);
    State.questions = { electric: null, gas: null };  // regenerate for the new data
    var a = State.data[State.activeFuel].analysis;
    State.accountKey = a.meta.account || a.meta.service || "default";
    document.getElementById("hero").hidden = true;
    document.getElementById("dashboard").hidden = false;
    document.getElementById("btn-new").hidden = false;
    regenTips();
    render();
    // Prompt for the billing cycle on upload, if not already set for this account.
    var s = State.settings[State.accountKey];
    if (!s || !s.billing) openBillingModal();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---- error helpers ---------------------------------------------------- */

  function showError(msg) {
    var e = document.getElementById("error-box");
    e.textContent = "⚠ " + msg; e.hidden = false;
  }
  function hideError() { document.getElementById("error-box").hidden = true; }

  /* ---- rendering: account + tabs --------------------------------------- */

  function maskAccount(acct) {
    if (!acct) return "";
    var s = String(acct);
    return s.length > 4 ? "••••" + s.slice(-4) : s;
  }

  function renderHead() {
    var a = State.data[State.activeFuel].analysis;
    document.getElementById("account-name").textContent = a.meta.name || "Your energy dashboard";
    var bits = [];
    if (a.meta.address) bits.push(a.meta.address);
    if (a.meta.account) bits.push("Acct " + maskAccount(a.meta.account));
    bits.push(fmt.dateMed(a.dateRange.start) + " – " + fmt.dateMed(a.dateRange.end) +
      " · " + a.dateRange.days + " days");
    document.getElementById("account-meta").textContent = bits.join("  ·  ");

    var tabs = document.getElementById("fuel-tabs");
    tabs.innerHTML = "";
    [["electric", "⚡ Electricity"], ["gas", "🔥 Gas"]].forEach(function (t) {
      if (!State.data[t[0]]) return;
      var b = document.createElement("button");
      b.className = "fuel-tab" + (State.activeFuel === t[0] ? " active" : "");
      b.dataset.fuel = t[0];
      b.textContent = t[1];
      b.onclick = function () {
        if (State.activeFuel === t[0]) return;
        State.activeFuel = t[0];
        State.selectedDay = null;
        State.eventFilter = "all";
        regenTips();
        render();
      };
      tabs.appendChild(b);
    });
    document.body.setAttribute("data-fuel", State.activeFuel);
  }

  /* ---- rendering: KPIs -------------------------------------------------- */

  function kpiCard(label, value, sub, sparkVals, color) {
    var card = document.createElement("div");
    card.className = "kpi";
    card.innerHTML = "<div class='kpi-label'>" + label + "</div>" +
      "<div class='kpi-value'>" + value + "</div>" +
      "<div class='kpi-sub'>" + (sub || "") + "</div>";
    if (sparkVals) {
      var sp = document.createElement("div");
      sp.className = "kpi-spark";
      card.appendChild(sp);
      // draw after in DOM for width
      setTimeout(function () { charts.sparkline(sp, sparkVals, { color: color, height: 34 }); }, 0);
    }
    return card;
  }

  function renderKpis() {
    var a = State.data[State.activeFuel].analysis;
    var unit = a.unit;
    var pal = charts.palette(a.fuel);
    var grid = document.getElementById("kpis");
    grid.innerHTML = "";
    var dailyUsage = a.daily.map(function (d) { return d.usage; });
    var dailyCost = a.daily.map(function (d) { return d.cost; });

    grid.appendChild(kpiCard("Total usage", fmt.num(a.totals.usage) + " <span class='u'>" + unit + "</span>",
      fmt.num(a.totals.avgDailyUsage) + " " + unit + "/day avg", dailyUsage, pal.accent));
    grid.appendChild(kpiCard("Total cost", fmt.usd(a.totals.cost),
      fmt.usd(a.totals.avgDailyCost) + "/day avg", dailyCost, "#a78bfa"));

    // Projected bill (current cycle) if billing set, else projected monthly.
    var billing = activeBilling();
    if (billing && billing.cycles.length) {
      var cur = billing.cycles[billing.cycles.length - 1];
      grid.appendChild(kpiCard("Projected bill · current cycle", fmt.usd(cur.projectedCost),
        cur.daysWithData + " of " + cur.lenDays + " days in", null));
    } else {
      grid.appendChild(kpiCard("Projected monthly cost", fmt.usd(a.totals.projMonthlyCost),
        "~30.4-day run rate", null));
    }

    if (a.fuel === "electric" && a.peak) {
      grid.appendChild(kpiCard("Peak-hour cost share", fmt.pct(a.peak.peakCostShare),
        a.rates.peakWindowLabel + " · +" + fmt.pct(a.rates.premiumPct) + " rate", null));
      grid.appendChild(kpiCard("Always-on load", fmt.num(a.baseline.overnight, 2) + " <span class='u'>" + unit + "/hr</span>",
        "≈ " + fmt.usd(a.baseline.monthlyCost) + "/mo standby", null));
    } else if (a.fuel === "gas" && a.gas) {
      grid.appendChild(kpiCard("Active gas days", a.gas.onDays + " <span class='u'>/ " + a.totals.days + "</span>",
        "~" + fmt.num(a.gas.onLevel, 2) + " " + unit + " when on", null));
    }

    grid.appendChild(kpiCard("Events flagged", String(a.events.length),
      "spikes, dips &amp; anomalies", null));
  }

  /* ---- rendering: billing ---------------------------------------------- */

  function renderBilling() {
    var box = document.getElementById("billing-content");
    var billing = activeBilling();
    if (!billing) {
      box.innerHTML = "<div class='empty-hint'>No billing cycle set yet. " +
        "<button id='billing-setup-inline' class='linkbtn'>Set your cycle dates</button> " +
        "to align charts to your bill and project the current period.</div>";
      var b = document.getElementById("billing-setup-inline");
      if (b) b.onclick = openBillingModal;
      return;
    }
    var a = State.data[State.activeFuel].analysis;
    var rows = billing.cycles.map(function (c) {
      var proj = c.partial
        ? "<span class='bc-proj'>proj. " + fmt.usd(c.projectedCost) + "</span>"
        : "";
      return "<div class='bc-row" + (c.isCurrent ? " bc-current" : "") + "'>" +
        "<div class='bc-range'>" + fmt.dateShort(c.start) + " – " + fmt.dateShort(c.end) +
          (c.partial ? " <span class='bc-tag'>in progress</span>" : "") + "</div>" +
        "<div class='bc-bar'><span style='width:" +
          Math.min(100, (c.cost / (billing.cycles.reduce(function (m, x) {
            return Math.max(m, x.partial ? x.projectedCost : x.cost); }, 1))) * 100) +
          "%;background:" + charts.palette(a.fuel).accent + "'></span></div>" +
        "<div class='bc-nums'><b>" + fmt.usd(c.cost) + "</b> " + proj +
          "<span class='bc-usage'>" + fmt.num(c.usage) + " " + a.unit + "</span></div>" +
        "</div>";
    }).join("");
    var cur = billing.cycles[billing.cycles.length - 1];
    var note = cur.partial
      ? "<div class='bc-note'>Current cycle is " + cur.daysWithData + " of " + cur.lenDays +
        " days in — projected total <b>" + fmt.usd(cur.projectedCost) + "</b> (" +
        fmt.num(cur.projectedUsage) + " " + a.unit + ").</div>"
      : "";
    box.innerHTML = "<div class='bc-list'>" + rows + "</div>" + note;
  }

  /* ---- rendering: insights + savings + tips ---------------------------- */

  function renderInsights() {
    var a = State.data[State.activeFuel].analysis;
    var box = document.getElementById("insights");
    box.innerHTML = a.insights.map(function (i) {
      return "<div class='insight insight-" + i.tone + "'>" +
        "<div class='insight-ico'>" + i.icon + "</div>" +
        "<div class='insight-body'><div class='insight-title'>" + i.title +
        (i.savings ? " <span class='save-chip'>~" + fmt.usd(i.savings) + "/yr</span>" : "") +
        "</div><div class='insight-text'>" + i.text + "</div></div></div>";
    }).join("");
  }

  function renderSavings() {
    var a = State.data[State.activeFuel].analysis;
    var box = document.getElementById("savings");
    var tips = State.tips[State.activeFuel] || [];
    var tipSave = tips.reduce(function (s, t) { return s + (t.savings || 0); }, 0);
    var total = Math.max(a.savings.total, tipSave);
    if (total <= 0) {
      box.innerHTML = "<div class='empty-hint'>No obvious savings levers detected — your usage looks efficient. " +
        "Add weather and answer a few questions below to dig deeper.</div>";
      return;
    }
    var items = a.savings.items.slice();
    // include quantified tips not already represented
    tips.forEach(function (t) {
      if (t.savings && !items.some(function (it) { return it.label === t.title; })) {
        items.push({ label: t.title, amount: t.savings, detail: "" });
      }
    });
    items.sort(function (x, y) { return y.amount - x.amount; });
    items = items.slice(0, 5);
    var maxAmt = items.reduce(function (m, x) { return Math.max(m, x.amount); }, 1);
    box.innerHTML =
      "<div class='save-total'><span class='save-total-num'>~" + fmt.usd(total) + "</span>" +
      "<span class='save-total-lbl'>estimated potential savings / year</span></div>" +
      items.map(function (it) {
        return "<div class='save-item'><div class='save-item-top'><span>" + it.label + "</span>" +
          "<b>" + fmt.usd(it.amount) + "</b></div>" +
          "<div class='save-item-bar'><span style='width:" + (it.amount / maxAmt * 100) + "%'></span></div>" +
          (it.detail ? "<div class='save-item-detail'>" + it.detail + "</div>" : "") + "</div>";
      }).join("");
  }

  function renderTips() {
    var box = document.getElementById("tips");
    var tips = State.tips[State.activeFuel] || [];
    if (!tips.length) { box.innerHTML = "<div class='empty-hint'>No recommendations yet.</div>"; return; }
    box.innerHTML = tips.map(function (t) {
      return "<div class='tip tip-p" + t.priority + "'>" +
        "<div class='tip-ico'>" + t.icon + "</div>" +
        "<div class='tip-main'><div class='tip-title'>" + t.title +
        (t.savings ? " <span class='save-chip'>~" + fmt.usd(t.savings) + "/yr</span>" : "") +
        "</div><div class='tip-body'>" + t.body + "</div></div></div>";
    }).join("");
  }

  /* ---- rendering: charts ----------------------------------------------- */

  function isElectric() { return State.activeFuel === "electric"; }

  function renderCharts() {
    var a = State.data[State.activeFuel].analysis;
    var pal = charts.palette(a.fuel);

    charts.timeSeries(document.getElementById("chart-timeseries"), {
      daily: a.daily, ma: a.dailyUsageMA, unit: a.unit, fuel: a.fuel,
      metric: State.metric, events: a.events, highlightKey: State.selectedDay,
      onSelectDay: setSelectedDay
    });

    var heatPanel = document.getElementById("panel-heatmap");
    var lcPanel = document.getElementById("panel-loadcurve");
    var peakPanel = document.getElementById("panel-peak");
    var weatherPanel = document.getElementById("panel-weather");

    if (a.granularity === "hourly" && a.byHod) {
      heatPanel.hidden = false; lcPanel.hidden = false;
      charts.heatmap(document.getElementById("chart-heatmap"), {
        daily: a.daily, unit: a.unit, fuel: a.fuel, byHod: a.byHod,
        peakHours: a.rates.detected ? a.rates.peakHours : [], peakLabel: a.rates.peakWindowLabel,
        events: a.events, highlightKey: State.selectedDay, onSelectDay: setSelectedDay
      });
      charts.loadCurve(document.getElementById("chart-loadcurve"), {
        byHod: a.byHod, unit: a.unit, fuel: a.fuel,
        peakHours: a.rates.detected ? a.rates.peakHours : []
      });
    } else {
      heatPanel.hidden = true; lcPanel.hidden = true;
    }

    charts.weekdayBars(document.getElementById("chart-weekday"), {
      byDow: a.byDow, unit: a.unit, fuel: a.fuel
    });

    // peak split
    if (a.fuel === "electric" && a.rates.detected && a.peak) {
      peakPanel.hidden = false;
      renderPeak(a);
    } else {
      peakPanel.hidden = true;
    }

    // weather panel (electric only)
    if (a.fuel === "electric") { weatherPanel.hidden = false; renderWeather(a); }
    else { weatherPanel.hidden = true; }
  }

  function renderPeak(a) {
    var box = document.getElementById("peak-content");
    box.innerHTML =
      "<div class='peak-grid'>" +
        "<div class='peak-stat'><span class='ps-num'>" + fmt.pct(a.peak.peakShare) + "</span>" +
          "<span class='ps-lbl'>of usage in peak</span></div>" +
        "<div class='peak-stat'><span class='ps-num'>" + fmt.pct(a.peak.peakCostShare) + "</span>" +
          "<span class='ps-lbl'>of cost in peak</span></div>" +
        "<div class='peak-stat'><span class='ps-num'>" + fmt.usd(a.rates.peakRate, 2) + "</span>" +
          "<span class='ps-lbl'>peak $/" + a.unit + "</span></div>" +
        "<div class='peak-stat'><span class='ps-num'>" + fmt.usd(a.rates.offPeakRate, 2) + "</span>" +
          "<span class='ps-lbl'>off-peak $/" + a.unit + "</span></div>" +
      "</div>" +
      "<div id='peak-split'></div>" +
      "<div class='peak-caption'>Peak window <b>" + a.rates.peakWindowLabel + "</b> costs " +
        fmt.pct(a.rates.premiumPct) + " more than off-peak. Every " + a.unit +
        " you move out of that window saves the difference.</div>";
    charts.splitBar(document.getElementById("peak-split"), [
      { label: "Peak cost", value: a.peak.peakCost, color: "#ff7a59" },
      { label: "Off-peak cost", value: a.peak.offPeakCost, color: charts.palette("electric").accent }
    ]);
  }

  /* ---- rendering: weather ---------------------------------------------- */

  function renderWeather(a) {
    var box = document.getElementById("weather-content");
    var wj = State.weather[State.activeFuel];
    var status = State.weatherStatus[State.activeFuel];
    var zipGuess = App.weather.extractZip(a.meta.address);

    if (wj && wj.available) {
      var hot = wj.daily.filter(function (d) { return d.tMax != null && d.tMax >= wj.hotThresh; });
      var mild = wj.daily.filter(function (d) { return d.tMax != null && d.tMax < wj.hotThresh; });
      var hotPeak = App.stats.mean(hot.map(function (d) { return d.peakUsage || 0; }));
      var mildPeak = App.stats.mean(mild.map(function (d) { return d.peakUsage || 0; }));
      var strength = Math.abs(wj.corr) >= 0.6 ? "strong" : Math.abs(wj.corr) >= 0.35 ? "moderate" : "weak";
      box.innerHTML =
        "<div class='wx-head'><span class='wx-place'>📍 " + esc(wj.place || "your area") + "</span>" +
          "<span class='wx-corr'>Usage ↔ temperature: <b>" + strength + "</b> (r = " +
          fmt.num(wj.corr, 2) + ")</span></div>" +
        "<div class='wx-grid'><div id='wx-scatter' class='chart-holder'></div>" +
        "<div class='wx-side'>" +
          (a.rates.detected ? "<div class='wx-fact'><span>Peak-window use on hot days (≥ " +
            fmt.num(wj.hotThresh, 0) + "°)</span><b>" + fmt.num(hotPeak, 1) + " " + a.unit + "</b></div>" +
            "<div class='wx-fact'><span>…on mild days</span><b>" + fmt.num(mildPeak, 1) + " " + a.unit + "</b></div>" : "") +
          "<div class='wx-hint'>" + (wj.corr >= 0.45
            ? "Cooling drives your bill — see the pre-cooling tip above."
            : "Weather isn't your main driver; focus on baseline &amp; appliances.") + "</div>" +
        "</div></div>";
      var pts = wj.daily.map(function (d) {
        return { x: d.tMax, y: d.usage, label: fmt.dateShort(d.date) };
      });
      charts.scatter(document.getElementById("wx-scatter"), { points: pts, unit: a.unit, fuel: a.fuel, height: 240 });
      return;
    }

    var loading = status === "loading";
    box.innerHTML =
      "<div class='wx-cta'>" +
        "<p>Add local hourly temperatures to see how much of your usage is weather-driven and unlock " +
          "pre-cooling tips. Only your ZIP and date range are sent to a free weather service — your usage data " +
          "stays in the browser.</p>" +
        "<div class='wx-form'>" +
          "<input id='wx-zip' class='input' type='text' inputmode='numeric' maxlength='5' placeholder='ZIP' value='" +
            (zipGuess || "") + "' />" +
          "<button id='wx-go' class='btn btn-primary'" + (loading ? " disabled" : "") + ">" +
            (loading ? "Fetching…" : "🌦️ Add local weather") + "</button>" +
        "</div>" +
        (status && status !== "loading" ? "<div class='wx-status'>" + status + "</div>" : "") +
      "</div>";
    var go = document.getElementById("wx-go");
    if (go) go.onclick = function () {
      var zip = (document.getElementById("wx-zip").value || "").trim();
      fetchWeather(zip);
    };
  }

  function fetchWeather(zip) {
    var fuel = State.activeFuel;
    var a = State.data[fuel].analysis;
    State.weatherStatus[fuel] = "loading";
    renderWeather(a);
    App.weather.enrich(a, { zip: zip }).then(function (wj) {
      State.weather[fuel] = wj;
      State.weatherStatus[fuel] = wj.available ? "" : "No weather data was available for that location/date range.";
      regenTips();
      renderWeather(a); renderTips(); renderSavings(); renderAcPlan();
    }).catch(function (e) {
      State.weatherStatus[fuel] = (e && e.message ? e.message : "Weather lookup failed.") +
        " You can still use every other feature.";
      renderWeather(a); renderAcPlan();
    });
  }

  /* ---- rendering: AC playbook ------------------------------------------ */

  /* Place names come from a third-party geocoder — never trust them as markup. */
  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function acRow(cells, cls) {
    return "<tr" + (cls ? " class='" + cls + "'" : "") + ">" +
      cells.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
  }

  function renderAcPlan() {
    var box = document.getElementById("acplan-content");
    var panel = document.getElementById("panel-acplan");
    var a = State.data[State.activeFuel].analysis;

    if (a.fuel !== "electric" || a.granularity !== "hourly") { panel.hidden = true; return; }
    panel.hidden = false;

    var s = acctSettings();
    var wj = State.weather[State.activeFuel];
    var plan = App.acplan.generate(a, wj, s.profile);

    // Not enough info yet — ask for the one thing we need.
    if (!plan.available) {
      if (plan.reason === "no-ac") {
        box.innerHTML = "<div class='ac-noac'>You told us there's no AC here, so there's no schedule to tune. " +
          "The night-flush habit below is still the whole game: open up once it's cooler outside than in, " +
          "close by 8 AM, and keep blinds shut on west and south windows through the afternoon.</div>";
        return;
      }
      var status = State.weatherStatus[State.activeFuel];
      var zipGuess = App.weather.extractZip(a.meta.address);
      box.innerHTML =
        "<div class='ac-cta'><p>Enter your ZIP and Wattwise pulls your local forecast, then builds a " +
          "thermostat schedule around your " + (a.rates.detected ? a.rates.peakWindowLabel : "peak") +
          " window — exact temperatures, exact times.</p>" +
        "<div class='wx-form'>" +
          "<input id='ac-zip' class='input' type='text' inputmode='numeric' maxlength='5' placeholder='ZIP' value='" +
            (zipGuess || "") + "' />" +
          "<button id='ac-go' class='btn btn-primary'" + (status === "loading" ? " disabled" : "") + ">" +
            (status === "loading" ? "Fetching…" : "Build my AC schedule") + "</button>" +
        "</div>" +
        (status && status !== "loading" ? "<div class='wx-status'>" + status + "</div>" : "") +
        "</div>";
      var go = document.getElementById("ac-go");
      if (go) go.onclick = function () { fetchWeather((document.getElementById("ac-zip").value || "").trim()); };
      return;
    }

    var u = plan.unit;
    var r = plan.rates;

    // 1. The whole idea in one line.
    var thesis = r.detected
      ? "Power costs you <b>" + fmt.usd(r.peakRate, 2) + "</b> from " + r.windowLabel + " and <b>" +
        fmt.usd(r.offPeakRate, 2) + "</b> the rest of the day. Same cooling, different price — so cool early " +
        "and let the house coast through the expensive part."
      : "Cool the house early and let it coast through the late afternoon, when both the heat and the grid peak.";

    // 2. Forecast strip.
    var strip = plan.days.map(function (d) {
      var w = App.weather.describeCode(d.code);
      var b = App.acplan.bandFor(d.tMax);
      return "<div class='fc-day fc-" + b.key + "'>" +
        "<span class='fc-dow'>" + fmt.DOW_SHORT[d.date.getDay()] + " " + d.date.getDate() + "</span>" +
        "<span class='fc-ico'>" + w.icon + "</span>" +
        "<span class='fc-hi'>" + fmt.num(d.tMax, 0) + "°</span>" +
        "<span class='fc-lo'>" + fmt.num(d.tMin, 0) + "°</span>" +
        "</div>";
    }).join("");

    // 3. The schedule — the hero of this panel.
    var schedRows = plan.schedule.map(function (row) {
      return acRow([
        row.period,
        fmt.hour12(row.hour),
        "<b class='ac-temp'>" + row.temp + "°</b>",
        "<span class='ac-note'>" + row.note + "</span>"
      ], row.key ? "ac-key" : "");
    }).join("");

    // 4. Per-forecast adjustment bands, marked with how many days hit each.
    var counts = {};
    plan.dayRows.forEach(function (d) { counts[d.band] = (counts[d.band] || 0) + 1; });
    var bandRows = plan.bands.map(function (b) {
      var n = counts[b.key] || 0;
      return acRow([
        b.name + (n ? " <span class='ac-count'>" + n + " day" + (n > 1 ? "s" : "") + "</span>" : ""),
        b.precool == null ? "—" : "<b>" + b.precool + "°</b> at " + fmt.hour12(plan.precoolHour),
        b.peak == null ? "—" : "<b>" + b.peak + "°</b> at " + fmt.hour12(plan.peakStart),
        "<span class='ac-note'>" + b.meaning + "</span>"
      ], n ? "ac-band-active" : "ac-band-dim");
    }).join("");

    // 5. Night flush — usually the biggest free win.
    var nf = plan.nightFlush;
    var flushHtml = nf.applicable
      ? "<div class='ac-flush'><div class='ac-flush-num'>" + fmt.num(nf.gap, 0) + "°</div>" +
        "<div class='ac-flush-body'><b>Free air conditioning every night.</b> Lows run " +
        fmt.num(nf.minLow, 0) + "–" + fmt.num(nf.maxLow, 0) + "° this week, well under your " +
        nf.setpoint + "° setting. Open windows around " + fmt.hour12(nf.openHour) +
        " once it's cooler outside than in, and close them by " + fmt.hour12(nf.closeHour) +
        " before the outside air passes your indoor temperature." +
        (plan.morningLoad ? " On most days that alone handles your mornings — it may erase the " +
          fmt.pct(plan.morningLoad.vsAvgPct, 0) + "-above-average cooling we see in your 8 AM–noon data." : "") +
        " It costs nothing, so do it first.</div></div>"
      : "<div class='ac-flush ac-flush-off'><div class='ac-flush-body'>Overnight lows average " +
        fmt.num(nf.avgLow, 0) + "°, only " + fmt.num(Math.max(0, nf.gap), 0) + "° below your setting, so " +
        "night-flushing won't do much this week. Lean on the pre-cool schedule instead.</div></div>";

    box.innerHTML =
      "<div class='ac-head'>" +
        "<span class='ac-place'>📍 " + esc(plan.place || "your area") + "</span>" +
        (plan.current && plan.current.temp != null
          ? "<span class='ac-now'>" + fmt.num(plan.current.temp, 0) + "° now</span>" : "") +
        (plan.savings > 0 ? "<span class='save-chip'>~" + fmt.usd(plan.savings, 0) + "/season</span>" : "") +
      "</div>" +
      "<p class='ac-thesis'>" + thesis + "</p>" +
      "<div class='fc-strip'>" + strip + "</div>" +

      "<h3 class='ac-h3'>Set your thermostat to this</h3>" +
      "<div class='ac-table-wrap'><table class='ac-table'>" +
        "<thead><tr><th>Period</th><th>Time</th><th>Set to</th><th>Why</th></tr></thead>" +
        "<tbody>" + schedRows + "</tbody></table></div>" +
      "<p class='ac-only-two'>Only two numbers really matter: <b>" + plan.scheduleBand.precool + "° at " +
        fmt.hour12(plan.precoolHour) + "</b> is the chill-the-cooler step, done while power is cheap. <b>" +
        plan.scheduleBand.peak + "° at " + fmt.hour12(plan.peakStart) + "</b> is the keep-the-lid-shut step — " +
        "the AC mostly rests through the expensive hours and the house drifts up slowly." +
      "</p>" +

      "<h3 class='ac-h3'>The gap between the lines is free cooling</h3>" +
      "<div id='ac-chart' class='chart-holder'></div>" +
      flushHtml +

      "<h3 class='ac-h3'>Adjust for the day's forecast</h3>" +
      "<div class='ac-table-wrap'><table class='ac-table'>" +
        "<thead><tr><th>If the high is</th><th>Pre-cool</th><th>At peak</th><th>What it means</th></tr></thead>" +
        "<tbody>" + bandRows + "</tbody></table></div>" +

      "<div class='ac-habits'>" +
        plan.habits.map(function (h) {
          return "<div class='ac-habit'><span class='ac-habit-ico'>" + h.icon + "</span><span>" + h.text + "</span></div>";
        }).join("") +
        "<div class='ac-habit ac-caution'><span class='ac-habit-ico'>⚠️</span><span><b>One caution.</b> " +
          plan.caution + "</span></div>" +
      "</div>";

    charts.forecastLines(document.getElementById("ac-chart"), {
      days: plan.days, setpoint: plan.scheduleBand.sleep, height: 240
    });
  }

  /* ---- rendering: context / diagnostic questions ----------------------- */

  function renderContext() {
    var box = document.getElementById("context-content");
    var qs = activeQuestions();
    var s = acctSettings();
    var ans = s.answers[State.activeFuel];
    if (!qs.length) { box.innerHTML = "<div class='empty-hint'>No questions for this view.</div>"; return; }

    var answered = qs.filter(function (q) {
      var a = ans[q.id];
      return a != null && (!Array.isArray(a) || a.length);
    }).length;

    var head = "<div class='ctx-progress'><div class='ctx-progress-bar'><span style='width:" +
      (answered / qs.length * 100) + "%'></span></div><span class='ctx-progress-txt'>" +
      answered + " of " + qs.length + " answered · each answer sharpens your tips, and stays on this device</span></div>";

    var cards = qs.map(function (q) { return renderQuestionCard(q, ans[q.id], ans[q.id + ":text"]); }).join("");
    box.innerHTML = head + "<div class='q-list'>" + cards + "</div>";
    wireQuestionCards(box, qs);
  }

  function renderQuestionCard(q, ansVal, freeText) {
    var isAnswered = ansVal != null && (!Array.isArray(ansVal) || ansVal.length);
    var opts = q.options.map(function (o) {
      var sel = q.multi ? (Array.isArray(ansVal) && ansVal.indexOf(o.value) !== -1) : ansVal === o.value;
      return "<button type='button' class='q-opt" + (sel ? " q-opt-sel" : "") + "' data-q='" + q.id +
        "' data-val='" + o.value + "'>" +
        "<span class='q-mark" + (q.multi ? " q-mark-box" : "") + "'>" + (sel ? (q.multi ? "✓" : "●") : "") + "</span>" +
        "<span class='q-opt-label'>" + o.label + "</span></button>";
    }).join("");
    var freeOpt = q.options.some(function (o) { return o.free && (q.multi ? (Array.isArray(ansVal) && ansVal.indexOf(o.value) !== -1) : ansVal === o.value); });
    var freeInput = freeOpt ? "<input type='text' class='input q-free' data-q='" + q.id +
      "' placeholder='Tell us more (optional)' value='" + (freeText ? String(freeText).replace(/"/g, "&quot;") : "") + "' />" : "";
    return "<div class='q-card" + (isAnswered ? " q-answered" : "") + "'>" +
      "<div class='q-top'>" +
        "<div class='q-title'>" + q.title + (isAnswered ? " <span class='q-check'>✓</span>" : "") + "</div>" +
        (q.chip ? "<span class='q-chip'>" + q.chip + "</span>" : "") +
      "</div>" +
      (q.subtitle ? "<div class='q-sub'>" + q.subtitle + "</div>" : "") +
      "<div class='q-opts" + (q.multi ? " q-opts-multi" : "") + "'>" + opts + "</div>" +
      freeInput +
      (isAnswered ? "<button class='linkbtn q-clear' data-q='" + q.id + "'>Clear answer</button>" : "") +
      "</div>";
  }

  function wireQuestionCards(box, qs) {
    var byId = {};
    qs.forEach(function (q) { byId[q.id] = q; });
    box.querySelectorAll(".q-opt").forEach(function (btn) {
      btn.onclick = function () {
        var q = byId[btn.dataset.q];
        var ans = acctSettings().answers[State.activeFuel];
        if (q.multi) {
          var cur = Array.isArray(ans[q.id]) ? ans[q.id].slice() : [];
          var i = cur.indexOf(btn.dataset.val);
          if (i === -1) cur.push(btn.dataset.val); else cur.splice(i, 1);
          setAnswer(q, cur);
        } else {
          setAnswer(q, ans[q.id] === btn.dataset.val ? null : btn.dataset.val);
        }
      };
    });
    box.querySelectorAll(".q-free").forEach(function (inp) {
      inp.onchange = function () {
        var s = acctSettings();
        s.answers[State.activeFuel][inp.dataset.q + ":text"] = inp.value;
        saveSettings();
      };
      inp.onclick = function (e) { e.stopPropagation(); };
    });
    box.querySelectorAll(".q-clear").forEach(function (b) {
      b.onclick = function () { setAnswer(byId[b.dataset.q], null); };
    });
  }

  /* ---- rendering: events ----------------------------------------------- */

  var CAUSE_OPTIONS = [
    ["", "What caused this? (optional)"], ["ac", "Air conditioning"], ["ev", "EV charging"],
    ["laundry", "Laundry / dryer"], ["dishwasher", "Dishwasher"], ["cooking", "Cooking / oven"],
    ["pool", "Pool pump"], ["guests", "Guests over"], ["heater", "Space / water heater"], ["other", "Other"]
  ];

  var FILTERS = [["all", "All"], ["spike", "Spikes"], ["dip", "Quiet days"], ["high", "High severity"], ["estimated", "Estimated"]];

  function renderEventFilters() {
    var a = State.data[State.activeFuel].analysis;
    var box = document.getElementById("event-filters");
    box.innerHTML = FILTERS.map(function (f) {
      var n = a.events.filter(function (e) { return matchFilter(e, f[0]); }).length;
      if (f[0] !== "all" && n === 0) return "";
      return "<button class='chip" + (State.eventFilter === f[0] ? " active" : "") + "' data-filter='" + f[0] + "'>" +
        f[1] + " <span class='chip-n'>" + n + "</span></button>";
    }).join("");
    box.querySelectorAll("[data-filter]").forEach(function (b) {
      b.onclick = function () { State.eventFilter = b.dataset.filter; renderEvents(); renderEventFilters(); };
    });
  }

  function matchFilter(e, f) {
    if (f === "all") return true;
    if (f === "high") return e.severity === "high";
    return e.type === f;
  }

  function renderEvents() {
    var a = State.data[State.activeFuel].analysis;
    var s = acctSettings();
    var box = document.getElementById("events");
    var list = a.events.filter(function (e) { return matchFilter(e, State.eventFilter); });
    if (!list.length) { box.innerHTML = "<div class='empty-hint'>No events match this filter.</div>"; return; }
    box.innerHTML = list.map(function (e) {
      var ann = s.annotations[State.activeFuel][e.dateKey] || {};
      var sevColor = charts.SEV_COLOR[e.severity];
      var causeSel = e.type === "spike" ?
        "<select class='ev-cause input' data-key='" + e.dateKey + "'>" +
          CAUSE_OPTIONS.map(function (o) {
            return "<option value='" + o[0] + "'" + (ann.cause === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
          }).join("") + "</select>" : "";
      var awayToggle = "<label class='ev-away'><input type='checkbox' class='ev-away-cb' data-key='" +
        e.dateKey + "'" + (ann.away ? " checked" : "") + " /> I was away</label>";
      return "<div class='event ev-" + e.severity + (State.selectedDay === e.dateKey ? " ev-selected" : "") +
        "' data-key='" + e.dateKey + "'>" +
        "<div class='ev-spine' style='background:" + sevColor + "'></div>" +
        "<div class='ev-main'>" +
          "<div class='ev-top'><span class='ev-type ev-type-" + e.type + "'>" + eventTypeLabel(e) + "</span>" +
            "<span class='ev-title'>" + e.title + "</span>" +
            (e.costImpact > 0.5 ? "<span class='ev-cost'>≈ " + fmt.usd(e.costImpact) + " impact</span>" : "") +
            (ann.cause ? "<span class='ev-tag'>" + causeLabel(ann.cause) + "</span>" : "") + "</div>" +
          "<div class='ev-detail'>" + e.detail + "</div>" +
          "<div class='ev-tip'>💡 " + causeAwareTip(e, ann) + "</div>" +
          "<div class='ev-actions'>" + causeSel + awayToggle +
            "<button class='ev-spot linkbtn' data-key='" + e.dateKey + "'>Spotlight on charts →</button>" +
          "</div>" +
        "</div></div>";
    }).join("");

    box.querySelectorAll(".ev-cause").forEach(function (sel) {
      sel.onchange = function () {
        var s2 = acctSettings(); var an = s2.annotations[State.activeFuel];
        an[sel.dataset.key] = an[sel.dataset.key] || {};
        an[sel.dataset.key].cause = sel.value;
        saveSettings(); regenTips(); renderEvents(); renderTips();
      };
      sel.onclick = function (ev) { ev.stopPropagation(); };
    });
    box.querySelectorAll(".ev-away-cb").forEach(function (cb) {
      cb.onchange = function () {
        var s2 = acctSettings(); var an = s2.annotations[State.activeFuel];
        an[cb.dataset.key] = an[cb.dataset.key] || {};
        an[cb.dataset.key].away = cb.checked;
        saveSettings(); regenTips(); renderTips(); renderSavings(); renderContext(); renderEvents();
      };
      cb.onclick = function (ev) { ev.stopPropagation(); };
    });
    box.querySelectorAll(".ev-spot").forEach(function (b) {
      b.onclick = function (ev) { ev.stopPropagation(); setSelectedDay(b.dataset.key); };
    });
    box.querySelectorAll(".event").forEach(function (card) {
      card.onclick = function () { setSelectedDay(card.dataset.key); };
    });
  }

  function eventTypeLabel(e) {
    if (e.type === "spike") return e.scope === "hour" ? "HOURLY SPIKE" : "DAILY SPIKE";
    if (e.type === "dip") return "QUIET DAY";
    if (e.type === "estimated") return "ESTIMATED";
    return e.type.toUpperCase();
  }
  function causeLabel(c) {
    var m = { ac: "AC", ev: "EV", laundry: "Laundry", dishwasher: "Dishwasher", cooking: "Cooking",
      pool: "Pool", guests: "Guests", heater: "Heater", other: "Other" };
    return m[c] || c;
  }
  function causeAwareTip(e, ann) {
    if (ann && ann.away) return "Marked as a day you were away — great for measuring your always-on baseline.";
    if (ann && ann.cause) {
      var t = {
        ac: "Air conditioning during peak is pricey — pre-cool earlier and set back the thermostat 4–9 PM.",
        ev: "If this is EV charging, schedule it to start after 9 PM to dodge peak rates entirely.",
        laundry: "Laundry is flexible — run the dryer after 9 PM on the cheaper rate.",
        dishwasher: "Use the dishwasher's delay-start so it runs after 9 PM.",
        cooking: "Cooking loads are hard to shift; a microwave or air fryer beats the oven on hot days.",
        pool: "Move the pool pump timer fully into off-peak and trim total runtime.",
        guests: "Guest-driven — expected, no action needed.",
        heater: "Water/space heating is a top load; a timer or setback schedule helps.",
        other: "Noted — keep an eye on whether this repeats."
      };
      return t[ann.cause] || e.tip;
    }
    return e.tip;
  }

  function setSelectedDay(key) {
    State.selectedDay = (State.selectedDay === key) ? null : key;
    renderCharts();
    renderEvents();
    var panel = document.getElementById("chart-timeseries");
    if (State.selectedDay && panel) panel.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---- master render ---------------------------------------------------- */

  function render() {
    renderHead();
    renderKpis();
    renderBilling();
    renderInsights();
    renderSavings();
    renderTips();
    renderAcPlan();
    renderCharts();
    renderContext();
    renderEventFilters();
    renderEvents();
  }

  /* ---- billing modal ---------------------------------------------------- */

  function openBillingModal() {
    var a = State.data[State.activeFuel].analysis;
    var modal = document.getElementById("billing-modal");
    var s = State.settings[State.accountKey];
    var startEl = document.getElementById("billing-start");
    var endEl = document.getElementById("billing-end");
    if (s && s.billing) {
      startEl.value = s.billing.startISO; endEl.value = s.billing.endISO;
    } else {
      startEl.value = dateToIso(a.dateRange.start);
      endEl.value = dateToIso(addDays(a.dateRange.start, 29));
    }
    updateBillingPreview();
    modal.hidden = false;
  }
  function closeBillingModal() { document.getElementById("billing-modal").hidden = true; }

  function updateBillingPreview() {
    var a = State.data[State.activeFuel].analysis;
    var startISO = document.getElementById("billing-start").value;
    var endISO = document.getElementById("billing-end").value;
    var prev = document.getElementById("billing-preview");
    var b = computeBilling(a, startISO, endISO);
    if (!b) { prev.innerHTML = "<span class='bp-warn'>Pick a start date before the end date.</span>"; return; }
    var cur = b.cycles[b.cycles.length - 1];
    prev.innerHTML = "Cycle length <b>" + b.lenDays + " days</b> · covers <b>" + b.cycles.length +
      "</b> period" + (b.cycles.length > 1 ? "s" : "") + " of your data" +
      (cur && cur.partial ? " · current cycle projects to <b>" + fmt.usd(cur.projectedCost) + "</b>" : "");
  }

  function saveBilling() {
    var startISO = document.getElementById("billing-start").value;
    var endISO = document.getElementById("billing-end").value;
    if (!startISO || !endISO) { closeBillingModal(); return; }
    var s = State.settings[State.accountKey] ||
      (State.settings[State.accountKey] = { billing: null, profile: null, annotations: { electric: {}, gas: {} } });
    s.billing = { startISO: startISO, endISO: endISO };
    saveSettings();
    closeBillingModal();
    regenTips();
    render();
  }

  /* ---- theme ------------------------------------------------------------ */

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(cur);
    if (State.activeFuel) renderCharts();
  }

  /* ---- wiring ----------------------------------------------------------- */

  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function init() {
    loadSettings();
    try {
      var savedTheme = localStorage.getItem(THEME_KEY);
      if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
    } catch (e) {}

    var dz = document.getElementById("dropzone");
    var fi = document.getElementById("file-input");
    dz.onclick = function () { fi.click(); };
    dz.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } };
    fi.onchange = function () { if (fi.files.length) ingestFiles(fi.files); };
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragging"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("dragging"); });
    });
    dz.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files);
    });
    // allow dropping anywhere on the hero
    var hero = document.getElementById("hero");
    ["dragover", "drop"].forEach(function (ev) {
      hero.addEventListener(ev, function (e) { e.preventDefault(); });
    });

    document.getElementById("btn-sample").onclick = loadSample;
    document.getElementById("btn-new").onclick = function () {
      document.getElementById("file-input").click();
    };
    document.getElementById("btn-theme").onclick = toggleTheme;

    // metric toggle
    document.getElementById("metric-toggle").addEventListener("click", function (e) {
      var b = e.target.closest("[data-metric]"); if (!b) return;
      State.metric = b.dataset.metric;
      document.querySelectorAll("#metric-toggle .seg").forEach(function (s) { s.classList.remove("active"); });
      b.classList.add("active");
      renderCharts();
    });

    // billing modal wiring
    document.getElementById("btn-edit-billing").onclick = openBillingModal;
    document.getElementById("billing-close").onclick = closeBillingModal;
    document.getElementById("billing-skip").onclick = closeBillingModal;
    document.getElementById("billing-save").onclick = saveBilling;
    document.getElementById("billing-start").addEventListener("input", updateBillingPreview);
    document.getElementById("billing-end").addEventListener("input", updateBillingPreview);
    document.getElementById("billing-modal").addEventListener("click", function (e) {
      if (e.target.id === "billing-modal") closeBillingModal();
    });

    window.addEventListener("resize", debounce(function () {
      if (State.activeFuel) renderCharts();
    }, 180));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }

  App._state = State; // expose for debugging
})(window.App = window.App || {});
