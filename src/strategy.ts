// Claude V2 — the TQQQ recovery strategy, as specified. Signals come from QQQ only; TQQQ is only
// ever the instrument that is bought, held, trimmed or sold.
import type { Bar, SeriesStatus } from './data.ts';
import { addTradingDays, fmtDate, isTradingDay } from './time.ts';

export interface StrategyParams {
  entryBufferPct: number; // QQQ close at least this % above SMA200 qualifies (Rule A)
  confirmCloses: number; // consecutive qualifying completed closes required (Rule A/B)
  firstAllocPct: number; // first allocation, % of equity (Rule A)
  addWaitSessions: number; // completed sessions after the first entry before the add (Rule B)
  targetAllocPct: number; // target after the add, % of equity (Rule B/E)
  trimThresholdPct: number; // weight above this at a completed close triggers a trim (Rule E)
  exitBufferPct: number; // QQQ close at or below SMA200 minus this % exits (Rule D)
  smaPeriod: number;
}

export const CLAUDE_V2_BASELINE: Readonly<StrategyParams> = Object.freeze({
  entryBufferPct: 2,
  confirmCloses: 2,
  firstAllocPct: 2.5,
  addWaitSessions: 20,
  targetAllocPct: 5,
  trimThresholdPct: 6,
  exitBufferPct: 3,
  smaPeriod: 200,
});

export const PARAM_KEYS: (keyof StrategyParams)[] = [
  'entryBufferPct', 'confirmCloses', 'firstAllocPct', 'addWaitSessions', 'targetAllocPct', 'trimThresholdPct', 'exitBufferPct', 'smaPeriod',
];

export function isBaseline(p: StrategyParams): boolean {
  return PARAM_KEYS.every((k) => p[k] === CLAUDE_V2_BASELINE[k]);
}

export function validateParams(p: StrategyParams): string[] {
  const e: string[] = [];
  const int = (x: number) => Number.isInteger(x);
  if (!(p.entryBufferPct >= 0 && p.entryBufferPct <= 20)) e.push('Entry buffer must be between 0% and 20%.');
  if (!(int(p.confirmCloses) && p.confirmCloses >= 1 && p.confirmCloses <= 10)) e.push('Entry confirmation must be a whole number of closes from 1 to 10.');
  if (!(p.firstAllocPct > 0 && p.firstAllocPct <= p.targetAllocPct)) e.push('First allocation must be above 0% and no larger than the target.');
  if (!(int(p.addWaitSessions) && p.addWaitSessions >= 1 && p.addWaitSessions <= 250)) e.push('Second-entry wait must be 1 to 250 trading sessions.');
  if (!(p.targetAllocPct > 0 && p.targetAllocPct <= 25)) e.push('Target allocation must be above 0% and at most 25%.');
  if (!(p.trimThresholdPct > p.targetAllocPct && p.trimThresholdPct <= 50)) e.push('Trim threshold must be above the target allocation.');
  if (!(p.exitBufferPct > 0 && p.exitBufferPct <= 30)) e.push('Exit threshold must be between 0% and 30% below SMA200.');
  if (!(int(p.smaPeriod) && p.smaPeriod >= 20 && p.smaPeriod <= 400)) e.push('SMA period must be 20 to 400 sessions.');
  return e;
}

// ---------- per-session points

export interface Point {
  i: number;
  d: string;
  o: number;
  c: number;
  sma: number | null;
  dist: number | null; // ((close / SMA) - 1) * 100
  qual: boolean | null; // close at least entryBuffer above SMA
  exitZone: boolean | null; // close at or below SMA minus exitBuffer
  qualRun: number; // consecutive qualifying closes ending here
  lastNonQual: number; // index of the latest non-qualifying (or SMA-less) close at or before here
}

const EPS = 1e-9;

/** Arithmetic mean of the `period` closes ending at each index (null until enough closes). */
export function smaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let k = i - period + 1; k <= i; k++) s += closes[k];
    out[i] = s / period;
  }
  return out;
}

export function isQualifying(close: number, sma: number, entryBufferPct: number): boolean {
  return close >= sma * (1 + entryBufferPct / 100) - EPS * sma;
}

export function isExitZone(close: number, sma: number, exitBufferPct: number): boolean {
  return close <= sma * (1 - exitBufferPct / 100) + EPS * sma;
}

