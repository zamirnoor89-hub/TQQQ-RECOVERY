// Historical simulation: one portfolio engine shared by every model. Each decision is taken at a
// completed close using only data up to that close, and executed at the next session's open
// (or, only as a reconciliation aid, at the signal close). Results are deterministic for a given input.
import type { Bar, Dividend } from './data.ts';
import { fingerprint } from './data.ts';
import type { CycleState, Decision, DecisionKind, Point, StrategyParams } from './strategy.ts';
import { applyExecuted, buildPoints, decideAtClose, initialCycleState, smaSeries } from './strategy.ts';
import type { CrossParams, MonthlyParams } from './strategies.ts';
import { SMA_CROSS_BASELINE, MONTHLY_BASELINE } from './strategies.ts';
import { daysBetween, lastSessionOfMonth } from './time.ts';

export type ModelId = string;

/** How a model allocates. Rotation covers every trend rule; Claude V2 is its own state machine. */
export type ModelKind = 'QQQ100' | 'QQQ_CASH' | 'MONTHLY' | 'QQQ_TQQQ_BH' | 'ROTATION' | 'CLAUDE_V2';

export type TrendRule = { type: 'close_above_sma'; period: number } | { type: 'sma_cross'; fast: number; slow: number };

export interface ModelDef {
  id: ModelId;
  kind: ModelKind;
  name: string;
  short: string;
  description: string;
  reference?: boolean;
  params?: StrategyParams; // CLAUDE_V2
  rule?: TrendRule; // ROTATION
  sleevePct?: number; // ROTATION and MONTHLY target, % of equity (default 5)
}

export interface ModelSpec {
  id: ModelId;
  name: string;
  short: string;
  description: string;
  reference?: boolean;
}

/** Display order and descriptions for the standard comparison (and the not-run Mike V2 slot). */
export const MODEL_SPECS: ModelSpec[] = [
  { id: 'QQQ100', name: 'QQQ 100% buy-and-hold', short: 'QQQ 100%', description: 'All capital in QQQ from the first session. Idle cash (dividends) is swept into QQQ at each month end.' },
  { id: 'QQQ_CASH', name: '95% QQQ + 5% cash, monthly rebalanced', short: '95/5 cash', description: 'QQQ 95% and cash 5%, rebalanced at each month end.' },
  { id: 'QQQ_TQQQ_M', name: '95% QQQ + 5% TQQQ, monthly rebalanced', short: 'Monthly 5% TQQQ', description: 'Strategy C. TQQQ reset to 5% (QQQ 95%) at each month end; weights drift between rebalances. No trend signals, no liquidation.' },
  { id: 'QQQ_TQQQ_M_MOD', name: 'Monthly rebalanced, modified target', short: 'Monthly (modified)', description: 'Strategy C with the target saved in Settings (differs from 5%).' },
  { id: 'SMA200_ROT', name: 'QQQ core + plain SMA200 rotation', short: 'Plain SMA200', description: '5% sleeve in TQQQ after a QQQ close above SMA200, in cash after a close at or below it. No buffer, one close, sleeve reset to 5% monthly while held.' },
  { id: 'CLAUDE_V2', name: 'QQQ core + Claude V2 recovery', short: 'Claude V2', description: 'Strategy A. Rules A–E with the Claude V2 baseline parameters. The uninvested part of the 5% sleeve stays in cash.' },
  { id: 'CLAUDE_V2_MOD', name: 'QQQ core + Claude V2, modified', short: 'Claude V2 (modified)', description: 'Rules A–E with the parameters saved in Settings (differs from the baseline).' },
  { id: 'SMA_CROSS', name: 'QQQ core + SMA50/SMA200 rotation', short: 'SMA50/SMA200', description: 'Strategy B. 5% TQQQ sleeve while QQQ SMA50 is strictly above SMA200, cash when SMA50 is at or below SMA200. Sleeve reset to 5% monthly while held.' },
  { id: 'SMA_CROSS_MOD', name: 'QQQ core + SMA crossover, modified', short: 'SMA cross (modified)', description: 'Strategy B with the moving averages or target saved in Settings (differs from 50/200/5%).' },
  { id: 'QQQ_TQQQ_BH', name: 'Initial 5% TQQQ, never rebalanced', short: '5% once, no rebalance', description: 'High-risk reference only: 95/5 at the start, then TQQQ is left to drift with no rebalancing. Not a maintained 5% allocation.', reference: true },
  { id: 'MIKE_V2', name: 'QQQ core + Mike V2 confirmation', short: 'Mike V2', description: 'Not run: the Mike V2 TQQQ entry and exit rules have not been supplied.' },
];

export function specOf(id: ModelId): ModelSpec {
  return MODEL_SPECS.find((m) => m.id === id) ?? { id, name: id, short: id, description: '' };
}

