// Acceptance tests (spec §16). Fixtures below are SYNTHETIC test series built on the real US
// exchange calendar; they are test inputs only and never appear in the published page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import type { Bar } from '../src/data.ts';
import { validateDaily, mergeBars, parseTimeSeries, parseQuote, parseDividends, parseApiUsage, resultText } from '../src/data.ts';
import {
  CLAUDE_V2_BASELINE, buildPoints, decideAtClose, applyExecuted, initialCycleState, evaluateLive, signalHistory, smaSeries,
} from '../src/strategy.ts';
import type { StrategyParams, UserPosition } from '../src/strategy.ts';
import { computeAllocation, planBuy } from '../src/allocation.ts';
import type { PortfolioInput } from '../src/allocation.ts';
import { simulate, lookaheadCheck } from '../src/backtest.ts';
import type { BacktestConfig } from '../src/backtest.ts';
import {
  tradingDaysInclusive, addTradingDays, usMarketHolidays, isEarlyClose, sessionTimes, fmtMyt, lastCompletedSession, etWallToUtc, nextTradingDay,
} from '../src/time.ts';
import { UserStore, applyTrade, defaultPortfolio, defaultSettings, newAlerts, readPortfolio } from '../src/store.ts';

const P: StrategyParams = { ...CLAUDE_V2_BASELINE };

/** Synthetic bars on real sessions starting at `from`, one per close value. */
function bars(from: string, closes: number[]): Bar[] {
  let d = from;
  const out: Bar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const o = i === 0 ? c : closes[i - 1];
    out.push({ d, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 1e6 });
    d = nextTradingDay(d);
  }
  return out;
}

const flat = (n: number, v = 100) => new Array(n).fill(v);
const pos = (o: Partial<UserPosition> = {}): UserPosition => ({ confirmed: true, shares: 0, firstEntryDate: null, secondEntryDate: null, lastExitDate: null, lastExitSignalDate: null, ...o });

// 1 ─────────────────────────────────────────────────────────────────────────
test('1. SMA200 equals the arithmetic mean of the 200 most recent completed closes', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.05);
  const b = bars('2025-01-02', closes);
  const pts = buildPoints(b, P);
  for (const t of [199, 230, 259]) {
    let s = 0;
    for (let k = t - 199; k <= t; k++) s += closes[k];
    assert.ok(Math.abs((pts[t].sma as number) - s / 200) < 1e-9, `SMA mismatch at ${t}`);
  }
  assert.equal(pts[198].sma, null, 'no SMA before 200 closes');
  // An in-progress session is excluded: validation at 11:00 ET on the last bar's date keeps it out.
  const lastDate = b[b.length - 1].d;
  const rep = validateDaily('QQQ', b, etWallToUtc(lastDate, 11, 0), { minBars: 202, calendarWindow: 260, awaitingHours: 4 });
  assert.equal(rep.inProgress?.d, lastDate);
  assert.equal(rep.completed.length, 259);
  const smaCompleted = smaSeries(rep.completed.map((x) => x.c), 200);
  let s = 0;
  for (let k = 59; k <= 258; k++) s += closes[k];
  assert.ok(Math.abs((smaCompleted[258] as number) - s / 200) < 1e-9);
});

// 2 ─────────────────────────────────────────────────────────────────────────
test('2. Entry triggers only after two qualifying completed closes', () => {
  const closes = [...flat(205), 103, 103, 103];
  const b = bars('2025-01-02', closes);
  const pts = buildPoints(b, P);
  const st = initialCycleState();
  assert.ok(pts[205].qual && !pts[204].qual);
  assert.deepEqual(decideAtClose(st, pts, 205, P, null), [], 'one qualifying close is not enough');
  assert.equal(decideAtClose(st, pts, 206, P, null)[0]?.kind, 'ENTRY');
  // Live: after one close WAIT with the confirmation pending; after two, BUY INITIAL.
  const one = evaluateLive({ points: pts.slice(0, 206), dataStatus: 'ok', dataIssues: [], params: P, position: pos(), weightAtClose: 0 });
  assert.equal(one.action, 'WAIT');
  assert.equal(one.entry.find((c) => c.id === 'e2')?.status, 'pending');
  const two = evaluateLive({ points: pts.slice(0, 207), dataStatus: 'ok', dataIssues: [], params: P, position: pos(), weightAtClose: 0 });
  assert.equal(two.action, 'BUY INITIAL');
  assert.equal(two.state, 'ENTRY ELIGIBLE');
  // A close just under +2% does not qualify.
  const under = buildPoints(bars('2025-01-02', [...flat(205), 101.99, 101.99]), P);
  assert.equal(under[206].qualRun, 0);
});

