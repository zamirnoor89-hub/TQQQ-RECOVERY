// Runs the app's TypeScript engine on the fixed inputs and writes results as JSON for compare.py.
// node --experimental-strip-types research/export_ts.ts out.json [feeBps] [dividends 0|1] [cashRate]
import { writeFileSync } from 'node:fs';
import { simulate } from '../src/backtest.ts';
import { CLAUDE_V2_BASELINE } from '../src/strategy.ts';
import { lastSessionOfMonth } from '../src/time.ts';
import { loadBars, loadDividends } from './load-inputs.ts';

const [out, bps = '5', dv = '0', rate = '0'] = process.argv.slice(2);
const q = loadBars('QQQ'), t = loadBars('TQQQ');
const r = simulate(q, t, { QQQ: loadDividends('QQQ'), TQQQ: loadDividends('TQQQ') }, {
  start: '2010-02-01', end: '2026-12-31', initialCapital: 100000, feeBps: Number(bps), feeFixed: 0, cashRatePct: Number(rate),
  useDividends: dv === '1', baseline: { ...CLAUDE_V2_BASELINE }, modified: null,
});
const res = {
  start: r.dates[0], end: r.dates[r.dates.length - 1], sessions: r.dates.length, lastIsMonthEnd: lastSessionOfMonth(r.dates[r.dates.length - 1]),
  models: Object.fromEntries(r.models.map((m) => [m.id, {
    final: m.final, cagr: m.cagr, maxDD: m.maxDD, sharpe: m.sharpe, equity: m.equity,
    trades: m.trades.map((x) => [x.date, x.signalDate, x.symbol, x.side, x.shares, x.price, x.fee, x.kind]),
  }])),
};
writeFileSync(out, JSON.stringify(res));
console.log(`wrote ${out}: ${res.sessions} sessions, ${r.models.length} models`);
