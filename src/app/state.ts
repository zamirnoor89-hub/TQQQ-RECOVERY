// Application state, data loading and derived evaluation.
import type { ApiUsage, Bar, Dividend, Quote, SeriesReport } from '../data.ts';
import { commonMissing, validateDaily, DEFAULT_VALIDATE } from '../data.ts';
import type { BacktestResult, LookaheadReport } from '../backtest.ts';
import { simulate } from '../backtest.ts';
import type { InputCheck } from '../data.ts';
import type { LiveEvaluation, Point, SignalEvent, StrategyParams } from '../strategy.ts';
import { buildPoints, evaluateLive, isBaseline, signalHistory, CLAUDE_V2_BASELINE } from '../strategy.ts';
import type { AllocationResult, RiskSummary, SleevePlan } from '../allocation.ts';
import { computeAllocation, planSleeve, riskSummary, sleeveWeightAt } from '../allocation.ts';
import type { Loaded, AlertRec, TradeKind } from '../store.ts';
import { UserStore, defaultPortfolio, defaultSettings, newAlerts, portfolioInput, positionOf, sleeveOf, sleevePosition, totalTqqqShares } from '../store.ts';
import type { Action, CrossEvaluation, CrossParams, CrossPoint, MarketSignal, MonthlyEvaluation, MonthlyParams, StrategyId, Tone } from '../strategies.ts';
import {
  ACTION_TONE, STRATEGY_IDS, STRATEGY_META, claudeAction, claudeSignal, crossPoints, evaluateCross, evaluateMonthly, isCrossBaseline, isMonthlyBaseline, isStrategyId,
} from '../strategies.ts';
import type { MethodRow, PeriodRow, Sensitivity, WalkForward } from '../research.ts';
import { storageGet } from '../ui/dom.ts';
import type { CallFailure, ConnState } from '../market.ts';
import { describeFailure } from '../market.ts';
import type { Runtime } from './runtime.ts';
import { fmtDate, lastCompletedSession, marketStatus } from '../time.ts';

export type Page = 'overview' | 'checklist' | 'trend' | 'portfolio' | 'backtest' | 'research' | 'history' | 'parameters';

export const PAGES: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'checklist', label: 'Strategy Checklist' },
  { id: 'trend', label: 'QQQ Trend' },
  { id: 'portfolio', label: 'Portfolio & Risk' },
  { id: 'backtest', label: 'Backtesting' },
  { id: 'research', label: 'Strategy Research' },
  { id: 'history', label: 'Trade History' },
  { id: 'parameters', label: 'Settings' },
];

/** A suggested order for one strategy's sleeve, sized from recorded holdings. Never executed by the app. */
export interface OrderLine {
  side: 'BUY' | 'SELL';
  shares: number;
  valueUsd: number;
  feeUsd: number;
  kind: TradeKind;
  note: string;
  limitedByCash: boolean;
}

/** Everything a strategy card shows, computed independently per strategy. */
export interface StrategyView {
  id: StrategyId;
  letter: string;
  name: string;
  followed: boolean;
  signal: MarketSignal;
  action: Action;
  tone: Tone;
  headline: string;
  reasons: string[];
  prevAction: Action | null; // last confirmed action while today's candle is awaited
  asOf: string | null;
  shares: number;
  weightPct: number | null;
  targetPct: number;
  order: OrderLine | null;
  orderProblem: string | null; // why an order cannot be sized
  modified: boolean;
}

interface SeriesState {
  raw: Bar[];
  report: SeriesReport | null;
  source: string | null;
  note: string | null;
  error: CallFailure | null;
  loadedAt: number | null;
  cacheWritable: boolean;
}

const emptySeries = (): SeriesState => ({ raw: [], report: null, source: null, note: null, error: null, loadedAt: null, cacheWritable: false });

type StoreState = 'loading' | 'ok' | 'unavailable' | 'readonly';