export interface BacktestConfig {
  start: string;
  end: string;
  initialCapital: number;
  feeBps: number; // per trade, % of value in basis points
  feeFixed: number; // USD per trade
  cashRatePct: number; // annual interest on cash
  useDividends: boolean;
  baseline: StrategyParams;
  modified: StrategyParams | null; // Claude V2 run as a separate model when it differs from the baseline
  cross?: CrossParams; // Strategy B (default 50/200, 5%)
  crossModified?: CrossParams | null;
  monthly?: MonthlyParams; // Strategy C (default 5%)
  monthlyModified?: MonthlyParams | null;
  /** Explicit model list (research runs). When omitted, the standard comparison set is used. */
  models?: ModelDef[];
  /** 'next_open' is the methodology. 'same_close' exists only to show how much that choice matters. */
  execution?: 'next_open' | 'same_close';
}

/** The standard comparison set for a configuration, in display order. */
export function standardModels(cfg: BacktestConfig): ModelDef[] {
  const def = (id: ModelId, kind: ModelKind, extra: Partial<ModelDef> = {}): ModelDef => {
    const s = specOf(id);
    return { id, kind, name: s.name, short: s.short, description: s.description, reference: s.reference, ...extra };
  };
  const cross = cfg.cross ?? SMA_CROSS_BASELINE;
  const monthly = cfg.monthly ?? MONTHLY_BASELINE;
  const out: ModelDef[] = [
    def('QQQ100', 'QQQ100'),
    def('QQQ_CASH', 'QQQ_CASH'),
    def('QQQ_TQQQ_M', 'MONTHLY', { sleevePct: monthly.targetPct }),
  ];
  if (cfg.monthlyModified) out.push(def('QQQ_TQQQ_M_MOD', 'MONTHLY', { sleevePct: cfg.monthlyModified.targetPct }));
  out.push(def('SMA200_ROT', 'ROTATION', { rule: { type: 'close_above_sma', period: 200 }, sleevePct: 5 }));
  out.push(def('CLAUDE_V2', 'CLAUDE_V2', { params: cfg.baseline }));
  if (cfg.modified) out.push(def('CLAUDE_V2_MOD', 'CLAUDE_V2', { params: cfg.modified }));
  out.push(def('SMA_CROSS', 'ROTATION', { rule: { type: 'sma_cross', fast: cross.fast, slow: cross.slow }, sleevePct: cross.targetPct }));
  if (cfg.crossModified) out.push(def('SMA_CROSS_MOD', 'ROTATION', { rule: { type: 'sma_cross', fast: cfg.crossModified.fast, slow: cfg.crossModified.slow }, sleevePct: cfg.crossModified.targetPct }));
  out.push(def('QQQ_TQQQ_BH', 'QQQ_TQQQ_BH'));
  return out;
}

export interface TradeRec {
  date: string;
  signalDate: string | null;
  symbol: 'QQQ' | 'TQQQ';
  side: 'BUY' | 'SELL';
  shares: number;
  price: number;
  value: number;
  fee: number;
  kind: string;
  /** TQQQ weight of equity right after a sized TQQQ purchase, at the execution price. */
  postWeight?: number;
}

export interface CycleRec {
  entrySignal: string;
  entryDate: string;
  addDate: string | null;
  trims: number;
  exitSignal: string | null;
  exitDate: string | null;
  invested: number;
  returned: number;
  returnPct: number | null;
  open: boolean;
}

export type EventKind = DecisionKind;

export interface ModelEvent {
  kind: EventKind;
  signalDate: string;
  execDate: string | null;
  reason: string;
}

export interface YearRet {
  year: number;
  ret: number;
  partial: boolean;
}

export interface FinalState {
  qqqShares: number;
  tqqqShares: number;
  cash: number;
  tqqqWeight: number; // at the last close
  invested: boolean; // rotation models: sleeve in TQQQ
  claude: { active: boolean; firstExecDate: string | null; secondDone: boolean } | null;
  monthlyDue: boolean; // the last close was a month end, so a rebalance executes at the next open
}

export interface ModelResult {
  id: ModelId;
  kind: ModelKind;
  name: string;
  short: string;
  reference: boolean;
  equity: number[];
  weights: number[]; // TQQQ weight at each close
  final: number;
  totalReturn: number;
  cagr: number;
  maxDD: number;
  maxDDPeak: string;
  maxDDTrough: string;
  vol: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  worstYear: YearRet | null;
  trades: TradeRec[];
  tqqqTrades: number;
  tradesPerYear: number;
  totalCosts: number;
  investedDays: number;
  investedPct: number;
  avgWeight: number; // % over every session
  maxWeight: number; // %
  cycles: CycleRec[];
  completedCycles: number;
  years: YearRet[];
  events: ModelEvent[];
  pending: ModelEvent[];
  state: FinalState;
}

export interface BacktestResult {
  config: BacktestConfig;
  dates: string[];
  models: ModelResult[];
  skipped: { id: ModelId; reason: string }[];
  dataFingerprint: string;
  resultFingerprint: string;
  notes: string[];
  dividendsUsed: { QQQ: number; TQQQ: number };
}

