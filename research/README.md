# Research inputs and the independent cross-check

## Fixed inputs (`data/`)

Real Twelve Data Daily candles and dividends, saved once so every result here can be reproduced exactly.

| File | Contents |
|---|---|
| `QQQ_1day.csv` | QQQ, 8 Dec 2006 – 26 Oct 2026 (the most recent 5,000 sessions; Twelve Data's history starts 10 Mar 1999, which the live app uses) |
| `TQQQ_1day.csv` | TQQQ, 11 Feb 2010 – 26 Oct 2026 (full history) |
| `QQQ_dividends.csv`, `TQQQ_dividends.csv` | Ex-dates and amounts as Twelve Data returns them (from mid-2012 and mid-2014) |

Prices are Twelve Data's default adjustment: **split-adjusted, not dividend-adjusted** (checked against known split dates and ex-dates). Dividends are therefore credited separately, once, as cash on the ex-date; using these prices *and* crediting dividends does not double-count. The 2006 start does not affect any result: every moving average already exists on TQQQ's first session.

## Methodology (defaults)

$100,000 · 11 Feb 2010 to the latest close · 5 bps per transaction · cash 0% · no margin · actual TQQQ prices · signal at a completed close, execution at the next session's open · fractional shares · CAGR on calendar days ÷ 365.25 · USD. The twelve points that most often differ between backtests are written out on the app's Strategy Research page ("Standard methodology").

## Files

- `load-inputs.ts` — reads the CSVs for the TypeScript engine.
- `export_ts.ts` — runs the app's engine (`src/backtest.ts`) on the fixed inputs and writes JSON.
- `reference_backtest.py` — an independent Python implementation of the same methodology, written from the rules (pandas rolling means, its own state machine and accounting).
- `compare.py` — runs both for three settings and compares every model trade by trade.
- `baseline-v1-snapshot.json` — the V1 engine's outputs, used to prove the V2 refactor leaves every V1 model (including Claude V2) bit-for-bit unchanged.
- `backtest-v1.reference.ts.txt` — the V1 engine source, kept for reference.

```bash
python3 -I research/compare.py      # needs Node 22.13+ and pandas
```

Last run: all 7 models × 3 settings match — same trades (date, signal close, symbol, side, kind, shares, price, fee) and identical daily equity.

## If another backtest disagrees

Compare its choices with the methodology first. The app's Research page quantifies the usual causes on this data (CAGR, default 5 bps with dividends):

| Assumption | Effect on CAGR |
|---|---|
| Trading at the signal close instead of the next open | under ±0.05 points |
| No costs | about +0.01 points |
| Price return only (no dividends) | about −0.8 points |
| Synthetic 3× QQQ instead of actual TQQQ | +0.06 to +0.13 points for TQQQ strategies |
| QQQ history only from 2010 (signals start Nov 2010) | about −0.4 to −0.6 points |
| Starting on 3 Jan 2011 | about −0.6 to −0.8 points |

Other common differences: Adjusted Close series (dividends inside prices) combined with separate dividend credits (double counting), whole-share rounding, a rebalance tolerance band, or a different CAGR year convention.
