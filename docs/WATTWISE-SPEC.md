# ⚡ Wattwise — Complete Application Specification

> A privacy-first web platform that turns PG&E "Green Button" interval CSVs into an
> interactive analytics dashboard, with anomaly detection, a forecast-driven AC
> schedule, and dollar-quantified saving advice.

| | |
|---|---|
| **Live** | https://pge-usage-tracker.vercel.app |
| **Repo** | https://github.com/aakarkale/pge-usage-tracker |
| **Hosting** | Vercel (static, production branch `main`, auto-deploy on merge) |
| **Backend** | Supabase project `wattwise` (`rhdtwvdcwlmaptdutelx`, us-west-1, free tier) |
| **Stack** | Vanilla HTML/CSS/JS. **Zero dependencies, zero build step.** |
| **Size** | ~6,300 lines across 14 JS modules, 1 stylesheet, 1 HTML file |

---

## Table of contents

1. [Design philosophy](#1-design-philosophy)
2. [Architecture & module map](#2-architecture--module-map)
3. [User flows](#3-user-flows)
4. [Onboarding (4 steps)](#4-onboarding-4-steps)
5. [Accounts, storage & the store abstraction](#5-accounts-storage--the-store-abstraction)
6. [Database schema & security](#6-database-schema--security)
7. [The dashboard — every panel in order](#7-the-dashboard--every-panel-in-order)
8. [KPI tiles](#8-kpi-tiles)
9. [Charts & visualizations](#9-charts--visualizations)
10. [The analysis engine](#10-the-analysis-engine)
11. [Anomaly / event detection](#11-anomaly--event-detection)
12. [The AC playbook](#12-the-ac-playbook)
13. [Diagnostic questions](#13-diagnostic-questions)
14. [Recommendations engine](#14-recommendations-engine)
15. [Weather integration](#15-weather-integration)
16. [Billing cycles & bill projection](#16-billing-cycles--bill-projection)
17. [Design system](#17-design-system)
18. [State model](#18-state-model)
19. [Security posture](#19-security-posture)
20. [Testing](#20-testing)
21. [Known limitations & next steps](#21-known-limitations--next-steps)

---

## 1. Design philosophy

Five rules the whole codebase follows:

1. **The meter can't tell you everything.** The engine surfaces *patterns*; the user
   supplies *causes*. Hence data-derived questions rather than a generic settings form.
2. **Never assume the rate plan.** Peak windows and rates are *inferred from the user's
   own cost column*, so the app works for any PG&E plan without configuration.
3. **Robust statistics only.** Utility data is heavy-tailed. Mean/σ baselines get dragged
   around by the very spikes we want to catch, so everything uses median/MAD.
4. **Advice people will actually follow.** Setpoints come from comfort *bands*, not an
   optimizer. An "optimal" number that gets overridden on day two saves nothing.
5. **Honest numbers.** Savings estimates only count load that plausibly belongs to the
   thing being discussed (e.g. cooling = hot-day minus mild-day delta), never a flat
   share of the bill.

---

## 2. Architecture & module map

Plain classic `<script>` tags, no modules, no bundler. Load order matters — each file
attaches to a global `App` namespace.

```
index.html            323 lines   Markup + panel scaffolding
css/styles.css        576 lines   Theme-aware design system
js/
  config.js            23   Supabase URL + publishable key
  sample-data.js        9   Inlined anonymized demo CSVs (works offline)
  format.js           112   Number / date / currency / hour formatting
  stats.js            163   Robust statistics primitives
  parse.js            242   PG&E CSV parser (fuel + granularity auto-detect)
  analyze.js          666   Aggregation, TOU detection, anomaly engine, insights
  tips.js             319   Hour / weather / context-aware saving tips
  questions.js        266   Data-derived diagnostic questions
  weather.js          262   Optional weather enrichment (history + forecast)
  acplan.js           219   Forecast-driven thermostat schedule
  charts.js           762   Dependency-free SVG charts
  api.js              337   Auth + data (GoTrue + PostgREST over plain fetch)
  account.js          647   Onboarding, account menu, saved-uploads library
  app.js            1,406   Orchestration, rendering, persistence, interactions
```

**Dependency direction:** `format` → `stats` → `parse` → `analyze` → {`tips`,
`questions`, `acplan`} → `charts` → `api` → `account` → `app`. Nothing reaches
backwards.

---

## 3. User flows

### First-time visitor
```
Load → Onboarding overlay
  Step 1 Account  → Sign up / Sign in / Explore as guest
  Step 2 Your home → ZIP (ONCE) + AC type, occupancy, home type, EV/pool/dryer
  Step 3 Upload   → drop CSV(s), or "Use sample data instead"
  Step 4 Billing  → confirm cycle start/end (pre-filled)
→ Dashboard renders
→ If a ZIP is on file, the forecast is fetched automatically (no second prompt)
```

### Returning visitor (signed in **or** guest)
```
Load → boot() restores session + profile + uploads
→ Most recent file of each fuel reopened automatically (ELECTRIC LEADS — richer data)
→ Saved billing cycle, day annotations and question answers hydrate back
→ Straight to the dashboard, no onboarding
```

### Uploading another file (later)
```
"＋ Upload CSV" (topbar) or "＋ Upload another" (uploads panel)
→ parse → analyze → save to account → BILLING CYCLE PROMPT (always)
→ dashboard re-renders, uploads panel refreshes
```

**Key rule:** the billing cycle is confirmed on **every new upload** (a new export
usually covers a new period), but **never re-prompted** when reopening a saved file
that already has one.

---

## 4. Onboarding (4 steps)

Rendered as a full-screen overlay (`#onboard`) with a step-dot progress rail.

| # | Step | Fields | Notes |
|---|---|---|---|
| 1 | **Account** | Name (signup only), Email, Password | Tabs: *Create account* / *Sign in*. Third path: **"Explore without an account"**. Password ≥ 8 chars enforced client-side. |
| 2 | **Your home** | **ZIP**, AC type, Typical weekday, Home type, EV / Pool / Electric dryer | ZIP validated as exactly 5 digits. "Skip for now" allowed. |
| 3 | **Upload** | Drag-drop or browse, multi-file | Appends across drops (electric + gas usually arrive separately), de-duplicated by name. "Use sample data instead" escape. |
| 4 | **Billing** | Cycle start, Cycle end | Separate modal (`#billing-modal`). Live preview: cycle length, periods covered, projected cost. |

**Field options**

- `ac_type`: Central AC · Heat pump · Window/portable · No AC
- `occupancy`: Someone home all day · Away 9–5 · Varies
- `home_type`: House · Townhouse · Apartment/condo
- Checkboxes: `has_ev`, `has_pool`, `has_electric_dryer`

**UX details**
- Primary buttons show live progress (`Signing in…`, `Creating account…`, `Saving…`)
  with a spinner, then restore their label.
- Dismissible (✕ or Escape) for anyone who already has data to return to; **not**
  dismissible on the Account step for a brand-new visitor.
- Email confirmation is handled: signup with confirmations on shows a
  "check your inbox" state and offers "Explore meanwhile".
- Friendly auth errors mapped from GoTrue codes (invalid credentials, already
  registered, invalid email, unconfirmed email, network unreachable).

---

## 5. Accounts, storage & the store abstraction

`App.account.store` presents **one interface with two backends**. Nothing else in the
app knows which is active.

| Operation | Guest (`localStorage`) | Signed in (Supabase) |
|---|---|---|
| `getProfile` / `saveProfile` | `wattwise.localProfile.v1` | `profiles` table |
| `listUploads` / `getUpload` / `createUpload` / `updateUpload` / `deleteUpload` | `wattwise.localUploads.v1` (capped at 12) | `uploads` table |
| `saveAnnotation` / `listAnnotations` | no-op | `annotations` table |
| `saveAnswer` / `listAnswers` | no-op | `answers` table |

**Guest mode is a first-class path**, not a degraded one — every feature works.

**localStorage keys**

| Key | Contents |
|---|---|
| `wattwise.session.v1` | access + refresh token, expiry, user |
| `wattwise.localProfile.v1` | guest profile (ZIP, home facts) |
| `wattwise.localUploads.v1` | guest uploads incl. raw CSV |
| `wattwise.settings.v2` | per-identity billing cycle, annotations, answers |
| `wattwise.theme` | `dark` / `light` |

**Guest → account migration.** Signing up after exploring copies the guest profile
(gap-fill only, never overwriting the account) and all guest uploads (oldest first,
preserving order) into the account. Local copies are cleared **only after every write
lands**.

**Auth mechanics** (`api.js`, no SDK):
- `POST /auth/v1/signup`, `/token?grant_type=password`, `/token?grant_type=refresh_token`,
  `/logout`, `GET /auth/v1/user`
- Proactive refresh when the token is < 60 s from expiry; one retry on a 401.
- Concurrent calls share a single in-flight refresh promise.
- **A session is discarded only on 400/401/403** — never on a network blip, timeout,
  429 or 5xx.
- Sign-out clears local state *first* (immediate on shared machines), bounded 5 s
  network call, and wipes the local caches.

---

## 6. Database schema & security

```sql
profiles
  id uuid PK → auth.users(id) ON DELETE CASCADE
  display_name, zip, home_type, ac_type, occupancy   text
  has_ev, has_pool, has_electric_dryer               boolean default false
  onboarded_at, created_at, updated_at               timestamptz

uploads
  id uuid PK, user_id uuid → auth.users
  file_name, fuel ('electric'|'gas'), unit, granularity,
  service_id, account_ref                            text
  period_start, period_end, billing_start, billing_end  date
  row_count int, total_usage numeric, total_cost numeric
  csv text                       -- raw file, re-parsed client-side on open
  created_at timestamptz
  INDEX (user_id, created_at DESC)

annotations
  id uuid PK, user_id, upload_id → uploads ON DELETE CASCADE
  date_key date, away boolean, cause text, updated_at
  UNIQUE (upload_id, date_key)

answers
  id uuid PK, user_id, fuel text, question_id text, value jsonb, updated_at
  UNIQUE (user_id, fuel, question_id)
```

**Row-level security** is enabled on all four tables with policies of the form
`(select auth.uid()) = user_id` (and `= id` for `profiles`), covering
SELECT/INSERT/UPDATE/DELETE.

A `handle_new_user()` trigger creates the profile row on signup. It is
`SECURITY DEFINER`, so `EXECUTE` is **revoked** from `anon` and `authenticated` — it
must only ever run from the trigger, never as a REST RPC.

**Verified against the live project:** anonymous SELECT returns `[]` on every table,
anonymous INSERT is rejected `42501`, the RPC is not callable, and the security
advisor reports **zero lints**.

---

## 7. The dashboard — every panel in order

| # | Panel | ID | Shown when |
|---|---|---|---|
| — | **Top bar** — brand, "＋ Upload CSV", account menu, theme toggle | `.topbar` | always |
| — | **Account header** — name, address, masked account, date range, fuel tabs | `.dash-head` | always |
| 1 | **KPI tiles** (6) | `#kpis` | always |
| 2 | **📂 Your uploads** | `#panel-uploads` | ≥ 1 saved upload |
| 3 | **🧾 Billing cycles** | `#panel-billing` | always |
| 4 | **💡 AI insights** + **💰 Savings at a glance** (2-up) | `#insights` / `#savings` | always |
| 5 | **✅ Personalized recommendations** | `#tips` | always |
| 6 | **❄️ Your AC playbook this week** | `#panel-acplan` | electric + hourly |
| 7 | **🧠 Sharpen your tips** (questions) | `#panel-context` | always |
| 8 | **Usage & cost over time** | `#chart-timeseries` | always |
| 9 | **🌡️ Hourly usage heatmap** | `#panel-heatmap` | hourly data only |
| 10 | **Daily load curve** + **By day of week** (2-up) | `#panel-loadcurve` | hourly / always |
| 11 | **⚡ Peak vs. off-peak** | `#panel-peak` | TOU detected |
| 12 | **🌦️ Weather & your usage** | `#panel-weather` | electric |
| 13 | **🔎 Event feed** | `#events` | always |

**Fuel tabs** (⚡ Electricity / 🔥 Gas) switch the entire dashboard; the accent color
changes with the fuel (amber → teal) via `[data-fuel]`.

### Panel details

**📂 Your uploads** — one row per saved file: fuel icon, filename, "viewing" badge,
date range, billing-cycle chip (or "no cycle set" in accent), totals, and Open /
Delete actions. Delete is confirmed.

**🧾 Billing cycles** — one row per cycle tiled across the data: date range, a
proportional bar, actual cost, projected cost for the in-progress cycle, and usage.
Current cycle is highlighted. "Edit cycle dates" reopens the modal.

**💡 AI insights** — tone-colored cards (info / warn / good) with an emoji, a title, an
optional green `~$X/yr` savings chip, and plain-English text.

**💰 Savings at a glance** — a large total, then ranked opportunities with proportional
bars and detail lines.

**🔎 Event feed** — filter chips (All / Spikes / Quiet days / High severity /
Estimated, each with counts). Each event card has a severity spine, a type tag, title,
cost-impact chip, detail sentence, a 💡 tip, and inline controls: a **cause dropdown**,
an **"I was away" checkbox**, and "Spotlight on charts →". Clicking a card highlights
that day across the time series and heatmap.

---

## 8. KPI tiles

Auto-fit grid, each with an accent left-edge bar, label, big value, sub-line, and
(where useful) a sparkline.

| Tile | Value | Sub | Sparkline |
|---|---|---|---|
| Total usage | Σ kWh / therms | avg per day | daily usage |
| Total cost | Σ $ | avg per day | daily cost (violet) |
| Projected bill · current cycle | $ | days elapsed / cycle length | — |
| *(fallback)* Projected monthly cost | $ | ~30.4-day run rate | — |
| Peak-hour cost share | % | window + rate premium | — |
| Always-on load | kWh/hr | ≈ $/month standby | — |
| *(gas)* Active gas days | n / total | typical level when on | — |
| Events flagged | count | "spikes, dips & anomalies" | — |

---

## 9. Charts & visualizations

All custom SVG in `charts.js`. No chart library. Shared tooltip, theme-aware via CSS
classes and tokens, redrawn on resize and theme change.

| Function | Chart | Details |
|---|---|---|
| `timeSeries` | Daily usage/cost area+line | Gradient fill, 7-day moving average (dashed), severity-colored event dots, crosshair + tooltip, click-to-select a day, vertical highlight for the selected day. Usage/Cost toggle. |
| `heatmap` | **Day × hour** | One row per day, 24 cells. 7-stop thermal ramp (deep blue → teal → green → yellow → orange → red) scaled to the 98th percentile. Peak window shaded with a "PEAK 4 PM–9 PM" label. Detected hourly spikes outlined in white. Selected day outlined in the accent. Per-cell tooltip with "% vs usual". Gradient legend. |
| `loadCurve` | Hour-of-day profile | Mean line with a p25–p75 shaded band, peak-window shading, per-hour tooltips. |
| `weekdayBars` | Avg usage by day of week | Weekends in accent, weekdays neutral. |
| `sparkline` | KPI micro-charts | Gradient area + line. |
| `splitBar` | Peak vs off-peak cost | Proportional segments + legend with percentages. |
| `scatter` | Usage vs temperature | Least-squares trend line, per-day tooltips. |
| `forecastLines` | **Free-cooling chart** | Daytime high + overnight low lines with a flat setpoint reference; the gap between the low line and the setpoint is shaded — that shaded area *is* the free cooling. |

`peakSegments()` splits the peak window into contiguous runs so a midnight-wrapping
window (e.g. 10 PM–2 AM) never paints past hour 23 or with negative width.

---

## 10. The analysis engine

`analyze.js` — pure functions over the parsed dataset.

### CSV parsing (`parse.js`)
Handles the PG&E export shape: BOM, 4 metadata rows (Name / Address / Account / Service),
a blank line, then `TYPE, DATE, START TIME, END TIME, USAGE (kWh|therms), COST, NOTES`.
Tolerant of quoted fields containing commas, `$` in costs, `M/D/YYYY` dates, and
`* This data was estimated` notes. **Fuel** is detected from the unit in the header;
**granularity** from the max rows per day (>1 ⇒ hourly).

### Time-of-Use rate detection
For each interval, implied price = `cost ÷ usage`. Hours whose median rate is
**≥ 1.12 ×** the overall median become the peak window. `peakWindow()` then collapses
that set to its **dominant contiguous run** (merging across midnight), so one noisy
hour can't relocate the window. Peak/off-peak rates are the medians within each group;
TOU is only reported when the premium is **≥ 8 %**.

> On the sample data this yields **4 PM – 9 PM**, $0.52 peak vs $0.39 off-peak, a
> **32 % premium** — inferred entirely from the cost column.

### Derived measures
- **Daily aggregates** — usage, cost, per-hour array, peak/off-peak split, estimated flag
- **Hour-of-day profile** — mean, median, p25/p75/p95 per hour
- **Day-of-week profile**
- **Always-on baseline** — median of each day's *quietest hour*, extrapolated to $/month and $/yr
- **Trend** — first third vs last third of the period
- **Weekday vs weekend**
- **Peak day**, and the hour that drove it
- **Gas on/off characterisation** — active days and typical "on" level

### Savings model
- **Peak shift** — 35 % of peak-window usage × rate spread, annualized
- **Phantom** — 25 % of always-on annual cost

---

## 11. Anomaly / event detection

Built on the **modified z-score** (Iglewicz–Hoaglin): `0.6745 × (x − median) / MAD`,
falling back to σ when MAD is 0. `sigmaRobust = 1.4826 × MAD`.

| Event | Scope | Trigger | Severity |
|---|---|---|---|
| **Hourly spike** | hour | `z ≥ 4` against **that hour-of-day's** baseline **AND** above a global size gate (`max(p75, median + σ_robust)`) | `z ≥ 6` high · `≥ 5` medium · else low |
| **Daily spike** | day | `z ≥ 2.5` and above p75, **or** a distribution extreme (≥ p95 / above the IQR fence) | `z ≥ 4` or above fence → high · `≥ 3` medium · else low |
| **Quiet day / dip** | day | `z ≤ −2.5`, or ≤ p05 / below the low fence (electric only) | `z ≤ −3.5` or below fence → medium · else low |
| **Estimated reading** | day | PG&E `* This data was estimated` note | low |

**Key design choices**
- Hourly spikes are scored **per hour of day**, so a spike is "high *for 2 PM*", not
  just "high" — and consecutive flagged hours collapse into a single window event.
- The extreme-value triggers require a non-degenerate scale (`MAD > 0`). This stops a
  bimodal series like summer gas (mostly 0, a steady ~1.06-therm "on" level) from
  flagging every ordinary active day.
- Events are ranked by severity → cost impact → |z|, and hourly events capped at 24 so
  the feed stays readable.

---

## 12. The AC playbook

`acplan.js` — the headline recommendation. Combines the **detected peak window**, the
**upcoming daily highs** (how hard to pre-cool) and the **overnight lows** (is outside
air free cooling?).

### Comfort bands (keyed on the day's forecast high, °F)

| Band | High | Pre-cool | At peak | Wake | Evening | Meaning |
|---|---|---|---|---|---|---|
| `off` | < 78° | — | — | 78° | 76° | Windows do the work — AC off |
| `standard` | 78–88° | **72°** | **78°** | 76° | 74° | Your default — most days land here |
| `hot` | 88–95° | **70°** | **77°** | 75° | 74° | Chill deeper early, hold higher at peak |
| `extreme` | > 95° | **68°** | **76°** | 74° | 73° | Comfort first — the bill will run higher |

### The schedule table (the hero)

| Period | Time | Set to | Why |
|---|---|---|---|
| Wake | 6 AM | 76° | Coast on last night's cool air |
| **Pre-cool** | **1 PM** | **72°** | Chill the house while power is cheap |
| **Peak** | **4 PM** | **78°** | Keep the lid shut — AC mostly rests |
| Evening | 9 PM | 74° | Cheap power returns |

Times are **derived**, not hardcoded: pre-cool = peak start − 3 h; peak = detected
window start; evening = detected window end.

The "typical" band is chosen by folding over `BANDS` (coolest → hottest) so count ties
break toward the **hotter** band — deterministically, and independent of the order days
appear in the forecast.

### Other elements
- **7-day forecast strip** — per day: weekday, weather icon, high/low. Hot and extreme
  days are visually flagged.
- **Free-cooling chart** — see `forecastLines` above.
- **Night-flush callout** — a big number (the gap between overnight lows and the
  setpoint) plus instructions: open windows at the peak-window end, close by 8 AM.
  Applicable when the gap ≥ 6°. Copy branches on whether *every* low clears the
  setpoint ("every night") or only most ("most nights").
- **Per-forecast band table**, annotated with how many of the next 7 days hit each band.
- **Two habits** — close west/south blinds by noon; leave the fan on Auto.
- **One caution** — an honest note that the peak setback is a real comfort change, and
  that a temperature you'll actually keep beats the theoretical optimum.

**Savings estimate** counts only the peak-window load that plausibly belongs to cooling
(hot-day minus mild-day delta), 70 % of it shifted, × rate spread, × 120 cooling days.

---

## 13. Diagnostic questions

`questions.js` — generated **from each user's own data**, only when the pattern is
genuinely present. Each carries a dollar figure where one applies.

| id | Category | Asks | Generated when |
|---|---|---|---|
| `recurring-window` | pattern | "Roughly N kW runs 8 AM–noon on weekdays but never weekends. Best guess what it is?" | A contiguous weekday-only (or weekend-only) load window is detected |
| `always-on` | baseline | "Which of these run continuously?" — *"This is the $1,966/yr question"* | Always-on annual cost > $60 |
| `spike-cause` | spike | "One of your sharpest spikes was Thu Jul 9 around 12 PM — 2.4 kWh (~3.5× normal). What ran then?" | ≥ 1 spike event |
| `dip-away` | dip | "Usage on Jul 2 was 78 % below normal. Were you home?" | ≥ 1 dip event |
| `peak-occupants` | peak | "~9.9 kWh/day lands in your 4–9 PM peak window. What's running then?" | TOU detected |
| `cooling-type` | profile | "How do you cool your home in summer?" | electric + hourly |
| `trend-driver` | trend | "Your usage fell 23 % over these weeks. Anything change?" | trend ≥ 15 % |
| `electric-loads` | profile | "Which of these are electric (not gas)?" | electric + hourly |
| `gas-uses` | profile | "What uses gas in your home?" | gas fuel |

**Answer mechanics**
- Single- and multi-select; a free-text "Something else" box where relevant.
- Answers are keyed `questionId@dateKey` for date-bound questions, so an answer about
  one upload's spike never attaches itself to a different upload's dates.
- Answers feed **two** places: the derived household **profile** (AC/EV/pool/dryer —
  aggregated across both fuels) and per-day **annotations** (cause / away).
- A progress rail shows "N of M answered"; answered cards are accent-tinted with a ✓
  and a "Clear answer" link.
- Every answer instantly regenerates the KPIs, insights, savings, tips, AC playbook and
  event feed.

---

## 14. Recommendations engine

`tips.js` — merges signals from four sources and ranks by (has savings) → priority →
amount.

**Categories:** `peak`, `phantom`, `load-shift`, `weather`, `appliance`, `behavior`,
`billing`

| Tip | Fires when |
|---|---|
| Shift flexible loads out of the *4 PM–9 PM* window | TOU detected |
| Hunt down always-on "phantom" load | baseline > 0 |
| Your cheapest hours to run anything heavy | TOU detected |
| Big late-evening ramp around 10 PM | evening hour > 1.8× average |
| Your usage is cooling-driven — pre-cool before the peak | weather corr ≥ 0.45 |
| Cool nights are free air-conditioning | avg overnight low ≤ 65° |
| Cooling isn't your main lever | weather corr ≤ 0.2 |
| Schedule EV charging after peak | `has_ev` |
| Run the pool pump off-peak | `has_pool` |
| Batch laundry into off-peak blocks | `has_electric_dryer` |
| Get a smart thermostat schedule going | central AC / heat pump |
| Cool only the room you're in | window AC |
| Your true baseline (measured while you were away) | ≥ 1 day marked "away" |
| Projected bill for your current cycle | billing cycle set |
| Summer gas is mostly hot water | gas fuel |

Cards are 2-up, priority-1 tips get an accent tint, and each shows a green `~$X/yr`
chip where quantified.

---

## 15. Weather integration

`weather.js` — **opt-in**, the only network call the analysis makes.

- **Geocoding:** ZIP → lat/lon via `api.zippopotam.us`, falling back to Open-Meteo's
  geocoder by city name.
- **History:** hourly temperatures for the CSV's date range (archive or forecast
  endpoint chosen by age), joined per day → tMax/tMin/tMean, and correlated against
  daily usage.
- **Forecast:** upcoming 7-day daily high/low + WMO weather codes + current conditions —
  this is what the AC playbook plans against.
- Both legs are fetched **in parallel** and whichever succeeds is kept; a same-location
  re-fetch **merges** rather than replacing, so a half-failure never destroys data
  already on screen.
- Network failures are normalized into *"Couldn't reach the weather service — check
  your connection and try again."*
- **Privacy:** only the ZIP and date range are sent. Usage data is never included.

The panel shows the located place, a correlation strength (strong/moderate/weak with
r), peak-window usage on hot vs mild days, and the usage-vs-temperature scatter.

---

## 16. Billing cycles & bill projection

- The user enters **one** cycle's start/end. The app derives the length and **tiles it
  backwards and forwards** across the whole dataset.
- Each cycle shows actual usage and cost; the in-progress cycle also shows a
  **projection** from its run-rate to a full-cycle total.
- The confirmed cycle is written back onto the `uploads` row(s) it describes, so
  reopening a saved file restores it without re-prompting.
- The projection surfaces as a KPI tile and as a tip.

---

## 17. Design system

**Dark-first**, with a full light theme and a persisted toggle. Accent switches by fuel.

```
--bg --bg-grad --panel --panel-2 --panel-elev
--border --border-strong
--text --text-dim --text-mute
--grid --cell-empty --bar-neutral --focus-neutral --shadow
--accent --accent-ink --accent-soft        (amber; teal when [data-fuel="gas"])
--violet                                    (cost series)
--cool --cool-fill                          (pre-cool / free-cooling)
--temp-high --temp-low                      (forecast series)
--radius --radius-sm --maxw --font --mono
```

**Semantic colors** are separate from the accent: severity high `#ff5c6c`,
medium `#ffb020`, low `#6ea8ff`; savings green `#34d399`.

**Components:** panels (gradient surface, 16 px radius, rise-in animation), KPI tiles
with accent edge, segmented toggles, filter chips, split bars, step rails, dropdown
menus, spinner buttons, modals with backdrop blur, and a shared floating chart tooltip.

**Responsive:** 2-up grids collapse at 860 px; the forecast strip goes 7→4 columns and
tables shrink at 620 px; uploads rows reflow at 640 px. Wide content scrolls inside its
own container so the page body never scrolls sideways.
`prefers-reduced-motion` disables all animation. A global
`[hidden] { display: none !important; }` guarantees the attribute always wins over
element `display` rules.

---

## 18. State model

```js
State = {
  data:          { electric: {dataset, analysis, csv}, gas: {...} },
  weather:       { electric, gas },      // join + forecast
  weatherStatus: { electric, gas },      // "" | "loading" | error text
  zipEntry:      { electric, gas },      // last ZIP typed
  uploadIds:     { electric, gas },      // saved row ids
  tips:          { electric: [], gas: [] },
  questions:     { electric, gas },      // generated question sets
  activeFuel, metric, selectedDay, eventFilter,
  accountKey,                            // "<uid>|<utility account>" or "guest|…"
  settings                               // per-identity: billing, profile, annotations, answers
}
```

`accountKey` is namespaced by the **authenticated identity**, never by the CSV's
utility account alone — otherwise two people sharing a browser would read and overwrite
each other's notes.

---

## 19. Security posture

| Concern | Handling |
|---|---|
| **Data isolation** | Postgres RLS on all four tables; verified anon reads return `[]` and anon writes are rejected `42501` |
| **API key** | Only the *publishable* key ships in client code (its intended use). No service-role key exists in the repo. |
| **XSS** | Every user- or server-supplied string reaching `innerHTML` goes through `esc()` — place names, weather status, filenames, free-text answers, ZIP attribute values. Verified with live payloads (`<img onerror>` and attribute-breakout `' onfocus='`): rendered as literal text, handlers never fire. |
| **Session storage** | Tokens in `localStorage`; discarded **only** on 400/401/403, so a network blip can't sign you out. Sign-out clears local state first and wipes caches. |
| **Shared machines** | Sign-out removes settings, profile and guest uploads. |
| **PII** | Bundled sample data is fully anonymized. Account numbers are masked in the UI (`••••1607`). |

---

## 20. Testing

No test framework — verification is done by driving the real app.

- **Unit-level (Node harness):** parse → analyze → tips → questions → acplan → weather
  join; band boundaries (77.9→off, 78→standard, 88→hot, 95→extreme); NaN/degenerate
  forecasts; peak-window collapse cases; a 5,000-permutation sweep proving the AC
  schedule is order-independent.
- **DOM (jsdom):** full render + interaction pass.
- **Browser (Playwright + Chromium):** onboarding walk, ZIP validation, real multi-file
  upload, persistence across reload, resume, billing prompts, fuel switching, theme
  toggle, resize refit, offline degradation, live auth round-trip, and XSS probes with
  real event handlers.

**Two adversarial review passes** (AC playbook, then the platform layer) produced 57
candidate findings, **36 confirmed** after independent verification — including two XSS
vectors, a cross-user data leak, and two bugs that would have signed users out on any
network blip. All fixed and verified.

**Regression invariant:** the sample data must always analyze to
**4 PM–9 PM · 1,687.8 kWh · $686.10 · 30 events · 7 questions**.

---

## 21. Known limitations & next steps

**Limitations**
- Email confirmation is enabled on the Supabase project, so signup requires a click-through
  before first sign-in. Handled gracefully, but it makes onboarding two-stage.
- **Setup still required:** Supabase → Auth → URL Configuration → Site URL must be set to
  `https://pge-usage-tracker.vercel.app` (and added to Redirect URLs), or confirmation
  emails link to `localhost:3000`.
- The signup/sign-in happy path has not been exercised end-to-end with a confirmed
  account (no service-role access to create a test user). Error paths *are* verified
  against the live API.
- Cross-device hydration of annotations/answers is wired but untested on a real second device.
- Guest storage is capped at 12 uploads and bounded by the browser's ~5 MB quota.
- Weather requires network; the published Artifact build can't reach it (CSP), the
  Vercel deployment can.
- Cost figures are indicative, not billing-accurate. Not affiliated with PG&E.

**Natural next steps**
- Export the insights as a PDF/CSV report
- Winter heating playbook (the mirror of the AC playbook)
- Multi-service / multi-property comparison
- Year-over-year comparison once multiple periods are saved
- A guided post-upload question step (top 2–3 questions as a wizard)

---

*Generated from the codebase at commit `5b20509`.*
