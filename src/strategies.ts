// Strategy B (QQQ SMA50/SMA200 trend rotation) and Strategy C (monthly rebalanced TQQQ), evaluated
// live from completed Daily candles, plus the vocabulary shared by all three strategies. Strategy A
// (Claude V2) stays in strategy.ts unchanged. Each strategy is evaluated only against its own
// sleeve of recorded holdings, so a signal in one never activates another.
import type { Bar, SeriesStatus } from './data.ts';
import type { CheckItem, LiveEvaluation, StrategyAction, StrategyParams } from './strategy.ts';
import { smaSeries } from './strategy.ts';
import { fmtDate, monthEndAfter, monthEndOnOrBefore, nextTradingDay } from './time.ts';

export type StrategyId = 'CLAUDE_V2' | 'SMA_CROSS' | 'MONTHLY';
export const STRATEGY_IDS: StrategyId[] = ['CLAUDE_V2', 'SMA_CROSS', 'MONTHLY'];

export interface StrategyMeta {
  letter: 'A' | 'B' | 'C';
  name: string;
  short: string;
  summary: string;
  modelId: string; // backtest model id for the default parameters
}

export const STRATEGY_META: Record<StrategyId, StrategyMeta> = {
  CLAUDE_V2: {
    letter: 'A', name: 'Claude V2 recovery', short: 'Claude V2', modelId: 'CLAUDE_V2',
    summary: 'Buys 2.5% after two closes ≥ 2% above SMA200, adds to 5% after 20 sessions and two new qualifying closes, exits all on a close ≤ 3% below SMA200, trims above 6%.',
  },
  SMA_CROSS: {
    letter: 'B', name: 'SMA50/SMA200 rotation', short: 'SMA50/SMA200', modelId: 'SMA_CROSS',
    summary: 'Holds a 5% TQQQ sleeve while QQQ’s SMA50 is strictly above its SMA200, rebalanced monthly; the whole sleeve goes to cash when SMA50 is at or below SMA200.',
  },
  MONTHLY: {
    letter: 'C', name: 'Monthly rebalanced 95/5', short: 'Monthly 95/5', modelId: 'QQQ_TQQQ_M',
    summary: 'Keeps TQQQ at 5% (QQQ 95%) by rebalancing at the open after each month-end close. No trend signals, no tactical exits, no margin.',
  },
};

export function isStrategyId(x: unknown): x is StrategyId {
  return x === 'CLAUDE_V2' || x === 'SMA_CROSS' || x === 'MONTHLY';
}

// ---------- parameters

export interface CrossParams {
  fast: number; // sessions
  slow: number;
  targetPct: number; // TQQQ sleeve, % of equity
}
export const SMA_CROSS_BASELINE: Readonly<CrossParams> = Object.freeze({ fast: 50, slow: 200, targetPct: 5 });

export interface MonthlyParams {
  targetPct: number;
}
export const MONTHLY_BASELINE: Readonly<MonthlyParams> = Object.freeze({ targetPct: 5 });

export function isCrossBaseline(p: CrossParams): boolean {
  return p.fast === SMA_CROSS_BASELINE.fast && p.slow === SMA_CROSS_BASELINE.slow && p.targetPct === SMA_CROSS_BASELINE.targetPct;
}
export function isMonthlyBaseline(p: MonthlyParams): boolean {
  return p.targetPct === MONTHLY_BASELINE.targetPct;
}

export function validateCross(p: CrossParams): string[] {
  const e: string[] = [];
  const int = (x: number) => Number.isInteger(x);
  if (!(int(p.fast) && p.fast >= 5 && p.fast <= 200)) e.push('Fast moving average must be 5 to 200 sessions.');
  if (!(int(p.slow) && p.slow >= 20 && p.slow <= 400)) e.push('Slow moving average must be 20 to 400 sessions.');
  if (int(p.fast) && int(p.slow) && p.fast >= p.slow) e.push('The fast average must be shorter than the slow one.');
  if (!(p.targetPct > 0 && p.targetPct <= 25)) e.push('Sleeve target must be above 0% and at most 25%.');
  return e;
}
export function validateMonthly(p: MonthlyParams): string[] {
  return p.targetPct > 0 && p.targetPct <= 25 ? [] : ['Monthly target must be above 0% and at most 25%.'];
}

// ---------- shared vocabulary

