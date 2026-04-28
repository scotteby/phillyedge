# PhillyEdge

Polymarket weather trading dashboard for the Philadelphia region. Enter your 7-day forecast, see edge calculations against live Polymarket markets, log trade intent, and track P&L over time.

## Tech Stack

- **Next.js 14** (App Router, TypeScript)
- **Supabase** (PostgreSQL database)
- **Tailwind CSS** (dark theme)
- **Vercel** (deploy target)

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd phillyedge
npm install
```

### 2. Set Up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the contents of [`supabase/schema.sql`](./supabase/schema.sql)
3. Copy your project credentials from **Settings → API**

### 3. Environment Variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

> The service role key is used server-side only (API routes) — it never reaches the browser.

### 4. Run Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to `/forecast` on first load.

---

## Deploy to Vercel

1. Push to GitHub
2. Import the repo in [vercel.com](https://vercel.com)
3. Add environment variables in the Vercel project settings (same three vars)
4. Deploy — Vercel auto-detects Next.js

---

## Usage

### Forecast (`/forecast`)
Enter your 7-day Philadelphia forecast: high/low temps, precip chance (0–100%), and precip type. Hit **Save & View Markets** to persist to Supabase and jump to the markets view.

### Markets (`/markets`)
Pulls active Philadelphia weather markets from the Polymarket CLOB API (cached in Supabase, refreshed every 30 minutes). For each market, the edge is calculated by comparing the market's YES price to your forecast:

| Market type | Edge formula |
|---|---|
| Precip / Rain | `our_precip_chance − market_pct` |
| Dry day | `(100 − our_precip_chance) − market_pct` |
| High temp > N°F | `75 − market_pct` if our high > N, else `25 − market_pct` |
| Low temp < N°F | `70 − market_pct` if our low < N, else `30 − market_pct` |

Signal thresholds:

| Signal | Edge |
|---|---|
| **Strong Buy** | ≥ 25 pts |
| **Buy** | ≥ 10 pts |
| **Neutral** | −10 to +10 |
| **Avoid** | ≤ −10 pts |

Click **Trade** on any market to log your trade intent and open Polymarket in a new tab. Actual trade execution is manual — this app logs the intent and calculates P&L.

### History (`/history`)
Summary stats (win rate, total P&L, avg edge) plus a full trade log. Change a trade's outcome (Pending → Win/Loss) in the dropdown; P&L is calculated automatically.

---

## Database Schema

See [`supabase/schema.sql`](./supabase/schema.sql) for the full schema. Three tables:

- **forecasts** — 7 rows per day entered, one per forecast day
- **trades** — one row per logged trade intent
- **market_cache** — cached Polymarket market data, refreshed every 30 min

---

## API Routes

| Route | Method | Description |
|---|---|---|
| `/api/forecast` | `POST` | Save a 7-day forecast |
| `/api/forecast` | `GET` | Fetch forecasts (optional `?date=YYYY-MM-DD`) |
| `/api/markets` | `GET` | Fetch/refresh Polymarket markets (with cache) |
| `/api/trades` | `POST` | Log a trade |
| `/api/trades` | `GET` | Fetch all trades |
| `/api/trades` | `PATCH` | Update trade outcome + P&L |
