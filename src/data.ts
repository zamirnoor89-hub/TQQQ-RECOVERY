// Market data parsing and validation. A provider response is never trusted on arrival:
// every series passes these checks before a single indicator is computed from it.
import { isTradingDay, isYmd, lastCompletedSession, sessionTimes, tradingDaysInclusive, CLOSE_GRACE_MIN } from './time.ts';

export interface Bar {
  d: string; // session date, YYYY-MM-DD (New York)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  percentChange: number | null;
  datetime: string | null;
  timestampMs: number | null;
  isMarketOpen: boolean | null;
}

export interface Dividend {
  exDate: string;
  amount: number;
}

// ---------- tool-result text extraction

/**
 * The Twelve Data connector wraps every answer as {"result": "<csv or text>"}; unwrap it whether it
 * arrives as JSON text, a parsed payload or structured content.
 */
export function unwrapResult(text: string): string {
  const t = text.trim();
  if (!t.startsWith('{')) return text;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    if (j && typeof j.result === 'string') return j.result;
  } catch {
    /* not JSON: leave as is */
  }
  return text;
}

/** Pull the text a Twelve Data tool returned out of an MCP call result (or a bare payload). */
export function resultText(result: unknown): string {
  return unwrapResult(rawResultText(result));
}

function rawResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const sc0 = (result as { structuredContent?: unknown }).structuredContent as Record<string, unknown> | undefined;
  if (sc0 && typeof sc0 === 'object' && typeof sc0.result === 'string') return sc0.result;
  const r = result as Record<string, unknown>;
  const content = r.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text);
    if (texts.length) return texts.join('\n');
  }
  const payload = r.payload;
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.result === 'string') return p.result;
    return JSON.stringify(payload);
  }
  const sc = r.structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc.result === 'string') return sc.result;
  if (typeof r.result === 'string') return r.result;
  return '';
}

// ---------- CSV / JSON parsing

export interface Table {
  header: string[];
  rows: string[][];
}

export function parseDelimited(text: string): Table | null {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 1) return null;
  const head = lines[0];
  const delim = head.includes(';') ? ';' : head.includes(',') ? ',' : head.includes('\t') ? '\t' : null;
  if (!delim) return null;
  const split = (l: string) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
  const header = split(head).map((h) => h.toLowerCase());
  return { header, rows: lines.slice(1).map(split) };
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === '' || s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface ParseResult<T> {
  ok: boolean;
  value: T;
  error: string | null;
}

/** Explain a non-data answer from the provider (plan limits, auth, symbol errors). */
function providerMessage(text: string): string {
  const t = text.trim();
  if (!t) return 'Empty response from Twelve Data';
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j.status === 'error' || j.message) return String(j.message ?? 'Twelve Data returned an error');
    } catch { /* fall through */ }
  }
  return t.length > 240 ? t.slice(0, 240) + '…' : t;
}

/** Parse a Twelve Data time_series answer (CSV, or the JSON envelope) into ascending bars. */
export function parseTimeSeries(text: string): ParseResult<Bar[]> {
  const t = text.trim();
  let rows: Record<string, string>[] = [];
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { status?: string; message?: string; values?: Record<string, string>[] };
      if (!Array.isArray(j.values)) return { ok: false, value: [], error: providerMessage(t) };
      rows = j.values;
    } catch {
      return { ok: false, value: [], error: 'Unreadable JSON from Twelve Data' };
    }
  } else {
    const tab = parseDelimited(t);
    if (!tab || !tab.header.includes('datetime') || !tab.header.includes('close')) {
      return { ok: false, value: [], error: providerMessage(t) };
    }
    rows = tab.rows.map((r) => Object.fromEntries(tab.header.map((h, i) => [h, r[i] ?? ''])));
  }
  const bars: Bar[] = [];
  for (const r of rows) {
    const d = String(r.datetime ?? '').slice(0, 10);
    const o = num(r.open), h = num(r.high), l = num(r.low), c = num(r.close);
    if (!isYmd(d) || o === null || h === null || l === null || c === null) {
      return { ok: false, value: [], error: `Malformed row in time series (${String(r.datetime ?? '?')})` };
    }
    bars.push({ d, o, h, l, c, v: num(r.volume) });
  }
  bars.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return { ok: true, value: bars, error: null };
}