/** The eight actions every strategy card speaks. */
export type Action = 'BUY' | 'ADD' | 'HOLD' | 'TRIM' | 'EXIT' | 'REBALANCE' | 'WAIT' | 'DATA UNAVAILABLE';
export type Tone = 'bull' | 'hold' | 'wait' | 'risk' | 'na';

export const ACTION_TONE: Record<Action, Tone> = {
  BUY: 'bull', ADD: 'bull', HOLD: 'hold', TRIM: 'wait', EXIT: 'risk', REBALANCE: 'wait', WAIT: 'wait', 'DATA UNAVAILABLE': 'na',
};

/** Claude V2 keeps its original action names internally; this maps them onto the shared set. */
export function claudeAction(a: StrategyAction): Action {
  switch (a) {
    case 'BUY INITIAL': return 'BUY';
    case 'ADD POSITION': return 'ADD';
    case 'EXIT ALL': return 'EXIT';
    default: return a;
  }
}

/** What the rules recommend from market data alone, independent of what the user holds. */
export interface MarketSignal {
  label: string;
  tone: Tone;
  recommendedPct: number | null; // TQQQ % of equity the rules call for at the next session
  detail: string;
}

export interface SleevePosition {
  confirmed: boolean; // the user has saved holdings at least once
  followed: boolean; // the user runs this strategy with real money
  shares: number;
  lastTradeDate: string | null; // latest recorded transaction in this sleeve
  entryDate: string | null; // first purchase of the current holding period
}

// ---------- Strategy B: SMA crossover

export interface CrossPoint {
  d: string;
  c: number;
  fast: number | null;
  slow: number | null;
  bull: boolean | null; // fast strictly above slow; null until both exist
}

export function crossPoints(bars: Bar[], p: CrossParams): CrossPoint[] {
  const closes = bars.map((b) => b.c);
  const f = smaSeries(closes, p.fast);
  const s = smaSeries(closes, p.slow);
  return bars.map((b, i) => ({ d: b.d, c: b.c, fast: f[i], slow: s[i], bull: f[i] === null || s[i] === null ? null : (f[i] as number) > (s[i] as number) }));
}

export interface CrossEvent {
  kind: 'BULLISH_CROSS' | 'BEARISH_CROSS';
  signalDate: string; // the completed close where the regime changed
  execDate: string; // next session's open
}

/** Every change of regime in the history (the first defined close sets the starting regime, not an event). */
export function crossEvents(points: CrossPoint[]): CrossEvent[] {
  const out: CrossEvent[] = [];
  let prev: boolean | null = null;
  for (const pt of points) {
    if (pt.bull === null) continue;
    if (prev !== null && pt.bull !== prev) out.push({ kind: pt.bull ? 'BULLISH_CROSS' : 'BEARISH_CROSS', signalDate: pt.d, execDate: nextTradingDay(pt.d) });
    prev = pt.bull;
  }
  return out;
}

export interface MonthSchedule {
  signalDate: string; // latest month-end close on or before the last completed session
  execDate: string; // the open after it
  done: boolean; // a sleeve transaction was recorded on or after execDate
  overdue: boolean; // execDate has already traded without a recorded rebalance
  nextSignal: string; // next month-end close after the last completed session
  nextExec: string;
}

export function monthSchedule(lastCompleted: string, lastTradeDate: string | null): MonthSchedule {
  const signalDate = monthEndOnOrBefore(lastCompleted);
  const execDate = nextTradingDay(signalDate);
  const done = !!lastTradeDate && lastTradeDate >= execDate;
  const nextSignal = monthEndAfter(lastCompleted);
  return { signalDate, execDate, done, overdue: !done && lastCompleted >= execDate, nextSignal, nextExec: nextTradingDay(nextSignal) };
}

export type CrossStage = 'CASH' | 'CROSS_UP' | 'BUY' | 'HOLD' | 'CROSS_DOWN' | 'EXIT';

export interface CrossEvaluation {
  asOf: string | null;
  fast: number | null;
  slow: number | null;
  spreadPct: number | null; // (fast / slow - 1) * 100
  regime: 'BULLISH' | 'BEARISH' | 'DATA UNAVAILABLE';
  regimeSince: string | null; // close of the latest crossover (or of the first defined close)
  lastCross: CrossEvent | null;
  signal: MarketSignal;
  action: Action;
  headline: string;
  reasons: string[];
  checklist: CheckItem[];
  stage: CrossStage;
  schedule: MonthSchedule | null;
  rebalanceDue: boolean;
  fired: { type: string; session: string; text: string }[];
}