export interface Derived {
  key: string;
  status: SeriesReport['status'] | 'loading';
  issues: string[];
  notes: string[];
  points: Point[];
  ev: LiveEvaluation;
  evPrev: LiveEvaluation | null; // last confirmed evaluation while today's candle is awaited
  tqqqOk: boolean;
  tqqqClose: number | null;
  tqqqCloseDate: string | null;
  priceUsd: number | null; // TQQQ price used for sizing (live if available, else confirmed close)
  priceLabel: string;
  alloc: AllocationResult | null;
  signals: SignalEvent[];
  live: { price: number; sma: number; dist: number; qual: boolean; exit: boolean; at: number | null } | null;
  // ---- V2 multi-strategy
  qqqClose: number | null;
  qqqPriceUsd: number | null;
  crossPts: CrossPoint[];
  cross: CrossEvaluation;
  crossPrev: CrossEvaluation | null;
  monthly: MonthlyEvaluation;
  monthlyPrev: MonthlyEvaluation | null;
  plans: { SMA_CROSS: SleevePlan | null; MONTHLY: SleevePlan | null };
  views: Record<StrategyId, StrategyView>;
  risk: RiskSummary | null;
  combinedTargetPct: number;
}

export const S = {
  page: 'overview' as Page,
  now: Date.now(),
  rt: null as Runtime | null,
  runtimeChecked: false,
  conn: { state: 'checking' as ConnState | 'checking', message: 'Connecting to Twelve Data…', usage: null as ApiUsage | null, lastOk: null as number | null },
  qqq: emptySeries(),
  tqqq: emptySeries(),
  quotes: { QQQ: null as Quote | null, TQQQ: null as Quote | null, at: null as number | null, error: null as CallFailure | null },
  divs: { status: 'idle' as 'idle' | 'loading' | 'ok' | 'error', QQQ: [] as Dividend[], TQQQ: [] as Dividend[], error: null as string | null },
  store: null as UserStore | null,
  storeState: 'loading' as StoreState,
  storeMsg: '',
  data: { portfolio: defaultPortfolio(), trades: [], settings: defaultSettings(), alerts: [] } as Loaded,
  loadingMarket: false,
  lastRefresh: null as number | null,
  lastSessionLoaded: null as string | null,
  strategy: (isStrategyId(storageGet('tqqq-strategy')) ? storageGet('tqqq-strategy') : 'CLAUDE_V2') as StrategyId,
  chart: { range: '1Y' as '6M' | '1Y' | '3Y' | '5Y' | 'MAX', log: false, algo: true, real: true, sma50: true },
  bt: {
    result: null as BacktestResult | null,
    look: null as LookaheadReport | null,
    inputs: null as InputCheck | null,
    running: false,
    error: null as string | null,
    log: true,
    compare: ['QQQ100', 'CLAUDE_V2', 'SMA_CROSS'] as string[],
    tradeModel: 'CLAUDE_V2' as string,
    form: { start: '', end: '', capital: 100000, feeBps: 5, feeFixed: 0, cashRate: 0, dividends: true },
  },
  research: {
    sens: null as Sensitivity | null,
    periods: null as PeriodRow[] | null,
    walk: null as WalkForward | null,
    method: null as MethodRow[] | null,
    inputs: null as InputCheck | null,
    running: false,
    error: null as string | null,
    ranAt: null as number | null,
    cfgNote: '',
  },
  markerRun: null as BacktestResult | null,
  formDirty: false,
  riskOpen: true,
  histFilter: 'ALL' as 'ALL' | StrategyId | 'CORE',
  toast: null as { text: string; tone: 'ok' | 'err' } | null,
};

let renderFn: () => void = () => {};
export function onRender(fn: () => void): void {
  renderFn = fn;
}
export function rerender(): void {
  derivedCache = null;
  renderFn();
}

export function toast(text: string, tone: 'ok' | 'err' = 'ok'): void {
  S.toast = { text, tone };
  renderFn();
  const mine = S.toast;
  setTimeout(() => {
    if (S.toast === mine) {
      S.toast = null;
      renderFn();
    }
  }, 4200);
}

// ---------- runtime

