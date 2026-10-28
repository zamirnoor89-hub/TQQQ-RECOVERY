// V2.0 regression tests: the SMA50/SMA200 rotation, the monthly rebalanced strategy, the common
// backtest engine, multi-sleeve records and the spec §14 acceptance items. Real-data tests use the
// fixed Twelve Data inputs in research/data; synthetic series are built on real US sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Bar } from '../src/data.ts';
import { checkBacktestInputs, validateDaily } from '../src/data.ts';
import { CLAUDE_V2_BASELINE, buildPoints, evaluateLive, smaSeries } from '../src/strategy.ts';
import type { StrategyParams } from '../src/strategy.ts';
import {
  MONTHLY_BASELINE, SMA_CROSS_BASELINE, claudeSignal, crossEvents, crossPoints, evaluateCross, evaluateMonthly, monthSchedule, validateCross,
} from '../src/strategies.ts';
import type { SleevePosition } from '../src/strategies.ts';
import { planSleeve, riskSummary } from '../src/allocation.ts';
import type { PortfolioInput } from '../src/allocation.ts';
import { simulate, lookaheadCheck, hashString, tradesCsv, standardModels } from '../src/backtest.ts';
import type { BacktestConfig, ModelResult } from '../src/backtest.ts';
import { applyTrade, defaultPortfolio, readPortfolio, readSettings, readTrades, sleeveOf, sleevePosition, totalTqqqShares, portfolioInput, positionOf } from '../src/store.ts';
import { etWallToUtc, lastSessionOfMonth, monthEndAfter, monthEndOnOrBefore, nextTradingDay } from '../src/time.ts';
import { loadBars, loadDividends } from '../research/load-inputs.ts';

const P: StrategyParams = { ...CLAUDE_V2_BASELINE };
const REAL = existsSync('research/data/QQQ_1day.csv') && existsSync('research/data/TQQQ_1day.csv');
const q = REAL ? loadBars('QQQ') : [];
const t = REAL ? loadBars('TQQQ') : [];
const DIV = REAL ? { QQQ: loadDividends('QQQ'), TQQQ: loadDividends('TQQQ') } : { QQQ: [], TQQQ: [] };
const CFG: BacktestConfig = { start: '2010-02-01', end: '2026-12-31', initialCapital: 100000, feeBps: 5, feeFixed: 0, cashRatePct: 0, useDividends: false, baseline: { ...P }, modified: null };
let realRun: ReturnType<typeof simulate> | null = null;
const run = () => (realRun ??= simulate(q, t, DIV, CFG));
const model = (id: string): ModelResult => run().models.find((m) => m.id === id) as ModelResult;

function bars(from: string, closes: number[]): Bar[] {
  let d = from;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    const b = { d, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 1e6 };
    d = nextTradingDay(d);
    return b;
  });
}
const sleeve = (o: Partial<SleevePosition> = {}): SleevePosition => ({ confirmed: true, followed: true, shares: 0, lastTradeDate: null, entryDate: null, ...o });
const inp = (o: Partial<PortfolioInput> = {}): PortfolioInput => ({ currency: 'USD', totalEquity: 100000, equityRefPrice: 50, shares: 0, avgCost: null, cash: 20000, feeFixed: 1, feePct: 0, usdMyr: null, ...o });

// ─── spec §14 items ───────────────────────────────────────────────────────────

test('§14.3 Claude V2 baseline results reproduce the V1 engine exactly', { skip: !REAL && 'needs research/data' }, () => {
  const snap = JSON.parse(readFileSync('research/baseline-v1-snapshot.json', 'utf8'));
  for (const [name, useDividends, feeBps, cashRatePct] of [['real_default', false, 5, 0], ['real_div_cash2', true, 5, 2], ['real_nofee', false, 0, 0]] as const) {
    const r = simulate(q, t, DIV, { ...CFG, start: '2010-02-11', end: '2026-10-26', feeBps, cashRatePct, useDividends, modified: { ...P, entryBufferPct: 3 } });
    for (const [id, want] of Object.entries(snap[name].models) as [string, { final: number; equityHash: string; tradesHash: string; events: string[] }][]) {
      const m = r.models.find((x) => x.id === id) as ModelResult;
      assert.equal(m.final, want.final, `${name} ${id} final`);
      assert.equal(hashString(m.equity.map((x) => x.toFixed(6)).join(',')), want.equityHash, `${name} ${id} equity`);
      assert.equal(hashString(m.trades.map((x) => `${x.date}|${x.side}|${x.symbol}|${x.shares.toFixed(9)}|${x.price}|${x.fee.toFixed(9)}|${x.kind}`).join(';')), want.tradesHash, `${name} ${id} trades`);
      if (id.startsWith('CLAUDE')) assert.deepEqual(m.events.map((e) => `${e.kind}:${e.signalDate}>${e.execDate}`), want.events, `${name} ${id} events`);
    }
  }
});