export interface CrossInput {
  bars: Bar[]; // validated completed QQQ candles
  dataStatus: SeriesStatus;
  dataIssues: string[];
  params: CrossParams;
  sleeve: SleevePosition;
  /** Sleeve weight of equity at the last confirmed close (null when unknown). */
  weightAtClose: number | null;
  /** Whole TQQQ shares a rebalance to target would trade now (null when it cannot be sized). */
  rebalanceShares: number | null;
}

const pct = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d) + '%');

export function evaluateCross(inp: CrossInput): CrossEvaluation {
  const p = inp.params;
  const pts = crossPoints(inp.bars, p);
  const last = pts.length ? pts[pts.length - 1] : null;
  const holding = inp.sleeve.shares > 0;
  const labels: [string, string][] = [
    ['b1', `SMA${p.fast} available`],
    ['b2', `SMA${p.slow} available`],
    ['b3', `SMA${p.fast} strictly above SMA${p.slow}`],
    ['b4', 'Active TQQQ sleeve status'],
    ['b5', 'Exit crossover status'],
    ['b6', 'Monthly allocation check'],
  ];
  const ev: CrossEvaluation = {
    asOf: last ? last.d : null, fast: last?.fast ?? null, slow: last?.slow ?? null, spreadPct: null, regime: 'DATA UNAVAILABLE',
    regimeSince: null, lastCross: null, signal: { label: 'DATA UNAVAILABLE', tone: 'na', recommendedPct: null, detail: 'No validated QQQ Daily candles.' },
    action: 'DATA UNAVAILABLE', headline: '', reasons: [], checklist: [], stage: 'CASH', schedule: null, rebalanceDue: false, fired: [],
  };
  const dataOk = inp.dataStatus === 'ok' && !!last;
  if (!dataOk || !last) {
    ev.checklist = labels.map(([id, label]) => ({ id, label, status: 'na', detail: 'Market data unavailable' }));
    ev.headline = inp.dataStatus === 'awaiting' ? 'Waiting for today’s Daily close' : 'Market data cannot be validated';
    ev.reasons = inp.dataIssues.length ? inp.dataIssues.slice(0, 3) : ['No validated QQQ Daily candles are available, so no signal is produced.'];
    return ev;
  }
  const fastOk = last.fast !== null, slowOk = last.slow !== null;
  ev.checklist.push({ id: 'b1', label: labels[0][1], status: fastOk ? 'pass' : 'na', detail: fastOk ? `${(last.fast as number).toFixed(2)} at the ${fmtDate(last.d)} close` : `Needs ${p.fast} completed closes` });
  ev.checklist.push({ id: 'b2', label: labels[1][1], status: slowOk ? 'pass' : 'na', detail: slowOk ? `${(last.slow as number).toFixed(2)} at the ${fmtDate(last.d)} close` : `Needs ${p.slow} completed closes` });
  if (last.bull === null) {
    ev.checklist.push(...labels.slice(2).map(([id, label]) => ({ id, label, status: 'na' as const, detail: 'Both averages are needed' })));
    ev.headline = 'Not enough history for both moving averages';
    ev.reasons = [`Needs at least ${p.slow} completed QQQ closes.`];
    return ev;
  }
  const bull = last.bull;
  const events = crossEvents(pts);
  ev.lastCross = events.length ? events[events.length - 1] : null;
  ev.regimeSince = ev.lastCross ? ev.lastCross.signalDate : pts.find((x) => x.bull !== null)?.d ?? null;
  ev.spreadPct = ((last.fast as number) / (last.slow as number) - 1) * 100;
  ev.regime = bull ? 'BULLISH' : 'BEARISH';
  const crossedToday = ev.lastCross?.signalDate === last.d;
  ev.signal = bull
    ? { label: crossedToday ? 'BULLISH CROSSOVER' : 'BULLISH TREND', tone: 'bull', recommendedPct: p.targetPct, detail: `SMA${p.fast} ${pct(ev.spreadPct)} vs SMA${p.slow}; ${p.targetPct}% TQQQ sleeve${crossedToday ? ' from the next open' : ` since the ${fmtDate(ev.regimeSince)} crossover`}.` }
    : { label: crossedToday ? 'BEARISH CROSSOVER' : 'BEARISH TREND', tone: 'risk', recommendedPct: 0, detail: `SMA${p.fast} ${pct(ev.spreadPct)} vs SMA${p.slow}; sleeve in cash${crossedToday ? ' from the next open' : ` since the ${fmtDate(ev.regimeSince)} crossover`}.` };
  if (crossedToday) ev.fired.push({ type: bull ? 'CROSS_BULLISH' : 'CROSS_BEARISH', session: last.d, text: `SMA${p.fast} crossed ${bull ? 'above' : 'at or below'} SMA${p.slow} at the ${fmtDate(last.d)} close` });

  const sched = monthSchedule(last.d, inp.sleeve.lastTradeDate);
  ev.schedule = sched;
  const w = inp.weightAtClose;
  const wPct = w === null ? null : w * 100;
  const due = holding && bull && !sched.done && (inp.sleeve.entryDate === null || inp.sleeve.entryDate < sched.execDate);
  ev.rebalanceDue = due;

  ev.checklist.push({
    id: 'b3', label: labels[2][1], status: bull ? 'pass' : 'fail',
    detail: `SMA${p.fast} ${(last.fast as number).toFixed(2)} vs SMA${p.slow} ${(last.slow as number).toFixed(2)} (${pct(ev.spreadPct)}); ${bull ? 'bullish' : 'bearish'} since ${fmtDate(ev.regimeSince)}`,
  });
  ev.checklist.push({
    id: 'b4', label: labels[3][1],
    status: !inp.sleeve.confirmed ? 'pending' : bull ? (holding ? 'pass' : 'pending') : holding ? 'fail' : 'pass',
    detail: !inp.sleeve.confirmed ? 'Confirm your holdings on the Portfolio page'
      : bull ? (holding ? `${inp.sleeve.shares} TQQQ shares in this sleeve${wPct !== null ? ` (${wPct.toFixed(2)}%)` : ''}` : `No TQQQ in this sleeve; buy to ${p.targetPct}% at the next open`)
      : holding ? `${inp.sleeve.shares} shares held while the trend is bearish` : 'Sleeve in cash, as the rule requires',
  });
  ev.checklist.push({
    id: 'b5', label: labels[4][1], status: bull ? 'pass' : 'fail',
    detail: bull ? `No exit: SMA${p.fast} is above SMA${p.slow}` : `Exit condition met since the ${fmtDate(ev.regimeSince)} close${holding ? '; sell the whole sleeve at the next open' : ''}`,
  });
  ev.checklist.push({
    id: 'b6', label: labels[5][1],
    status: !holding || !bull ? 'na' : due ? (inp.rebalanceShares === 0 ? 'pass' : 'pending') : 'pass',
    detail: !holding || !bull ? 'Only applies while the sleeve is held'
      : due ? (inp.rebalanceShares === null ? `Rebalance to ${p.targetPct}% at the ${fmtDate(sched.execDate)} open (month-end ${fmtDate(sched.signalDate)})` : inp.rebalanceShares === 0 ? `Within one share of ${p.targetPct}%; nothing to trade this month` : `Rebalance ${Math.abs(inp.rebalanceShares)} shares toward ${p.targetPct}% (month-end ${fmtDate(sched.signalDate)})`)
      : `${wPct !== null ? `Weight ${wPct.toFixed(2)}%; ` : ''}next check after the ${fmtDate(sched.nextSignal)} close`,
  });

  // ---- action: exit first, then entry, then the monthly reset
  if (!bull && holding) {
    ev.action = 'EXIT';
    ev.stage = 'EXIT';
    ev.headline = 'Sell the whole TQQQ sleeve at the next regular session';
    ev.reasons = [`QQQ SMA${p.fast} is at or below SMA${p.slow} (${pct(ev.spreadPct)}) since the ${fmtDate(ev.regimeSince)} close.`, 'The QQQ core is kept; the sleeve’s proceeds stay in cash.'];
  } else if (!bull) {
    ev.action = 'WAIT';
    ev.stage = 'CASH';
    ev.headline = 'Sleeve stays in cash';
    ev.reasons = [`SMA${p.fast} is ${pct(ev.spreadPct)} vs SMA${p.slow}. A buy needs SMA${p.fast} strictly above SMA${p.slow} at a completed close.`];
  } else if (!holding) {
    ev.action = 'BUY';
    ev.stage = crossedToday ? 'CROSS_UP' : 'BUY';
    ev.headline = `Buy TQQQ to ${p.targetPct}% of equity at the next session’s open`;
    ev.reasons = [`SMA${p.fast} is above SMA${p.slow} (${pct(ev.spreadPct)}) since the ${fmtDate(ev.regimeSince)} close and this sleeve holds no TQQQ.`];
    if (!crossedToday) ev.reasons.push('The crossover is not new; the rule holds the sleeve whenever the trend is bullish, so entering now follows the rule.');
    if (!inp.sleeve.confirmed) ev.reasons.push('Your holdings are not confirmed yet. Check the Portfolio page before acting.');
  } else if (due && inp.rebalanceShares !== 0) {
    ev.action = 'REBALANCE';
    ev.stage = 'HOLD';
    ev.headline = `Reset the sleeve to ${p.targetPct}% at the ${fmtDate(sched.execDate)} open`;
    ev.reasons = [`Month-end rebalance after the ${fmtDate(sched.signalDate)} close${wPct !== null ? `; the sleeve was ${wPct.toFixed(2)}% at the last close` : ''}.`];
    if (sched.overdue) ev.reasons.push(`The scheduled open (${fmtDate(sched.execDate)}) has passed without a recorded rebalance.`);
    ev.fired.push({ type: 'CROSS_REBALANCE_DUE', session: sched.signalDate, text: `SMA crossover sleeve: month-end rebalance due at the ${fmtDate(sched.execDate)} open` });
  } else {
    ev.action = 'HOLD';
    ev.stage = 'HOLD';
    ev.headline = 'Keep the TQQQ sleeve';
    ev.reasons = [`SMA${p.fast} remains above SMA${p.slow} (${pct(ev.spreadPct)}). Next monthly reset after the ${fmtDate(sched.nextSignal)} close.`];
  }
  return ev;
}

