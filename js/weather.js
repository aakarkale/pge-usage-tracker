/* ============================================================================
 * weather.js — Optional local-weather enrichment (runs in the user's browser).
 *
 * Privacy note: this is the ONE feature that makes a network request, and only
 * when the user opts in. Usage data never leaves the browser — only the ZIP
 * (or city) and the date range are sent, to free, key-less services:
 *   • ZIP → lat/lon via api.zippopotam.us (fallback: Open-Meteo geocoding)
 *   • hourly temperature via Open-Meteo (archive for older ranges, forecast
 *     endpoint for the recent past)
 *
 * All network calls are wrapped with timeouts and fallbacks; any failure is
 * surfaced as a friendly message and the dashboard keeps working without it.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var S = App.stats;

  function extractZip(address) {
    if (!address) return "";
    var m = String(address).match(/\b(\d{5})(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }

  function extractCity(address) {
    if (!address) return "";
    var parts = String(address).split(",");
    if (parts.length < 2) return "";
    // "SAN JOSE CA 95124" -> tokens before the 2-letter state code.
    var seg = parts[parts.length - 1].trim().replace(/\d/g, "").trim();
    var tokens = seg.split(/\s+/);
    if (tokens.length && /^[A-Za-z]{2}$/.test(tokens[tokens.length - 1])) tokens.pop();
    return tokens.join(" ").trim();
  }

  function fetchJson(url, timeoutMs) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
    return fetch(url, { signal: ctrl.signal, mode: "cors" })
      .then(function (r) {
        clearTimeout(to);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function (e) { clearTimeout(to); throw e; });
  }

  /* ZIP (or city) → {lat, lon, place}. */
  function geocode(opts) {
    var zip = opts.zip, city = opts.city;
    if (zip) {
      return fetchJson("https://api.zippopotam.us/us/" + encodeURIComponent(zip), 10000)
        .then(function (d) {
          var p = d.places && d.places[0];
          if (!p) throw new Error("no place");
          return {
            lat: parseFloat(p.latitude), lon: parseFloat(p.longitude),
            place: (p["place name"] || city || zip) + ", " + (p["state abbreviation"] || "")
          };
        })
        .catch(function () { return geocodeCity(city || zip); });
    }
    return geocodeCity(city);
  }

  function geocodeCity(name) {
    if (!name) return Promise.reject(new Error("No ZIP or city to locate."));
    return fetchJson("https://geocoding-api.open-meteo.com/v1/search?count=1&country=US&name=" +
      encodeURIComponent(name), 10000).then(function (d) {
      var r = d.results && d.results[0];
      if (!r) throw new Error("Couldn't locate \"" + name + "\".");
      return { lat: r.latitude, lon: r.longitude, place: r.name + (r.admin1 ? ", " + r.admin1 : "") };
    });
  }

  function ymd(d) {
    return d.getFullYear() + "-" + App.fmt.pad2(d.getMonth() + 1) + "-" + App.fmt.pad2(d.getDate());
  }

  /* Hourly temperature for [start, end]; picks the right Open-Meteo endpoint. */
  function fetchHourly(lat, lon, start, end, unitF) {
    var tz = "auto";
    var tunit = unitF === false ? "celsius" : "fahrenheit";
    var base = "&latitude=" + lat + "&longitude=" + lon +
      "&hourly=temperature_2m&temperature_unit=" + tunit +
      "&timezone=" + tz + "&start_date=" + ymd(start) + "&end_date=" + ymd(end);
    var today = new Date();
    var ageDays = (today - start) / 86400000;
    var forecastUrl = "https://api.open-meteo.com/v1/forecast?" + base.slice(1);
    var archiveUrl = "https://archive-api.open-meteo.com/v1/archive?" + base.slice(1);
    var primary = ageDays <= 90 ? forecastUrl : archiveUrl;
    var secondary = ageDays <= 90 ? archiveUrl : forecastUrl;

    function ok(d) { return d && d.hourly && d.hourly.time && d.hourly.time.length; }
    return fetchJson(primary, 14000).then(function (d) {
      if (ok(d)) return d;
      return fetchJson(secondary, 14000);
    }).catch(function () {
      return fetchJson(secondary, 14000);
    }).then(function (d) {
      if (!ok(d)) throw new Error("No weather data was returned for this location/date range.");
      return { unit: tunit === "fahrenheit" ? "°F" : "°C", time: d.hourly.time, temp: d.hourly.temperature_2m };
    });
  }

  /*
   * Join a fetched hourly series to the analysis. Pure & testable: pass the
   * raw {time, temp} arrays and get back the weatherJoin the UI/tips consume.
   */
  function join(analysis, hourly, place, unitLabel) {
    var byKey = {}; // dateKey -> [24]
    for (var i = 0; i < hourly.time.length; i++) {
      var t = hourly.time[i];
      var day = t.slice(0, 10);
      var hr = parseInt(t.slice(11, 13), 10);
      if (!byKey[day]) byKey[day] = new Array(24).fill(null);
      byKey[day][hr] = hourly.temp[i];
    }

    var daily = analysis.daily.map(function (d) {
      var temps = (byKey[d.dateKey] || []).filter(function (v) { return v != null; });
      return {
        dateKey: d.dateKey, date: d.date, usage: d.usage,
        peakUsage: d.peakUsage || 0,
        tMax: temps.length ? S.max(temps) : null,
        tMin: temps.length ? S.min(temps) : null,
        tMean: temps.length ? S.mean(temps) : null
      };
    });

    var us = [], tmax = [];
    daily.forEach(function (w) { if (w.tMax != null) { us.push(w.usage); tmax.push(w.tMax); } });

    return {
      place: place || "",
      unit: unitLabel || "°F",
      tempByKey: byKey,
      daily: daily,
      corr: S.correlation(tmax, us),
      hotThresh: tmax.length ? S.quantile(tmax, 0.7) : null,
      available: daily.some(function (w) { return w.tMax != null; })
    };
  }

  /* One-call convenience: locate + fetch + join. Returns a Promise. */
  function enrich(analysis, opts) {
    opts = opts || {};
    var zip = opts.zip || extractZip(analysis.meta.address);
    var city = opts.city || extractCity(analysis.meta.address);
    if (!zip && !city && !(opts.lat && opts.lon)) {
      return Promise.reject(new Error("No location found in the file. Enter a ZIP code to add weather."));
    }
    var locate = (opts.lat && opts.lon)
      ? Promise.resolve({ lat: opts.lat, lon: opts.lon, place: opts.place || (zip || city) })
      : geocode({ zip: zip, city: city });

    return locate.then(function (loc) {
      return fetchHourly(loc.lat, loc.lon, analysis.dateRange.start, analysis.dateRange.end, opts.fahrenheit)
        .then(function (h) {
          var wj = join(analysis, h, loc.place, h.unit);
          wj.lat = loc.lat; wj.lon = loc.lon; wj.zip = zip;
          return wj;
        });
    });
  }

  App.weather = {
    extractZip: extractZip,
    extractCity: extractCity,
    geocode: geocode,
    fetchHourly: fetchHourly,
    join: join,
    enrich: enrich
  };
})(window.App = window.App || {});