// 3 ─────────────────────────────────────────────────────────────────────────
test('3. A position cannot be purchased twice from the same entry signal', () => {
  const closes = [...flat(205), ...flat(60, 104)];
  const b = bars('2025-01-02', closes);
  const pts = buildPoints(b, P);
  const hist = signalHistory(pts, P);
  assert.equal(hist.filter((e) => e.kind === 'ENTRY').length, 1, 'one entry for one qualifying run');
  // Live: once holding, no BUY INITIAL.
  const held = evaluateLive({ points: pts, dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 10, firstEntryDate: b[207].d }), weightAtClose: 0.025 });
  assert.notEqual(held.action, 'BUY INITIAL');
  // Live: a manual sale inside the same run does not re-arm the entry (fresh cycle rule).
  const soldInRun = evaluateLive({ points: pts, dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 0, lastExitDate: b[230].d }), weightAtClose: 0 });
  assert.equal(soldInRun.action, 'WAIT');
  // After the threshold is lost and regained, a new cycle may start.
  const b2 = bars('2025-01-02', [...closes, 100, 100, 106, 106]);
  const pts2 = buildPoints(b2, P);
  const again = evaluateLive({ points: pts2, dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 0, lastExitDate: b[230].d }), weightAtClose: 0 });
  assert.equal(again.action, 'BUY INITIAL');
});

// 4 ─────────────────────────────────────────────────────────────────────────
test('4. Second purchase requires at least 20 actual trading sessions', () => {
  const closes = [...flat(205), ...flat(80, 105)];
  const b = bars('2026-06-01', closes);
  const pts = buildPoints(b, P);
  let st = initialCycleState();
  // Entry signal at 206, executed at the open of 207.
  assert.equal(decideAtClose(st, pts, 206, P, 0)[0].kind, 'ENTRY');
  st = applyExecuted(st, 'ENTRY', 206, 207);
  for (let t = 207; t < 207 + 19; t++) assert.deepEqual(decideAtClose(st, pts, t, P, 0.025).map((d) => d.kind), [], `no add at session ${t - 207 + 1}`);
  assert.equal(decideAtClose(st, pts, 207 + 19, P, 0.025)[0].kind, 'ADD', 'add on the 20th completed session');
  // Calendar projection skips weekends and holidays (Thanksgiving 2026-11-26).
  const next = addTradingDays('2026-11-16', 19);
  const counted = tradingDaysInclusive('2026-11-16', next);
  assert.equal(counted.length, 20);
  assert.ok(!counted.includes('2026-11-26'));
  // Live: the timer counts completed sessions since the confirmed entry date.
  const live = evaluateLive({ points: pts.slice(0, 207 + 19), dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 10, firstEntryDate: b[207].d }), weightAtClose: 0.025 });
  assert.equal(live.sessionsElapsed, 19);
  assert.equal(live.action, 'HOLD');
  const live20 = evaluateLive({ points: pts.slice(0, 207 + 20), dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 10, firstEntryDate: b[207].d }), weightAtClose: 0.025 });
  assert.equal(live20.sessionsElapsed, 20);
  assert.equal(live20.action, 'ADD POSITION');
  assert.equal(live20.nextAddDate, b[207 + 19].d);
});