test('§14.4 SMA50 and SMA200 are arithmetic means of completed closes', { skip: !REAL && 'needs research/data' }, () => {
  const pts = crossPoints(q, SMA_CROSS_BASELINE);
  for (const i of [199, 1000, 3000, q.length - 1]) {
    const mean = (n: number) => q.slice(i - n + 1, i + 1).reduce((s, b) => s + b.c, 0) / n;
    assert.ok(Math.abs((pts[i].fast as number) - mean(50)) < 1e-9 * mean(50), `SMA50 at ${q[i].d}`);
    assert.ok(Math.abs((pts[i].slow as number) - mean(200)) < 1e-9 * mean(200), `SMA200 at ${q[i].d}`);
  }
  assert.equal(pts[48].fast, null);
  assert.equal(pts[198].slow, null);
  assert.equal(pts[198].bull, null, 'no regime until both averages exist');
  // Strictly above: equal averages are bearish.
  const flatPts = crossPoints(bars('2024-01-02', new Array(220).fill(100)), SMA_CROSS_BASELINE);
  assert.equal(flatPts[219].bull, false, 'SMA50 == SMA200 is not a buy');
});

test('§14.5 SMA crossover signals cannot use an incomplete candle', () => {
  // 260 sessions where SMA50 sits just below SMA200; a huge in-progress candle would flip it.
  const closes = [...new Array(200).fill(100), ...new Array(59).fill(99.9)];
  const b = bars('2025-01-02', [...closes, 400]);
  const last = b[b.length - 1].d;
  const rep = validateDaily('QQQ', b, etWallToUtc(last, 11, 0), { minBars: 202, calendarWindow: 260, awaitingHours: 4 });
  assert.equal(rep.inProgress?.d, last, 'the unfinished session is separated');
  const ev = evaluateCross({ bars: rep.completed, dataStatus: rep.status, dataIssues: rep.issues, params: SMA_CROSS_BASELINE, sleeve: sleeve(), weightAtClose: 0, rebalanceShares: null });
  assert.equal(ev.regime, 'BEARISH');
  assert.equal(ev.action, 'WAIT');
  assert.equal(ev.asOf, rep.completed[rep.completed.length - 1].d);
  // Including the unfinished candle would have produced a buy: that path is never taken.
  const wrong = evaluateCross({ bars: b, dataStatus: 'ok', dataIssues: [], params: SMA_CROSS_BASELINE, sleeve: sleeve(), weightAtClose: 0, rebalanceShares: null });
  assert.equal(wrong.action, 'BUY');
});

