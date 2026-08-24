/* ============================================================================
 * format.js — Number, date, and currency formatting helpers.
 * Pure functions, no dependencies. Attached to the global App namespace.
 * ==========================================================================*/
(function (App) {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday",
                  "Thursday", "Friday", "Saturday"];

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  /* Round to a sensible number of decimals and group thousands. */
  function num(v, decimals) {
    if (v == null || isNaN(v)) return "—";
    if (decimals == null) decimals = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    var parts = Number(v).toFixed(decimals).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  function usd(v, decimals) {
    if (v == null || isNaN(v)) return "—";
    if (decimals == null) decimals = Math.abs(v) >= 100 ? 0 : 2;
    var neg = v < 0;
    return (neg ? "-$" : "$") + num(Math.abs(v), decimals);
  }

  /* Compact currency for axes: $1.2k */
  function usdCompact(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    if (a >= 1000) return "$" + num(v / 1000, 1) + "k";
    return "$" + num(v, a >= 10 ? 0 : 2);
  }

  function pct(v, decimals) {
    if (v == null || isNaN(v)) return "—";
    if (decimals == null) decimals = Math.abs(v) >= 10 ? 0 : 1;
    return num(v, decimals) + "%";
  }

  /* Signed percent with an explicit + for positive deltas. */
  function signedPct(v, decimals) {
    if (v == null || isNaN(v)) return "—";
    var s = v > 0 ? "+" : "";
    return s + pct(v, decimals);
  }

  /* "Jul 16" */
  function dateShort(d) {
    return MONTHS[d.getMonth()] + " " + d.getDate();
  }

  /* "Jul 16, 2026" */
  function dateMed(d) {
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  /* "Thu, Jul 16" */
  function dateDow(d) {
    return DOW_SHORT[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
  }

  /* Hour-of-day label: 0 -> "12 AM", 13 -> "1 PM" */
  function hour12(h) {
    var suffix = h < 12 ? "AM" : "PM";
    var hr = h % 12;
    if (hr === 0) hr = 12;
    return hr + " " + suffix;
  }

  /* Compact hour label for dense axes: 0 -> "12a", 13 -> "1p" */
  function hour12Compact(h) {
    var suffix = h < 12 ? "a" : "p";
    var hr = h % 12;
    if (hr === 0) hr = 12;
    return hr + suffix;
  }

  /* "1–2 PM" for an interval starting at hour h. */
  function hourRange(h) {
    return hour12(h) + "–" + hour12((h + 1) % 24);
  }

  /* Turn a count of days into a friendly range description. */
  function unitLabel(fuel) {
    return fuel === "gas" ? "therms" : "kWh";
  }

  App.fmt = {
    pad2: pad2,
    num: num,
    usd: usd,
    usdCompact: usdCompact,
    pct: pct,
    signedPct: signedPct,
    dateShort: dateShort,
    dateMed: dateMed,
    dateDow: dateDow,
    hour12: hour12,
    hour12Compact: hour12Compact,
    hourRange: hourRange,
    unitLabel: unitLabel,
    MONTHS: MONTHS,
    DOW_SHORT: DOW_SHORT,
    DOW_LONG: DOW_LONG
  };
})(window.App = window.App || {});
