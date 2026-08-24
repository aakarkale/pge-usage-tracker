/* ============================================================================
 * charts.js — Dependency-free SVG chart components.
 *
 * Every chart renders directly into a container element using its measured
 * width, so the app can simply re-render on resize. A single shared tooltip
 * div is reused across all charts. No external libraries — this keeps the app
 * self-contained (it even runs from file://) and lets us style everything to
 * match the dashboard exactly.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var fmt = App.fmt;

  /* ---- tiny SVG helpers ------------------------------------------------- */

  function el(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* Nice axis ticks. */
  function niceTicks(min, max, count) {
    if (min === max) { max = min + 1; }
    var range = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(range / count)));
    var err = (range / count) / step;
    if (err >= 7.5) step *= 10;
    else if (err >= 3.5) step *= 5;
    else if (err >= 1.5) step *= 2;
    var start = Math.ceil(min / step) * step;
    var ticks = [];
    for (var v = start; v <= max + step * 0.5; v += step) {
      ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return ticks;
  }

  /* ---- colour ----------------------------------------------------------- */

  function palette(fuel) {
    if (fuel === "gas") {
      return {
        accent: "#2dd4bf", accentSoft: "rgba(45,212,191,0.16)",
        line: "#2dd4bf", grad0: "rgba(45,212,191,0.42)", grad1: "rgba(45,212,191,0.02)"
      };
    }
    return {
      accent: "#ffc24b", accentSoft: "rgba(255,194,75,0.16)",
      line: "#ffc24b", grad0: "rgba(255,194,75,0.42)", grad1: "rgba(255,194,75,0.02)"
    };
  }

  // Thermal ramp (blue → teal → green → yellow → orange → red) for the heatmap.
  var HEAT = [
    [12, 26, 54], [23, 85, 126], [31, 158, 137],
    [127, 211, 78], [246, 215, 67], [247, 148, 32], [232, 59, 47]
  ];
  function heatColor(t) {
    t = clamp(t, 0, 1);
    var seg = t * (HEAT.length - 1);
    var i = Math.floor(seg);
    var f = seg - i;
    if (i >= HEAT.length - 1) return "rgb(" + HEAT[HEAT.length - 1].join(",") + ")";
    var a = HEAT[i], b = HEAT[i + 1];
    var r = Math.round(a[0] + (b[0] - a[0]) * f);
    var g = Math.round(a[1] + (b[1] - a[1]) * f);
    var bl = Math.round(a[2] + (b[2] - a[2]) * f);
    return "rgb(" + r + "," + g + "," + bl + ")";
  }

  var SEV_COLOR = { high: "#ff5c6c", medium: "#ffb020", low: "#6ea8ff" };

  /* ---- shared tooltip --------------------------------------------------- */

  var tipEl = null;
  function tooltip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "chart-tip";
      tipEl.style.opacity = "0";
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    var t = tooltip();
    t.innerHTML = html;
    t.style.opacity = "1";
    var w = t.offsetWidth, h = t.offsetHeight;
    var px = x + 14, py = y + 14;
    if (px + w > window.innerWidth - 8) px = x - w - 14;
    if (py + h > window.innerHeight - 8) py = y - h - 14;
    t.style.left = Math.max(8, px) + "px";
    t.style.top = Math.max(8, py) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = "0"; }

  /* ---- time-series (daily) --------------------------------------------- */

  function timeSeries(container, opts) {
    clear(container);
    var daily = opts.daily;
    if (!daily.length) return;
    var pal = palette(opts.fuel);
    var metric = opts.metric || "usage";
    var W = container.clientWidth || 640;
    var H = opts.height || 300;
    var m = { t: 18, r: 16, b: 30, l: 48 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var vals = daily.map(function (d) { return d[metric]; });
    var vmax = Math.max.apply(null, vals) * 1.12 || 1;
    var vmin = 0;
    var t0 = daily[0].date.getTime();
    var t1 = daily[daily.length - 1].date.getTime();
    var span = (t1 - t0) || 1;

    function X(t) { return m.l + ((t - t0) / span) * iw; }
    function Y(v) { return m.t + ih - ((v - vmin) / (vmax - vmin)) * ih; }

    var svg = el("svg", { width: W, height: H, class: "chart-svg", role: "img" });

    // gradient
    var defs = el("defs");
    var gid = "grad-" + opts.fuel + "-" + metric;
    var lg = el("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.appendChild(el("stop", { offset: "0%", "stop-color": metric === "cost" ? "#8b5cf6" : pal.grad0 }));
    lg.appendChild(el("stop", { offset: "100%", "stop-color": metric === "cost" ? "rgba(139,92,246,0.02)" : pal.grad1 }));
    defs.appendChild(lg);
    svg.appendChild(defs);
    var lineColor = metric === "cost" ? "#a78bfa" : pal.line;

    // y gridlines + labels
    var yticks = niceTicks(vmin, vmax, 4);
    yticks.forEach(function (v) {
      var y = Y(v);
      svg.appendChild(el("line", { x1: m.l, y1: y, x2: m.l + iw, y2: y, class: "grid-line" }));
      var lbl = el("text", { x: m.l - 8, y: y + 4, class: "axis-label", "text-anchor": "end" });
      lbl.textContent = metric === "cost" ? fmt.usdCompact(v) : fmt.num(v, v < 10 ? 1 : 0);
      svg.appendChild(lbl);
    });

    // x labels (~6)
    var xcount = Math.min(6, daily.length);
    for (var i = 0; i < xcount; i++) {
      var idx = Math.round(i * (daily.length - 1) / Math.max(1, xcount - 1));
      var d = daily[idx].date;
      var x = X(d.getTime());
      var xl = el("text", { x: x, y: H - 10, class: "axis-label", "text-anchor": "middle" });
      xl.textContent = fmt.dateShort(d);
      svg.appendChild(xl);
    }

    // area + line paths
    var areaD = "M " + X(t0) + " " + Y(0);
    var lineD = "";
    daily.forEach(function (d, k) {
      var x = X(d.date.getTime()), y = Y(d[metric]);
      areaD += " L " + x + " " + y;
      lineD += (k === 0 ? "M " : " L ") + x + " " + y;
    });
    areaD += " L " + X(t1) + " " + Y(0) + " Z";
    svg.appendChild(el("path", { d: areaD, fill: "url(#" + gid + ")", stroke: "none" }));
    svg.appendChild(el("path", { d: lineD, fill: "none", stroke: lineColor, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round", class: "series-line" }));

    // moving average (usage only)
    if (metric === "usage" && opts.ma) {
      var maD = "";
      opts.ma.forEach(function (v, k) {
        var x = X(daily[k].date.getTime()), y = Y(v);
        maD += (k === 0 ? "M " : " L ") + x + " " + y;
      });
      svg.appendChild(el("path", { d: maD, fill: "none", "stroke-width": 1.5,
        "stroke-dasharray": "4 4", class: "ma-line" }));
    }

    // event markers
    var evtByKey = {};
    (opts.events || []).forEach(function (e) {
      var cur = evtByKey[e.dateKey];
      if (!cur || (cur === "low" && e.severity !== "low") || (cur === "medium" && e.severity === "high")) {
        evtByKey[e.dateKey] = e.severity;
      }
    });
    daily.forEach(function (d) {
      var sev = evtByKey[d.dateKey];
      if (!sev) return;
      var x = X(d.date.getTime()), y = Y(d[metric]);
      svg.appendChild(el("circle", { cx: x, cy: y, r: 4.5, fill: SEV_COLOR[sev],
        stroke: "#0b1220", "stroke-width": 1.5, class: "evt-dot" }));
    });

    // highlight selected day
    if (opts.highlightKey) {
      daily.forEach(function (d) {
        if (d.dateKey === opts.highlightKey) {
          var x = X(d.date.getTime());
          svg.appendChild(el("line", { x1: x, y1: m.t, x2: x, y2: m.t + ih,
            stroke: lineColor, "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0.6 }));
          svg.appendChild(el("circle", { cx: x, cy: Y(d[metric]), r: 6, fill: "none",
            stroke: lineColor, "stroke-width": 2 }));
        }
      });
    }

    // hover interaction
    var focus = el("g", { opacity: 0 });
    var fLine = el("line", { y1: m.t, y2: m.t + ih, "stroke-width": 1, class: "focus-line" });
    var fDot = el("circle", { r: 4.5, class: "focus-dot" });
    focus.appendChild(fLine); focus.appendChild(fDot);
    svg.appendChild(focus);

    var overlay = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent",
      style: "cursor:crosshair" });
    overlay.addEventListener("mousemove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var frac = clamp((mx - m.l) / iw, 0, 1);
      var idx = Math.round(frac * (daily.length - 1));
      var d = daily[idx];
      var x = X(d.date.getTime()), y = Y(d[metric]);
      focus.setAttribute("opacity", 1);
      fLine.setAttribute("x1", x); fLine.setAttribute("x2", x);
      fDot.setAttribute("cx", x); fDot.setAttribute("cy", y);
      var html = "<div class='tt-title'>" + fmt.dateDow(d.date) +
        (d.estimated ? " <span class='tt-tag'>est.</span>" : "") + "</div>" +
        "<div class='tt-row'><span class='tt-key'>Usage</span><span class='tt-val'>" +
        fmt.num(d.usage) + " " + opts.unit + "</span></div>" +
        "<div class='tt-row'><span class='tt-key'>Cost</span><span class='tt-val'>" +
        fmt.usd(d.cost) + "</span></div>";
      showTip(html, ev.clientX, ev.clientY);
    });
    overlay.addEventListener("mouseleave", function () { focus.setAttribute("opacity", 0); hideTip(); });
    overlay.addEventListener("click", function (ev) {
      var rect = svg.getBoundingClientRect();
      var frac = clamp((ev.clientX - rect.left - m.l) / iw, 0, 1);
      var idx = Math.round(frac * (daily.length - 1));
      if (opts.onSelectDay) opts.onSelectDay(daily[idx].dateKey);
    });
    svg.appendChild(overlay);

    container.appendChild(svg);
  }

  /* ---- heatmap (day × hour) -------------------------------------------- */

  function heatmap(container, opts) {
    clear(container);
    var daily = opts.daily;
    if (!daily.length) return;
    var W = container.clientWidth || 720;
    var m = { t: 26, r: 14, b: 8, l: 54 };
    var rowH = daily.length > 45 ? 12 : (daily.length > 30 ? 15 : 20);
    var iw = W - m.l - m.r;
    var cellW = iw / 24;
    var H = m.t + daily.length * rowH + m.b;

    // colour scale top = robust p98 of hourly usage
    var allHours = [];
    daily.forEach(function (d) { d.hours.forEach(function (h) { if (h != null) allHours.push(h); }); });
    allHours.sort(function (a, b) { return a - b; });
    var scaleMax = allHours.length ? allHours[Math.floor(allHours.length * 0.98)] : 1;
    if (scaleMax <= 0) scaleMax = 1;

    var svg = el("svg", { width: W, height: H, class: "chart-svg" });
    var peakHours = opts.peakHours || [];

    // peak window backdrop
    if (peakHours.length) {
      var px = m.l + peakHours[0] * cellW;
      var pw = peakHours.length * cellW;
      svg.appendChild(el("rect", { x: px, y: 4, width: pw, height: H - 8, rx: 3, class: "peak-band" }));
      var pl = el("text", { x: px + pw / 2, y: 12, class: "axis-label", "text-anchor": "middle",
        style: "font-weight:600;fill:var(--accent)" });
      pl.textContent = "PEAK " + opts.peakLabel;
      svg.appendChild(pl);
    }

    // hour column labels
    for (var h = 0; h <= 24; h += 3) {
      var x = m.l + h * cellW;
      var hl = el("text", { x: x, y: 22, class: "axis-label", "text-anchor": "middle" });
      hl.textContent = h === 24 ? "" : fmt.hour12Compact(h);
      svg.appendChild(hl);
    }

    // rows
    var byKey = {};
    daily.forEach(function (d, r) { byKey[d.dateKey] = r; });

    daily.forEach(function (d, r) {
      var y = m.t + r * rowH;
      // row label every few rows + first/last
      if (r % (daily.length > 40 ? 5 : 3) === 0 || r === daily.length - 1) {
        var rl = el("text", { x: m.l - 8, y: y + rowH / 2 + 3, class: "axis-label", "text-anchor": "end" });
        rl.textContent = fmt.dateShort(d.date);
        svg.appendChild(rl);
      }
      for (var hh = 0; hh < 24; hh++) {
        var u = d.hours[hh];
        var cx = m.l + hh * cellW;
        var color = u == null ? "var(--cell-empty)" : heatColor(u / scaleMax);
        var cell = el("rect", {
          x: cx + 0.5, y: y + 0.5, width: Math.max(1, cellW - 1), height: rowH - 1,
          fill: color, rx: 1.5, class: "heat-cell"
        });
        cell.__d = d; cell.__h = hh; cell.__u = u;
        svg.appendChild(cell);
      }
    });

    // outline event cells
    (opts.events || []).forEach(function (e) {
      if (e.scope !== "hour") return;
      var r = byKey[e.dateKey];
      if (r == null) return;
      var s = e.hourStart != null ? e.hourStart : e.hour;
      var en = e.hourEnd != null ? e.hourEnd : e.hour;
      var y = m.t + r * rowH;
      svg.appendChild(el("rect", { x: m.l + s * cellW + 0.5, y: y + 0.5,
        width: (en - s + 1) * cellW - 1, height: rowH - 1, fill: "none",
        stroke: "#fff", "stroke-width": 1.5, rx: 2, opacity: 0.9, "pointer-events": "none" }));
    });

    // highlight row
    if (opts.highlightKey && byKey[opts.highlightKey] != null) {
      var hr = byKey[opts.highlightKey];
      svg.appendChild(el("rect", { x: m.l, y: m.t + hr * rowH, width: iw, height: rowH,
        fill: "none", stroke: "var(--accent)", "stroke-width": 2, rx: 2, "pointer-events": "none" }));
    }

    // interaction (event delegation)
    svg.addEventListener("mousemove", function (ev) {
      var target = ev.target;
      if (target.__d === undefined) { hideTip(); return; }
      var d = target.__d, hh = target.__h, u = target.__u;
      var base = opts.byHod ? opts.byHod[hh].median : 0;
      var cmp = base > 0 && u != null ? fmt.signedPct((u / base - 1) * 100) + " vs usual" : "";
      var html = "<div class='tt-title'>" + fmt.dateDow(d.date) + " · " + fmt.hourRange(hh) + "</div>" +
        "<div class='tt-row'><span class='tt-key'>Usage</span><span class='tt-val'>" +
        (u == null ? "—" : fmt.num(u, 2) + " " + opts.unit) + "</span></div>" +
        (cmp ? "<div class='tt-sub'>" + cmp + "</div>" : "");
      showTip(html, ev.clientX, ev.clientY);
    });
    svg.addEventListener("mouseleave", hideTip);
    svg.addEventListener("click", function (ev) {
      if (ev.target.__d && opts.onSelectDay) opts.onSelectDay(ev.target.__d.dateKey);
    });

    container.appendChild(svg);

    // legend
    var legend = document.createElement("div");
    legend.className = "heat-legend";
    var grad = "linear-gradient(to right,";
    for (var s2 = 0; s2 <= 10; s2++) grad += heatColor(s2 / 10) + (s2 < 10 ? "," : "");
    grad += ")";
    legend.innerHTML =
      "<span class='heat-legend-label'>Low</span>" +
      "<span class='heat-legend-bar' style='background:" + grad + "'></span>" +
      "<span class='heat-legend-label'>High · " + fmt.num(scaleMax, 1) + "+ " + opts.unit + "/hr</span>";
    container.appendChild(legend);
  }

  /* ---- hour-of-day load curve ------------------------------------------ */

  function loadCurve(container, opts) {
    clear(container);
    var byHod = opts.byHod;
    if (!byHod) return;
    var pal = palette(opts.fuel);
    var W = container.clientWidth || 640;
    var H = opts.height || 260;
    var m = { t: 16, r: 14, b: 28, l: 46 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var vmax = 0;
    byHod.forEach(function (b) { if (b.p95 > vmax) vmax = b.p95; if (b.mean > vmax) vmax = b.mean; });
    vmax *= 1.12; if (vmax <= 0) vmax = 1;

    function X(h) { return m.l + (h / 23) * iw; }
    function Y(v) { return m.t + ih - (v / vmax) * ih; }

    var svg = el("svg", { width: W, height: H, class: "chart-svg" });

    // peak shading
    var peakHours = opts.peakHours || [];
    if (peakHours.length) {
      svg.appendChild(el("rect", { x: X(peakHours[0]), y: m.t,
        width: X(peakHours[peakHours.length - 1]) - X(peakHours[0]) + iw / 23, height: ih,
        class: "peak-band" }));
    }

    // y grid
    niceTicks(0, vmax, 4).forEach(function (v) {
      var y = Y(v);
      svg.appendChild(el("line", { x1: m.l, y1: y, x2: m.l + iw, y2: y, class: "grid-line" }));
      var lbl = el("text", { x: m.l - 8, y: y + 4, class: "axis-label", "text-anchor": "end" });
      lbl.textContent = fmt.num(v, v < 1 ? 2 : v < 10 ? 1 : 0);
      svg.appendChild(lbl);
    });
    // x labels
    for (var h = 0; h < 24; h += 3) {
      var xl = el("text", { x: X(h), y: H - 9, class: "axis-label", "text-anchor": "middle" });
      xl.textContent = fmt.hour12Compact(h);
      svg.appendChild(xl);
    }

    // p25-p75 band
    var bandTop = "", bandBot = "";
    byHod.forEach(function (b, i) {
      bandTop += (i === 0 ? "M " : " L ") + X(b.hod) + " " + Y(b.p75);
    });
    for (var j = byHod.length - 1; j >= 0; j--) {
      bandBot += " L " + X(byHod[j].hod) + " " + Y(byHod[j].p25);
    }
    svg.appendChild(el("path", { d: bandTop + bandBot + " Z", fill: pal.accentSoft, stroke: "none" }));

    // mean line
    var lineD = "";
    byHod.forEach(function (b, i) { lineD += (i === 0 ? "M " : " L ") + X(b.hod) + " " + Y(b.mean); });
    svg.appendChild(el("path", { d: lineD, fill: "none", stroke: pal.line, "stroke-width": 2.5,
      "stroke-linejoin": "round" }));

    // dots + hover
    byHod.forEach(function (b) {
      var dot = el("circle", { cx: X(b.hod), cy: Y(b.mean), r: 6, fill: "transparent",
        style: "cursor:pointer" });
      dot.addEventListener("mousemove", function (ev) {
        var html = "<div class='tt-title'>" + fmt.hourRange(b.hod) + "</div>" +
          "<div class='tt-row'><span class='tt-key'>Average</span><span class='tt-val'>" +
          fmt.num(b.mean, 2) + " " + opts.unit + "</span></div>" +
          "<div class='tt-row'><span class='tt-key'>Typical range</span><span class='tt-val'>" +
          fmt.num(b.p25, 2) + "–" + fmt.num(b.p75, 2) + "</span></div>";
        showTip(html, ev.clientX, ev.clientY);
      });
      dot.addEventListener("mouseleave", hideTip);
      svg.appendChild(el("circle", { cx: X(b.hod), cy: Y(b.mean), r: 2.5, fill: pal.line }));
      svg.appendChild(dot);
    });

    container.appendChild(svg);
  }

  /* ---- weekday bars ----------------------------------------------------- */

  function weekdayBars(container, opts) {
    clear(container);
    var byDow = opts.byDow;
    var pal = palette(opts.fuel);
    var W = container.clientWidth || 420;
    var H = opts.height || 220;
    var m = { t: 14, r: 12, b: 26, l: 40 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var vmax = 0;
    byDow.forEach(function (b) { if (b.meanUsage > vmax) vmax = b.meanUsage; });
    vmax *= 1.15; if (vmax <= 0) vmax = 1;
    var bw = iw / 7 * 0.64;
    var gap = iw / 7;

    var svg = el("svg", { width: W, height: H, class: "chart-svg" });
    niceTicks(0, vmax, 3).forEach(function (v) {
      var y = m.t + ih - (v / vmax) * ih;
      svg.appendChild(el("line", { x1: m.l, y1: y, x2: m.l + iw, y2: y, class: "grid-line" }));
      var lbl = el("text", { x: m.l - 6, y: y + 4, class: "axis-label", "text-anchor": "end" });
      lbl.textContent = fmt.num(v, v < 10 ? 1 : 0);
      svg.appendChild(lbl);
    });

    byDow.forEach(function (b, i) {
      var x = m.l + i * gap + (gap - bw) / 2;
      var bh = (b.meanUsage / vmax) * ih;
      var y = m.t + ih - bh;
      var weekend = (b.dow === 0 || b.dow === 6);
      var rect = el("rect", { x: x, y: y, width: bw, height: Math.max(0, bh), rx: 4,
        fill: weekend ? pal.accent : "var(--bar-neutral)", style: "cursor:pointer",
        class: "bar" });
      rect.addEventListener("mousemove", function (ev) {
        var html = "<div class='tt-title'>" + fmt.DOW_SHORT[b.dow] + "</div>" +
          "<div class='tt-row'><span class='tt-key'>Avg usage</span><span class='tt-val'>" +
          fmt.num(b.meanUsage) + " " + opts.unit + "</span></div>" +
          "<div class='tt-row'><span class='tt-key'>Avg cost</span><span class='tt-val'>" +
          fmt.usd(b.meanCost) + "</span></div>";
        showTip(html, ev.clientX, ev.clientY);
      });
      rect.addEventListener("mouseleave", hideTip);
      svg.appendChild(rect);
      var xl = el("text", { x: m.l + i * gap + gap / 2, y: H - 9, class: "axis-label", "text-anchor": "middle" });
      xl.textContent = fmt.DOW_SHORT[b.dow][0];
      svg.appendChild(xl);
    });

    container.appendChild(svg);
  }

  /* ---- sparkline (KPI cards) ------------------------------------------- */

  function sparkline(container, values, opts) {
    clear(container);
    if (!values.length) return;
    var W = container.clientWidth || 120;
    var H = opts && opts.height ? opts.height : 40;
    var color = (opts && opts.color) || "#ffc24b";
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    var span = (max - min) || 1;
    var svg = el("svg", { width: W, height: H, class: "spark" });
    var d = "", area = "M 0 " + H;
    values.forEach(function (v, i) {
      var x = (i / (values.length - 1)) * W;
      var y = H - 3 - ((v - min) / span) * (H - 6);
      d += (i === 0 ? "M " : " L ") + x.toFixed(1) + " " + y.toFixed(1);
      area += " L " + x.toFixed(1) + " " + y.toFixed(1);
    });
    area += " L " + W + " " + H + " Z";
    var gid = "spk-" + Math.random().toString(36).slice(2, 8);
    var defs = el("defs");
    var lg = el("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.appendChild(el("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.35 }));
    lg.appendChild(el("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }));
    defs.appendChild(lg); svg.appendChild(defs);
    svg.appendChild(el("path", { d: area, fill: "url(#" + gid + ")" }));
    svg.appendChild(el("path", { d: d, fill: "none", stroke: color, "stroke-width": 1.75,
      "stroke-linejoin": "round", "stroke-linecap": "round" }));
    container.appendChild(svg);
  }

  /* ---- horizontal split bar (peak vs off-peak) ------------------------- */

  function splitBar(container, segments) {
    clear(container);
    var total = segments.reduce(function (s, x) { return s + x.value; }, 0) || 1;
    var bar = document.createElement("div");
    bar.className = "split-bar";
    segments.forEach(function (seg) {
      var d = document.createElement("div");
      d.className = "split-seg";
      d.style.width = (seg.value / total * 100) + "%";
      d.style.background = seg.color;
      d.title = seg.label + ": " + Math.round(seg.value / total * 100) + "%";
      bar.appendChild(d);
    });
    container.appendChild(bar);
    var legend = document.createElement("div");
    legend.className = "split-legend";
    segments.forEach(function (seg) {
      var item = document.createElement("div");
      item.className = "split-legend-item";
      item.innerHTML = "<span class='dot' style='background:" + seg.color + "'></span>" +
        seg.label + " <b>" + Math.round(seg.value / total * 100) + "%</b>";
      legend.appendChild(item);
    });
    container.appendChild(legend);
  }

  /* ---- scatter (usage vs temperature) ---------------------------------- */

  function scatter(container, opts) {
    clear(container);
    var pts = opts.points.filter(function (p) { return p.x != null && p.y != null; });
    if (!pts.length) return;
    var pal = palette(opts.fuel);
    var W = container.clientWidth || 520;
    var H = opts.height || 260;
    var m = { t: 16, r: 16, b: 34, l: 46 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var xs = pts.map(function (p) { return p.x; });
    var ys = pts.map(function (p) { return p.y; });
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymax = Math.max.apply(null, ys) * 1.1, ymin = 0;
    var xpad = (xmax - xmin) * 0.08 || 1;
    xmin -= xpad; xmax += xpad;
    function X(v) { return m.l + ((v - xmin) / (xmax - xmin)) * iw; }
    function Y(v) { return m.t + ih - ((v - ymin) / (ymax - ymin)) * ih; }

    var svg = el("svg", { width: W, height: H, class: "chart-svg" });
    niceTicks(ymin, ymax, 4).forEach(function (v) {
      var y = Y(v);
      svg.appendChild(el("line", { x1: m.l, y1: y, x2: m.l + iw, y2: y, class: "grid-line" }));
      var lbl = el("text", { x: m.l - 8, y: y + 4, class: "axis-label", "text-anchor": "end" });
      lbl.textContent = fmt.num(v, v < 10 ? 1 : 0);
      svg.appendChild(lbl);
    });
    niceTicks(xmin, xmax, 5).forEach(function (v) {
      var x = X(v);
      var lbl = el("text", { x: x, y: H - 10, class: "axis-label", "text-anchor": "middle" });
      lbl.textContent = fmt.num(v, 0) + "°";
      svg.appendChild(lbl);
    });
    // axis captions
    var xc = el("text", { x: m.l + iw / 2, y: H - 22, class: "axis-caption", "text-anchor": "middle" });
    xc.textContent = "Daily high temperature";
    svg.appendChild(xc);

    // trend line (least squares)
    if (pts.length >= 3) {
      var mx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
      var my = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
      var num = 0, den = 0;
      for (var i = 0; i < pts.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
      if (den > 0) {
        var slope = num / den, intc = my - slope * mx;
        svg.appendChild(el("line", {
          x1: X(xmin), y1: Y(Math.max(ymin, Math.min(ymax, slope * xmin + intc))),
          x2: X(xmax), y2: Y(Math.max(ymin, Math.min(ymax, slope * xmax + intc))),
          "stroke-width": 1.5, "stroke-dasharray": "5 4", class: "trend-line"
        }));
      }
    }

    pts.forEach(function (p) {
      var dot = el("circle", { cx: X(p.x), cy: Y(p.y), r: 4.5, fill: pal.accent,
        "fill-opacity": 0.75, stroke: "#0b1220", "stroke-width": 0.75, style: "cursor:pointer" });
      dot.addEventListener("mousemove", function (ev) {
        var html = "<div class='tt-title'>" + (p.label || "") + "</div>" +
          "<div class='tt-row'><span class='tt-key'>High</span><span class='tt-val'>" + fmt.num(p.x, 0) + "°</span></div>" +
          "<div class='tt-row'><span class='tt-key'>Usage</span><span class='tt-val'>" +
          fmt.num(p.y) + " " + opts.unit + "</span></div>";
        showTip(html, ev.clientX, ev.clientY);
      });
      dot.addEventListener("mouseleave", hideTip);
      svg.appendChild(dot);
    });

    container.appendChild(svg);
  }

  /* ---- forecast lines (high / low / setpoint) --------------------------- */
  /*
   * The story this chart tells: the vertical gap between the overnight-low
   * line and your setpoint line is free cooling you can let into the house.
   */
  function forecastLines(container, opts) {
    clear(container);
    var days = opts.days || [];
    if (days.length < 2) return;
    var W = container.clientWidth || 600;
    var H = opts.height || 250;
    var m = { t: 16, r: 14, b: 44, l: 42 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var all = [];
    days.forEach(function (d) { all.push(d.tMax, d.tMin); });
    all.push(opts.setpoint);
    var vmin = Math.floor((Math.min.apply(null, all) - 8) / 10) * 10;
    var vmax = Math.ceil((Math.max.apply(null, all) + 8) / 10) * 10;

    function X(i) { return m.l + (i / (days.length - 1)) * iw; }
    function Y(v) { return m.t + ih - ((v - vmin) / (vmax - vmin)) * ih; }

    var svg = el("svg", { width: W, height: H, class: "chart-svg" });

    niceTicks(vmin, vmax, 4).forEach(function (v) {
      var y = Y(v);
      svg.appendChild(el("line", { x1: m.l, y1: y, x2: m.l + iw, y2: y, class: "grid-line" }));
      var lbl = el("text", { x: m.l - 8, y: y + 4, class: "axis-label", "text-anchor": "end" });
      lbl.textContent = fmt.num(v, 0) + "°";
      svg.appendChild(lbl);
    });

    // Shade the free-cooling gap between the setpoint and the overnight lows.
    var gapD = "";
    days.forEach(function (d, i) { gapD += (i === 0 ? "M " : " L ") + X(i) + " " + Y(opts.setpoint); });
    for (var j = days.length - 1; j >= 0; j--) gapD += " L " + X(j) + " " + Y(days[j].tMin);
    svg.appendChild(el("path", { d: gapD + " Z", stroke: "none", class: "gap-fill" }));

    var SERIES = [
      { key: "tMax", color: "#6ea8ff", label: "Daytime high" },
      { key: "tMin", color: "#ff9d5c", label: "Overnight low" }
    ];
    SERIES.forEach(function (s) {
      var d = "";
      days.forEach(function (day, i) { d += (i === 0 ? "M " : " L ") + X(i) + " " + Y(day[s.key]); });
      svg.appendChild(el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": 2.25,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
      days.forEach(function (day, i) {
        svg.appendChild(el("circle", { cx: X(i), cy: Y(day[s.key]), r: 3, fill: s.color }));
      });
    });

    // Flat setpoint reference line.
    svg.appendChild(el("line", { x1: X(0), y1: Y(opts.setpoint), x2: X(days.length - 1),
      y2: Y(opts.setpoint), "stroke-width": 2, "stroke-dasharray": "5 4", class: "setpoint-line" }));

    days.forEach(function (day, i) {
      var xl = el("text", { x: X(i), y: H - 26, class: "axis-label", "text-anchor": "middle" });
      xl.textContent = fmt.DOW_SHORT[day.date.getDay()];
      svg.appendChild(xl);
      var xd = el("text", { x: X(i), y: H - 14, class: "axis-label", "text-anchor": "middle",
        style: "opacity:.65" });
      xd.textContent = day.date.getDate();
      svg.appendChild(xd);

      // Invisible hover column for a per-day tooltip.
      var half = iw / (days.length - 1) / 2;
      var hit = el("rect", { x: X(i) - half, y: m.t, width: half * 2, height: ih,
        fill: "transparent", style: "cursor:pointer" });
      hit.addEventListener("mousemove", function (ev) {
        var gap = opts.setpoint - day.tMin;
        showTip("<div class='tt-title'>" + fmt.dateDow(day.date) + "</div>" +
          "<div class='tt-row'><span class='tt-key'>High</span><span class='tt-val'>" + fmt.num(day.tMax, 0) + "°</span></div>" +
          "<div class='tt-row'><span class='tt-key'>Low</span><span class='tt-val'>" + fmt.num(day.tMin, 0) + "°</span></div>" +
          (gap > 0 ? "<div class='tt-sub'>" + fmt.num(gap, 0) + "° of free cooling overnight</div>" : ""),
          ev.clientX, ev.clientY);
      });
      hit.addEventListener("mouseleave", hideTip);
      svg.appendChild(hit);
    });

    container.appendChild(svg);

    var legend = document.createElement("div");
    legend.className = "split-legend";
    legend.innerHTML =
      "<div class='split-legend-item'><span class='dot' style='background:#6ea8ff'></span>Daytime high</div>" +
      "<div class='split-legend-item'><span class='dot' style='background:#ff9d5c'></span>Overnight low</div>" +
      "<div class='split-legend-item'><span class='dot' style='background:var(--cool)'></span>Your " +
        fmt.num(opts.setpoint, 0) + "° setting</div>";
    container.appendChild(legend);
  }

  App.charts = {
    palette: palette,
    forecastLines: forecastLines,
    heatColor: heatColor,
    timeSeries: timeSeries,
    heatmap: heatmap,
    loadCurve: loadCurve,
    weekdayBars: weekdayBars,
    sparkline: sparkline,
    splitBar: splitBar,
    scatter: scatter,
    hideTip: hideTip,
    SEV_COLOR: SEV_COLOR
  };
})(window.App = window.App || {});