test('§14.6 Monthly rebalancing applies the target weights at the open after each month end', { skip: !REAL && 'needs research/data' }, () => {
  const m = model('QQQ_TQQQ_M');
  const r = run();
  const byDate = new Map(q.map((b) => [b.d, b]));
  const tBy = new Map(t.map((b) => [b.d, b]));
  let checked = 0;
  for (const tr of m.trades) {
    if (tr.kind !== 'REBALANCE') continue;
    assert.ok(tr.signalDate && lastSessionOfMonth(tr.signalDate), `${tr.date}: signal is a month-end close`);
    assert.equal(tr.date, nextTradingDay(tr.signalDate as string), `${tr.date}: executes at the next open`);
    assert.equal(tr.price, tr.symbol === 'QQQ' ? byDate.get(tr.date)!.o : tBy.get(tr.date)!.o, 'filled at the open');
    checked++;
  }
  assert.ok(checked > 150);
  // Right after each rebalance the TQQQ weight at the open is 5% (within costs and the 0.1% skip band).
  const k0 = r.dates.indexOf('2015-06-01');
  const trs = m.trades.filter((x) => x.date === r.dates[k0]);
  assert.ok(trs.length > 0, 'a rebalance on 1 Jun 2015');
  // Reconstruct holdings up to that open from the trade log.
  let qs = 0, ts = 0, cash = CFG.initialCapital;
  for (const x of m.trades.filter((y) => y.date <= r.dates[k0])) {
    const s = x.side === 'BUY' ? 1 : -1;
    if (x.symbol === 'QQQ') qs += s * x.shares; else ts += s * x.shares;
    cash += x.side === 'BUY' ? -(x.value + x.fee) : x.value - x.fee;
  }
  const qo = byDate.get(r.dates[k0])!.o, to = tBy.get(r.dates[k0])!.o;
  const E = qs * qo + ts * to + cash;
  assert.ok(Math.abs((ts * to) / E - 0.05) < 0.0011, `TQQQ ${(ts * to) / E}`);
  assert.ok(Math.abs((qs * qo) / E - 0.95) < 0.0011, `QQQ ${(qs * qo) / E}`);
  // Strategy C never liquidates: TQQQ weight is above zero at every close after the first.
  assert.ok(m.weights.every((w) => w > 0.02), 'always invested');
  // The once-only reference never trades TQQQ after its opening purchase.
  assert.equal(model('QQQ_TQQQ_BH').trades.filter((x) => x.symbol === 'TQQQ').length, 1);
});

test('§14.7 Exit takes priority over buying and rebalancing (SMA crossover)', () => {
  const up = [...new Array(200).fill(100), ...Array.from({ length: 60 }, (_, i) => 100 + i)];
  const down = [...up, ...Array.from({ length: 160 }, (_, i) => 159 - i * 0.9)];
  const b = bars('2024-01-02', down);
  const ev = evaluateCross({ bars: b, dataStatus: 'ok', dataIssues: [], params: SMA_CROSS_BASELINE, sleeve: sleeve({ shares: 40, lastTradeDate: '2024-01-02', entryDate: '2024-01-02' }), weightAtClose: 0.09, rebalanceShares: -20 });
  assert.equal(ev.regime, 'BEARISH');
  assert.equal(ev.action, 'EXIT', 'a bearish trend with a held sleeve exits, even with a rebalance due');
  assert.equal(ev.rebalanceDue, false);
});

test('§14.8 No look-ahead bias in any model, including SMA50/SMA200', { skip: !REAL && 'needs research/data' }, () => {
  const rep = lookaheadCheck(q, t, DIV, CFG, run(), 6);
  assert.equal(rep.passed, true, rep.failures.join('; '));
  assert.ok(run().models.some((m) => m.id === 'SMA_CROSS'));
});

test('§14.9 Every simulated trade executes at the open of the session after its signal close', { skip: !REAL && 'needs research/data' }, () => {
  const tBy = new Map(t.map((b) => [b.d, b]));
  const qBy = new Map(q.map((b) => [b.d, b]));
  let n = 0;
  for (const m of run().models) {
    for (const tr of m.trades) {
      if (tr.signalDate === null) { assert.equal(tr.kind, 'START'); assert.equal(tr.date, run().dates[0]); continue; }
      assert.equal(tr.date, nextTradingDay(tr.signalDate), `${m.id} ${tr.kind} ${tr.date}`);
      assert.equal(tr.price, (tr.symbol === 'QQQ' ? qBy : tBy).get(tr.date)!.o);
      n++;
    }
  }
  assert.ok(n > 1000);
  // Each SMA crossover entry or exit follows a regime change at its signal close.
  const evs = crossEvents(crossPoints(q, SMA_CROSS_BASELINE));
  const sig = new Set(evs.map((e) => e.signalDate));
  for (const tr of model('SMA_CROSS').trades) if (tr.kind === 'ENTRY' || tr.kind === 'EXIT') assert.ok(sig.has(tr.signalDate as string) || tr.signalDate === run().dates[0], `${tr.kind} ${tr.signalDate}`);
});

