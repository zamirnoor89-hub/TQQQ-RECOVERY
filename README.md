# TQQQ Recovery V2.0 — Multi-Strategy Investment Dashboard

A private website that monitors and compares three independent ways of running a small TQQQ satellite next to a QQQ core, from completed Daily candles:

- **A · Claude V2** (unchanged): buy 2.5% after two closes ≥ 2% above SMA200, add to 5% after 20 sessions and two new qualifying closes, exit on a close ≤ 3% below SMA200, trim above 6%.
- **B · SMA50/SMA200 rotation**: 5% TQQQ while QQQ's SMA50 is strictly above its SMA200, reset monthly; the whole sleeve to cash when SMA50 is at or below SMA200.
- **C · Monthly rebalanced 95/5**: TQQQ reset to 5% at the open after each month-end close; no signals, no liquidation.

Each strategy has its own market signal, its own sleeve of your recorded holdings, its own portfolio action (BUY / ADD / HOLD / TRIM / EXIT / REBALANCE / WAIT / DATA UNAVAILABLE), checklist, timeline and backtest. It keeps your holdings, real trades, settings and alerts in its own database, runs backtests and robustness research on Twelve Data history, and shows exposure and drawdown scenarios.

- **Two ways to host it, same routes.** On **Vercel** as one serverless function (`api/index.mjs`) with your records in **Upstash Redis**; or on any Node host as one server (`dist/site/server.mjs`) with a SQLite file. Both are built from `server/app.ts`.
- **No npm packages.** Only Node's built-ins (`http`, `crypto`, `zlib`, `sqlite`) and `fetch` for Redis's REST API.
- **Your Twelve Data key stays on the server.** It is read from `TWELVE_DATA_API_KEY`, sent only in the `Authorization` header to Twelve Data, and never reaches the browser, a URL, the database or a log.
- **Password sign-in.** The site will not open without `DASHBOARD_PASSWORD`.
- **Persistent records.** Upstash Redis on Vercel; a SQLite file in `DATA_DIR` elsewhere.

Decision support only: it never places orders, and a signal is never recorded as a trade.

---

## Run it on your computer (5 minutes)

Needs **Node.js 22.13 or newer** (`node --version`).

```bash
node build.mjs
TWELVE_DATA_API_KEY=your_key DASHBOARD_PASSWORD=choose-a-password npm start
```

Open http://localhost:8080 and sign in. On Windows PowerShell:

```powershell
node build.mjs
$env:TWELVE_DATA_API_KEY="your_key"; $env:DASHBOARD_PASSWORD="choose-a-password"; npm start
```

---

## Put it online

### Vercel (with Upstash Redis)

Vercel runs the dashboard as one serverless function and keeps nothing on disk, so your holdings, trades, settings, alerts and the price cache go into a free Upstash Redis database that you connect from Vercel's Storage tab. `vercel.json` already sets everything else: the build (`node build.mjs`), the function, the routing, and the region (`sin1`, Singapore).

1. **Put the code on GitHub.** Create a **private** repository and upload this folder's contents (GitHub's *Add file → Upload files* accepts the whole folder). Keep `api/`, `public/` and `vercel.json`. Never upload a `.env` file.
2. **Import it into Vercel.** *Add New → Project*, pick the repository, leave *Framework Preset* on **Other** and change nothing else. Deploy. The first deployment shows a "needs setting up" page; that is expected.
3. **Add the database.** In the project: *Storage → Create Database → Upstash for Redis*. Choose the free plan and the **Singapore (ap-southeast-1)** region, then connect it to the project for all environments. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
4. **Add your two secrets.** *Settings → Environment Variables*: `TWELVE_DATA_API_KEY` and `DASHBOARD_PASSWORD`. Tick **Sensitive** for both.
5. **Redeploy.** *Deployments → ⋯ on the latest → Redeploy*. New variables only reach new deployments.
6. **Open `https://<your-project>.vercel.app`** and sign in. The first load downloads full QQQ and TQQQ history (about 4 Twelve Data calls) and stores it in Redis; later visits fetch only the latest sessions.

If you pick a different Upstash region, change `"regions"` in `vercel.json` to the Vercel region next to it (for example `iad1` for us-east-1) so every database call stays short.

**From the command line instead of GitHub:** install the Vercel CLI (`npm i -g vercel`), run `vercel` in this folder to create the project, do steps 3–4 in the dashboard (or `vercel env add TWELVE_DATA_API_KEY production`), then `vercel --prod`.

**Changing the code later:** run `node build.mjs` and commit the updated `api/index.mjs` with your change. Vercel also rebuilds on every deployment.

**Good to know**
- Vercel's Hobby plan is for personal, non-commercial use, which this is. Upstash's free plan allows 500,000 commands a month; a dashboard visit uses roughly 10–20.
- The function sends each response under Vercel's 4.5 MB limit (full QQQ history is about 0.6 MB, 0.15 MB compressed) and stops after 120 seconds.
- Several Vercel instances may run at once. They share the session secret, the login-attempt lockout and the Twelve Data credit count through Redis, so the per-minute limit holds across all of them.
- Preview deployments use the same database if you connect it to Preview as well.

### Render