// 5 ─────────────────────────────────────────────────────────────────────────
test('5. Second purchase never takes the allocation beyond the target', () => {
  const inp: PortfolioInput = { currency: 'USD', totalEquity: 100000, equityRefPrice: 50, shares: 50, avgCost: 50, cash: 50000, feeFixed: 1, feePct: 0.1, usdMyr: null };
  // Weight after the add, on post-fee equity, never exceeds 5% across many prices and positions.
  for (const price of [0.97, 12.34, 49.99, 50, 77.7, 101.01, 250]) {
    for (const shares of [0, 3, 10, 40, 80]) {
      const at = { ...inp, shares, equityRefPrice: price };
      const a = computeAllocation(at, price, P);
      const plan = a.add!;
      const eqAfter = (a.equityUsd as number) - plan.feeUsd;
      const wAfter = ((a.valueUsd + plan.valueUsd) / eqAfter) * 100;
      assert.ok(plan.shares === 0 || wAfter <= 5 + 1e-9, `over target at ${price} × ${shares}: ${wAfter}`);
      const first = a.initial!;
      const w1 = ((a.valueUsd + first.valueUsd) / ((a.equityUsd as number) - first.feeUsd)) * 100;
      assert.ok(first.shares === 0 || w1 <= 2.5 + 1e-9);
    }
  }
  // Already above target: buys nothing.
  assert.equal(planBuy(5, 100000, 5200, 50, 10000, inp).shares, 0);
  // Cash-limited: never spends more than available cash, fees included.
  const lim = planBuy(5, 100000, 0, 50, 1000, inp);
  assert.ok(lim.totalUsd <= 1000 && lim.limitedByCash);
  // Backtest: right after each sized TQQQ purchase, the weight is at most its target.
  const { cfg, q, t } = fixtureBacktest();
  const res = simulate(q, t, { QQQ: [], TQQQ: [] }, { ...cfg, feeFixed: 1 });
  const v2 = res.models.find((m) => m.id === 'CLAUDE_V2')!;
  const adds = v2.trades.filter((x) => x.kind === 'ADD');
  assert.ok(adds.length > 0, 'fixture produces adds');
  for (const ad of adds) assert.ok((ad.postWeight as number) <= 0.05 + 1e-12, `ADD on ${ad.date} left ${ad.postWeight}`);
  for (const en of v2.trades.filter((x) => x.kind === 'INITIAL')) assert.ok((en.postWeight as number) <= 0.025 + 1e-12);
});

// 6 ─────────────────────────────────────────────────────────────────────────
test('6. Exit triggers after one completed close at or below −3%', () => {
  const base = [...flat(205), 104, 104, ...flat(30, 104)];
  // Find the exact −3% level on the next session.
  const pre = buildPoints(bars('2025-01-02', [...base, 0.0001]), P);
  const t = base.length;
  const sumPrev = base.slice(t - 199).reduce((s, x) => s + x, 0);
  const exact = (0.97 * sumPrev) / (200 - 0.97); // close c with c = 0.97 * (sumPrev + c) / 200
  void pre;
  const ptsExact = buildPoints(bars('2025-01-02', [...base, exact]), P);
  assert.ok(ptsExact[t].exitZone, 'a close exactly at −3% exits');
  const ptsAbove = buildPoints(bars('2025-01-02', [...base, exact * 1.0005]), P);
  assert.ok(!ptsAbove[t].exitZone, 'a close just above −3% does not exit');
  let st = initialCycleState();
  st = applyExecuted(st, 'ENTRY', 206, 207);
  assert.deepEqual(decideAtClose(st, ptsExact, t, P, 0.03).map((d) => d.kind), ['EXIT']);
  const live = evaluateLive({ points: ptsExact, dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 10, firstEntryDate: '2025-01-02' }), weightAtClose: 0.03 });
  assert.equal(live.action, 'EXIT ALL');
  // The exit stays required after a recovery until the sale is recorded.
  const recovered = buildPoints(bars('2025-01-02', [...base, exact, 104]), P);
  const sticky = evaluateLive({ points: recovered, dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 10, firstEntryDate: '2025-01-02' }), weightAtClose: 0.03 });
  assert.equal(sticky.action, 'EXIT ALL');
});

// 7 ─────────────────────────────────────────────────────────────────────────
test('7. EXIT takes priority over BUY, ADD and TRIM', () => {
  const closes = [...flat(205), ...flat(40, 105), 80];
  const pts = buildPoints(bars('2025-01-02', closes), P);
  const t = closes.length - 1;
  let st = initialCycleState();
  st = applyExecuted(st, 'ENTRY', 206, 207); // add due (elapsed ≥ 20) and weight above trim
  const decs = decideAtClose(st, pts, t, P, 0.09);
  assert.deepEqual(decs.map((d) => d.kind), ['EXIT']);
  const live = evaluateLive({ points: pts, dataStatus: 'ok', dataIssues: [], params: P, position: pos({ shares: 100, firstEntryDate: '2025-01-02' }), weightAtClose: 0.09 });
  assert.equal(live.action, 'EXIT ALL');
  assert.equal(live.state, 'EXIT REQUIRED');
});