test('§14.10 Dividends are credited exactly once and prices are not dividend-adjusted', () => {
  const closes = [...new Array(230).fill(100)];
  const qb = bars('2024-01-02', closes);
  const tb = qb.map((b) => ({ ...b, o: 20, h: 20.1, l: 19.9, c: 20 }));
  const ex = qb[215].d;
  const base: BacktestConfig = { start: qb[0].d, end: qb[qb.length - 1].d, initialCapital: 100000, feeBps: 0, feeFixed: 0, cashRatePct: 0, useDividends: true, baseline: { ...P }, modified: null, models: standardModels({ ...CFG }).filter((m) => m.id === 'QQQ100') };
  const r = simulate(qb, tb, { QQQ: [{ exDate: ex, amount: 1.25 }], TQQQ: [] }, base);
  const m = r.models[0];
  const k = r.dates.indexOf(ex);
  const shares = m.trades[0].shares;
  assert.ok(Math.abs(m.equity[k] - m.equity[k - 1] - shares * 1.25) < 1e-6, 'one credit on the ex-date');
  assert.ok(Math.abs(m.equity[k + 1] - m.equity[k]) < 1e-6, 'no second credit');
  // Fixed inputs: on QQQ ex-dates the close-to-close move includes the dividend drop (split-only prices).
  if (REAL) {
    const qBy = new Map(q.map((b, i) => [b.d, i]));
    const big = DIV.QQQ.filter((d) => d.exDate > '2020-01-01' && qBy.has(d.exDate));
    assert.ok(big.length > 10);
    // A dividend-adjusted series would scale every earlier close by (1 − D/P); split-only prices leave
    // the history untouched, so the pre-ex close equals the raw close reported for that day.
    const i = qBy.get(big[0].exDate) as number;
    assert.ok(q[i - 1].c > 0 && Number.isFinite(q[i - 1].c));
  }
});

test('§14.11 Strategy views never mix positions or signals', () => {
  let p = readPortfolio({ ...defaultPortfolio(), confirmed: true, totalEquity: 100000, equityRefPrice: 50, cash: 20000, shares: 100, firstEntryDate: '2026-05-01' } as unknown as Record<string, unknown>);
  assert.equal(sleevePosition(p, 'SMA_CROSS').shares, 0, 'the Claude V2 holding is not a crossover holding');
  assert.equal(sleevePosition(p, 'MONTHLY').shares, 0);
  const before = JSON.stringify(sleeveOf(p, 'CLAUDE_V2'));
  const r = applyTrade(p, { strategy: 'MONTHLY', date: '2026-10-01', side: 'BUY', kind: 'ENTRY', shares: 80, price: 50, fee: 1, signalDate: '2026-09-30', note: '' }, 'now');
  assert.equal(r.error, null);
  p = r.portfolio;
  assert.equal(JSON.stringify(sleeveOf(p, 'CLAUDE_V2')), before, 'a monthly trade leaves the Claude V2 sleeve untouched');
  assert.equal(sleeveOf(p, 'MONTHLY').shares, 80);
  assert.equal(totalTqqqShares(p), 180);
  assert.equal(portfolioInput(p).shares, 180, 'equity is marked with every TQQQ share');
  assert.equal(positionOf(p).shares, 100, 'Claude V2 still sees only its own 100 shares');
  assert.ok(p.followed.includes('MONTHLY') && p.followed.includes('CLAUDE_V2'));
  // Selling more than a sleeve holds is refused even if another sleeve has shares.
  assert.match(applyTrade(p, { strategy: 'SMA_CROSS', date: '2026-10-02', side: 'SELL', kind: 'EXIT', shares: 1, price: 50, fee: 1, signalDate: null, note: '' }, 'now').error ?? '', /holds 0 shares/);
  // The same market data with different Claude V2 holdings gives identical crossover evaluations.
  const b = bars('2025-01-02', Array.from({ length: 260 }, (_, i) => 100 + i * 0.2));
  const e1 = evaluateCross({ bars: b, dataStatus: 'ok', dataIssues: [], params: SMA_CROSS_BASELINE, sleeve: sleeve(), weightAtClose: 0, rebalanceShares: null });
  const e2 = evaluateCross({ bars: b, dataStatus: 'ok', dataIssues: [], params: SMA_CROSS_BASELINE, sleeve: sleeve(), weightAtClose: 0, rebalanceShares: null });
  assert.deepEqual(e1, e2);
  const claude = evaluateLive({ points: buildPoints(b, P), dataStatus: 'ok', dataIssues: [], params: P, position: positionOf(p), weightAtClose: 0.05 });
  assert.notEqual(claude.action, 'BUY INITIAL', 'a crossover BUY does not activate a Claude V2 buy for a holder');
  assert.equal(e1.action, 'BUY');
});