export function buildPoints(bars: Bar[], p: StrategyParams): Point[] {
  const sma = smaSeries(bars.map((b) => b.c), p.smaPeriod);
  const pts: Point[] = [];
  let run = 0;
  let lastNon = -1;
  for (let i = 0; i < bars.length; i++) {
    const s = sma[i];
    const c = bars[i].c;
    const qual = s === null ? null : isQualifying(c, s, p.entryBufferPct);
    const exitZone = s === null ? null : isExitZone(c, s, p.exitBufferPct);
    if (qual) run += 1;
    else {
      run = 0;
      lastNon = i;
    }
    pts.push({ i, d: bars[i].d, o: bars[i].o, c, sma: s, dist: s === null ? null : (c / s - 1) * 100, qual, exitZone, qualRun: run, lastNonQual: lastNon });
  }
  return pts;
}

export type Regime = 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'DATA UNAVAILABLE';

export function regimeOf(pt: Point | null | undefined): Regime {
  if (!pt || pt.sma === null || pt.qual === null) return 'DATA UNAVAILABLE';
  if (pt.qual) return 'BULLISH';
  if (pt.exitZone) return 'BEARISH';
  return 'NEUTRAL';
}

/** True when the `n` closes ending at t all qualify and all sit at or after `fromIdx`. */
export function qualifiedPair(points: Point[], t: number, n: number, fromIdx = 0): boolean {
  const pt = points[t];
  return !!pt && pt.qualRun >= n && t - n + 1 >= fromIdx;
}

// ---------- model cycle state machine (algorithm-generated signals)

export interface CycleState {
  active: boolean;
  firstExecIdx: number; // session whose open executed the first purchase
  secondDone: boolean;
  cycleEndIdx: number; // signal session of the last exit (-1 = none)
  cycleNo: number;
}

export function initialCycleState(): CycleState {
  return { active: false, firstExecIdx: -1, secondDone: false, cycleEndIdx: -1, cycleNo: 0 };
}

export type DecisionKind = 'ENTRY' | 'ADD' | 'ADD_AT_TARGET' | 'TRIM' | 'EXIT';

export interface Decision {
  kind: DecisionKind;
  reason: string;
}

/**
 * Decide at the completed close of session t. `weight` is TQQQ's share of equity at that close
 * (null when unknown). Orders execute at the next session's open; the caller applies them.
 * Priority: EXIT over everything; ADD before TRIM (an add only happens below target).
 */
export function decideAtClose(s: CycleState, points: Point[], t: number, p: StrategyParams, weight: number | null): Decision[] {
  const pt = points[t];
  if (!pt || pt.sma === null) return [];
  if (s.active) {
    if (pt.exitZone) return [{ kind: 'EXIT', reason: `QQQ closed ${fmtPct(pt.dist)} vs SMA200, at or below −${p.exitBufferPct}%` }];
    const out: Decision[] = [];
    if (!s.secondDone && s.firstExecIdx >= 0) {
      const elapsed = t - s.firstExecIdx + 1;
      if (elapsed >= p.addWaitSessions && qualifiedPair(points, t, p.confirmCloses, s.firstExecIdx)) {
        if (weight !== null && weight >= p.targetAllocPct / 100 - 1e-12) out.push({ kind: 'ADD_AT_TARGET', reason: 'Second stage due, position already at or above target; nothing to buy' });
        else out.push({ kind: 'ADD', reason: `${elapsed} sessions since first entry and ${p.confirmCloses} new qualifying closes` });
      }
    }
    if (weight !== null && weight > p.trimThresholdPct / 100 && !out.some((d) => d.kind === 'ADD')) {
      out.push({ kind: 'TRIM', reason: `TQQQ weight ${(weight * 100).toFixed(2)}% above ${p.trimThresholdPct}%` });
    }
    return out;
  }
  if (pt.qualRun >= p.confirmCloses && pt.lastNonQual >= s.cycleEndIdx) {
    return [{ kind: 'ENTRY', reason: `${p.confirmCloses} consecutive closes at least +${p.entryBufferPct}% above SMA200` }];
  }
  return [];
}