// 8 ─────────────────────────────────────────────────────────────────────────
test('8. TQQQ weight above 6% generates the trim action', () => {
  const pts = buildPoints(bars('2025-01-02', [...flat(205), ...flat(30, 104)]), P);
  const p = pos({ shares: 100, firstEntryDate: '2025-11-03', secondEntryDate: '2025-12-01' });
  assert.equal(evaluateLive({ points: pts, dataStatus: 'ok', dataIssues: [], params: P, position: p, weightAtClose: 0.0601 }).action, 'TRIM');
  assert.equal(evaluateLive({ points: pts, dataStatus: 'ok', dataIssues: [], params: P, position: p, weightAtClose: 0.06 }).action, 'HOLD', 'exactly 6% does not exceed');
  const inp: PortfolioInput = { currency: 'USD', totalEquity: 100000, equityRefPrice: 70, shares: 100, avgCost: 40, cash: 1000, feeFixed: 0, feePct: 0, usdMyr: null };
  const a = computeAllocation(inp, 70, P); // 7% weight
  assert.ok(a.trim && a.trim.shares > 0);
  assert.ok((a.trim.weightAfterPct as number) >= 5 - 1e-9 && (a.trim.weightAfterPct as number) < 5.1);
  const d = decideAtClose(applyExecuted(initialCycleState(), 'ENTRY', 206, 207), pts, 220, P, 0.065);
  assert.ok(d.some((x) => x.kind === 'TRIM'));
});

// 9 ─────────────────────────────────────────────────────────────────────────
test('9. Missing or stale data cannot generate confirmed signals', () => {
  const b = bars('2025-01-02', [...flat(205), ...flat(40, 104)]);
  const lastD = b[b.length - 1].d;
  const now = etWallToUtc(nextTradingDay(lastD), 9, 0);
  const good = validateDaily('QQQ', b, now);
  assert.equal(good.status, 'ok');
  const gappy = b.filter((_, i) => i !== b.length - 10);
  const rep = validateDaily('QQQ', gappy, now);
  assert.equal(rep.status, 'invalid');
  const ev = evaluateLive({ points: buildPoints(rep.completed, P), dataStatus: rep.status, dataIssues: rep.issues, params: P, position: pos(), weightAtClose: 0 });
  assert.equal(ev.action, 'DATA UNAVAILABLE');
  assert.ok([...ev.entry, ...ev.second, ...ev.hold].every((c) => c.status === 'na'), 'nothing shown as verified');
  const stale = validateDaily('QQQ', b, etWallToUtc(addTradingDays(lastD, 5), 12, 0));
  assert.equal(stale.status, 'stale');
  const broken = b.map((x, i) => (i === 220 ? { ...x, h: x.l * 0.9 } : x));
  assert.equal(validateDaily('QQQ', broken, now).status, 'invalid');
  assert.equal(validateDaily('QQQ', [], now).status, 'missing');
  // An error text from the provider never parses as data.
  assert.equal(parseTimeSeries('You have run out of API credits for the current minute.').ok, false);
  assert.equal(parseQuote('symbol;close\nQQQ;-1', 'QQQ').ok, false);
});