export async function startRuntime(make: () => Promise<Runtime>): Promise<void> {
  let rt: Runtime;
  try {
    rt = await make();
  } catch (e) {
    S.conn = { ...S.conn, state: 'unknown', message: 'Could not start: ' + ((e as { message?: string })?.message ?? String(e)) };
    S.storeState = 'unavailable';
    rerender();
    return;
  }
  S.rt = rt;
  S.runtimeChecked = true;
  if (rt.store) {
    S.store = new UserStore(rt.store.db, rt.store.uid);
    try {
      S.data = await S.store.load();
      S.storeState = 'ok';
      S.storeMsg = '';
    } catch (e) {
      S.storeState = 'unavailable';
      S.storeMsg = 'Saved data could not be loaded: ' + ((e as { message?: string })?.message ?? 'unknown error');
    }
  } else {
    S.storeState = 'unavailable';
    S.storeMsg = rt.storeUnavailable ?? 'Saving is not available.';
  }
  rerender();
  if (rt.market) await loadMarket(false);
  else {
    const u = rt.marketUnavailable ?? { state: 'no_runtime' as ConnState, message: 'Market data is not available.' };
    S.conn = { ...S.conn, state: u.state, message: u.message };
    rerender();
  }
}

/** Persist with one consistent failure path: a refused write switches the page to read-only. */
export async function persist(what: string, fn: (s: UserStore) => Promise<void>): Promise<boolean> {
  if (!S.store || S.storeState !== 'ok') {
    toast(`${what} not saved: ${S.storeMsg || 'saving is unavailable'}`, 'err');
    return false;
  }
  try {
    await fn(S.store);
    return true;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'invalid_argument') {
      S.storeState = 'readonly';
      S.storeMsg = 'You can view this page but not save changes to it.';
    }
    toast(`${what} not saved: ${(e as { message?: string })?.message ?? code ?? 'error'}`, 'err');
    return false;
  }
}

// ---------- market data

export async function loadMarket(forceFull: boolean): Promise<void> {
  const mk = S.rt?.market;
  if (!mk || S.loadingMarket) return;
  S.loadingMarket = true;
  S.conn = { ...S.conn, state: S.conn.state === 'ok' ? 'ok' : 'checking', message: 'Loading Daily candles from Twelve Data…' };
  renderFn();
  const now = Date.now();
  S.now = now;
  const one = async (sym: 'QQQ' | 'TQQQ', st: SeriesState) => {
    try {
      const r = await mk.history(sym, now, forceFull);
      st.raw = r.bars;
      st.source = r.source;
      st.note = r.note;
      st.error = null;
      st.loadedAt = Date.now();
      st.cacheWritable = r.cacheWritable;
    } catch (e) {
      st.error = describeFailure(e);
    }
  };
  await one('QQQ', S.qqq);
  if (!S.qqq.error) await one('TQQQ', S.tqqq);
  validateAll(now);
  await refreshQuotes(true);
  const err = S.qqq.error ?? S.tqqq.error ?? S.quotes.error;
  if (S.qqq.error) S.conn = { ...S.conn, state: S.qqq.error.state, message: S.qqq.error.message };
  else if (err) S.conn = { ...S.conn, state: 'ok', message: `Connected; ${err === S.tqqq.error ? 'TQQQ history' : 'live quotes'} unavailable: ${err.message}`, lastOk: Date.now() };
  else S.conn = { ...S.conn, state: 'ok', message: 'Connected', lastOk: Date.now() };
  S.lastRefresh = Date.now();
  S.lastSessionLoaded = lastCompletedSession(now);
  S.loadingMarket = false;
  S.markerRun = null;
  derivedCache = null;
  recordAlerts();
  rerender();
}

function validateAll(now: number): void {
  const shared = commonMissing([S.qqq.raw, S.tqqq.raw].filter((b) => b.length), DEFAULT_VALIDATE.calendarWindow);
  const opts = { ...DEFAULT_VALIDATE, sharedMissing: shared };
  S.qqq.report = S.qqq.raw.length ? validateDaily('QQQ', S.qqq.raw, now, opts) : null;
  S.tqqq.report = S.tqqq.raw.length ? validateDaily('TQQQ', S.tqqq.raw, now, opts) : null;
}