// ---------- internals

interface Acct {
  q: number; // QQQ shares (fractional)
  t: number; // TQQQ shares
  cash: number;
}

type Order =
  | { op: 'tqqq_to_pct'; pct: number; kind: string; signalDate: string }
  | { op: 'tqqq_sell_all'; kind: string; signalDate: string }
  | { op: 'tqqq_trim_to_pct'; pct: number; kind: string; signalDate: string }
  | { op: 'mark'; decision: EventKind; signalIdx: number; signalDate: string }
  | { op: 'monthly'; signalDate: string };

type Px = 'o' | 'c';

const MIN_TRADE_FRAC = 0.001; // skip rebalance trades smaller than 0.1% of equity

function warmup(m: ModelDef): number {
  if (m.kind === 'CLAUDE_V2' && m.params) return m.params.smaPeriod;
  if (m.kind === 'ROTATION' && m.rule) return m.rule.type === 'sma_cross' ? Math.max(m.rule.fast, m.rule.slow) : m.rule.period;
  return 0;
}

export function simulate(
  qqqBars: Bar[],
  tqqqBars: Bar[],
  dividends: { QQQ: Dividend[]; TQQQ: Dividend[] },
  cfg: BacktestConfig,
): BacktestResult {
  const notes: string[] = [];
  const defs = cfg.models ?? standardModels(cfg);
  const mode = cfg.execution ?? 'next_open';
  const qIdx = new Map<string, number>();
  qqqBars.forEach((b, i) => qIdx.set(b.d, i));
  const tByDate = new Map<string, Bar>();
  for (const b of tqqqBars) tByDate.set(b.d, b);
  const closes = qqqBars.map((b) => b.c);
  const smaCache = new Map<number, (number | null)[]>();
  const smaOf = (period: number) => {
    let s = smaCache.get(period);
    if (!s) {
      s = smaSeries(closes, period);
      smaCache.set(period, s);
    }
    return s;
  };
  const pointsCache = new Map<string, Point[]>();
  const pointsOf = (p: StrategyParams) => {
    const key = JSON.stringify(p);
    let pts = pointsCache.get(key);
    if (!pts) {
      pts = buildPoints(qqqBars, p);
      pointsCache.set(key, pts);
    }
    return pts;
  };

  // One common window: sessions present for both symbols, inside the dates, where every model's
  // moving averages exist (and always the baseline SMA200, so research runs share the main window).
  const need = Math.max(cfg.baseline.smaPeriod, ...defs.map(warmup));
  const dates: string[] = [];
  for (const b of qqqBars) {
    if (b.d < cfg.start || b.d > cfg.end) continue;
    if (!tByDate.has(b.d)) continue;
    const i = qIdx.get(b.d) as number;
    if (i < need - 1) continue;
    dates.push(b.d);
  }
  const N = dates.length;
  const skipped: { id: ModelId; reason: string }[] = [{ id: 'MIKE_V2', reason: 'Mike V2 confirmation rules have not been supplied, so this model is not simulated.' }];
  if (N < 30) {
    return { config: cfg, dates, models: [], skipped, dataFingerprint: '', resultFingerprint: '', notes: ['Fewer than 30 overlapping sessions with valid moving averages; nothing to simulate.'], dividendsUsed: { QQQ: 0, TQQQ: 0 } };
  }
  const qBar = (k: number) => qqqBars[qIdx.get(dates[k]) as number];
  const tBar = (k: number) => tByDate.get(dates[k]) as Bar;

  // Dividends: cash credited on the ex-date to shares held at the prior close. Twelve Data prices
  // are split-adjusted only (not dividend-adjusted), so crediting cash does not double-count.
  // Implausible amounts (over 10% of the prior close) are discarded rather than trusted.
  const divMap = { QQQ: new Map<string, number>(), TQQQ: new Map<string, number>() };
  const dividendsUsed = { QQQ: 0, TQQQ: 0 };
  if (cfg.useDividends) {
    for (const sym of ['QQQ', 'TQQQ'] as const) {
      let dropped = 0;
      const bars = sym === 'QQQ' ? qqqBars : tqqqBars;
      for (const dv of dividends[sym]) {
        let prev: Bar | null = null;
        for (let i = bars.length - 1; i >= 0; i--) if (bars[i].d < dv.exDate) { prev = bars[i]; break; }
        if (!prev || dv.amount / prev.c > 0.1) { dropped++; continue; }
        divMap[sym].set(dv.exDate, (divMap[sym].get(dv.exDate) ?? 0) + dv.amount);
        dividendsUsed[sym]++;
      }
      if (dropped) notes.push(`${dropped} ${sym} dividend record(s) discarded as implausible relative to price.`);
      const first = dividends[sym].length ? dividends[sym][0].exDate : null;
      if (!first) notes.push(`Twelve Data returned no ${sym} dividend history; ${sym} is price return only.`);
      else if (first > cfg.start) notes.push(`Twelve Data’s ${sym} dividend history starts ${first}; payments before that date are not credited.`);
    }
  }
  const divBetween = (sym: 'QQQ' | 'TQQQ', after: string, upTo: string) => {
    let s = 0;
    for (const [d, a] of divMap[sym]) if (d > after && d <= upTo) s += a;
    return s;
  };

  const fee = (value: number) => (value > 0 ? (value * cfg.feeBps) / 10000 + cfg.feeFixed : 0);

  interface ModelRun {
    def: ModelDef;
    acct: Acct;
    equity: number[];
    weights: number[];
    trades: TradeRec[];
    pending: Order[];
    cycle: CycleState;
    params: StrategyParams | null;
    points: Point[] | null;
    trend: ((qi: number) => boolean | null) | null;
    sleeve: number; // % of equity
    invested: boolean; // rotation state
    cycles: CycleRec[];
    events: ModelEvent[];
    pendingEvents: ModelEvent[];
    investedDays: number;
  }

  const runs: ModelRun[] = defs.map((def) => {
    let trend: ModelRun['trend'] = null;
    if (def.kind === 'ROTATION' && def.rule) {
      const rule = def.rule;
      if (rule.type === 'close_above_sma') {
        const s = smaOf(rule.period);
        trend = (qi) => (s[qi] === null ? null : closes[qi] > (s[qi] as number));
      } else {
        const f = smaOf(rule.fast), sl = smaOf(rule.slow);
        trend = (qi) => (f[qi] === null || sl[qi] === null ? null : (f[qi] as number) > (sl[qi] as number));
      }
    }
    return {
      def, acct: { q: 0, t: 0, cash: cfg.initialCapital }, equity: [], weights: [], trades: [], pending: [], cycle: initialCycleState(),
      params: def.kind === 'CLAUDE_V2' ? (def.params as StrategyParams) : null,
      points: def.kind === 'CLAUDE_V2' ? pointsOf(def.params as StrategyParams) : null,
      trend, sleeve: def.sleevePct ?? 5, invested: false, cycles: [], events: [], pendingEvents: [], investedDays: 0,
    };
  });

  const px = (k: number, sym: 'QQQ' | 'TQQQ', f: Px) => (sym === 'QQQ' ? qBar(k)[f] : tBar(k)[f]);

  const trade = (r: ModelRun, sym: 'QQQ' | 'TQQQ', deltaShares: number, price: number, k: number, kind: string, signalDate: string | null) => {
    if (!(Math.abs(deltaShares) > 1e-12)) return;
    const a = r.acct;
    if (deltaShares > 0) {
      let value = deltaShares * price;
      // No borrowing: a purchase is cut to what cash pays for, fees included.
      if (value + fee(value) > a.cash) {
        value = Math.max(0, (a.cash - cfg.feeFixed) / (1 + cfg.feeBps / 10000));
        deltaShares = value / price;
      }
      if (value <= 1e-9) return;
      const f = fee(value);
      a.cash -= value + f;
      if (sym === 'QQQ') a.q += deltaShares; else a.t += deltaShares;
      r.trades.push({ date: dates[k], signalDate, symbol: sym, side: 'BUY', shares: deltaShares, price, value, fee: f, kind });
    } else {
      const held = sym === 'QQQ' ? a.q : a.t;
      const sh = Math.min(held, -deltaShares);
      const value = sh * price;
      if (value <= 1e-9) return;
      const f = fee(value);
      a.cash += value - f;
      if (sym === 'QQQ') a.q -= sh; else a.t -= sh;
      if (sym === 'TQQQ' && a.t < 1e-12) a.t = 0;
      r.trades.push({ date: dates[k], signalDate, symbol: sym, side: 'SELL', shares: sh, price, value, fee: f, kind });
    }
  };

  /** Move QQQ and/or TQQQ toward target weights. Undefined weight = leave alone. */
  const rebalanceTo = (r: ModelRun, k: number, wq: number | undefined, wt: number | undefined, kind: string, signalDate: string | null, f: Px) => {
    const qo = px(k, 'QQQ', f), to = px(k, 'TQQQ', f);
    const a = r.acct;
    const E = a.q * qo + a.t * to + a.cash;
    const dq = wq === undefined ? 0 : (wq * E) / qo - a.q;
    const dt = wt === undefined ? 0 : (wt * E) / to - a.t;
    const big = (d: number, p: number) => Math.abs(d * p) >= MIN_TRADE_FRAC * E;
    // Sells first so buys can use the proceeds.
    if (dq < 0 && big(dq, qo)) trade(r, 'QQQ', dq, qo, k, kind, signalDate);
    if (dt < 0 && big(dt, to)) trade(r, 'TQQQ', dt, to, k, kind, signalDate);
    if (dt > 0 && big(dt, to)) trade(r, 'TQQQ', dt, to, k, kind, signalDate);
    if (dq > 0 && big(dq, qo)) trade(r, 'QQQ', dq, qo, k, kind, signalDate);
  };

  const monthly = (r: ModelRun, k: number, signalDate: string, f: Px) => {
    const a = r.acct;
    const E = a.q * px(k, 'QQQ', f) + a.t * px(k, 'TQQQ', f) + a.cash;
    const s = r.sleeve;
    switch (r.def.kind) {
      case 'QQQ100':
      case 'QQQ_TQQQ_BH': {
        // Sweep idle cash into QQQ; TQQQ untouched.
        const tw = (a.t * px(k, 'TQQQ', f)) / E;
        rebalanceTo(r, k, 1 - tw, undefined, 'SWEEP', signalDate, f);
        break;
      }
      case 'QQQ_CASH':
        rebalanceTo(r, k, 0.95, undefined, 'REBALANCE', signalDate, f);
        break;
      case 'MONTHLY':
        rebalanceTo(r, k, (100 - s) / 100, s / 100, 'REBALANCE', signalDate, f);
        break;
      case 'ROTATION':
        if (r.invested) rebalanceTo(r, k, (100 - s) / 100, s / 100, 'REBALANCE', signalDate, f);
        else rebalanceTo(r, k, (100 - s) / 100, undefined, 'REBALANCE', signalDate, f);
        break;
      case 'CLAUDE_V2': {
        const p = r.params as StrategyParams;
        const tw = (a.t * px(k, 'TQQQ', f)) / E;
        const cashTarget = Math.max(0, p.targetAllocPct / 100 - tw);
        rebalanceTo(r, k, 1 - tw - cashTarget, undefined, 'REBALANCE', signalDate, f);
        break;
      }
      default:
        break;
    }
  };

  const openCycle = (r: ModelRun): CycleRec | null => {
    const c = r.cycles[r.cycles.length - 1];
    return c && c.open ? c : null;
  };

  const execute = (r: ModelRun, k: number, f: Px) => {
    const orders = r.pending;
    r.pending = [];
    const monthlyOrders = orders.filter((o) => o.op === 'monthly');
    for (const o of orders) {
      if (o.op === 'monthly') continue;
      const before = r.trades.length;
      const to = px(k, 'TQQQ', f);
      const qo = px(k, 'QQQ', f);
      const a = r.acct;
      if (o.op === 'tqqq_to_pct') {
        // Buy x so that (value + x) / (equity - fee(x)) equals the target exactly: fees never push
        // the position past its target.
        const E = a.q * qo + a.t * to + a.cash;
        const w = o.pct / 100;
        const x = (w * (E - cfg.feeFixed) - a.t * to) / (1 + (w * cfg.feeBps) / 10000);
        if (x > 0) trade(r, 'TQQQ', x / to, to, k, o.kind, o.signalDate);
        const last = r.trades[r.trades.length - 1];
        if (r.trades.length > before && last.symbol === 'TQQQ') {
          last.postWeight = (a.t * to) / (a.q * qo + a.t * to + a.cash);
        }
      } else if (o.op === 'tqqq_trim_to_pct') {
        const E = a.q * qo + a.t * to + a.cash;
        const excess = a.t * to - (o.pct / 100) * E;
        if (excess > 0) trade(r, 'TQQQ', -excess / to, to, k, o.kind, o.signalDate);
      } else if (o.op === 'tqqq_sell_all') {
        trade(r, 'TQQQ', -a.t, to, k, o.kind, o.signalDate);
      } else if (o.op === 'mark') {
        if (r.def.kind === 'CLAUDE_V2') r.cycle = applyExecuted(r.cycle, o.decision, o.signalIdx, qIdx.get(dates[k]) as number);
        const ev = r.pendingEvents.find((e) => e.signalDate === o.signalDate && e.kind === o.decision);
        if (ev) {
          ev.execDate = dates[k];
          r.events.push(ev);
          r.pendingEvents = r.pendingEvents.filter((e) => e !== ev);
        }
        continue;
      }
      // Cycle bookkeeping for TQQQ sleeve P/L.
      for (const tr of r.trades.slice(before)) {
        if (tr.symbol !== 'TQQQ') continue;
        let c = openCycle(r);
        if (!c && tr.side === 'BUY') {
          c = { entrySignal: tr.signalDate ?? tr.date, entryDate: tr.date, addDate: null, trims: 0, exitSignal: null, exitDate: null, invested: 0, returned: 0, returnPct: null, open: true };
          r.cycles.push(c);
        }
        if (!c) continue;
        if (tr.side === 'BUY') {
          c.invested += tr.value + tr.fee;
          if (tr.kind === 'ADD') c.addDate = tr.date;
        } else {
          c.returned += tr.value - tr.fee;
          if (tr.kind === 'TRIM') c.trims++;
          if (r.acct.t === 0) {
            c.exitSignal = tr.signalDate;
            c.exitDate = tr.date;
            c.open = false;
            c.returnPct = c.invested > 0 ? (c.returned / c.invested - 1) * 100 : null;
          }
        }
      }
      if (o.op === 'tqqq_to_pct' && r.def.kind === 'ROTATION') r.invested = true;
      if (o.op === 'tqqq_sell_all' && r.def.kind === 'ROTATION') r.invested = false;
    }
    for (const o of monthlyOrders) monthly(r, k, o.signalDate, f);
  };

  const decide = (r: ModelRun, k: number, E: number) => {
    const d = dates[k];
    const a = r.acct;
    const qi = qIdx.get(d) as number;
    if (r.def.kind === 'ROTATION' && r.trend) {
      const inTrend = r.trend(qi) === true;
      if (inTrend && !r.invested) {
        r.pending.push({ op: 'tqqq_to_pct', pct: r.sleeve, kind: 'ENTRY', signalDate: d });
        r.pendingEvents.push({ kind: 'ENTRY', signalDate: d, execDate: null, reason: 'Trend rule turned on' });
        r.pending.push({ op: 'mark', decision: 'ENTRY', signalIdx: qi, signalDate: d });
      }
      if (!inTrend && r.invested) {
        r.pending.push({ op: 'tqqq_sell_all', kind: 'EXIT', signalDate: d });
        r.pendingEvents.push({ kind: 'EXIT', signalDate: d, execDate: null, reason: 'Trend rule turned off' });
        r.pending.push({ op: 'mark', decision: 'EXIT', signalIdx: qi, signalDate: d });
      }
    }
    if (r.def.kind === 'CLAUDE_V2') {
      const p = r.params as StrategyParams;
      const w = E > 0 ? (a.t * tBar(k).c) / E : null;
      const decs: Decision[] = decideAtClose(r.cycle, r.points as Point[], qi, p, w);
      for (const dec of decs) {
        r.pendingEvents.push({ kind: dec.kind, signalDate: d, execDate: null, reason: dec.reason });
        if (dec.kind === 'ENTRY') r.pending.push({ op: 'tqqq_to_pct', pct: p.firstAllocPct, kind: 'INITIAL', signalDate: d });
        else if (dec.kind === 'ADD') r.pending.push({ op: 'tqqq_to_pct', pct: p.targetAllocPct, kind: 'ADD', signalDate: d });
        else if (dec.kind === 'TRIM') r.pending.push({ op: 'tqqq_trim_to_pct', pct: p.targetAllocPct, kind: 'TRIM', signalDate: d });
        else if (dec.kind === 'EXIT') r.pending.push({ op: 'tqqq_sell_all', kind: 'EXIT', signalDate: d });
        r.pending.push({ op: 'mark', decision: dec.kind, signalIdx: qi, signalDate: d });
      }
    }
    if (lastSessionOfMonth(d)) r.pending.push({ op: 'monthly', signalDate: d });
  };

  for (let k = 0; k < N; k++) {
    const d = dates[k];
    const qb = qBar(k), tb = tBar(k);
    for (const r of runs) {
      const a = r.acct;
      if (k === 0) {
        // Opening allocation at the first session's open.
        switch (r.def.kind) {
          case 'QQQ100': rebalanceTo(r, 0, 1, undefined, 'START', null, 'o'); break;
          case 'MONTHLY': rebalanceTo(r, 0, (100 - r.sleeve) / 100, r.sleeve / 100, 'START', null, 'o'); break;
          case 'QQQ_TQQQ_BH': rebalanceTo(r, 0, 0.95, 0.05, 'START', null, 'o'); break;
          case 'ROTATION': rebalanceTo(r, 0, (100 - r.sleeve) / 100, undefined, 'START', null, 'o'); break;
          default: rebalanceTo(r, 0, 0.95, undefined, 'START', null, 'o');
        }
      } else {
        const prev = dates[k - 1];
        if (cfg.cashRatePct > 0 && a.cash > 0) a.cash *= Math.pow(1 + cfg.cashRatePct / 100, daysBetween(prev, d) / 365);
        if (cfg.useDividends) a.cash += a.q * divBetween('QQQ', prev, d) + a.t * divBetween('TQQQ', prev, d);
        if (mode === 'next_open') execute(r, k, 'o');
      }
      let E = a.q * qb.c + a.t * tb.c + a.cash;
      if (mode === 'same_close') {
        // Reconciliation aid: decide and trade at the same close (uses that close twice).
        decide(r, k, E);
        execute(r, k, 'c');
        E = a.q * qb.c + a.t * tb.c + a.cash;
        r.equity.push(E);
        r.weights.push(E > 0 ? (a.t * tb.c) / E : 0);
        if (a.t > 0) r.investedDays++;
        continue;
      }
      r.equity.push(E);
      r.weights.push(E > 0 ? (a.t * tb.c) / E : 0);
      if (a.t > 0) r.investedDays++;
      // Decisions at this close, for the next open (at the final close they stay pending).
      decide(r, k, E);
    }
  }

  // ---- metrics
  const years = daysBetween(dates[0], dates[N - 1]) / 365.25;
  const rfDaily = Math.pow(1 + cfg.cashRatePct / 100, 1 / 252) - 1;
  const lastDate = dates[N - 1];
  const models: ModelResult[] = runs.map((r) => {
    const eq = r.equity;
    const final = eq[N - 1];
    let peak = eq[0], peakD = dates[0], maxDD = 0, ddPeak = dates[0], ddTrough = dates[0];
    for (let k = 0; k < N; k++) {
      if (eq[k] > peak) { peak = eq[k]; peakD = dates[k]; }
      const dd = eq[k] / peak - 1;
      if (dd < maxDD) { maxDD = dd; ddPeak = peakD; ddTrough = dates[k]; }
    }
    const rets: number[] = [];
    for (let k = 1; k < N; k++) rets.push(eq[k] / eq[k - 1] - 1);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const downside = Math.sqrt(rets.reduce((s, x) => s + Math.min(0, x - rfDaily) ** 2, 0) / Math.max(1, rets.length));
    const yrs: YearRet[] = [];
    let startE = cfg.initialCapital;
    for (let k = 0; k < N; k++) {
      const y = Number(dates[k].slice(0, 4));
      const lastOfYear = k === N - 1 || dates[k + 1].slice(0, 4) !== dates[k].slice(0, 4);
      if (lastOfYear) {
        const firstYear = y === Number(dates[0].slice(0, 4));
        yrs.push({ year: y, ret: (eq[k] / startE - 1) * 100, partial: (firstYear && dates[0].slice(5) > '01-05') || (k === N - 1 && dates[k].slice(5) < '12-24') });
        startE = eq[k];
      }
    }
    const full = yrs.filter((y) => !y.partial);
    const pool = full.length ? full : yrs;
    const worstYear = pool.length ? pool.reduce((w, y) => (y.ret < w.ret ? y : w)) : null;
    const tqqqTrades = r.trades.filter((t) => t.symbol === 'TQQQ').length;
    for (const c of r.cycles) if (c.open) {
      const lastT = tBar(N - 1).c;
      c.returnPct = c.invested > 0 ? ((c.returned + r.acct.t * lastT) / c.invested - 1) * 100 : null;
    }
    const cagr = years > 0 ? (Math.pow(final / cfg.initialCapital, 1 / years) - 1) * 100 : 0;
    const spec = specOf(r.def.id);
    return {
      id: r.def.id,
      kind: r.def.kind,
      name: r.def.name || spec.name,
      short: r.def.short || spec.short,
      reference: !!(r.def.reference ?? spec.reference),
      equity: eq,
      weights: r.weights,
      final,
      totalReturn: (final / cfg.initialCapital - 1) * 100,
      cagr,
      maxDD: maxDD * 100,
      maxDDPeak: ddPeak,
      maxDDTrough: ddTrough,
      vol: sd * Math.sqrt(252) * 100,
      sharpe: sd > 0 ? ((mean - rfDaily) / sd) * Math.sqrt(252) : null,
      sortino: downside > 0 ? ((mean - rfDaily) / downside) * Math.sqrt(252) : null,
      calmar: maxDD < 0 ? cagr / Math.abs(maxDD * 100) : null,
      worstYear,
      trades: r.trades,
      tqqqTrades,
      tradesPerYear: years > 0 ? tqqqTrades / years : 0,
      totalCosts: r.trades.reduce((s, t) => s + t.fee, 0),
      investedDays: r.investedDays,
      investedPct: (r.investedDays / N) * 100,
      avgWeight: (r.weights.reduce((s, w) => s + w, 0) / N) * 100,
      maxWeight: Math.max(...r.weights) * 100,
      cycles: r.cycles,
      completedCycles: r.cycles.filter((c) => !c.open).length,
      years: yrs,
      events: r.events,
      pending: [...r.pendingEvents],
      state: {
        qqqShares: r.acct.q,
        tqqqShares: r.acct.t,
        cash: r.acct.cash,
        tqqqWeight: r.weights[N - 1],
        invested: r.def.kind === 'ROTATION' ? r.invested : r.acct.t > 0,
        claude: r.def.kind === 'CLAUDE_V2' ? { active: r.cycle.active, firstExecDate: r.cycle.firstExecIdx >= 0 ? qqqBars[r.cycle.firstExecIdx].d : null, secondDone: r.cycle.secondDone } : null,
        monthlyDue: mode === 'next_open' && lastSessionOfMonth(lastDate),
      },
    };
  });

  let h = '';
  for (const m of models) h += m.equity.map((x) => x.toFixed(6)).join(',') + '|' + m.trades.length + ';';
  const resultFingerprint = hashString(h) + hashString(h.split('').reverse().join(''));
  return {
    config: cfg,
    dates,
    models,
    skipped,
    dataFingerprint: fingerprint(qqqBars) + '-' + fingerprint(tqqqBars),
    resultFingerprint,
    notes,
    dividendsUsed,
  };
}