// 10 ────────────────────────────────────────────────────────────────────────
test('10. Portfolio actions and account state survive a page reload', async () => {
  const mem = new Map<string, Record<string, unknown>>();
  const db = {
    doc: (path: string) => ({
      get: async () => ({ exists: mem.has(path), data: () => (mem.has(path) ? JSON.parse(JSON.stringify(mem.get(path))) : undefined) }),
      set: async (data: Record<string, unknown>) => { mem.set(path, JSON.parse(JSON.stringify(data))); },
    }),
  };
  const s1 = new UserStore(db, 'u_test');
  let p = { ...defaultPortfolio(), confirmed: true, totalEquity: 100000, equityRefPrice: 60, cash: 10000 };
  const tr = { date: '2026-10-26', side: 'BUY' as const, kind: 'INITIAL' as const, shares: 41, price: 60, fee: 1, signalDate: '2026-10-23', note: '' };
  const r = applyTrade(p, tr, '2026-10-26T14:00:00Z');
  assert.equal(r.error, null);
  p = r.portfolio;
  const settings = { ...defaultSettings(), quoteRefreshMin: 5 };
  await s1.savePortfolio(p);
  await s1.saveTrades([{ ...tr, id: 't1', createdAt: '2026-10-26T14:00:00Z', realizedUsd: null }]);
  await s1.saveSettings(settings);
  await s1.saveAlerts(newAlerts([], [{ type: 'FIRST_ELIGIBLE', session: '2026-10-23', text: 'x' }], settings.alerts, 'now'));
  const loaded = await new UserStore(db, 'u_test').load(); // a fresh instance = a reload
  assert.equal(loaded.portfolio.shares, 41);
  assert.equal(loaded.portfolio.firstEntryDate, '2026-10-26');
  assert.equal(loaded.portfolio.cash, 10000 - 41 * 60 - 1);
  assert.equal(loaded.trades.length, 1);
  assert.equal(loaded.settings.quoteRefreshMin, 5);
  assert.equal(loaded.alerts.length, 1);
  // Alerts are deduplicated by type and session.
  assert.equal(newAlerts(loaded.alerts, [{ type: 'FIRST_ELIGIBLE', session: '2026-10-23', text: 'x' }], settings.alerts, 'later').length, 0);
  // A manual edit without a trade record does not create a transaction.
  await s1.savePortfolio({ ...loaded.portfolio, shares: 50 });
  const again = await new UserStore(db, 'u_test').load();
  assert.equal(again.portfolio.shares, 50);
  assert.equal(again.trades.length, 1);
  // A full sale closes the cycle and records the exit dates.
  const sold = applyTrade(again.portfolio, { date: '2026-12-01', side: 'SELL', kind: 'EXIT', shares: 50, price: 55, fee: 1, signalDate: '2026-11-30', note: '' }, 'now');
  assert.equal(sold.portfolio.shares, 0);
  assert.equal(sold.portfolio.lastExitSignalDate, '2026-11-30');
  assert.equal(sold.portfolio.firstEntryDate, null);
  assert.equal(readPortfolio(undefined).confirmed, false);
});

// 11 ────────────────────────────────────────────────────────────────────────
test('11. US exchange times convert correctly to Malaysian time across DST', () => {
  assert.equal(fmtMyt(sessionTimes('2026-10-23').closeUtc), '24 Oct 2026, 04:00 MYT'); // EDT: 16:00 ET = 04:00 MYT next day
  assert.equal(fmtMyt(sessionTimes('2026-11-02').closeUtc), '03 Nov 2026, 05:00 MYT'); // EST after 1 Nov
  assert.equal(fmtMyt(sessionTimes('2026-03-09').openUtc), '09 Mar 2026, 21:30 MYT'); // first EDT session of 2026
  assert.equal(fmtMyt(sessionTimes('2026-03-06').openUtc), '06 Mar 2026, 22:30 MYT');
  assert.equal(fmtMyt(sessionTimes('2026-11-27').closeUtc), '28 Nov 2026, 02:00 MYT'); // early close 13:00 EST
  const h = usMarketHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) assert.ok(h.has(d), d);
  assert.ok(isEarlyClose('2026-11-27') && isEarlyClose('2026-12-24'));
  assert.ok(!usMarketHolidays(2022).has('2021-12-31'), 'Saturday New Year is not observed on Friday');
  // 05:00 MYT on Tue 27 Oct 2026 = 17:00 EDT Mon 26 Oct: the 26 Oct session is complete.
  assert.equal(lastCompletedSession(Date.UTC(2026, 9, 26, 21, 0)), '2026-10-26');
  assert.equal(lastCompletedSession(Date.UTC(2026, 9, 26, 20, 5)), '2026-10-23', 'within the grace period after the close');
});

// 12 ────────────────────────────────────────────────────────────────────────
test('12. Signals come from QQQ; valuations use TQQQ', () => {
  const { cfg, q, t } = fixtureBacktest();
  const a = simulate(q, t, { QQQ: [], TQQQ: [] }, cfg);
  const tAlt = t.map((b) => ({ ...b, o: b.o * 1.7, h: b.h * 1.7, l: b.l * 1.7, c: b.c * 1.7 }));
  const b = simulate(q, tAlt, { QQQ: [], TQQQ: [] }, cfg);
  const sig = (r: typeof a) => r.models.find((m) => m.id === 'CLAUDE_V2')!.events.filter((e) => e.kind !== 'TRIM').map((e) => e.kind + e.signalDate).join();
  assert.equal(sig(a), sig(b), 'scaling TQQQ prices does not move entry/add/exit signals');
  const v = (r: typeof a) => r.models.find((m) => m.id === 'CLAUDE_V2')!.trades.filter((x) => x.symbol === 'TQQQ')[0];
  assert.ok(Math.abs(v(b).price / v(a).price - 1.7) < 1e-9, 'trade valuations use TQQQ prices');
  const qAlt = q.map((x, i) => (i > 300 && i < 330 ? { ...x, c: x.c * 0.9, l: x.l * 0.9, o: x.o * 0.9 } : x));
  assert.notEqual(sig(a), sig(simulate(qAlt, t, { QQQ: [], TQQQ: [] }, cfg)), 'changing QQQ changes signals');
  const inp: PortfolioInput = { currency: 'MYR', totalEquity: 470000, equityRefPrice: 66, shares: 100, avgCost: 60, cash: 47000, feeFixed: 0, feePct: 0, usdMyr: 4.7 };
  const al = computeAllocation(inp, 66, P);
  assert.ok(Math.abs(al.valueUsd - 6600) < 1e-9 && Math.abs((al.equityUsd as number) - 100000) < 1e-6);
});