export async function refreshQuotes(silent = false): Promise<void> {
  const mk = S.rt?.market;
  if (!mk) return;
  try {
    const [q, t] = await Promise.all([mk.quote('QQQ'), mk.quote('TQQQ')]);
    S.quotes = { QQQ: q, TQQQ: t, at: Date.now(), error: null };
  } catch (e) {
    S.quotes = { ...S.quotes, error: describeFailure(e) };
  }
  S.lastRefresh = Date.now();
  if (!silent) {
    derivedCache = null;
    recordAlerts();
    rerender();
  }
}

export async function checkUsage(): Promise<void> {
  const mk = S.rt?.market;
  if (!mk) return;
  try {
    S.conn = { ...S.conn, usage: await mk.usage() };
    toast('Twelve Data usage updated');
  } catch (e) {
    toast(describeFailure(e).message, 'err');
  }
  rerender();
}

export async function rebuildCache(): Promise<void> {
  const mk = S.rt?.market;
  if (!mk) return;
  try {
    await mk.clearCache();
  } catch (e) {
    toast(describeFailure(e).message, 'err');
    return;
  }
  await loadMarket(true);
  toast('Price history reloaded from Twelve Data');
}

export async function loadDividends(): Promise<boolean> {
  const mk = S.rt?.market;
  if (!mk) return false;
  if (S.divs.status === 'ok') return true;
  S.divs.status = 'loading';
  renderFn();
  try {
    const [q, t] = await Promise.all([mk.dividends('QQQ'), mk.dividends('TQQQ')]);
    S.divs = { status: 'ok', QQQ: q, TQQQ: t, error: null };
    return true;
  } catch (e) {
    S.divs = { status: 'error', QQQ: [], TQQQ: [], error: describeFailure(e).message };
    return false;
  }
}

/** Timer tick: refresh quotes on the chosen interval during the session; reload candles after each close. */
export function tick(): void {
  const now = Date.now();
  S.now = now;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!S.rt?.market || S.loadingMarket) {
    renderFn();
    return;
  }
  const lcs = lastCompletedSession(now);
  if (S.lastSessionLoaded && lcs !== S.lastSessionLoaded) {
    void loadMarket(false);
    return;
  }
  const d = derive();
  if (d.status === 'awaiting' && S.lastRefresh && now - S.lastRefresh > 5 * 60000) {
    void loadMarket(false);
    return;
  }
  const mins = S.data.settings.quoteRefreshMin;
  const ms = marketStatus(now);
  if (mins > 0 && (ms.phase === 'open') && (!S.quotes.at || now - S.quotes.at >= mins * 60000)) {
    void refreshQuotes(false);
    return;
  }
  renderFn();
}

// ---------- derived evaluation

let derivedCache: Derived | null = null;

export function params(): StrategyParams {
  return S.data.settings.params;
}
export function crossParams(): CrossParams {
  return S.data.settings.cross;
}
export function monthlyParams(): MonthlyParams {
  return S.data.settings.monthly;
}

function sellLine(shares: number, valueUsd: number, feeUsd: number, kind: TradeKind, note: string): OrderLine {
  return { side: 'SELL', shares, valueUsd, feeUsd, kind, note, limitedByCash: false };
}