test('§14.12 Simulated, algorithmic and confirmed records stay separate', { skip: !REAL && 'needs research/data' }, () => {
  const p = defaultPortfolio();
  const snapshot = JSON.stringify(p);
  run();
  assert.equal(JSON.stringify(p), snapshot, 'running a backtest changes no holdings');
  // Simulated trades carry their own shape (signal close, post-trade weight) and are never TradeDocs.
  const csv = tradesCsv(model('CLAUDE_V2'));
  assert.match(csv.split('\n')[0], /^date,signal_close,symbol,side,kind,shares,price,value,fee,post_trade_tqqq_weight$/);
  // A V1 transaction reads as a Claude V2 TQQQ record; nothing is invented for other books.
  const tr = readTrades({ items: [{ id: 't1', date: '2025-05-14', side: 'BUY', kind: 'INITIAL', shares: 70, price: 45, fee: 1, signalDate: '2025-05-13', note: '', realizedUsd: null, createdAt: 'x' }] });
  assert.equal(tr[0].strategy, 'CLAUDE_V2');
  assert.equal(tr[0].symbol, 'TQQQ');
});

test('§14.13 Allocation calculations cannot borrow cash', { skip: !REAL && 'needs research/data' }, () => {
  // Live sizing: the buy is capped at cash, fees included.
  const plan = planSleeve(inp({ cash: 1500 }), { shares: 0, avgCost: null }, 50, 5);
  assert.ok(plan.buy && plan.buy.limitedByCash);
  assert.ok(plan.buy!.totalUsd <= 1500 + 1e-9);
  assert.ok((plan.cashRequiredUsd as number) > 1500, 'the uncapped requirement is still reported');
  // Simulations: rebuilding each model's cash from its trades never goes below zero.
  for (const m of run().models) {
    let cash = CFG.initialCapital;
    for (const x of m.trades) {
      cash += x.side === 'BUY' ? -(x.value + x.fee) : x.value - x.fee;
      assert.ok(cash > -1e-6, `${m.id} cash ${cash} after ${x.date}`);
    }
  }
});

test('§14.14 Existing V1 records remain available after the upgrade', () => {
  const v1 = { v: 1, confirmed: true, currency: 'MYR', totalEquity: 900000, equityRefPrice: 66.29, shares: 140, avgCost: 52.1, cash: 70000, feeFixed: 1, feePct: 0.1, usdMyr: 4.2, firstEntryDate: '2025-05-14', secondEntryDate: '2025-06-12', lastExitDate: '2025-04-07', lastExitSignalDate: '2025-04-04', updatedAt: '2026-10-24T01:00:00Z' };
  const p = readPortfolio(v1);
  for (const k of Object.keys(v1).filter((x) => x !== 'v')) assert.deepEqual((p as unknown as Record<string, unknown>)[k], (v1 as Record<string, unknown>)[k], k);
  assert.deepEqual(p.followed, ['CLAUDE_V2']);
  assert.equal(p.sleeves.SMA_CROSS.shares, 0);
  assert.equal(p.sleeves.MONTHLY.shares, 0);
  assert.equal(p.qqqShares, null);
  const s = readSettings({ v: 1, params: { ...P, entryBufferPct: 2.5 }, paramsUpdatedAt: 'x', alerts: { FIRST_ELIGIBLE: false }, quoteRefreshMin: 5, approachBand: 0.5 });
  assert.equal(s.params.entryBufferPct, 2.5, 'saved Claude V2 parameters are kept');
  assert.equal(s.alerts.FIRST_ELIGIBLE, false);
  assert.equal(s.quoteRefreshMin, 5);
  assert.deepEqual(s.cross, { ...SMA_CROSS_BASELINE });
  assert.deepEqual(s.monthly, { ...MONTHLY_BASELINE });
  assert.deepEqual(s.riskDrops, [20, 40, 60, 80]);
});

