// Strategy research: parameter sensitivity, regime periods, walk-forward selection and methodology
// sensitivity. Everything here is computed from the same validated candles and the same engine as
// the backtest page. Nothing here changes the default strategies or picks a "best" parameter set.
import type { Bar, Dividend } from './data.ts';
import type { BacktestConfig, BacktestResult, ModelDef, ModelResult } from './backtest.ts';
import { simulate, specOf, standardModels, syntheticTqqq } from './backtest.ts';
import { prevTradingDay } from './time.ts';

export const SMA_PAIRS: [number, number][] = [[40, 180], [50, 180], [50, 200], [50, 250], [100, 200]];
export const DEFAULT_PAIR: [number, number] = [50, 200];

export const pairId = (f: number, s: number) => `CROSS_${f}_${s}`;

export interface MetricRow {
  id: string;
  label: string;
  isDefault: boolean;
  final: number;
  cagr: number;
  totalReturn: number;
  maxDD: number;
  vol: number;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  worstYear: number | null;
  completedCycles: number;
  investedPct: number;
  tqqqTrades: number;
}

function row(m: ModelResult, label: string, isDefault: boolean): MetricRow {
  return {
    id: m.id, label, isDefault, final: m.final, cagr: m.cagr, totalReturn: m.totalReturn, maxDD: m.maxDD, vol: m.vol, sharpe: m.sharpe,
    sortino: m.sortino, calmar: m.calmar, worstYear: m.worstYear ? m.worstYear.ret : null, completedCycles: m.completedCycles,
    investedPct: m.investedPct, tqqqTrades: m.tqqqTrades,
  };
}

function refModels(cfg: BacktestConfig): ModelDef[] {
  return standardModels({ ...cfg, modified: null, crossModified: null, monthlyModified: null }).filter((m) => ['QQQ100', 'QQQ_TQQQ_M', 'SMA200_ROT', 'CLAUDE_V2'].includes(m.id));
}

// ---------- 1. parameter sensitivity

export interface Sensitivity {
  run: BacktestResult;
  pairs: MetricRow[];
  references: MetricRow[];
  cagrRange: [number, number];
  ddRange: [number, number];
  sharpeRange: [number, number];
  defaultRank: number; // by CAGR, 1 = highest (for description only; nothing is selected by it)
  summary: string;
}

/** Runs every candidate SMA pair and the reference models in one simulation, so all share one window. */
export function sensitivity(q: Bar[], t: Bar[], div: { QQQ: Dividend[]; TQQQ: Dividend[] }, cfg: BacktestConfig, pairs = SMA_PAIRS): Sensitivity {
  const models: ModelDef[] = [
    ...refModels(cfg),
    ...pairs.map(([f, s]): ModelDef => ({
      id: pairId(f, s), kind: 'ROTATION', name: `SMA${f}/SMA${s} rotation`, short: `SMA${f}/${s}`, description: `5% TQQQ sleeve while SMA${f} > SMA${s}.`,
      rule: { type: 'sma_cross', fast: f, slow: s }, sleevePct: 5,
    })),
  ];
  const run = simulate(q, t, div, { ...cfg, models });
  const byId = new Map(run.models.map((m) => [m.id, m]));
  const pr = pairs.map(([f, s]) => row(byId.get(pairId(f, s)) as ModelResult, `SMA${f}/SMA${s}`, f === DEFAULT_PAIR[0] && s === DEFAULT_PAIR[1]));
  const references = refModels(cfg).map((m) => row(byId.get(m.id) as ModelResult, specOf(m.id).short, false));
  const range = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
  const cagrRange = range(pr.map((r) => r.cagr));
  const ddRange = range(pr.map((r) => r.maxDD));
  const sharpeRange = range(pr.map((r) => r.sharpe ?? 0));
  const sorted = [...pr].sort((a, b) => b.cagr - a.cagr);
  const defaultRank = sorted.findIndex((r) => r.isDefault) + 1;
  const spread = cagrRange[1] - cagrRange[0];
  const consistent = spread <= 1 && ddRange[1] - ddRange[0] <= 5;
  const summary = `Across the ${pr.length} pairs, CAGR runs from ${cagrRange[0].toFixed(2)}% to ${cagrRange[1].toFixed(2)}% (a ${spread.toFixed(2)}-point spread) and maximum drawdown from ${ddRange[0].toFixed(1)}% to ${ddRange[1].toFixed(1)}%. `
    + (consistent
      ? 'Results are broadly consistent across nearby settings, so the default does not depend on one narrowly optimised pair.'
      : 'Results move noticeably between nearby settings, so any single pair’s historical figures should be read with caution.')
    + ` The default SMA50/SMA200 ranks ${defaultRank} of ${pr.length} by CAGR in this window; the ranking is descriptive and the default is not changed by it.`;
  return { run, pairs: pr, references, cagrRange, ddRange, sharpeRange, defaultRank, summary };
}