export function derive(): Derived {
  const key = `${S.qqq.loadedAt}|${S.tqqq.loadedAt}|${S.quotes.at}|${JSON.stringify(S.data.portfolio)}|${JSON.stringify(params())}|${JSON.stringify(S.data.settings.cross)}|${JSON.stringify(S.data.settings.monthly)}|${S.markerRun ? 'm' : '-'}`;
  if (derivedCache && derivedCache.key === key) return derivedCache;
  const p = params();
  const cp = crossParams();
  const mp = monthlyParams();
  const pf = S.data.portfolio;
  const rep = S.qqq.report;
  const status = rep ? rep.status : S.qqq.error ? 'missing' : 'loading';
  const points = rep ? buildPoints(rep.completed, p) : [];
  const trep = S.tqqq.report;
  const tqqqOk = !!trep && (trep.status === 'ok' || trep.status === 'awaiting');
  const lastD = points.length ? points[points.length - 1].d : null;
  const tBar = tqqqOk && lastD ? trep!.completed.find((b) => b.d === lastD) ?? null : null;
  const tqqqClose = tBar ? tBar.c : null;
  const qqqClose = lastD ? points[points.length - 1].c : null;
  const pin = portfolioInput(pf);
  // Each strategy's weight is its own sleeve's share of the whole account.
  const sleeveW = (shares: number) => (tqqqClose !== null ? sleeveWeightAt(pin, shares, tqqqClose, qqqClose) : shares === 0 ? 0 : null);
  const weightAtClose = sleeveW(pf.shares);
  const pos = positionOf(pf);
  const issues = rep ? [...rep.issues] : S.qqq.error ? [S.qqq.error.message] : [];
  const ev = evaluateLive({ points, dataStatus: rep ? rep.status : 'missing', dataIssues: issues, params: p, position: pos, weightAtClose });
  if (pf.shares > 0 && tqqqClose === null && ev.action !== 'DATA UNAVAILABLE') {
    ev.reasons.push('TQQQ prices could not be validated, so the 6% trim check is skipped.');
  }
  let evPrev: LiveEvaluation | null = null;
  if (rep && rep.status === 'awaiting') {
    evPrev = evaluateLive({ points, dataStatus: 'ok', dataIssues: [], params: p, position: pos, weightAtClose });
  }
  // Prices for sizing: live quotes during the session, otherwise the confirmed closes.
  const q = S.quotes.TQQQ;
  const ms = marketStatus(S.now);
  const liveWindow = ms.phase === 'open' || ms.phase === 'pre' || ms.phase === 'post';
  let priceUsd: number | null = null;
  let priceLabel = '';
  if (q && liveWindow) {
    priceUsd = q.price;
    priceLabel = 'live TQQQ quote';
  } else if (tqqqOk && trep!.completed.length) {
    const lb = trep!.completed[trep!.completed.length - 1];
    priceUsd = lb.c;
    priceLabel = `TQQQ close on ${fmtDate(lb.d)}`;
  } else if (q) {
    priceUsd = q.price;
    priceLabel = 'latest TQQQ quote';
  }
  const qq = S.quotes.QQQ;
  const qqqPriceUsd = qq && liveWindow ? qq.price : qqqClose ?? qq?.price ?? null;
  const alloc = priceUsd !== null ? computeAllocation(pin, priceUsd, p, { shares: pf.shares, avgCost: pf.avgCost }, qqqPriceUsd) : null;
  // Live, unconfirmed position of QQQ against an SMA200 that includes the live price.
  let live: Derived['live'] = null;
  if (qq && points.length >= p.smaPeriod && (ms.phase === 'open' || (rep && rep.inProgress))) {
    const closes = points.slice(-(p.smaPeriod - 1)).map((x) => x.c);
    const sma = (closes.reduce((s, x) => s + x, 0) + qq.price) / p.smaPeriod;
    const dist = (qq.price / sma - 1) * 100;
    live = { price: qq.price, sma, dist, qual: qq.price >= sma * (1 + p.entryBufferPct / 100), exit: qq.price <= sma * (1 - p.exitBufferPct / 100), at: qq.timestampMs ?? S.quotes.at };
  }
  const signals = points.length ? signalHistory(points, p) : [];

  // ---- Strategy B and C
  const crossSl = sleeveOf(pf, 'SMA_CROSS');
  const monSl = sleeveOf(pf, 'MONTHLY');
  const plans = {
    SMA_CROSS: priceUsd !== null ? planSleeve(pin, crossSl, priceUsd, cp.targetPct, qqqPriceUsd) : null,
    MONTHLY: priceUsd !== null ? planSleeve(pin, monSl, priceUsd, mp.targetPct, qqqPriceUsd) : null,
  };
  const crossPts = rep ? crossPoints(rep.completed, cp) : [];
  const crossIn = (st: typeof status) => ({
    bars: rep ? rep.completed : [], dataStatus: (st === 'loading' ? 'missing' : st) as Exclude<typeof status, 'loading'>, dataIssues: issues, params: cp,
    sleeve: sleevePosition(pf, 'SMA_CROSS'), weightAtClose: sleeveW(crossSl.shares), rebalanceShares: plans.SMA_CROSS?.ok ? plans.SMA_CROSS.rebalanceShares : null,
  });
  const cross = evaluateCross(crossIn(status));
  const crossPrev = rep && rep.status === 'awaiting' ? evaluateCross(crossIn('ok')) : null;
  const tStatus = trep ? trep.status : S.tqqq.error ? 'missing' : 'missing';
  const tIssues = trep ? [...trep.issues] : S.tqqq.error ? [S.tqqq.error.message] : [];
  const monIn = (st: typeof tStatus) => ({
    lastCompleted: trep?.lastCompleted ?? null, dataStatus: st, dataIssues: tIssues, params: mp, sleeve: sleevePosition(pf, 'MONTHLY'),
    weightAtClose: (() => {
      if (!trep || !trep.completed.length) return null;
      const lb = trep.completed[trep.completed.length - 1];
      const qb = rep?.completed.find((b) => b.d === lb.d)?.c ?? null;
      return monSl.shares === 0 ? 0 : sleeveWeightAt(pin, monSl.shares, lb.c, qb);
    })(),
    rebalanceShares: plans.MONTHLY?.ok ? plans.MONTHLY.rebalanceShares : null,
    rebalanceValueUsd: plans.MONTHLY?.ok ? plans.MONTHLY.rebalanceValueUsd : null,
    cashRequiredUsd: plans.MONTHLY?.equityUsd != null ? plans.MONTHLY.cashRequiredUsd : null,
    cashAvailableUsd: plans.MONTHLY?.cashUsd ?? null,
  });
  const monthly = evaluateMonthly(monIn(tStatus));
  const monthlyPrev = trep && trep.status === 'awaiting' ? evaluateMonthly(monIn('ok')) : null;

  // ---- per-strategy views
  const mr = markerRun();
  const cm = mr?.models.find((m) => m.id === (isBaseline(p) ? 'CLAUDE_V2' : 'CLAUDE_V2_MOD')) ?? null;
  const snap = cm && cm.state.claude ? { pending: cm.pending, active: cm.state.claude.active, firstExecDate: cm.state.claude.firstExecDate, secondDone: cm.state.claude.secondDone, weightPct: cm.state.tqqqWeight * 100 } : null;
  const followed = new Set(pf.followed);
  const claudeOrder = (): { order: OrderLine | null; problem: string | null } => {
    const a = alloc;
    const act = ev.action;
    if (!['BUY INITIAL', 'ADD POSITION', 'TRIM', 'EXIT ALL'].includes(act)) return { order: null, problem: null };
    if (!a || !a.ok) {
      if (act === 'EXIT ALL' && pf.shares > 0) return { order: sellLine(pf.shares, priceUsd ? pf.shares * priceUsd : 0, 0, 'EXIT', 'the whole Claude V2 sleeve'), problem: null };
      return { order: null, problem: a && a.problems.length ? a.problems[0] : 'Complete your holdings on the Portfolio page' };
    }
    if (act === 'BUY INITIAL' && a.initial) return { order: { side: 'BUY', shares: a.initial.shares, valueUsd: a.initial.valueUsd, feeUsd: a.initial.feeUsd, kind: 'INITIAL', note: a.initial.limitedByCash ? 'limited by available cash' : `to ${p.firstAllocPct}% of equity`, limitedByCash: a.initial.limitedByCash }, problem: null };
    if (act === 'ADD POSITION' && a.add) return { order: { side: 'BUY', shares: a.add.shares, valueUsd: a.add.valueUsd, feeUsd: a.add.feeUsd, kind: 'ADD', note: a.add.limitedByCash ? 'limited by available cash' : `to ${p.targetAllocPct}% in total`, limitedByCash: a.add.limitedByCash }, problem: null };
    if (act === 'TRIM' && a.trim) return { order: sellLine(a.trim.shares, a.trim.valueUsd, a.trim.feeUsd, 'TRIM', `back toward ${p.targetAllocPct}%`), problem: null };
    if (act === 'EXIT ALL') return { order: sellLine(a.exit.shares, a.exit.valueUsd, a.exit.feeUsd, 'EXIT', 'the whole Claude V2 sleeve'), problem: null };
    return { order: null, problem: null };
  };
  const sleeveOrder = (plan: SleevePlan | null, action: Action, target: number, buyKind: TradeKind): { order: OrderLine | null; problem: string | null } => {
    if (!['BUY', 'REBALANCE', 'EXIT'].includes(action)) return { order: null, problem: null };
    if (!plan || !plan.ok) {
      if (action === 'EXIT' && plan && plan.sleeveShares > 0) return { order: sellLine(plan.sleeveShares, plan.valueUsd, 0, 'EXIT', 'the whole sleeve'), problem: null };
      return { order: null, problem: plan && plan.problems.length ? plan.problems[0] : 'TQQQ price unavailable' };
    }
    if (action === 'EXIT') return { order: sellLine(plan.exit.shares, plan.exit.valueUsd, plan.exit.feeUsd, 'EXIT', 'the whole sleeve'), problem: null };
    if (plan.buy && (action === 'BUY' || plan.rebalanceShares! > 0)) {
      return { order: { side: 'BUY', shares: plan.buy.shares, valueUsd: plan.buy.valueUsd, feeUsd: plan.buy.feeUsd, kind: action === 'BUY' ? buyKind : 'REBALANCE', note: plan.buy.limitedByCash ? 'limited by available cash' : `to ${target}% of equity`, limitedByCash: plan.buy.limitedByCash }, problem: null };
    }
    if (plan.sell && plan.sell.shares > 0) return { order: sellLine(plan.sell.shares, plan.sell.valueUsd, plan.sell.feeUsd, 'REBALANCE', `back to ${target}%`), problem: null };
    return { order: null, problem: null };
  };
  const co = claudeOrder();
  const xo = sleeveOrder(plans.SMA_CROSS, cross.action, cp.targetPct, 'ENTRY');
  const mo = sleeveOrder(plans.MONTHLY, monthly.action, mp.targetPct, 'ENTRY');
  const views: Record<StrategyId, StrategyView> = {
    CLAUDE_V2: {
      id: 'CLAUDE_V2', letter: 'A', name: STRATEGY_META.CLAUDE_V2.name, followed: followed.has('CLAUDE_V2'),
      signal: claudeSignal(evPrev ?? ev, snap, p), action: claudeAction(ev.action), tone: ACTION_TONE[claudeAction(ev.action)],
      headline: ev.headline, reasons: ev.reasons, prevAction: evPrev ? claudeAction(evPrev.action) : null, asOf: ev.asOf,
      shares: pf.shares, weightPct: weightAtClose === null ? null : weightAtClose * 100, targetPct: p.targetAllocPct, order: co.order, orderProblem: co.problem, modified: !isBaseline(p),
    },
    SMA_CROSS: {
      id: 'SMA_CROSS', letter: 'B', name: STRATEGY_META.SMA_CROSS.name, followed: followed.has('SMA_CROSS'),
      signal: (crossPrev ?? cross).signal, action: cross.action, tone: ACTION_TONE[cross.action], headline: cross.headline, reasons: cross.reasons,
      prevAction: crossPrev ? crossPrev.action : null, asOf: cross.asOf, shares: crossSl.shares, weightPct: plans.SMA_CROSS?.weightPct ?? (crossSl.shares === 0 ? 0 : null),
      targetPct: cp.targetPct, order: xo.order, orderProblem: xo.problem, modified: !isCrossBaseline(cp),
    },
    MONTHLY: {
      id: 'MONTHLY', letter: 'C', name: STRATEGY_META.MONTHLY.name, followed: followed.has('MONTHLY'),
      signal: (monthlyPrev ?? monthly).signal, action: monthly.action, tone: ACTION_TONE[monthly.action], headline: monthly.headline, reasons: monthly.reasons,
      prevAction: monthlyPrev ? monthlyPrev.action : null, asOf: monthly.asOf, shares: monSl.shares, weightPct: plans.MONTHLY?.weightPct ?? (monSl.shares === 0 ? 0 : null),
      targetPct: mp.targetPct, order: mo.order, orderProblem: mo.problem, modified: !isMonthlyBaseline(mp),
    },
  };
  const combinedTargetPct = STRATEGY_IDS.filter((id) => followed.has(id)).reduce((s2, id) => s2 + views[id].targetPct, 0) || p.targetAllocPct;
  const risk = priceUsd !== null ? riskSummary(pin, priceUsd, qqqPriceUsd, combinedTargetPct, S.data.settings.riskDrops) : null;
  derivedCache = {
    key, status, issues, notes: rep ? rep.notes : [], points, ev, evPrev, tqqqOk, tqqqClose, tqqqCloseDate: tBar ? tBar.d : null,
    priceUsd, priceLabel, alloc, signals, live,
    qqqClose, qqqPriceUsd, crossPts, cross, crossPrev, monthly, monthlyPrev, plans, views, risk, combinedTargetPct,
  };
  return derivedCache;
}

