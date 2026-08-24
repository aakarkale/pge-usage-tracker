/* ============================================================================
 * parse.js — PG&E "Green Button" interval CSV parser.
 *
 * PG&E exports look like:
 *
 *     Name,Sample Customer
 *     Address,"123 Example St, SAN JOSE CA 95124"
 *     Account Number,9000000000
 *     Service,9000000001
 *
 *     TYPE,DATE,START TIME,END TIME,USAGE (kWh),COST,NOTES
 *     Electric usage,7/2/2026,0:00,0:59,0.38,$0.12 ,
 *     ...
 *
 * Gas exports are identical but daily (one row per day, 0:00–23:59) with a
 * "USAGE (therms)" column. This parser is tolerant of both, of a leading BOM,
 * of quoted fields containing commas, and of "* This data was estimated" notes.
 * ==========================================================================*/
(function (App) {
  "use strict";

  /* Split one CSV line into fields, honouring double-quoted sections. */
  function splitCsvLine(line) {
    var out = [];
    var cur = "";
    var inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function stripBom(s) {
    if (s.charCodeAt(0) === 0xFEFF) return s.slice(1);
    if (s.indexOf("﻿") === 0) return s.slice(1);
    return s;
  }

  function toNumber(s) {
    if (s == null) return 0;
    var cleaned = String(s).replace(/[$,\s]/g, "");
    if (cleaned === "" || cleaned === "-") return 0;
    var v = parseFloat(cleaned);
    return isNaN(v) ? 0 : v;
  }

  /* Parse "7/2/2026" (M/D/YYYY) + "13:00" into a local Date. */
  function parseDateTime(dateStr, timeStr) {
    var d = String(dateStr).trim().split(/[\/\-]/);
    if (d.length < 3) return null;
    var month = parseInt(d[0], 10);
    var day = parseInt(d[1], 10);
    var year = parseInt(d[2], 10);
    if (year < 100) year += 2000;
    var hour = 0, minute = 0;
    if (timeStr) {
      var t = String(timeStr).trim().split(":");
      hour = parseInt(t[0], 10) || 0;
      minute = parseInt(t[1], 10) || 0;
    }
    if (isNaN(month) || isNaN(day) || isNaN(year)) return null;
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  function dateKey(d) {
    return d.getFullYear() + "-" +
           App.fmt.pad2(d.getMonth() + 1) + "-" +
           App.fmt.pad2(d.getDate());
  }

  /* Locate the data header row (the one beginning with TYPE / DATE). */
  function findHeaderIndex(lines) {
    for (var i = 0; i < lines.length; i++) {
      var upper = lines[i].toUpperCase();
      if (upper.indexOf("TYPE") === 0 && upper.indexOf("DATE") !== -1) return i;
      if (upper.indexOf("DATE") !== -1 &&
          (upper.indexOf("USAGE") !== -1) &&
          (upper.indexOf("START") !== -1)) return i;
    }
    return -1;
  }

  function detectFuel(headerFields, sampleTypeCell) {
    var joined = headerFields.join(" ").toLowerCase();
    if (/therm/.test(joined)) return { fuel: "gas", unit: "therms" };
    if (/kwh/.test(joined)) return { fuel: "electric", unit: "kWh" };
    var t = (sampleTypeCell || "").toLowerCase();
    if (/gas/.test(t)) return { fuel: "gas", unit: "therms" };
    if (/electric/.test(t)) return { fuel: "electric", unit: "kWh" };
    return { fuel: "electric", unit: "kWh" };
  }

  function columnIndexes(headerFields) {
    var idx = { date: -1, start: -1, end: -1, usage: -1, cost: -1, notes: -1, type: -1 };
    for (var i = 0; i < headerFields.length; i++) {
      var h = headerFields[i].toLowerCase();
      if (h.indexOf("type") !== -1 && idx.type === -1) idx.type = i;
      else if (h.indexOf("date") !== -1 && idx.date === -1) idx.date = i;
      else if (h.indexOf("start") !== -1) idx.start = i;
      else if (h.indexOf("end") !== -1) idx.end = i;
      else if (h.indexOf("usage") !== -1) idx.usage = i;
      else if (h.indexOf("cost") !== -1) idx.cost = i;
      else if (h.indexOf("note") !== -1) idx.notes = i;
    }
    // Fallbacks to the canonical PG&E column order.
    if (idx.date === -1) idx.date = 1;
    if (idx.start === -1) idx.start = 2;
    if (idx.end === -1) idx.end = 3;
    if (idx.usage === -1) idx.usage = 4;
    if (idx.cost === -1) idx.cost = 5;
    if (idx.notes === -1) idx.notes = 6;
    return idx;
  }

  function readMeta(lines, headerIdx) {
    var meta = { name: "", address: "", account: "", service: "" };
    for (var i = 0; i < headerIdx; i++) {
      var f = splitCsvLine(lines[i]);
      var key = (f[0] || "").toLowerCase();
      var val = (f[1] || "").trim();
      if (key.indexOf("name") !== -1) meta.name = val;
      else if (key.indexOf("address") !== -1) meta.address = val;
      else if (key.indexOf("account") !== -1) meta.account = val;
      else if (key.indexOf("service") !== -1) meta.service = val;
    }
    return meta;
  }

  /*
   * Parse a raw CSV string into a normalized dataset. Throws an Error with a
   * user-friendly message if the file does not look like PG&E interval data.
   */
  function parse(text, fileName) {
    if (!text || !text.trim()) throw new Error("The file appears to be empty.");
    text = stripBom(text);
    var lines = text.split(/\r\n|\n|\r/);

    var headerIdx = findHeaderIndex(lines);
    if (headerIdx === -1) {
      throw new Error(
        "Couldn't find a PG&E data header (TYPE, DATE, START TIME, USAGE …). " +
        "Make sure this is an interval-usage CSV exported from pge.com."
      );
    }

    var headerFields = splitCsvLine(lines[headerIdx]);
    var cols = columnIndexes(headerFields);

    // Grab a sample TYPE cell to help fuel detection.
    var sampleType = "";
    for (var s = headerIdx + 1; s < lines.length; s++) {
      if (lines[s] && lines[s].trim()) {
        sampleType = splitCsvLine(lines[s])[cols.type] || "";
        break;
      }
    }
    var fuelInfo = detectFuel(headerFields, sampleType);
    var meta = readMeta(lines, headerIdx);

    var rows = [];
    var perDateCount = {};
    var estimatedCount = 0;

    for (var i = headerIdx + 1; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.trim()) continue;
      var f = splitCsvLine(line);
      var ds = f[cols.date];
      if (!ds || !ds.trim()) continue;

      var ts = parseDateTime(ds, f[cols.start]);
      if (!ts) continue;

      var usage = toNumber(f[cols.usage]);
      var cost = toNumber(f[cols.cost]);
      var notes = (f[cols.notes] || "").trim();
      var estimated = /estimat/i.test(notes);
      if (estimated) estimatedCount++;

      var key = dateKey(ts);
      perDateCount[key] = (perDateCount[key] || 0) + 1;

      rows.push({
        ts: ts,
        dateKey: key,
        dow: ts.getDay(),
        hour: ts.getHours(),
        usage: usage,
        cost: cost,
        estimated: estimated,
        notes: notes
      });
    }

    if (!rows.length) {
      throw new Error("No usage rows were found in this file.");
    }

    rows.sort(function (a, b) { return a.ts - b.ts; });

    // Granularity: more than one interval per day ⇒ intraday (hourly-ish).
    var maxPerDay = 0;
    for (var k in perDateCount) {
      if (perDateCount[k] > maxPerDay) maxPerDay = perDateCount[k];
    }
    var granularity = maxPerDay > 1 ? "hourly" : "daily";

    // Approximate the interval length in minutes for display.
    var intervalMinutes = granularity === "daily" ? 1440 : Math.round(1440 / maxPerDay);

    return {
      fuel: fuelInfo.fuel,
      unit: fuelInfo.unit,
      granularity: granularity,
      intervalMinutes: intervalMinutes,
      meta: meta,
      rows: rows,
      estimatedCount: estimatedCount,
      fileName: fileName || "",
      startDate: rows[0].ts,
      endDate: rows[rows.length - 1].ts
    };
  }

  App.parse = {
    parse: parse,
    splitCsvLine: splitCsvLine,
    parseDateTime: parseDateTime,
    dateKey: dateKey
  };
})(window.App = window.App || {});
