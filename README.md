# ⚡ Wattwise — PG&E Energy Usage Insights

Turn your PG&E **gas** and **electricity** interval exports into a beautiful, interactive
dashboard — with automatic spike/dip detection, an hourly usage heatmap, weather correlation,
bill projection, and personalized, dollar-quantified saving tips.

**Everything runs in your browser.** Your usage CSVs are parsed with JavaScript in the page and
are never uploaded anywhere. (The one optional exception — local weather — is described below and
only sends your ZIP + date range, never your usage.)

> Not affiliated with or endorsed by PG&E. Cost figures are indicative, not billing-accurate.

---

## ✨ What it does

- **Drag-and-drop ingestion** of PG&E "Green Button" interval CSVs — electricity (hourly) and gas
  (daily), one or both. Fuel type and granularity are auto-detected from the file.
- **Time-of-Use rate detection** — Wattwise reads the cost column and figures out your peak vs.
  off-peak windows and rates on its own (e.g. *4–9 PM at $0.49/kWh vs $0.36 off-peak*), with no
  assumptions about your rate plan.
- **Anomaly engine** — robust statistics (median/MAD modified z-scores + IQR fences) flag:
  - **Hourly spikes** — an hour far above its own time-of-day baseline (collapsed into windows so a
    long AC afternoon is one event, not five).
  - **Daily spikes** — unusually heavy days.
  - **Quiet days / dips** — likely travel or an appliance left off (great for finding your true baseline).
  - **Estimated readings** — PG&E-estimated days are flagged as lower-confidence.
- **Signature visualizations** (all custom SVG, zero chart libraries):
  - Day × hour **heatmap** with spikes outlined and the peak window highlighted.
  - **Usage & cost time series** with a 7-day trend line and event markers.
  - **Load curve** (average usage by hour with a typical-range band).
  - **Day-of-week** profile, **peak vs off-peak** cost split, and **usage-vs-temperature** scatter.
- **Billing cycles** — enter your cycle dates and every total is grouped by billing period, with a
  **projected bill** for the in-progress cycle.
- **The AC playbook** *(optional, needs a ZIP)* — the headline recommendation. Wattwise pulls your local
  7-day forecast and builds a concrete thermostat schedule around *your* detected peak window:

  | Period | Time | Set to |
  |---|---|---|
  | Wake | 6 AM | 76° |
  | **Pre-cool** | **1 PM** | **72°** |
  | **Peak** | **4 PM** | **78°** |
  | Evening | 9 PM | 74° |

  Plus per-day adjustment bands (skip AC under 78°, pre-cool harder above 88°), and a **night-flush**
  callout that measures the gap between the overnight lows and your setpoint — free cooling you can let
  in through a window.
- **Weather-aware tips** *(optional)* — pull local hourly temperatures and Wattwise measures how
  cooling-driven your usage is, then suggests pre-cooling and load-shifting worth real dollars.
- **Personalized recommendations** — tell it what you have (AC, EV, pool pump, electric dryer) and
  mark days you were away, and the tips and explanations sharpen accordingly.

---

## 🚀 Run it

It's a static site with **no build step and no dependencies**. Any of these work:

```bash
# 1) Python (built in on most machines)
python3 -m http.server 8000
# then open http://localhost:8000

# 2) Node
npx serve .        # or: npx http-server .
```

Or simply **double-click `index.html`** — because the scripts are plain classic scripts (no ES-module
imports) and the sample data is inlined, the app runs straight from `file://`, fully offline.

Click **“Try it with sample data”** to explore immediately, or drop in your own files.

### Get your data from PG&E
Sign in at pge.com → **Energy Usage Details** → **Green Button / Download my data** → choose a date
range and **CSV (interval)**. You'll get one file per service (one for electric, one for gas).

---

## 🔒 Privacy

| Data | Where it goes |
|------|----------------|
| Your usage CSVs | Parsed in the browser tab. Never leave your device. |
| Your settings (billing cycle, household profile, day notes) | Saved in this browser's `localStorage`. Never leave your device. |
| **Optional** weather lookup | Sends only your **ZIP** and **date range** to free, key-less services (zippopotam.us for geocoding, Open-Meteo for temperatures). Your usage is never included. |

If you never click "Add local weather," the app makes **zero network requests.**

---

## 🧠 How the analysis works

- **Robust baselines.** Utility data is spiky, so mean/standard-deviation baselines get dragged
  around by the very outliers we want to catch. Wattwise uses the **median** and **MAD** (median
  absolute deviation) to build each baseline, then scores points with the **modified z-score**
  (Iglewicz–Hoaglin). Hourly points are scored against a baseline for *that hour of day*, so a spike
  is "high **for 2 PM**," not just "high."
- **Rate inference.** For each interval, implied price = `cost ÷ usage`. Hours that are
  systematically pricier become the peak window; peak/off-peak rates are the medians within each group.
- **Always-on (phantom) load.** The median of each day's quietest hour approximates the power that's
  always drawing — a surprisingly large, and very reducible, slice of most bills.
- **Bill projection.** Your billing cycle tiles across the data; the in-progress cycle is projected
  from its run-rate to a full-cycle total.

See [`js/analyze.js`](js/analyze.js) for the full engine and [`js/tips.js`](js/tips.js) for how the
numbers become recommendations.

---

## 📁 Project structure

```
index.html          Markup + panel scaffolding
css/styles.css      Theme-aware design system (dark + light, accent per fuel)
js/
  format.js         Number / date / currency formatting
  stats.js          Robust statistics (median, MAD, quantiles, z-scores, correlation)
  parse.js          PG&E CSV parser (fuel + granularity auto-detect)
  analyze.js        Aggregation, TOU detection, anomaly engine, insights
  tips.js           Hour / weather / context-aware saving tips
  acplan.js         Forecast-driven thermostat schedule (the AC playbook)
  questions.js      Data-derived diagnostic questions
  weather.js        Optional client-side weather enrichment (history + forecast)
  charts.js         Dependency-free SVG charts (heatmap, time series, load curve, …)
  app.js            Orchestration, rendering, persistence, interactions
  sample-data.js    Inlined anonymized sample CSVs (offline demo)
sample-data/        The same samples as real .csv files
dist/wattwise.html  Portable single-file build (generated by build.js)
```

Regenerate the single-file build with:

```bash
node build.js
```

---

## 🌐 Deploy

Because it's a static site, host it anywhere — GitHub Pages, Netlify, Vercel, Cloudflare Pages, or an
S3 bucket. No server code, no environment variables, no build required (just serve the folder).