// ---------- 2. historical periods

export interface Period {
  id: string;
  label: string;
  start: string; // first session in the period; returns are measured from the prior close
  end: string;
  note: string;
}

export const PERIODS: Period[] = [
  { id: 'p1', label: '2010–2018', start: '2010-01-01', end: '2018-12-31', note: 'From TQQQ’s first sessions through the late-2018 selloff.' },
  { id: 'p2', label: '2019–2026', start: '2019-01-01', end: '2026-12-31', note: 'From January 2019 to the latest completed close.' },
  { id: 'p3', label: '2020 pandemic selloff', start: '2020-02-20', end: '2020-06-30', note: 'From the 19 Feb 2020 close through the crash and the rebound to the end of June.' },
  { id: 'p4', label: '2022 bear market', start: '2022-01-03', end: '2022-12-30', note: 'Calendar 2022.' },
  { id: 'p5', label: 'April 2025 volatility', start: '2025-03-03', end: '2025-06-30', note: 'March to June 2025, covering the early-April tariff selloff and recovery.' },
];

export interface PeriodCell {
  ret: number; // %
  maxDD: number; // % within the period
  startWeight: number; // TQQQ % at the prior close
  maxWeight: number;
  trades: number; // TQQQ trades executed in the period
}

export interface PeriodRow {
  period: Period;
  from: string; // base close (or the first session when the period starts with the backtest)
  to: string;
  covered: boolean;
  cells: Record<string, PeriodCell>;
}

/**
 * Period results are read from one continuous full-window run, so every strategy enters each period
 * in the state its rules had actually reached, rather than starting fresh in cash.
 */
export function periodTable(run: BacktestResult, periods = PERIODS): PeriodRow[] {
  const dates = run.dates;
  return periods.map((p) => {
    const i0 = dates.findIndex((d) => d >= p.start);
    let i1 = -1;
    for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= p.end) { i1 = i; break; }
    const covered = i0 >= 0 && i1 >= i0;
    const cells: Record<string, PeriodCell> = {};
    if (covered) {
      // The base is the prior close; a period that begins with the backtest starts from the capital.
      const cap = run.config.initialCapital;
      for (const m of run.models) {
        const baseEq = i0 > 0 ? m.equity[i0 - 1] : cap;
        let peak = baseEq, dd = 0, maxW = i0 > 0 ? m.weights[i0 - 1] : 0;
        for (let k = i0; k <= i1; k++) {
          peak = Math.max(peak, m.equity[k]);
          dd = Math.min(dd, m.equity[k] / peak - 1);
          maxW = Math.max(maxW, m.weights[k]);
        }
        cells[m.id] = {
          ret: (m.equity[i1] / baseEq - 1) * 100,
          maxDD: dd * 100,
          startWeight: i0 > 0 ? m.weights[i0 - 1] * 100 : 0,
          maxWeight: maxW * 100,
          trades: m.trades.filter((x) => x.symbol === 'TQQQ' && x.date >= dates[i0] && x.date <= dates[i1]).length,
        };
      }
    }
    return { period: p, from: covered ? (i0 > 0 ? dates[i0 - 1] : dates[0]) : '', to: covered ? dates[i1] : '', covered, cells };
  });
}

// ---------- 3. walk-forward