export function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A model's simulated transactions as CSV (one row per executed trade). */
export function tradesCsv(m: ModelResult): string {
  const rows = ['date,signal_close,symbol,side,kind,shares,price,value,fee,post_trade_tqqq_weight'];
  for (const t of m.trades) {
    rows.push([t.date, t.signalDate ?? '', t.symbol, t.side, t.kind, t.shares.toFixed(8), t.price.toFixed(6), t.value.toFixed(4), t.fee.toFixed(4), t.postWeight === undefined ? '' : t.postWeight.toFixed(6)].join(','));
  }
  return rows.join('\n') + '\n';
}

/** Daily equity of every model as CSV. */
export function equityCsv(r: BacktestResult): string {
  const rows = ['date,' + r.models.map((m) => m.id).join(',')];
  r.dates.forEach((d, k) => rows.push(d + ',' + r.models.map((m) => m.equity[k].toFixed(4)).join(',')));
  return rows.join('\n') + '\n';
}

/**
 * Reconciliation aid only: a TQQQ series rebuilt as 3× QQQ's daily return less a daily expense
 * charge, starting from the real TQQQ close on `from`. Real TQQQ also pays swap financing and
 * tracking costs, so this usually flatters it.
 */
export function syntheticTqqq(qqq: Bar[], from: string, startClose: number, expensePct = 0.84): Bar[] {
  const out: Bar[] = [];
  const daily = expensePct / 100 / 252;
  let prevQ: Bar | null = null;
  let prevC = startClose;
  for (const b of qqq) {
    if (b.d < from) { prevQ = b; continue; }
    if (!prevQ || b.d === from) {
      out.push({ d: b.d, o: startClose, h: startClose, l: startClose, c: startClose, v: null });
      prevQ = b;
      prevC = startClose;
      continue;
    }
    const o = prevC * (1 + 3 * (b.o / prevQ.c - 1));
    const c = prevC * (1 + 3 * (b.c / prevQ.c - 1) - daily);
    const hi = prevC * (1 + 3 * (b.h / prevQ.c - 1));
    const lo = prevC * (1 + 3 * (b.l / prevQ.c - 1));
    out.push({ d: b.d, o, h: Math.max(o, c, hi), l: Math.max(1e-9, Math.min(o, c, lo)), c, v: null });
    prevQ = b;
    prevC = c;
  }
  return out;
}