export function parseQuote(text: string, symbol: string): ParseResult<Quote | null> {
  const t = text.trim();
  let rec: Record<string, unknown> | null = null;
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j.status === 'error') return { ok: false, value: null, error: providerMessage(t) };
      rec = j;
    } catch {
      return { ok: false, value: null, error: 'Unreadable JSON from Twelve Data' };
    }
  } else {
    const tab = parseDelimited(t);
    if (!tab || tab.rows.length < 1 || !tab.header.includes('close')) return { ok: false, value: null, error: providerMessage(t) };
    rec = Object.fromEntries(tab.header.map((h, i) => [h, tab.rows[0][i] ?? '']));
  }
  const g = (k: string) => (rec && rec[k] !== undefined ? String(rec[k]) : undefined);
  const price = num(g('close'));
  if (price === null || price <= 0) return { ok: false, value: null, error: 'Quote has no valid price' };
  const sym = (g('symbol') ?? symbol).toUpperCase();
  if (sym !== symbol.toUpperCase()) return { ok: false, value: null, error: `Quote returned for ${sym}, expected ${symbol}` };
  // `timestamp` is the session start; `last_quote_at` is when the price was quoted.
  const ts = num(g('last_quote_at')) ?? num(g('timestamp'));
  const open = g('is_market_open');
  return {
    ok: true,
    error: null,
    value: {
      symbol: sym,
      price,
      previousClose: num(g('previous_close')),
      change: num(g('change')),
      percentChange: num(g('percent_change')),
      datetime: g('datetime') ?? null,
      timestampMs: ts !== null ? ts * 1000 : null,
      isMarketOpen: open === undefined ? null : open === 'true' || open === 'True' || open === '1',
    },
  };
}

export function parseDividends(text: string): ParseResult<Dividend[]> {
  const t = text.trim();
  let rows: Record<string, string>[] = [];
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { dividends?: Record<string, string>[]; status?: string };
      if (!Array.isArray(j.dividends)) return { ok: false, value: [], error: providerMessage(t) };
      rows = j.dividends;
    } catch {
      return { ok: false, value: [], error: 'Unreadable JSON from Twelve Data' };
    }
  } else {
    const tab = parseDelimited(t);
    if (!tab) return { ok: false, value: [], error: providerMessage(t) };
    rows = tab.rows.map((r) => Object.fromEntries(tab.header.map((h, i) => [h, r[i] ?? ''])));
    if (!tab.header.some((h) => h.includes('date')) || !tab.header.some((h) => h.includes('amount'))) {
      return { ok: false, value: [], error: providerMessage(t) };
    }
  }
  const out: Dividend[] = [];
  for (const r of rows) {
    const dateKey = Object.keys(r).find((k) => k === 'ex_date') ?? Object.keys(r).find((k) => k.includes('date'));
    const amtKey = Object.keys(r).find((k) => k.includes('amount'));
    const d = dateKey ? String(r[dateKey]).slice(0, 10) : '';
    const a = amtKey ? num(String(r[amtKey])) : null;
    if (isYmd(d) && a !== null && a > 0) out.push({ exDate: d, amount: a });
  }
  out.sort((x, y) => (x.exDate < y.exDate ? -1 : 1));
  return { ok: true, value: out, error: null };
}

export interface ApiUsage {
  plan: string | null;
  used: number | null;
  limit: number | null;
}

export function parseApiUsage(text: string): ApiUsage | null {
  const t = text.trim();
  let rec: Record<string, unknown> | null = null;
  if (t.startsWith('{')) {
    try { rec = JSON.parse(t) as Record<string, unknown>; } catch { return null; }
  } else {
    const tab = parseDelimited(t);
    if (!tab || tab.rows.length < 1) return null;
    rec = Object.fromEntries(tab.header.map((h, i) => [h, tab.rows[0][i] ?? '']));
  }
  if (!rec || rec.status === 'error') return null;
  const limit = num(rec.plan_limit !== undefined ? String(rec.plan_limit) : undefined);
  return {
    plan: rec.plan_category ? String(rec.plan_category) : null,
    used: num(rec.current_usage !== undefined ? String(rec.current_usage) : undefined),
    limit: limit && limit > 0 ? limit : null, // the connector reports 0 when it has no limit to show
  };
}