// 13 ────────────────────────────────────────────────────────────────────────
test('13. The app never contains or exposes a Twelve Data API key', () => {
  // Browser bundles: no key, no key variable, no Twelve Data host; the website only calls its own /api.
  for (const f of ['dist/index.html', 'dist/site/public/index.html', 'src/market.ts', 'src/site/runtime.ts']) {
    if (!existsSync(f)) continue;
    const s = readFileSync(f, 'utf8');
    assert.ok(!/apikey\s*[=:]/i.test(s), `${f}: apikey parameter`);
    assert.ok(!/twelvedata\.com/i.test(s), `${f}: direct Twelve Data host`);
    assert.ok(!/TWELVE_DATA_API_KEY\b(?!\s+(?:and|in|setting|and restart))/.test(s.replace(/from its TWELVE_DATA_API_KEY setting|Set TWELVE_DATA_API_KEY in the host’s environment and restart/g, '')), `${f}: key variable read`);
    for (const m of s.matchAll(/fetch\(\s*([^,)]+)/g)) assert.ok(/^(path|'\/api\/)/.test(m[1].trim()), `${f}: fetch target ${m[1]}`);
    assert.ok(!/XMLHttpRequest|new WebSocket|EventSource/.test(s), `${f}: other network call`);
  }
  assert.ok(!/\bfetch\s*\(/.test(readFileSync('dist/index.html', 'utf8')), 'the claude.ai page makes no network calls of its own');
  // Server: the key is read from the environment and only ever sent in the Authorization header.
  const srv = readFileSync('server/tdrest.ts', 'utf8');
  assert.match(srv, /Authorization: `apikey \$\{this\.opts\.apiKey\}`/);
  assert.ok(!/apikey=/.test(srv) && !/console\.(log|error)/.test(srv), 'key never in a query string or a log line');
});

// 14 ────────────────────────────────────────────────────────────────────────
test('14. Backtest results are reproducible from the source data', () => {
  const { cfg, q, t } = fixtureBacktest();
  const a = simulate(q, t, { QQQ: [], TQQQ: [] }, cfg);
  const b = simulate(q.map((x) => ({ ...x })), t.map((x) => ({ ...x })), { QQQ: [], TQQQ: [] }, { ...cfg });
  assert.equal(a.resultFingerprint, b.resultFingerprint);
  assert.equal(a.dataFingerprint, b.dataFingerprint);
  assert.deepEqual(a.models.map((m) => m.final), b.models.map((m) => m.final));
  assert.ok(a.models.length >= 6);
  const v2 = a.models.find((m) => m.id === 'CLAUDE_V2')!;
  assert.ok(v2.events.some((e) => e.kind === 'ENTRY') && v2.events.some((e) => e.kind === 'EXIT'));
});

// 15 ────────────────────────────────────────────────────────────────────────
test('15. No look-ahead bias', () => {
  const { cfg, q, t } = fixtureBacktest();
  const full = simulate(q, t, { QQQ: [{ exDate: q[400].d, amount: 0.5 }], TQQQ: [] }, { ...cfg, useDividends: true, cashRatePct: 2 });
  const rep = lookaheadCheck(q, t, { QQQ: [{ exDate: q[400].d, amount: 0.5 }], TQQQ: [] }, { ...cfg, useDividends: true, cashRatePct: 2 }, full, 10);
  assert.equal(rep.passed, true, rep.failures.join('; '));
  assert.equal(rep.checked, 10);
  // Live signals: evaluating with future bars removed gives the same answer for that date.
  const pts = buildPoints(q, P);
  const hist = signalHistory(pts, P);
  const cut = 420;
  const histCut = signalHistory(pts.slice(0, cut + 1), P).filter((e) => e.signalIdx < cut);
  assert.deepEqual(histCut.map((e) => e.kind + e.signalDate), hist.filter((e) => e.signalIdx < cut).map((e) => e.kind + e.signalDate));
});

test('Real Twelve Data connector answers parse (wrapped {"result": ...} format)', () => {
  // Shapes observed from the live connector on 27 Oct 2026.
  const ts = '{"result":"datetime;open;high;low;close;volume\\n2026-10-26;707.059998;715.25;705.58002;712.20001;32925600\\n2026-10-23;702.20001;709.29999;701.15997;704.40002;30224700\\n"}';
  for (const shape of [ts, { content: [{ type: 'text', text: ts }] }, { content: [], structuredContent: JSON.parse(ts) }, { payload: JSON.parse(ts) }]) {
    const p = parseTimeSeries(resultText(shape));
    assert.ok(p.ok, p.error ?? '');
    assert.deepEqual(p.value.map((b) => b.d), ['2026-10-23', '2026-10-26']);
    assert.equal(p.value[1].c, 712.20001);
  }
  const q = parseQuote(resultText('{"result":"symbol;name;exchange;mic_code;currency;datetime;timestamp;last_quote_at;open;high;low;close;volume;previous_close;change;percent_change;average_volume;is_market_open\\nQQQ;Invesco QQQ Trust, Series 1;NASDAQ;XNMS;USD;2026-10-26;1793021400;1793044740;707.06;715.25;705.58;712.20001;32925600;704.40002;7.8;1.10732;42577270;false"}'), 'QQQ');
  assert.ok(q.ok && q.value);
  assert.equal(q.value!.timestampMs, 1793044740000, 'quote time comes from last_quote_at');
  assert.equal(q.value!.isMarketOpen, false);
  const dv = parseDividends(resultText('{"result":"{\\"meta\\": {\\"symbol\\": \\"QQQ\\"}, \\"dividends\\": [{\\"ex_date\\": \\"2026-09-21\\", \\"amount\\": 0.75143}, {\\"ex_date\\": \\"2026-06-22\\", \\"amount\\": 0.81349}]}"}'));
  assert.ok(dv.ok);
  assert.deepEqual(dv.value, [{ exDate: '2026-06-22', amount: 0.81349 }, { exDate: '2026-09-21', amount: 0.75143 }]);
  const u = parseApiUsage(resultText('{"result":"timestamp;current_usage;plan_limit\\n2026-10-27 06:23:10;6;0\\n"}'));
  assert.deepEqual(u, { plan: null, used: 6, limit: null });
});

test('Cache merge detects a split re-adjustment', () => {
  const b = bars('2025-01-02', flat(50, 100));
  const ok = mergeBars(b.slice(0, 40), b.slice(30));
  assert.ok(ok.consistent && ok.bars.length === 50);
  const split = mergeBars(b.slice(0, 40), b.slice(30).map((x) => ({ ...x, c: x.c / 2, o: x.o / 2, h: x.h / 2, l: x.l / 2 })));
  assert.equal(split.consistent, false);
});

/** A synthetic QQQ path with a rally, a drawdown through the exit, and a recovery. */
function fixtureBacktest(): { cfg: BacktestConfig; q: Bar[]; t: Bar[] } {
  const qc: number[] = [];
  let x = 100;
  for (let i = 0; i < 900; i++) {
    const phase = i < 300 ? 0.0006 : i < 420 ? -0.0025 : i < 650 ? 0.0018 : i < 720 ? -0.003 : 0.0012;
    x *= 1 + phase + Math.sin(i / 3) * 0.004;
    qc.push(Number(x.toFixed(4)));
  }
  const q = bars('2022-01-03', qc);
  const tc: number[] = [];
  let y = 30;
  for (let i = 0; i < qc.length; i++) {
    if (i > 0) y *= 1 + 3 * (qc[i] / qc[i - 1] - 1);
    tc.push(Number(y.toFixed(4)));
  }
  const t = bars('2022-01-03', tc);
  return {
    q, t,
    cfg: { start: q[0].d, end: q[q.length - 1].d, initialCapital: 100000, feeBps: 5, feeFixed: 0, cashRatePct: 0, useDividends: false, baseline: { ...CLAUDE_V2_BASELINE }, modified: null },
  };
}
