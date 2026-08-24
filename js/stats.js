/* ============================================================================
 * stats.js — Statistics utilities for anomaly detection.
 *
 * We favour ROBUST statistics (median, MAD) over mean/std because utility
 * data is heavy-tailed: a few big spikes would inflate the mean and standard
 * deviation and hide the very anomalies we want to surface. The "modified
 * z-score" (Iglewicz & Hoaglin) built on the median and MAD is resistant to
 * those outliers.
 * ==========================================================================*/
(function (App) {
  "use strict";

  function sum(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s;
  }

  function mean(arr) {
    return arr.length ? sum(arr) / arr.length : 0;
  }

  function min(arr) {
    var m = Infinity;
    for (var i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m === Infinity ? 0 : m;
  }

  function max(arr) {
    var m = -Infinity;
    for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m === -Infinity ? 0 : m;
  }

  function std(arr, mu) {
    if (arr.length < 2) return 0;
    if (mu == null) mu = mean(arr);
    var s = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - mu;
      s += d * d;
    }
    return Math.sqrt(s / (arr.length - 1));
  }

  /* Linear-interpolated quantile on a copy-sorted array. q in [0,1]. */
  function quantile(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q;
    var base = Math.floor(pos);
    var rest = pos - base;
    if (a[base + 1] !== undefined) {
      return a[base] + rest * (a[base + 1] - a[base]);
    }
    return a[base];
  }

  function median(arr) {
    return quantile(arr, 0.5);
  }

  /* Median absolute deviation. Returns the RAW MAD (not scaled). */
  function mad(arr, med) {
    if (!arr.length) return 0;
    if (med == null) med = median(arr);
    var dev = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) dev[i] = Math.abs(arr[i] - med);
    return median(dev);
  }

  /*
   * Summarise a numeric series into a reusable baseline object. Captures both
   * robust (median/MAD) and classic (mean/std) descriptors plus quartiles and
   * IQR fences so callers can pick whichever signal fits.
   */
  function describe(arr) {
    var med = median(arr);
    var rawMad = mad(arr, med);
    var q1 = quantile(arr, 0.25);
    var q3 = quantile(arr, 0.75);
    var iqr = q3 - q1;
    var mu = mean(arr);
    return {
      n: arr.length,
      sum: sum(arr),
      mean: mu,
      std: std(arr, mu),
      min: min(arr),
      max: max(arr),
      median: med,
      mad: rawMad,
      // 1.4826 rescales MAD to be a consistent estimator of sigma for
      // normally-distributed data.
      sigmaRobust: 1.4826 * rawMad,
      p05: quantile(arr, 0.05),
      p25: q1,
      p75: q3,
      p95: quantile(arr, 0.95),
      iqr: iqr,
      fenceLow: q1 - 1.5 * iqr,
      fenceHigh: q3 + 1.5 * iqr
    };
  }

  /*
   * Modified z-score. Uses MAD when it is non-zero; otherwise falls back to
   * the standard deviation so we still get a meaningful score for series with
   * many repeated values (e.g. a gas meter that is mostly 0).
   */
  function modifiedZ(x, desc) {
    if (desc.mad > 1e-9) {
      return 0.6745 * (x - desc.median) / desc.mad;
    }
    if (desc.std > 1e-9) {
      return (x - desc.mean) / desc.std;
    }
    return 0;
  }

  /* Simple centered-ish trailing moving average for trend lines. */
  function movingAverage(arr, window) {
    var out = new Array(arr.length);
    var half = Math.floor(window / 2);
    for (var i = 0; i < arr.length; i++) {
      var lo = Math.max(0, i - half);
      var hi = Math.min(arr.length - 1, i + half);
      var s = 0, c = 0;
      for (var j = lo; j <= hi; j++) { s += arr[j]; c++; }
      out[i] = s / c;
    }
    return out;
  }

  /* Pearson correlation, used for lightweight weather/behaviour hints. */
  function correlation(xs, ys) {
    var n = Math.min(xs.length, ys.length);
    if (n < 3) return 0;
    var mx = mean(xs), my = mean(ys);
    var num = 0, dx = 0, dy = 0;
    for (var i = 0; i < n; i++) {
      var a = xs[i] - mx, b = ys[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    if (dx === 0 || dy === 0) return 0;
    return num / Math.sqrt(dx * dy);
  }

  App.stats = {
    sum: sum,
    mean: mean,
    min: min,
    max: max,
    std: std,
    quantile: quantile,
    median: median,
    mad: mad,
    describe: describe,
    modifiedZ: modifiedZ,
    movingAverage: movingAverage,
    correlation: correlation
  };
})(window.App = window.App || {});