export interface WalkStep {
  testYear: number;
  trainFrom: string;
  trainTo: string;
  scores: { id: string; label: string; sharpe: number | null }[];
  chosen: string;
  chosenLabel: string;
  chosenRet: number;
  defaultRet: number;
  refRets: Record<string, number>;
}

export interface WalkForward {
  criterion: string;
  minTrainYears: number;
  steps: WalkStep[];
  chosenCagr: number | null;
  defaultCagr: number | null;
  refCagr: Record<string, number | null>;
  testFrom: string | null;
  testTo: string | null;
  label: string;
}

function sharpeOf(eq: number[], from: number, to: number, rfDaily: number): number | null {
  const r: number[] = [];
  for (let k = from + 1; k <= to; k++) r.push(eq[k] / eq[k - 1] - 1);
  if (r.length < 60) return null;
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1));
  return sd > 0 ? ((mean - rfDaily) / sd) * Math.sqrt(252) : null;
}

/**
 * Each calendar year is tested with the SMA pair that had the best Sharpe ratio over all earlier
 * years (expanding window). The criterion is fixed in advance and the test year is never seen when
 * choosing. The candidate list itself was written knowing the whole history, so the result is
 * labelled partly out-of-sample.
 */
export function walkForward(s: Sensitivity, cashRatePct: number, minTrainYears = 3, pairs = SMA_PAIRS): WalkForward {
  const run = s.run;
  const dates = run.dates;
  const byId = new Map(run.models.map((m) => [m.id, m]));
  const rfDaily = Math.pow(1 + cashRatePct / 100, 1 / 252) - 1;
  const yearEnd = new Map<number, number>(); // year → index of its last session
  dates.forEach((d, i) => yearEnd.set(Number(d.slice(0, 4)), i));
  const years = [...yearEnd.keys()].sort((a, b) => a - b);
  const first = years[0];
  const steps: WalkStep[] = [];
  const refIds = ['QQQ100', 'QQQ_TQQQ_M', 'CLAUDE_V2'];
  for (const y of years) {
    if (y - first < minTrainYears) continue;
    const trainEnd = yearEnd.get(y - 1);
    const testEnd = yearEnd.get(y);
    if (trainEnd === undefined || testEnd === undefined) continue;
    const scores = pairs.map(([f, sl]) => {
      const m = byId.get(pairId(f, sl)) as ModelResult;
      return { id: m.id, label: `SMA${f}/SMA${sl}`, sharpe: sharpeOf(m.equity, 0, trainEnd, rfDaily) };
    });
    const valid = scores.filter((x) => x.sharpe !== null);
    if (!valid.length) continue;
    // Ties go to the earlier pair in the fixed list, never to the higher test result.
    const best = valid.reduce((a, b) => ((b.sharpe as number) > (a.sharpe as number) + 1e-12 ? b : a));
    const ret = (id: string) => {
      const m = byId.get(id) as ModelResult;
      return (m.equity[testEnd] / m.equity[trainEnd] - 1) * 100;
    };
    steps.push({
      testYear: y, trainFrom: dates[0], trainTo: dates[trainEnd], scores, chosen: best.id, chosenLabel: best.label,
      chosenRet: ret(best.id), defaultRet: ret(pairId(...DEFAULT_PAIR)), refRets: Object.fromEntries(refIds.map((id) => [id, ret(id)])),
    });
  }
  const cagr = (rets: number[]) => {
    if (!steps.length) return null;
    const g = rets.reduce((p, r) => p * (1 + r / 100), 1);
    const from = yearEnd.get(steps[0].testYear - 1) as number;
    const to = yearEnd.get(steps[steps.length - 1].testYear) as number;
    const yrs = (Date.parse(dates[to]) - Date.parse(dates[from])) / (365.25 * 86400000);
    return yrs > 0 ? (Math.pow(g, 1 / yrs) - 1) * 100 : null;
  };
  return {
    criterion: 'Highest Sharpe ratio over all earlier years (expanding window), decided before each test year',
    minTrainYears,
    steps,
    chosenCagr: cagr(steps.map((x) => x.chosenRet)),
    defaultCagr: cagr(steps.map((x) => x.defaultRet)),
    refCagr: Object.fromEntries(refIds.map((id) => [id, cagr(steps.map((x) => x.refRets[id]))])),
    testFrom: steps.length ? dates[yearEnd.get(steps[0].testYear - 1) as number] : null,
    testTo: steps.length ? dates[yearEnd.get(steps[steps.length - 1].testYear) as number] : null,
    label: 'Partly out-of-sample: each choice uses only earlier data, but the five candidate pairs were chosen with today’s knowledge.',
  };
}