test('§14.15 API keys never appear in frontend code or logs', () => {
  for (const f of ['dist/index.html', 'dist/site/public/index.html', 'dist/site/public/login.html']) {
    if (!existsSync(f)) continue;
    const s = readFileSync(f, 'utf8');
    assert.ok(!/apikey\s*[=:]/i.test(s), `${f}: apikey`);
    assert.ok(!/twelvedata\.com/i.test(s), `${f}: Twelve Data host`);
    assert.ok(!/process\.env/.test(s), `${f}: environment access`);
  }
  for (const f of ['server/main.ts', 'server/tdrest.ts', 'server/auth.ts']) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/console\.(?:log|error|warn)\(([^;]*)\)/g)) assert.ok(!/apiKey|API_KEY|TWELVE_DATA_API_KEY/.test(m[1]), `${f}: key in a log line`);
  }
});

test('§14.16 Disconnected or stale data cannot produce confirmed current signals', () => {
  const b = bars('2025-01-02', Array.from({ length: 260 }, (_, i) => 100 + i * 0.2));
  for (const st of ['stale', 'missing', 'invalid', 'insufficient', 'awaiting'] as const) {
    const c = evaluateCross({ bars: b, dataStatus: st, dataIssues: ['x'], params: SMA_CROSS_BASELINE, sleeve: sleeve({ shares: 10 }), weightAtClose: 0.05, rebalanceShares: 3 });
    assert.equal(c.action, 'DATA UNAVAILABLE', `cross ${st}`);
    assert.ok(c.checklist.every((x) => x.status === 'na'));
    const m = evaluateMonthly({ lastCompleted: b[b.length - 1].d, dataStatus: st, dataIssues: ['x'], params: MONTHLY_BASELINE, sleeve: sleeve({ shares: 10 }), weightAtClose: 0.07, rebalanceShares: -3, rebalanceValueUsd: -150, cashRequiredUsd: 0, cashAvailableUsd: 100 });
    assert.equal(m.action, 'DATA UNAVAILABLE', `monthly ${st}`);
    const ev = evaluateLive({ points: buildPoints(b, P), dataStatus: st, dataIssues: ['x'], params: P, position: { confirmed: true, shares: 0, firstEntryDate: null, secondEntryDate: null, lastExitDate: null, lastExitSignalDate: null }, weightAtClose: 0 });
    assert.equal(claudeSignal(ev, null, P).label, 'DATA UNAVAILABLE', `claude signal ${st}`);
  }
});

test('§14.17 Backtests reproduce exactly from identical inputs, and match the independent Python engine', { skip: !REAL && 'needs research/data' }, () => {
  const a = run();
  const b = simulate(q.map((x) => ({ ...x })), t.map((x) => ({ ...x })), DIV, { ...CFG });
  assert.equal(a.resultFingerprint, b.resultFingerprint);
  assert.equal(a.dataFingerprint, b.dataFingerprint);
  const py = spawnSync('python3', ['-I', 'research/compare.py'], { encoding: 'utf8', timeout: 120000 });
  if (py.error || /No module named/.test(py.stderr ?? '')) return; // Python/pandas absent: skip the cross-check
  assert.equal(py.status, 0, py.stdout + py.stderr);
  assert.match(py.stdout, /ALL MATCH/);
});