// ---------- Strategy C: monthly rebalanced

export interface MonthlyInput {
  lastCompleted: string | null; // last validated completed session (TQQQ)
  dataStatus: SeriesStatus;
  dataIssues: string[];
  params: MonthlyParams;
  sleeve: SleevePosition;
  weightAtClose: number | null;
  /** Signed whole TQQQ shares that bring the sleeve to target now (null when it cannot be sized). */
  rebalanceShares: number | null;
  rebalanceValueUsd: number | null;
  cashRequiredUsd: number | null; // purchase cost incl. fees (0 when selling)
  cashAvailableUsd: number | null;
}

export interface MonthlyEvaluation {
  asOf: string | null;
  weightPct: number | null;
  targetPct: number;
  driftPts: number | null;
  schedule: MonthSchedule | null;
  signal: MarketSignal;
  action: Action;
  headline: string;
  reasons: string[];
  checklist: CheckItem[];
  fired: { type: string; session: string; text: string }[];
}

export function evaluateMonthly(inp: MonthlyInput): MonthlyEvaluation {
  const p = inp.params;
  const labels: [string, string][] = [
    ['c1', 'TQQQ portfolio weight'], ['c2', `Target ${p.targetPct}% weight`], ['c3', 'Rebalance due date'],
    ['c4', 'Cash required'], ['c5', 'Cash available'], ['c6', 'Planned transaction amount'],
  ];
  const ev: MonthlyEvaluation = {
    asOf: inp.lastCompleted, weightPct: null, targetPct: p.targetPct, driftPts: null, schedule: null,
    signal: { label: 'DATA UNAVAILABLE', tone: 'na', recommendedPct: null, detail: 'No validated TQQQ Daily candles.' },
    action: 'DATA UNAVAILABLE', headline: '', reasons: [], checklist: [], fired: [],
  };
  if (inp.dataStatus !== 'ok' || !inp.lastCompleted) {
    ev.checklist = labels.map(([id, label]) => ({ id, label, status: 'na', detail: 'Market data unavailable' }));
    ev.headline = inp.dataStatus === 'awaiting' ? 'Waiting for today’s Daily close' : 'Market data cannot be validated';
    ev.reasons = inp.dataIssues.length ? inp.dataIssues.slice(0, 3) : ['No validated TQQQ Daily candles are available.'];
    return ev;
  }
  const holding = inp.sleeve.shares > 0;
  const sched = monthSchedule(inp.lastCompleted, inp.sleeve.lastTradeDate);
  ev.schedule = sched;
  const wPct = inp.weightAtClose === null ? null : inp.weightAtClose * 100;
  ev.weightPct = wPct;
  ev.driftPts = wPct === null ? null : wPct - p.targetPct;
  const atMonthEnd = sched.signalDate === inp.lastCompleted;
  ev.signal = atMonthEnd
    ? { label: 'REBALANCE DATE', tone: 'wait', recommendedPct: p.targetPct, detail: `Month-end close ${fmtDate(sched.signalDate)}: reset to ${p.targetPct}% at the ${fmtDate(sched.execDate)} open.` }
    : { label: 'DRIFT ALLOWED', tone: 'hold', recommendedPct: p.targetPct, detail: `Target ${p.targetPct}%; weights drift until the ${fmtDate(sched.nextSignal)} close.` };
  const due = !holding || (!sched.done && (inp.sleeve.entryDate === null || inp.sleeve.entryDate < sched.execDate));
  const sh = inp.rebalanceShares;
  const cashOk = inp.cashRequiredUsd === null || inp.cashAvailableUsd === null ? null : inp.cashAvailableUsd + 1e-9 >= inp.cashRequiredUsd;
  ev.checklist = [
    { id: 'c1', label: labels[0][1], status: wPct === null ? 'na' : 'pass', detail: wPct === null ? 'Enter total equity on the Portfolio page' : `${wPct.toFixed(2)}% at the ${fmtDate(inp.lastCompleted)} close` },
    { id: 'c2', label: labels[1][1], status: wPct === null || sh === null ? 'na' : sh === 0 ? 'pass' : 'pending', detail: wPct === null ? 'Weight unknown' : sh === 0 ? `Within one share of ${p.targetPct}%` : `Drift ${ev.driftPts !== null ? (ev.driftPts >= 0 ? '+' : '−') + Math.abs(ev.driftPts).toFixed(2) : '—'} points; reset at the next scheduled rebalance` },
    {
      id: 'c3', label: labels[2][1],
      status: !holding ? 'pending' : !due ? 'pass' : sched.overdue ? 'fail' : 'pending',
      detail: !holding ? `No TQQQ in this sleeve; establish ${p.targetPct}% at the next open` : !due ? `Done for this month; next after the ${fmtDate(sched.nextSignal)} close (${fmtDate(sched.nextExec)} open)` : sched.overdue ? `Was due at the ${fmtDate(sched.execDate)} open and is not recorded` : `Due at the ${fmtDate(sched.execDate)} open (month-end ${fmtDate(sched.signalDate)})`,
    },
    { id: 'c4', label: labels[3][1], status: inp.cashRequiredUsd === null ? 'na' : 'pass', detail: inp.cashRequiredUsd === null ? 'Needs equity and a TQQQ price' : inp.cashRequiredUsd > 0 ? `$${inp.cashRequiredUsd.toFixed(2)} including fees` : 'None: the trade is a sale or nothing is needed' },
    { id: 'c5', label: labels[4][1], status: inp.cashAvailableUsd === null ? 'na' : cashOk === false ? 'fail' : 'pass', detail: inp.cashAvailableUsd === null ? 'Enter cash available on the Portfolio page' : cashOk === false ? `$${inp.cashAvailableUsd.toFixed(2)}: short by $${((inp.cashRequiredUsd ?? 0) - inp.cashAvailableUsd).toFixed(2)}. Sell QQQ first or the purchase is limited to cash.` : `$${inp.cashAvailableUsd.toFixed(2)}` },
    {
      id: 'c6', label: labels[5][1],
      status: sh === null ? 'na' : !due ? 'pass' : sh === 0 ? 'pass' : 'pending',
      detail: sh === null ? 'Cannot be sized yet' : !due ? 'No trade until the next rebalance date' : sh === 0 ? 'Nothing to trade at whole-share size' : `${sh > 0 ? 'Buy' : 'Sell'} ${Math.abs(sh)} TQQQ${inp.rebalanceValueUsd !== null ? ` ≈ $${Math.abs(inp.rebalanceValueUsd).toFixed(2)}` : ''}`,
    },
  ];
  if (!holding) {
    ev.action = 'BUY';
    ev.headline = `Establish the ${p.targetPct}% TQQQ allocation at the next session’s open`;
    ev.reasons = ['This sleeve holds no TQQQ. Strategy C holds its target at all times; there is no entry signal to wait for.'];
    if (!inp.sleeve.confirmed) ev.reasons.push('Your holdings are not confirmed yet. Check the Portfolio page before acting.');
  } else if (due && sh !== 0) {
    ev.action = 'REBALANCE';
    ev.headline = `Rebalance TQQQ to ${p.targetPct}% at the ${fmtDate(sched.execDate)} open`;
    ev.reasons = [`Month-end close ${fmtDate(sched.signalDate)}${wPct !== null ? `: TQQQ was ${wPct.toFixed(2)}% of equity` : ''}. Buy if below target, sell if above; no margin.`];
    if (sched.overdue) ev.reasons.push(`The scheduled open (${fmtDate(sched.execDate)}) has passed without a recorded rebalance.`);
    ev.fired.push({ type: 'MONTHLY_REBALANCE_DUE', session: sched.signalDate, text: `Monthly 95/5: rebalance due at the ${fmtDate(sched.execDate)} open` });
  } else {
    ev.action = 'HOLD';
    ev.headline = 'No trade until the next month-end';
    ev.reasons = [due ? 'This month’s rebalance needs no whole-share trade.' : `Rebalanced for this month. Weights drift until the ${fmtDate(sched.nextSignal)} close.`, 'There is no tactical exit in this strategy, including in bear markets.'];
  }
  return ev;
}