// ---------- 4. methodology sensitivity (reconciling with other backtests)

export interface MethodVariant {
  id: string;
  label: string;
  explain: string;
}

export const METHOD_VARIANTS: MethodVariant[] = [
  { id: 'default', label: 'Methodology default', explain: 'Next-session open execution, actual TQQQ, costs as set, dividends as set.' },
  { id: 'same_close', label: 'Trade at the signal close', explain: 'Executes at the same close that produced the signal. Not achievable in practice; many quick scripts do this.' },
  { id: 'no_costs', label: 'No transaction costs', explain: 'Costs set to zero.' },
  { id: 'dividends_off', label: 'Price return only', explain: 'Dividends not credited.' },
  { id: 'dividends_on', label: 'Dividends credited', explain: 'Dividends credited as cash on ex-dates (where Twelve Data has the history).' },
  { id: 'synthetic', label: 'Synthetic 3× QQQ instead of TQQQ', explain: 'TQQQ replaced by 3× QQQ’s daily return less 0.84% a year. Ignores TQQQ’s swap financing and tracking costs.' },
  { id: 'short_warmup', label: 'QQQ history only from 2010', explain: 'SMA200 computed from QQQ data starting with TQQQ’s first session, so signals start about ten months later.' },
  { id: 'start_2011', label: 'Start on 3 Jan 2011', explain: 'Calendar-year start instead of TQQQ’s first session.' },
];

export interface MethodRow {
  variant: MethodVariant;
  start: string;
  end: string;
  cells: Record<string, { cagr: number; maxDD: number; final: number; cagr252: number }>;
}

export const METHOD_MODELS = ['QQQ100', 'QQQ_TQQQ_M', 'SMA200_ROT', 'CLAUDE_V2', 'SMA_CROSS'];

export function methodology(q: Bar[], t: Bar[], div: { QQQ: Dividend[]; TQQQ: Dividend[] }, cfg: BacktestConfig): MethodRow[] {
  const base: BacktestConfig = { ...cfg, modified: null, crossModified: null, monthlyModified: null, models: undefined };
  const out: MethodRow[] = [];
  for (const v of METHOD_VARIANTS) {
    let qq = q, tt = t, c: BacktestConfig = { ...base };
    if (v.id === 'same_close') c.execution = 'same_close';
    if (v.id === 'no_costs') { c.feeBps = 0; c.feeFixed = 0; }
    if (v.id === 'dividends_off') { if (!cfg.useDividends) continue; c.useDividends = false; }
    if (v.id === 'dividends_on') { if (cfg.useDividends || !(div.QQQ.length || div.TQQQ.length)) continue; c.useDividends = true; }
    if (v.id === 'synthetic') tt = syntheticTqqq(q, t[0].d, t[0].c);
    if (v.id === 'short_warmup') qq = q.filter((b) => b.d >= t[0].d);
    if (v.id === 'start_2011') c.start = cfg.start > '2011-01-03' ? cfg.start : '2011-01-03';
    const r = simulate(qq, tt, div, c);
    if (!r.models.length) continue;
    const N = r.dates.length;
    const cells: MethodRow['cells'] = {};
    for (const m of r.models) {
      if (!METHOD_MODELS.includes(m.id)) continue;
      cells[m.id] = { cagr: m.cagr, maxDD: m.maxDD, final: m.final, cagr252: (Math.pow(m.final / cfg.initialCapital, 252 / (N - 1)) - 1) * 100 };
    }
    out.push({ variant: v, start: r.dates[0], end: r.dates[N - 1], cells });
  }
  return out;
}

/** The session before `date`, for labelling period bases. */
export function priorSession(date: string): string {
  return prevTradingDay(date);
}