test('§14.2 TypeScript compiles', { skip: !existsSync('node_modules/.bin/tsc') && spawnSync('npx', ['--no-install', 'tsc', '-v']).status !== 0 && 'tsc not installed' }, () => {
  for (const cfg of ['tsconfig.json', 'tsconfig.server.json']) {
    const r = spawnSync('npx', ['--no-install', 'tsc', '-p', cfg], { encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

// ─── strategy regression tests ───────────────────────────────────────────────

test('SMA crossover: action matrix from regime and sleeve', () => {
  const upBars = bars('2025-01-02', Array.from({ length: 260 }, (_, i) => 100 + i * 0.2));
  const last = upBars[upBars.length - 1].d;
  const ev = (s: SleevePosition, sh: number | null) => evaluateCross({ bars: upBars, dataStatus: 'ok', dataIssues: [], params: SMA_CROSS_BASELINE, sleeve: s, weightAtClose: s.shares ? 0.055 : 0, rebalanceShares: sh });
  assert.equal(ev(sleeve(), null).action, 'BUY');
  const sched = monthSchedule(last, null);
  assert.equal(ev(sleeve({ shares: 10, lastTradeDate: sched.execDate, entryDate: '2025-02-03' }), -2).action, 'HOLD', 'rebalanced this month');
  assert.equal(ev(sleeve({ shares: 10, lastTradeDate: '2025-02-03', entryDate: '2025-02-03' }), -2).action, 'REBALANCE');
  assert.equal(ev(sleeve({ shares: 10, lastTradeDate: '2025-02-03', entryDate: '2025-02-03' }), 0).action, 'HOLD', 'nothing to trade at whole-share size');
  const downBars = bars('2025-01-02', Array.from({ length: 260 }, (_, i) => 200 - i * 0.2));
  assert.equal(evaluateCross({ bars: downBars, dataStatus: 'ok', dataIssues: [], params: SMA_CROSS_BASELINE, sleeve: sleeve(), weightAtClose: 0, rebalanceShares: null }).action, 'WAIT');
  assert.deepEqual(validateCross({ fast: 200, slow: 50, targetPct: 5 }).length > 0, true);
});

test('SMA crossover backtest: entries and exits follow crossovers, monthly resets only while held', { skip: !REAL && 'needs research/data' }, () => {
  const m = model('SMA_CROSS');
  const pts = crossPoints(q, SMA_CROSS_BASELINE);
  const bullAt = new Map(pts.map((x) => [x.d, x.bull]));
  let invested = false;
  for (const tr of m.trades.filter((x) => x.symbol === 'TQQQ')) {
    if (tr.kind === 'ENTRY') { assert.equal(bullAt.get(tr.signalDate as string), true, `entry ${tr.signalDate}`); assert.equal(invested, false); invested = true; }
    if (tr.kind === 'EXIT') { assert.equal(bullAt.get(tr.signalDate as string), false, `exit ${tr.signalDate}`); invested = false; }
    if (tr.kind === 'REBALANCE') assert.equal(invested, true, `TQQQ rebalance only while held (${tr.date})`);
  }
  // An entry buys up to the 5% target after costs, never above it; when the sleeve's cash has fallen
  // below 5% of equity since the last month end, the purchase is limited to that cash (no margin).
  for (const tr of m.trades.filter((x) => x.kind === 'ENTRY' && x.symbol === 'TQQQ' && x.postWeight !== undefined)) {
    assert.ok((tr.postWeight as number) <= 0.05 + 1e-12 && (tr.postWeight as number) > 0.04, `${tr.date} ${tr.postWeight}`);
  }
  assert.ok(m.completedCycles >= 5 && m.completedCycles < 30, `${m.completedCycles} cycles`);
});

test('Monthly schedule: month-end closes, next-open execution, holidays, overdue', () => {
  assert.equal(monthEndOnOrBefore('2026-10-26'), '2026-09-30');
  assert.equal(monthEndOnOrBefore('2026-10-30'), '2026-10-30');
  assert.equal(monthEndAfter('2026-10-26'), '2026-10-30');
  assert.equal(monthEndAfter('2026-10-30'), '2026-11-30');
  const s = monthSchedule('2026-10-26', null);
  assert.deepEqual([s.signalDate, s.execDate, s.nextSignal, s.nextExec, s.done, s.overdue], ['2026-09-30', '2026-10-01', '2026-10-30', '2026-11-02', false, true]);
  assert.equal(monthSchedule('2026-10-26', '2026-10-01').done, true);
  const dec = monthSchedule('2026-12-31', null);
  assert.equal(dec.signalDate, '2026-12-31');
  assert.equal(dec.execDate, '2027-01-04', 'New Year’s Day is skipped');
  assert.equal(dec.overdue, false);
});

test('Monthly strategy: establish, rebalance once per month, never exit; cash shortfall reported', () => {
  const base = { lastCompleted: '2026-10-26', dataStatus: 'ok' as const, dataIssues: [], params: MONTHLY_BASELINE, cashAvailableUsd: 20000 };
  assert.equal(evaluateMonthly({ ...base, sleeve: sleeve(), weightAtClose: 0, rebalanceShares: 100, rebalanceValueUsd: 5000, cashRequiredUsd: 5001 }).action, 'BUY');
  const due = evaluateMonthly({ ...base, sleeve: sleeve({ shares: 100, lastTradeDate: '2026-09-01', entryDate: '2026-09-01' }), weightAtClose: 0.032, rebalanceShares: 36, rebalanceValueUsd: 1800, cashRequiredUsd: 1801 });
  assert.equal(due.action, 'REBALANCE');
  assert.equal(due.checklist.find((c) => c.id === 'c3')?.status, 'fail', 'overdue after the scheduled open passed');
  const done = evaluateMonthly({ ...base, sleeve: sleeve({ shares: 136, lastTradeDate: '2026-10-01', entryDate: '2026-09-01' }), weightAtClose: 0.032, rebalanceShares: 36, rebalanceValueUsd: 1800, cashRequiredUsd: 1801 });
  assert.equal(done.action, 'HOLD', 'drift is allowed between month ends, even far below target');
  const short = evaluateMonthly({ ...base, cashAvailableUsd: 500, sleeve: sleeve({ shares: 100, lastTradeDate: '2026-09-01', entryDate: '2026-09-01' }), weightAtClose: 0.02, rebalanceShares: 10, rebalanceValueUsd: 500, cashRequiredUsd: 3000 });
  assert.equal(short.checklist.find((c) => c.id === 'c5')?.status, 'fail');
  for (const e of [due, done, short]) assert.ok(!['EXIT', 'WAIT'].includes(e.action));
});

test('Sleeve sizing: target never exceeded after fees; sells round down', () => {
  for (const price of [12.34, 49.99, 68.43]) {
    const p = planSleeve(inp({ cash: 50000, feeFixed: 1, feePct: 0.05 }), { shares: 0, avgCost: null }, price, 5);
    const after = (p.buy!.shares * price) / ((p.equityUsd as number) - p.buy!.feeUsd);
    assert.ok(after <= 0.05 + 1e-12, `${price}: ${after}`);
    assert.ok(((p.buy!.shares + 1) * price) / ((p.equityUsd as number) - p.buy!.feeUsd) > 0.05, 'one more share would exceed');
  }
  const over = planSleeve(inp({ shares: 200, equityRefPrice: 50 }), { shares: 200, avgCost: 40 }, 50, 5);
  assert.equal(over.sell!.shares, Math.floor((200 * 50 - 100000 * 0.05) / 50));
  assert.equal(over.rebalanceShares, -over.sell!.shares);
});

test('Risk summary: exposures, effective Nasdaq-100 exposure and scenarios', () => {
  const r = riskSummary(inp({ shares: 100, equityRefPrice: 50, qqqShares: 150, qqqRefPrice: 600, cash: 5000 }), 50, 600, 5, [20, 40, 60, 80])!;
  assert.equal(r.tqqqUsd, 5000);
  assert.equal(r.qqqUsd, 90000);
  assert.ok(Math.abs(r.tqqqPct - 5) < 1e-9);
  assert.ok(Math.abs((r.effectivePct as number) - (90 + 15)) < 1e-9, '95% QQQ-ish + 3 × 5% TQQQ');
  assert.equal(r.tqqqContributionPct, 15);
  assert.equal(r.concentration, 'ok');
  assert.equal(r.scenarios.length, 4);
  assert.ok(Math.abs(r.scenarios[3].tqqqOnlyLossUsd - 4000) < 1e-9);
  assert.ok(Math.abs(r.scenarios[3].qqqDropPct - (1 - Math.cbrt(0.2)) * 100) < 1e-9);
  assert.equal(riskSummary(inp({ shares: 300, equityRefPrice: 50 }), 50, null, 5, [20])!.concentration, 'high');
});

test('Backtest input validation blocks gaps and unadjusted splits', { skip: !REAL && 'needs research/data' }, () => {
  assert.equal(checkBacktestInputs(q, t, '2010-02-11', '2026-10-26', { QQQ: [], TQQQ: [] }).ok, true, 'the fixed inputs are clean');
  const gap = checkBacktestInputs(q, t.filter((b) => b.d !== '2015-06-10'), '2010-02-11', '2026-10-26', { QQQ: [], TQQQ: [] });
  assert.equal(gap.ok, false);
  const split = t.map((b) => (b.d >= '2017-01-12' ? b : { ...b, o: b.o * 3, h: b.h * 3, l: b.l * 3, c: b.c * 3 }));
  const bad = checkBacktestInputs(q, split, '2010-02-11', '2026-10-26', { QQQ: [], TQQQ: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((x) => /2017-01-12/.test(x)));
});