export interface LookaheadReport {
  checked: number;
  passed: boolean;
  failures: string[];
}

/**
 * No-look-ahead validation: re-run the simulation on data truncated at several dates and require
 * every equity value, trade and signal up to each cut to be identical to the full run.
 */
export function lookaheadCheck(
  qqqBars: Bar[],
  tqqqBars: Bar[],
  dividends: { QQQ: Dividend[]; TQQQ: Dividend[] },
  cfg: BacktestConfig,
  full: BacktestResult,
  cuts = 8,
): LookaheadReport {
  const failures: string[] = [];
  const N = full.dates.length;
  if (N < 60) return { checked: 0, passed: true, failures };
  let checked = 0;
  for (let j = 1; j <= cuts; j++) {
    const k = Math.floor((N - 1) * (j / (cuts + 1)));
    const cut = full.dates[k];
    const part = simulate(qqqBars.filter((b) => b.d <= cut), tqqqBars.filter((b) => b.d <= cut), {
      QQQ: dividends.QQQ.filter((d) => d.exDate <= cut),
      TQQQ: dividends.TQQQ.filter((d) => d.exDate <= cut),
    }, { ...cfg, end: cut });
    checked++;
    for (const m of full.models) {
      const pm = part.models.find((x) => x.id === m.id);
      if (!pm) { failures.push(`${m.short}: missing in truncated run at ${cut}`); continue; }
      for (let i = 0; i <= k; i++) {
        if (Math.abs(pm.equity[i] - m.equity[i]) > 1e-9 * Math.max(1, m.equity[i])) {
          failures.push(`${m.short}: equity differs on ${full.dates[i]} when data ends ${cut}`);
          break;
        }
      }
      const a = m.trades.filter((t) => t.date <= cut).map((t) => `${t.date}${t.side}${t.symbol}${t.shares.toFixed(8)}`).join();
      const b = pm.trades.map((t) => `${t.date}${t.side}${t.symbol}${t.shares.toFixed(8)}`).join();
      if (a !== b) failures.push(`${m.short}: trades differ when data ends ${cut}`);
      const ea = m.events.concat(m.pending).filter((e) => e.signalDate <= cut).map((e) => e.kind + e.signalDate).sort().join();
      const eb = pm.events.concat(pm.pending).map((e) => e.kind + e.signalDate).sort().join();
      if (ea !== eb) failures.push(`${m.short}: signals differ when data ends ${cut}`);
    }
  }
  return { checked, passed: failures.length === 0, failures: failures.slice(0, 8) };
}