// ---------- validation

export type SeriesStatus = 'ok' | 'awaiting' | 'stale' | 'invalid' | 'insufficient' | 'missing';

export interface SeriesReport {
  symbol: string;
  status: SeriesStatus;
  issues: string[];
  notes: string[];
  completed: Bar[]; // validated, completed regular-session candles only, ascending
  inProgress: Bar | null; // today's unfinished candle, if the provider sent one
  /** Problems older than the live calendar window: they do not block live signals but do block backtests. */
  historyIssues: string[];
  lastCompleted: string | null;
  expectedLast: string;
}

export interface ValidateOptions {
  minBars: number;
  /** Sessions checked against the exchange calendar for gaps (most recent N). */
  calendarWindow: number;
  /** Hours after the expected close that a missing candle is 'awaiting' rather than 'stale'. */
  awaitingHours: number;
  /** Dates another symbol also lacks: treated as unscheduled market closures, not gaps. */
  sharedMissing?: Set<string>;
  /** Largest believable close-to-close move (fraction). Larger jumps are treated as data errors. */
  maxDailyMove?: number;
}

/**
 * Default jump limits. QQQ's largest daily move since 1999 is about 12% and TQQQ's about 35%; an
 * unadjusted 2:1 split shows up as −50%, so these limits catch adjustment errors without flagging
 * real market moves.
 */
export const MAX_DAILY_MOVE: Record<string, number> = { QQQ: 0.25, TQQQ: 0.45 };

export const DEFAULT_VALIDATE: ValidateOptions = { minBars: 202, calendarWindow: 260, awaitingHours: 4 };

export function structuralIssues(bars: Bar[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (![b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0)) issues.push(`Non-positive or missing price on ${b.d}`);
    else if (b.h + 1e-9 < Math.max(b.o, b.c) || b.l - 1e-9 > Math.min(b.o, b.c) || b.h < b.l) issues.push(`High/low inconsistent with open/close on ${b.d}`);
    if (b.v !== null && (!Number.isFinite(b.v) || b.v < 0)) issues.push(`Invalid volume on ${b.d}`);
    if (i > 0 && bars[i - 1].d === b.d) issues.push(`Duplicate candle for ${b.d}`);
    if (i > 0 && bars[i - 1].d > b.d) issues.push(`Candles out of order at ${b.d}`);
    if (issues.length > 5) break;
  }
  return issues;
}