/** Apply a decision once it has executed at the open of `execIdx`. */
export function applyExecuted(s: CycleState, kind: DecisionKind, signalIdx: number, execIdx: number): CycleState {
  switch (kind) {
    case 'ENTRY':
      return { ...s, active: true, firstExecIdx: execIdx, secondDone: false, cycleNo: s.cycleNo + 1 };
    case 'ADD':
    case 'ADD_AT_TARGET':
      return { ...s, secondDone: true };
    case 'EXIT':
      return { ...s, active: false, firstExecIdx: -1, secondDone: false, cycleEndIdx: signalIdx };
    default:
      return s;
  }
}

export interface SignalEvent {
  kind: DecisionKind | 'QUALIFIED';
  signalIdx: number;
  signalDate: string;
  execIdx: number | null;
  execDate: string | null;
  reason: string;
}

/**
 * QQQ-only signal history: qualification dates, entries, adds and exits, with execution at the
 * next session's open. Trims need portfolio weights, so they come from the backtest instead.
 */
export function signalHistory(points: Point[], p: StrategyParams): SignalEvent[] {
  const out: SignalEvent[] = [];
  let s = initialCycleState();
  for (let t = 0; t < points.length; t++) {
    const pt = points[t];
    if (pt.qualRun === p.confirmCloses) out.push({ kind: 'QUALIFIED', signalIdx: t, signalDate: pt.d, execIdx: null, execDate: null, reason: `${p.confirmCloses} consecutive qualifying closes` });
    for (const dec of decideAtClose(s, points, t, p, null)) {
      const exec = t + 1 < points.length ? t + 1 : null;
      out.push({ kind: dec.kind, signalIdx: t, signalDate: pt.d, execIdx: exec, execDate: exec === null ? null : points[exec].d, reason: dec.reason });
      if (exec !== null) s = applyExecuted(s, dec.kind, t, exec);
      else if (dec.kind === 'ADD_AT_TARGET') s = applyExecuted(s, dec.kind, t, t);
    }
  }
  return out;
}

// ---------- live evaluation against the user's real position

export type StrategyState =
  | 'FLAT' | 'ENTRY ELIGIBLE' | 'HALF ALLOCATED' | 'ADD ELIGIBLE' | 'FULL ALLOCATED'
  | 'HOLDING' | 'TRIM REQUIRED' | 'EXIT REQUIRED' | 'DATA UNAVAILABLE';

export type StrategyAction = 'BUY INITIAL' | 'ADD POSITION' | 'HOLD' | 'TRIM' | 'EXIT ALL' | 'WAIT' | 'DATA UNAVAILABLE';

export type CheckStatus = 'pass' | 'pending' | 'fail' | 'na';

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface UserPosition {
  confirmed: boolean; // the user has saved their holdings at least once
  shares: number;
  firstEntryDate: string | null; // execution date of the first purchase in the active cycle
  secondEntryDate: string | null;
  lastExitDate: string | null; // execution date of the last full exit
  lastExitSignalDate: string | null; // session whose close triggered it
}

export interface LiveInput {
  points: Point[];
  dataStatus: SeriesStatus;
  dataIssues: string[];
  params: StrategyParams;
  position: UserPosition;
  /** TQQQ weight of equity at the last confirmed close (null when unknown). */
  weightAtClose: number | null;
}

export type TimelineStage = 'WAITING' | 'CONFIRMED' | 'BUY' | 'WAIT_SESSIONS' | 'ADD' | 'HOLD' | 'EXIT';

export interface LiveEvaluation {
  asOf: string | null;
  regime: Regime;
  state: StrategyState;
  action: StrategyAction;
  headline: string;
  reasons: string[];
  activeRule: string;
  entry: CheckItem[];
  second: CheckItem[];
  hold: CheckItem[];
  stage: TimelineStage;
  runStart: string | null; // first close of the current qualifying run
  confirmedOn: string | null; // close that completed the confirmation
  sessionsElapsed: number | null;
  nextAddDate: string | null;
  exitTriggeredOn: string | null;
  addAtTarget: boolean;
  fired: { type: string; session: string; text: string }[];
}

function fmtPct(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—';
  return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2) + '%';
}

function indexOnOrAfter(points: Point[], date: string): number {
  for (let k = 0; k < points.length; k++) if (points[k].d >= date) return k;
  return points.length; // after the last completed session
}