/** Total TQQQ shares across sleeves (for display). */
export function allTqqqShares(): number {
  return totalTqqqShares(S.data.portfolio);
}

/** Store newly fired alerts (deduplicated by type and session date). */
function recordAlerts(): void {
  if (!S.store || S.storeState !== 'ok') return;
  const d = derive();
  if (d.status === 'loading') return;
  const followed = new Set(S.data.portfolio.followed);
  const fired = [
    ...d.ev.fired,
    ...d.cross.fired.filter((f) => f.type !== 'CROSS_REBALANCE_DUE' || followed.has('SMA_CROSS')),
    ...(followed.has('MONTHLY') ? d.monthly.fired : []),
  ];
  const fresh = newAlerts(S.data.alerts, fired, S.data.settings.alerts, new Date().toISOString());
  if (!fresh.length) return;
  const all: AlertRec[] = [...S.data.alerts, ...fresh];
  S.data.alerts = all;
  void persist('Alerts', (st) => st.saveAlerts(all));
}

// ---------- backtests

export function backtestWindow(): { start: string; end: string; qFirst: string | null; tFirst: string | null } | null {
  const q = S.qqq.report?.completed ?? [];
  const t = S.tqqq.report?.completed ?? [];
  if (q.length < 260 || t.length < 30) return null;
  const p = params();
  const firstSma = q[Math.max(p.smaPeriod, CLAUDE_V2_BASELINE.smaPeriod, crossParams().slow, 200) - 1]?.d ?? q[0].d;
  const start = [firstSma, t[0].d].sort()[1];
  const end = [q[q.length - 1].d, t[t.length - 1].d].sort()[0];
  return { start, end, qFirst: q[0].d, tFirst: t[0].d };
}

export function markerRun(): BacktestResult | null {
  if (S.markerRun) return S.markerRun;
  const win = backtestWindow();
  if (!win) return null;
  const q = S.qqq.report!.completed;
  const t = S.tqqq.report!.completed;
  const p = params();
  const cp = crossParams();
  const mp = monthlyParams();
  S.markerRun = simulate(q, t, { QQQ: [], TQQQ: [] }, {
    start: win.start, end: win.end, initialCapital: 100000, feeBps: 0, feeFixed: 0, cashRatePct: 0, useDividends: false,
    baseline: { ...CLAUDE_V2_BASELINE }, modified: isBaseline(p) ? null : { ...p },
    crossModified: isCrossBaseline(cp) ? null : { ...cp }, monthlyModified: isMonthlyBaseline(mp) ? null : { ...mp },
  });
  return S.markerRun;
}