/** Split a series into completed candles and the in-progress one, and validate it. */
export function validateDaily(symbol: string, raw: Bar[], nowMs: number, opts: ValidateOptions = DEFAULT_VALIDATE): SeriesReport {
  const expectedLast = lastCompletedSession(nowMs);
  const report: SeriesReport = { symbol, status: 'ok', issues: [], notes: [], completed: [], inProgress: null, historyIssues: [], lastCompleted: null, expectedLast };
  if (!raw.length) {
    report.status = 'missing';
    report.issues.push('No candles received');
    return report;
  }
  const bars = [...raw].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const structural = structuralIssues(bars);
  if (structural.length) {
    report.status = 'invalid';
    report.issues.push(...structural);
    return report;
  }
  const completed: Bar[] = [];
  for (const b of bars) {
    const closeAt = sessionTimes(b.d).closeUtc + CLOSE_GRACE_MIN * 60000;
    if (closeAt <= nowMs) completed.push(b);
    else if (b.d === bars[bars.length - 1].d) report.inProgress = b;
  }
  report.completed = completed;
  report.lastCompleted = completed.length ? completed[completed.length - 1].d : null;

  // Discontinuities (for example a split the provider did not adjust) anywhere in the history.
  const limit = opts.maxDailyMove ?? MAX_DAILY_MOVE[symbol] ?? 0.5;
  const windowStart = completed.length > opts.calendarWindow ? completed[completed.length - opts.calendarWindow].d : completed[0]?.d ?? '';
  for (const j of jumps(completed, limit)) {
    const text = `${symbol} close moves ${(j.move * 100).toFixed(1)}% from ${j.from} to ${j.d}, beyond the ${(limit * 100).toFixed(0)}% plausibility limit (possible unadjusted split or bad print)`;
    if (j.d >= windowStart) report.issues.push(text);
    else if (report.historyIssues.length < 6) report.historyIssues.push(text);
  }

  // Calendar checks over the recent window that the strategy reads.
  const recent = completed.slice(-opts.calendarWindow);
  if (recent.length) {
    const have = new Set(recent.map((b) => b.d));
    for (const b of recent) {
      if (!isTradingDay(b.d)) report.notes.push(`Provider has a candle on ${b.d}, which the built-in calendar marks as closed`);
    }
    for (const d of tradingDaysInclusive(recent[0].d, recent[recent.length - 1].d)) {
      if (!have.has(d)) {
        if (opts.sharedMissing && opts.sharedMissing.has(d)) report.notes.push(`No session on ${d} for any symbol; treated as an unscheduled market closure`);
        else report.issues.push(`Missing Daily candle for trading session ${d}`);
      }
    }
  }
  if (report.issues.length) {
    report.status = 'invalid';
    return report;
  }
  if (completed.length < opts.minBars) {
    report.status = 'insufficient';
    report.issues.push(`Only ${completed.length} completed Daily candles; ${opts.minBars} required`);
    return report;
  }
  if (report.lastCompleted !== null && report.lastCompleted < expectedLast) {
    const sinceClose = nowMs - sessionTimes(expectedLast).closeUtc;
    // Missing session(s) between the last candle and the expected one.
    const gap = tradingDaysInclusive(report.lastCompleted, expectedLast).length - 1;
    if (gap === 1 && sinceClose < opts.awaitingHours * 3600000) {
      report.status = 'awaiting';
      report.notes.push(`Waiting for the ${expectedLast} Daily candle to be published`);
    } else {
      report.status = 'stale';
      report.issues.push(`Stale: last completed candle is ${report.lastCompleted}, expected ${expectedLast}`);
    }
  }
  return report;
}

/** Close-to-close moves larger than `limit` (as a fraction). */
export function jumps(bars: Bar[], limit: number): { d: string; from: string; move: number }[] {
  const out: { d: string; from: string; move: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const move = bars[i].c / bars[i - 1].c - 1;
    if (Math.abs(move) > limit) out.push({ d: bars[i].d, from: bars[i - 1].d, move });
  }
  return out;
}

/** Trading sessions in [from, to] missing from `bars`, excluding closures every symbol shares. */
export function windowGaps(bars: Bar[], from: string, to: string, shared?: Set<string>): string[] {
  const have = new Set(bars.map((b) => b.d));
  return tradingDaysInclusive(from, to).filter((d) => !have.has(d) && !(shared && shared.has(d)));
}

/**
 * Sessions where TQQQ's daily return differs from three times QQQ's by more than `maxDevPts`
 * percentage points. Real tracking differences stay under about 7 points (March 2020), so larger
 * gaps indicate misaligned or wrongly adjusted data.
 */
export function trackingBreaks(qqq: Bar[], tqqq: Bar[], maxDevPts = 15): { d: string; devPts: number }[] {
  const qm = new Map(qqq.map((b) => [b.d, b]));
  const out: { d: string; devPts: number }[] = [];
  for (let i = 1; i < tqqq.length; i++) {
    const a = qm.get(tqqq[i].d), b = qm.get(tqqq[i - 1].d);
    if (!a || !b) continue;
    const dev = (tqqq[i].c / tqqq[i - 1].c - 1 - 3 * (a.c / b.c - 1)) * 100;
    if (Math.abs(dev) > maxDevPts) out.push({ d: tqqq[i].d, devPts: dev });
  }
  return out;
}

export interface InputCheck {
  ok: boolean;
  issues: string[];
  notes: string[];
}