export function evaluateLive(inp: LiveInput): LiveEvaluation {
  const { points, params: p, position: pos } = inp;
  const last = points.length ? points[points.length - 1] : null;
  const t = points.length - 1;
  const holding = pos.shares > 0;
  const dataOk = inp.dataStatus === 'ok' && !!last && last.sma !== null && points.length >= 2;

  const base: LiveEvaluation = {
    asOf: last ? last.d : null,
    regime: dataOk ? regimeOf(last) : 'DATA UNAVAILABLE',
    state: 'DATA UNAVAILABLE',
    action: 'DATA UNAVAILABLE',
    headline: '',
    reasons: [],
    activeRule: '—',
    entry: [],
    second: [],
    hold: [],
    stage: 'WAITING',
    runStart: null,
    confirmedOn: null,
    sessionsElapsed: null,
    nextAddDate: null,
    exitTriggeredOn: null,
    addAtTarget: false,
    fired: [],
  };

  const na = (id: string, label: string, detail = 'Market data unavailable'): CheckItem => ({ id, label, status: 'na', detail });
  const entryLabels: [string, string][] = [
    ['e1', `QQQ closes at least ${p.entryBufferPct}% above SMA200`],
    ['e2', `${p.confirmCloses} consecutive qualifying Daily closes`],
    ['e3', 'No active entry cycle'],
    ['e4', 'No pending exit'],
    ['e5', `Initial allocation is below the ${p.firstAllocPct}% target`],
  ];
  const secondLabels: [string, string][] = [
    ['s1', 'First purchase completed'],
    ['s2', `At least ${p.addWaitSessions} trading sessions elapsed`],
    ['s3', `${p.confirmCloses} new qualifying Daily closes`],
    ['s4', 'Exit rule inactive'],
    ['s5', 'Second allocation not previously completed'],
  ];
  const holdLabels: [string, string][] = [
    ['h1', 'Existing position identified'],
    ['h2', 'Exit threshold monitored'],
    ['h3', `QQQ remains above SMA200 minus ${p.exitBufferPct}%`],
    ['h4', `TQQQ allocation reviewed for the ${p.trimThresholdPct}% trim threshold`],
  ];

  if (!dataOk || !last || last.sma === null) {
    base.entry = entryLabels.map(([id, l]) => na(id, l));
    base.second = secondLabels.map(([id, l]) => na(id, l));
    base.hold = holdLabels.map(([id, l]) => na(id, l));
    base.headline = inp.dataStatus === 'awaiting' ? 'Waiting for today’s Daily close' : 'Market data cannot be validated';
    base.reasons = inp.dataIssues.length ? inp.dataIssues.slice(0, 3) : ['No validated QQQ Daily candles are available, so no signal is produced.'];
    if (inp.dataStatus !== 'awaiting') base.fired.push({ type: 'DATA_UNAVAILABLE', session: last?.d ?? 'none', text: base.reasons[0] });
    return base;
  }

  const ev = base;
  ev.regime = regimeOf(last);
  const sma = last.sma as number;
  const entryLevel = sma * (1 + p.entryBufferPct / 100);
  const exitLevel = sma * (1 - p.exitBufferPct / 100);
  const qualNow = !!last.qual;
  const run = last.qualRun;
  if (run > 0) {
    ev.runStart = points[t - run + 1].d;
    if (run >= p.confirmCloses) ev.confirmedOn = points[t - run + p.confirmCloses].d;
  }

  // Cycle boundary for the fresh-cycle requirement (Rule D).
  let cycleEndIdx = -1;
  if (pos.lastExitSignalDate) cycleEndIdx = Math.min(indexOnOrAfter(points, pos.lastExitSignalDate), t + 1);
  else if (pos.lastExitDate) cycleEndIdx = Math.max(-1, indexOnOrAfter(points, pos.lastExitDate) - 1);
  const fresh = last.lastNonQual >= cycleEndIdx;

  // Exit pending: any completed close in the exit zone since the position's first entry.
  const firstIdx = pos.firstEntryDate ? indexOnOrAfter(points, pos.firstEntryDate) : -1;
  let exitIdx = -1;
  if (holding) {
    const from = firstIdx >= 0 ? firstIdx : t;
    for (let k = from; k <= t; k++) if (points[k].exitZone) { exitIdx = k; break; }
  }
  const exitPending = exitIdx >= 0;
  if (exitPending) ev.exitTriggeredOn = points[exitIdx].d;

  const w = inp.weightAtClose;
  const wPct = w === null ? null : w * 100;

  // ---- Entry checklist
  ev.entry = [
    { id: 'e1', label: entryLabels[0][1], status: qualNow ? 'pass' : 'fail', detail: `Close ${last.c.toFixed(2)} vs entry level ${entryLevel.toFixed(2)} (${fmtPct(last.dist)})` },
    {
      id: 'e2', label: entryLabels[1][1],
      status: run >= p.confirmCloses ? 'pass' : run > 0 ? 'pending' : 'fail',
      detail: run >= p.confirmCloses ? `${run} qualifying closes in a row since ${fmtDate(ev.runStart)}` : run > 0 ? `${run} of ${p.confirmCloses} so far` : 'Latest close does not qualify',
    },
    {
      id: 'e3', label: entryLabels[2][1],
      status: !pos.confirmed ? 'pending' : holding ? 'fail' : 'pass',
      detail: !pos.confirmed ? 'Confirm your TQQQ holdings on the Portfolio page' : holding ? `${pos.shares} TQQQ shares held` : 'No TQQQ held',
    },
    {
      id: 'e4', label: entryLabels[3][1],
      status: exitPending ? 'fail' : 'pass',
      detail: exitPending ? `Exit triggered on ${fmtDate(ev.exitTriggeredOn)} is not yet recorded` : 'No exit outstanding',
    },
    {
      id: 'e5', label: entryLabels[4][1],
      status: !holding ? 'pass' : wPct === null ? 'na' : wPct < p.firstAllocPct ? 'pass' : 'fail',
      detail: !holding ? 'Current weight 0%' : wPct === null ? 'Enter total equity to measure weight' : `Current weight ${wPct.toFixed(3)}% (position already held)`,
    },
  ];
  if (!holding && cycleEndIdx >= 0) {
    ev.entry.push({
      id: 'e6', label: 'Fresh recovery cycle since the last exit',
      status: fresh ? 'pass' : 'pending',
      detail: fresh ? 'QQQ lost the entry threshold after the last exit' : 'QQQ must first close below the entry threshold, then re-qualify',
    });
  }

  // ---- Second-entry checklist
  const elapsed = holding && firstIdx >= 0 && firstIdx <= t ? t - firstIdx + 1 : holding && firstIdx > t ? 0 : null;
  ev.sessionsElapsed = elapsed;
  if (pos.firstEntryDate && isTradingDay(pos.firstEntryDate)) ev.nextAddDate = addTradingDays(pos.firstEntryDate, p.addWaitSessions - 1);
  const addPair = holding && firstIdx >= 0 && qualifiedPair(points, t, p.confirmCloses, firstIdx);
  const secondDone = !!pos.secondEntryDate;
  ev.second = [
    {
      id: 's1', label: secondLabels[0][1],
      status: !holding ? 'fail' : pos.firstEntryDate ? 'pass' : 'pending',
      detail: !holding ? 'No TQQQ position' : pos.firstEntryDate ? `First purchase ${fmtDate(pos.firstEntryDate)}` : 'Position held; enter the confirmed entry date',
    },
    {
      id: 's2', label: secondLabels[1][1],
      status: elapsed === null ? 'na' : elapsed >= p.addWaitSessions ? 'pass' : 'pending',
      detail: elapsed === null ? 'Needs a confirmed entry date' : `${elapsed} of ${p.addWaitSessions} sessions${ev.nextAddDate ? `; eligible from the ${fmtDate(ev.nextAddDate)} close` : ''}`,
    },
    {
      id: 's3', label: secondLabels[2][1],
      status: !holding || firstIdx < 0 ? 'na' : addPair ? 'pass' : qualNow ? 'pending' : 'pending',
      detail: !holding || firstIdx < 0 ? 'Needs an active position with an entry date' : addPair ? `Latest ${p.confirmCloses} closes qualify` : `${Math.min(run, Math.max(0, t - firstIdx + 1))} of ${p.confirmCloses} qualifying closes since entry`,
    },
    {
      id: 's4', label: secondLabels[3][1],
      status: exitPending || last.exitZone ? 'fail' : 'pass',
      detail: exitPending ? `Exit triggered on ${fmtDate(ev.exitTriggeredOn)}` : `Close ${fmtPct(last.dist)} vs exit at −${p.exitBufferPct}%`,
    },
    {
      id: 's5', label: secondLabels[4][1],
      status: secondDone ? 'fail' : !holding ? 'na' : 'pass',
      detail: secondDone ? `Second purchase recorded ${fmtDate(pos.secondEntryDate)}` : !holding ? 'No active cycle' : 'Not yet completed this cycle',
    },
  ];

  // ---- Hold / exit checklist
  ev.hold = [
    { id: 'h1', label: holdLabels[0][1], status: holding ? 'pass' : 'pending', detail: holding ? `${pos.shares} shares` : 'No TQQQ held' },
    { id: 'h2', label: holdLabels[1][1], status: 'pass', detail: `Exit level ${exitLevel.toFixed(2)} (SMA200 ${sma.toFixed(2)})` },
    { id: 'h3', label: holdLabels[2][1], status: last.exitZone ? 'fail' : 'pass', detail: `Close ${last.c.toFixed(2)} (${fmtPct(last.dist)})` },
    {
      id: 'h4', label: holdLabels[3][1],
      status: !holding ? 'na' : wPct === null ? 'na' : wPct > p.trimThresholdPct ? 'fail' : 'pass',
      detail: !holding ? 'No position to review' : wPct === null ? 'Enter total equity to measure weight' : `Weight ${wPct.toFixed(2)}% at the ${fmtDate(last.d)} close`,
    },
  ];

  // ---- Action (exit has priority over everything)
  const add = (type: string, text: string) => ev.fired.push({ type, session: last.d, text });
  if (run === p.confirmCloses) add('CONFIRMATION_COMPLETE', `QQQ completed ${p.confirmCloses} consecutive qualifying closes`);
  if (!qualNow && last.dist !== null && last.dist >= p.entryBufferPct - 0.5) add('APPROACH_ENTRY', `QQQ is ${fmtPct(last.dist)} vs SMA200, within 0.5 points of the entry buffer`);
  if (!last.exitZone && last.dist !== null && last.dist <= -p.exitBufferPct + 0.5) add('APPROACH_EXIT', `QQQ is ${fmtPct(last.dist)} vs SMA200, within 0.5 points of the exit threshold`);

  if (holding && exitPending) {
    ev.state = 'EXIT REQUIRED';
    ev.action = 'EXIT ALL';
    ev.activeRule = 'Rule D — Exit';
    ev.stage = 'EXIT';
    ev.headline = 'Sell all TQQQ at the next regular session';
    ev.reasons = [
      `QQQ closed at or below SMA200 −${p.exitBufferPct}% on ${fmtDate(ev.exitTriggeredOn)}. One completed close is enough.`,
      'The exit overrides every entry, add and trim rule until the sale is recorded.',
    ];
    add('EXIT_CONFIRMED', `Exit triggered by the ${fmtDate(ev.exitTriggeredOn)} close`);
    return ev;
  }

  if (holding) {
    const addEligible = !secondDone && elapsed !== null && elapsed >= p.addWaitSessions && addPair;
    const atTarget = wPct !== null && wPct >= p.targetAllocPct - 1e-9;
    if (wPct !== null && wPct > p.trimThresholdPct) {
      ev.state = 'TRIM REQUIRED';
      ev.action = 'TRIM';
      ev.activeRule = 'Rule E — Rebalance';
      ev.stage = 'HOLD';
      ev.headline = `Reduce TQQQ toward ${p.targetAllocPct}% at the next session`;
      ev.reasons = [`TQQQ was ${wPct.toFixed(2)}% of equity at the ${fmtDate(last.d)} close, above the ${p.trimThresholdPct}% trigger.`, 'The 6% level is a rebalancing trigger, not a guaranteed cap.'];
      if (addEligible) ev.addAtTarget = true;
      add('TRIM_REQUIRED', `TQQQ weight ${wPct.toFixed(2)}% above ${p.trimThresholdPct}%`);
      return ev;
    }
    if (addEligible && !atTarget) {
      ev.state = 'ADD ELIGIBLE';
      ev.action = 'ADD POSITION';
      ev.activeRule = 'Rule B — Second purchase';
      ev.stage = 'ADD';
      ev.headline = `Add to a total of ${p.targetAllocPct}% at the next session’s open`;
      ev.reasons = [`${elapsed} completed sessions since the first entry, and the latest ${p.confirmCloses} closes are at least +${p.entryBufferPct}% above SMA200.`, 'Size the add from the actual position value, limited by available cash.'];
      add('SECOND_ELIGIBLE', 'Second purchase eligible');
      return ev;
    }
    ev.action = 'HOLD';
    ev.activeRule = 'Rule C — Hold';
    ev.stage = 'HOLD';
    ev.headline = 'Keep the existing TQQQ position';
    if (addEligible && atTarget) {
      ev.addAtTarget = true;
      ev.state = 'FULL ALLOCATED';
      ev.reasons = [`The second stage is due but TQQQ is already ${wPct?.toFixed(2)}% of equity, at or above the ${p.targetAllocPct}% target, so there is nothing to buy. Mark the second stage complete.`];
    } else if (secondDone) {
      ev.state = 'FULL ALLOCATED';
      ev.reasons = [`Second purchase recorded on ${fmtDate(pos.secondEntryDate)}. Hold while QQQ stays above SMA200 −${p.exitBufferPct}%.`];
    } else if (!pos.firstEntryDate) {
      ev.state = 'HOLDING';
      ev.reasons = ['A position is held but its entry date is unknown, so the second-entry timer cannot run. Add the confirmed entry date on the Portfolio page.'];
    } else {
      ev.state = 'HALF ALLOCATED';
      ev.stage = elapsed !== null && elapsed >= p.addWaitSessions ? 'ADD' : 'WAIT_SESSIONS';
      ev.reasons = [
        elapsed !== null && elapsed < p.addWaitSessions
          ? `${elapsed} of ${p.addWaitSessions} sessions since the first entry; the add becomes possible from the ${fmtDate(ev.nextAddDate)} close.`
          : `Waiting for ${p.confirmCloses} consecutive closes at least +${p.entryBufferPct}% above SMA200 before the add.`,
      ];
    }
    ev.reasons.push(`QQQ is ${fmtPct(last.dist)} vs SMA200; the exit is at −${p.exitBufferPct}%. RSI, MACD and shorter averages do not trigger sales.`);
    return ev;
  }

  // Flat
  if (run >= p.confirmCloses && fresh && !exitPending) {
    ev.state = 'ENTRY ELIGIBLE';
    ev.action = 'BUY INITIAL';
    ev.activeRule = 'Rule A — Entry';
    ev.stage = 'CONFIRMED';
    ev.headline = `Buy the first ${p.firstAllocPct}% at the next session’s open`;
    ev.reasons = [
      `QQQ closed at least +${p.entryBufferPct}% above SMA200 for ${run} consecutive sessions (confirmed on ${fmtDate(ev.confirmedOn)}).`,
      run > p.confirmCloses + 5 ? `The qualifying run began on ${fmtDate(ev.runStart)}, ${run} sessions ago; the entry rules are still met while you hold no TQQQ.` : 'No active cycle and no pending exit.',
    ];
    if (!pos.confirmed) ev.reasons.push('Your holdings are not confirmed yet. Check the Portfolio page before acting.');
    add('FIRST_ELIGIBLE', 'First purchase eligible');
    return ev;
  }
  ev.state = 'FLAT';
  ev.action = 'WAIT';
  ev.activeRule = 'Rule A — Entry';
  ev.stage = 'WAITING';
  ev.headline = 'Wait for a confirmed recovery';
  ev.reasons = [
    qualNow
      ? run < p.confirmCloses
        ? `${run} of ${p.confirmCloses} qualifying closes so far.`
        : 'This qualifying run started before your last exit. QQQ must first close below the entry threshold, then re-qualify.'
      : `QQQ is ${fmtPct(last.dist)} vs SMA200; entry needs ${p.confirmCloses} consecutive closes at or above +${p.entryBufferPct}% (${entryLevel.toFixed(2)} today).`,
  ];
  return ev;
}