1. Create a **private** GitHub repository and upload this folder's contents (GitHub's "Add file → Upload files" accepts the whole folder).
2. In Render: **New → Blueprint**, pick the repository. Render reads `render.yaml`: a Node web service with a 1 GB disk at `/var/data`.
3. When asked, enter `TWELVE_DATA_API_KEY` and `DASHBOARD_PASSWORD`.
4. Deploy. Your site is at `https://tqqq-recovery.onrender.com` (or the name you chose).

Persistent disks need a paid instance (Starter). On the free plan the database is wiped on every deploy.

### Railway

New project → Deploy from GitHub repo. Add a **Volume** mounted at `/data`, then set variables `TWELVE_DATA_API_KEY`, `DASHBOARD_PASSWORD`, `DATA_DIR=/data`, `COOKIE_SECURE=true`. Build command `node build.mjs`, start command `npm start`.

### A VPS or home server (Docker)

```bash
cp .env.example .env    # fill in the key and password
docker compose up -d --build
```

Put it behind HTTPS (Caddy, nginx or Cloudflare Tunnel) and set `COOKIE_SECURE=true`. Without Docker, `deploy/tqqq-recovery.service` is a systemd unit.

---

## Settings (environment variables)

| Variable | Required | Default | What it does |
|---|---|---|---|
| `TWELVE_DATA_API_KEY` | yes | — | Your Twelve Data key. Without it the site shows DATA UNAVAILABLE. |
| `DASHBOARD_PASSWORD` | yes | — | Sign-in password. Changing it signs every device out. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel | — | Set by Vercel's Upstash integration. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work. |
| `REDIS_KEY_PREFIX` | no | `tqqq:` | Vercel only. Lets several sites share one Redis database. |
| `DATA_DIR` | no | `./data` | Node host only. Folder for `tqqq.db`. Must be persistent storage. |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address. Hosts usually set `PORT`. |
| `TD_CREDITS_PER_MINUTE` | no | `50` | Credits this site may spend per minute. Lower it if other apps share the key (Grow plan: 55). |
| `COOKIE_SECURE` | no | `false` (Vercel: `true`) | Set `true` when served over HTTPS (also detected from `X-Forwarded-Proto`). |
| `SESSION_SECRET` | no | generated | Signs sessions. Generated once and kept in the database if not set. |
| `ALLOW_NO_PASSWORD` | no | `false` | Node host only: `true` for local use without a password. Ignored on Vercel. |

### Twelve Data credits

A visit uses about 2–6 credits: one small update per symbol (history is cached by year in the database) plus two quotes. The first ever load downloads full history in about 4 calls. Dividends (backtests only) are fetched at most once a day and are counted as 20 credits each. If the per-minute allowance is used up, requests wait up to a minute rather than fail. On Vercel the count is kept in Redis per clock minute, so all instances share it.

---

## What's in the box

```
server/        app.ts (routes, shared), main.ts + sqlite.ts (Node host), vercel.ts + redis.ts (Vercel),
               auth.ts (password and session cookie), tdrest.ts (Twelve Data REST client)
api/index.mjs  the built Vercel function (from build.mjs; commit it)
public/        static files Vercel serves directly (robots.txt only)
vercel.json    Vercel build, function, region and routing
src/           the strategy engine and the pages, shared with the claude.ai version
  time.ts        US exchange calendar (holidays, early closes), New York ↔ Malaysia time
  data.ts        parsing and completed-candle validation
  strategy.ts    SMA200, Claude V2 state machine, checklists (unchanged rules)
  strategies.ts  SMA50/SMA200 rotation and monthly 95/5: live evaluation, checklists, schedules
  allocation.ts  sizing per sleeve (whole shares, cash-capped, never above target after fees), risk
  backtest.ts    one engine for every model, metrics, trade logs, no-look-ahead check
  research.ts    SMA-pair sensitivity, periods, walk-forward, methodology sensitivity
  store.ts       holdings by strategy sleeve, transactions, settings; reads V1 records unchanged
  site/          website entry and sign-in page
research/      fixed Twelve Data inputs, the independent Python engine and the cross-check
tests/         acceptance and regression tests, server tests, browser test (tests/e2e)
build.mjs      builds dist/ (no npm needed)
```

`dist/index.html` is the claude.ai version of the same dashboard, which uses the Twelve Data connector instead of a key.

## Tests

```bash
node build.mjs && npm test
```

62 checks: the original V1 acceptance tests, the V2.0 acceptance items (§14), regression tests for the two new strategies, the Node server (sign-in, cross-site protection, caching, persistence across a restart, the key never leaving the server), the Vercel function (run through `tests/vercel-local.mjs`, which applies `vercel.json`'s rewrite and Vercel's size limits, against stand-in Upstash and Twelve Data servers: several instances sharing one database, cold starts, the shared login lockout and credit allowance, setup errors, neither secret leaving the server) and a trade-by-trade comparison with the independent Python engine (`python3 -I research/compare.py`, needs pandas). Real-data tests use the fixed Twelve Data files in `research/data`.

The browser test (`node tests/e2e/browser.mjs`, needs Playwright) runs the built page on desktop and phone, in dark and light mode, with a saved V1 record.

## Backups

On a Node host, everything you enter is in `DATA_DIR/tqqq.db`; copy that file to back it up. On Vercel it is in your Upstash database, in the hashes `tqqq:doc:data/users/owner` (your records) and `tqqq:doc:market/...` (the price cache, which rebuilds itself if lost).