/** Checks a backtest's whole input window, not just the recent sessions the live strategy reads. */
export function checkBacktestInputs(qqq: Bar[], tqqq: Bar[], start: string, end: string, history: { QQQ: string[]; TQQQ: string[] }): InputCheck {
  const issues: string[] = [];
  const notes: string[] = [];
  if (!qqq.length || !tqqq.length) return { ok: false, issues: ['QQQ and TQQQ history are both required.'], notes };
  const shared = new Set<string>();
  const from = [start, qqq[0].d, tqqq[0].d].sort()[2];
  const to = [end, qqq[qqq.length - 1].d, tqqq[tqqq.length - 1].d].sort()[0];
  const gq = windowGaps(qqq, from, to);
  const gt = windowGaps(tqqq, from, to);
  for (const d of gq) if (gt.includes(d)) shared.add(d);
  const realQ = gq.filter((d) => !shared.has(d));
  const realT = gt.filter((d) => !shared.has(d));
  if (realQ.length) issues.push(`QQQ is missing ${realQ.length} trading session${realQ.length === 1 ? '' : 's'} in the window (first ${realQ[0]}).`);
  if (realT.length) issues.push(`TQQQ is missing ${realT.length} trading session${realT.length === 1 ? '' : 's'} in the window (first ${realT[0]}).`);
  if (shared.size) notes.push(`${shared.size} session${shared.size === 1 ? '' : 's'} missing for both symbols (${[...shared].slice(0, 3).join(', ')}) treated as unscheduled market closures.`);
  const inWin = (b: Bar) => b.d >= from && b.d <= to;
  for (const [sym, bars] of [['QQQ', qqq], ['TQQQ', tqqq]] as const) {
    const lim = MAX_DAILY_MOVE[sym];
    for (const j of jumps(bars.filter(inWin), lim).slice(0, 3)) issues.push(`${sym} close moves ${(j.move * 100).toFixed(1)}% on ${j.d}, beyond the ${(lim * 100).toFixed(0)}% plausibility limit.`);
  }
  const breaks = trackingBreaks(qqq.filter(inWin), tqqq.filter(inWin));
  for (const b of breaks.slice(0, 3)) issues.push(`TQQQ’s return on ${b.d} differs from 3× QQQ by ${b.devPts.toFixed(1)} points, which suggests misaligned or wrongly adjusted data.`);
  for (const x of [...history.QQQ, ...history.TQQQ].slice(0, 3)) notes.push(x);
  return { ok: issues.length === 0, issues, notes };
}

/** Trading sessions that a set of series all lack (unscheduled closures). */
export function commonMissing(seriesList: Bar[][], window: number): Set<string> {
  const missingSets = seriesList.map((bars) => {
    const recent = bars.slice(-window);
    const out = new Set<string>();
    if (!recent.length) return out;
    const have = new Set(recent.map((b) => b.d));
    for (const d of tradingDaysInclusive(recent[0].d, recent[recent.length - 1].d)) if (!have.has(d)) out.add(d);
    return out;
  });
  if (!missingSets.length) return new Set();
  return new Set([...missingSets[0]].filter((d) => missingSets.every((s) => s.has(d))));
}

// ---------- cache merge

export interface MergeResult {
  bars: Bar[];
  consistent: boolean;
  mismatchDate: string | null;
}

/**
 * Merge fresh provider bars over cached bars. Overlapping closes must agree (split adjustment
 * rewrites history; a mismatch means the cache is from an older adjustment and must be rebuilt).
 */
export function mergeBars(cached: Bar[], fresh: Bar[], tolerance = 0.002): MergeResult {
  const map = new Map<string, Bar>();
  for (const b of cached) map.set(b.d, b);
  for (const b of fresh) {
    const old = map.get(b.d);
    if (old && Math.abs(old.c - b.c) / b.c > tolerance) {
      return { bars: fresh.slice(), consistent: false, mismatchDate: b.d };
    }
    map.set(b.d, b);
  }
  const bars = [...map.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return { bars, consistent: true, mismatchDate: null };
}

/** Deterministic fingerprint (FNV-1a) of a bar series, for reproducibility checks. */
export function fingerprint(bars: Bar[]): string {
  let h = 2166136261;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  for (const b of bars) feed(`${b.d}|${b.o}|${b.h}|${b.l}|${b.c};`);
  return (h >>> 0).toString(16).padStart(8, '0');
}