// ---------- Strategy A market signal

export interface ModelSnapshot {
  pending: { kind: string; signalDate: string }[];
  active: boolean;
  firstExecDate: string | null;
  secondDone: boolean;
  weightPct: number;
}

/**
 * Claude V2's market signal: the rule state of a model portfolio run on the same completed closes,
 * so it does not depend on the user's own entries. Falls back to the plain regime without a model.
 */
export function claudeSignal(ev: LiveEvaluation, model: ModelSnapshot | null, p: StrategyParams): MarketSignal {
  if (ev.action === 'DATA UNAVAILABLE') return { label: 'DATA UNAVAILABLE', tone: 'na', recommendedPct: null, detail: 'No validated QQQ Daily candles.' };
  if (!model) {
    const tone: Tone = ev.regime === 'BULLISH' ? 'bull' : ev.regime === 'BEARISH' ? 'risk' : 'wait';
    return { label: ev.regime, tone, recommendedPct: null, detail: 'Model state unavailable without validated TQQQ history; regime only.' };
  }
  const has = (k: string) => model.pending.some((e) => e.kind === k);
  if (has('EXIT')) return { label: 'EXIT SIGNAL', tone: 'risk', recommendedPct: 0, detail: `Close at or below SMA200 −${p.exitBufferPct}%: the rules sell all TQQQ at the next open.` };
  if (has('ENTRY')) return { label: 'ENTRY SIGNAL', tone: 'bull', recommendedPct: p.firstAllocPct, detail: `${p.confirmCloses} closes ≥ +${p.entryBufferPct}%: the rules buy ${p.firstAllocPct}% at the next open.` };
  if (has('ADD')) return { label: 'ADD SIGNAL', tone: 'bull', recommendedPct: p.targetAllocPct, detail: `Second stage: the rules add to ${p.targetAllocPct}% at the next open.` };
  if (has('TRIM')) return { label: 'TRIM SIGNAL', tone: 'wait', recommendedPct: p.targetAllocPct, detail: `The model sleeve is above ${p.trimThresholdPct}%: trim toward ${p.targetAllocPct}% at the next open.` };
  if (model.active) {
    return {
      label: 'IN RECOVERY CYCLE', tone: 'bull', recommendedPct: model.secondDone ? p.targetAllocPct : p.firstAllocPct,
      detail: `Rules hold TQQQ since the ${fmtDate(model.firstExecDate)} open (${model.secondDone ? 'full' : 'first stage'}; model weight ${model.weightPct.toFixed(2)}%).`,
    };
  }
  return { label: 'NO ACTIVE CYCLE', tone: ev.regime === 'BEARISH' ? 'risk' : 'wait', recommendedPct: 0, detail: `Rules hold no TQQQ; waiting for ${p.confirmCloses} closes at least +${p.entryBufferPct}% above SMA200 in a fresh cycle.` };
}
