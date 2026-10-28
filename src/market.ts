// Twelve Data access. In claude.ai it goes through the viewer's connector; on the website the server's
// REST client implements the same interface. The browser never sees an API key either way.
import type { ApiUsage, Bar, Dividend, Quote } from './data.ts';
import { mergeBars, parseApiUsage, parseDividends, parseQuote, parseTimeSeries, resultText } from './data.ts';
import { etDate, tradingDaysInclusive } from './time.ts';

export const TD_SERVER = 'Twelve Data';
export const TD_TOOLS = ['get_time_series', 'get_quote', 'get_dividends', 'get_api_usage'];

export interface McpLike {
  callTool(server: string, tool: string, input?: unknown, options?: { cache?: false | { staleTime?: number; gcTime?: number; refresh?: boolean } }): Promise<unknown>;
}

export type ConnState =
  | 'ok' | 'not_connected' | 'needs_reauth' | 'not_allowed' | 'approval_required' | 'selection_required'
  | 'unavailable' | 'provider_error' | 'no_runtime' | 'unknown';

export interface CallFailure {
  state: ConnState;
  code: string;
  message: string;
}

export function describeFailure(err: unknown): CallFailure {
  const e = (err ?? {}) as { code?: string; message?: string };
  const code = typeof e.code === 'string' ? e.code : 'upstream_error';
  const msg = typeof e.message === 'string' ? e.message : String(err);
  switch (code) {
    case 'server_not_connected':
    case 'server_not_found':
      return { state: 'not_connected', code, message: 'Twelve Data is not connected. Add it in claude.ai Settings → Connectors, then reload.' };
    case 'needs_reauth':
      return { state: 'needs_reauth', code, message: 'Twelve Data needs you to sign in again. Reconnect it in claude.ai Settings → Connectors.' };
    case 'not_in_manifest':
    case 'blocked_by_policy':
    case 'consent_required':
      return { state: 'not_allowed', code, message: 'This page is not allowed to use Twelve Data for you. Allow the connector from the page’s permissions.' };
    case 'approval_required':
      return { state: 'approval_required', code, message: 'Twelve Data access needs your approval for this page.' };
    case 'selection_required':
      return { state: 'selection_required', code, message: 'More than one Twelve Data connector is set up. Choose one when claude.ai asks.' };
    case 'server_unavailable':
      return { state: 'unavailable', code, message: msg && !/^\s*$/.test(msg) && code !== msg ? msg : 'Twelve Data did not answer in time. Try Refresh in a minute.' };
    case 'rate_limited':
      return { state: 'unavailable', code, message: msg || 'The Twelve Data credit limit for this minute is used up. Try again in a minute.' };
    case 'tool_error':
      return { state: 'provider_error', code, message: msg };
    case 'not_configured':
      return { state: 'not_connected', code, message: msg || 'The server has no Twelve Data key configured.' };
    case 'unauthorized':
      return { state: 'not_allowed', code, message: 'Please sign in again.' };
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return { state: 'no_runtime', code, message: 'Connector access is not available in this view. Open the page in claude.ai.' };
    default:
      return { state: 'unknown', code, message: msg || 'Unexpected connector error' };
  }
}

export class TwelveData {
  credits = 0;
  private mcp: McpLike;
  constructor(mcp: McpLike) {
    this.mcp = mcp;
  }

  private async call(tool: string, input: Record<string, unknown>, cache: false | { staleTime: number; gcTime: number }): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.mcp.callTool(TD_SERVER, tool, input, { cache });
        this.credits += 1;
        return resultText(res);
      } catch (err) {
        lastErr = err;
        const e = err as { retryable?: boolean; retryAfterMs?: number };
        if (attempt === 0 && e && e.retryable) {
          await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs ?? 1500 + Math.random() * 1500, 8000)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async series(symbol: string, opts: { start?: string; end?: string; outputsize: number; longCache?: boolean }): Promise<Bar[]> {
    const input: Record<string, unknown> = { symbol, interval: '1day', outputsize: opts.outputsize };
    if (opts.start) input.start_date = opts.start;
    if (opts.end) input.end_date = opts.end;
    const text = await this.call('get_time_series', input, opts.longCache ? { staleTime: 6 * 3600000, gcTime: 24 * 3600000 } : false);
    const parsed = parseTimeSeries(text);
    if (!parsed.ok) throw { code: 'tool_error', message: parsed.error ?? 'Unreadable time series' };
    return parsed.value;
  }

  async quote(symbol: string): Promise<Quote> {
    const text = await this.call('get_quote', { symbol }, false);
    const parsed = parseQuote(text, symbol);
    if (!parsed.ok || !parsed.value) throw { code: 'tool_error', message: parsed.error ?? 'Unreadable quote' };
    return parsed.value;
  }

  async dividends(symbol: string): Promise<Dividend[]> {
    const text = await this.call('get_dividends', { symbol }, { staleTime: 24 * 3600000, gcTime: 7 * 24 * 3600000 });
    const parsed = parseDividends(text);
    if (!parsed.ok) throw { code: 'tool_error', message: parsed.error ?? 'Unreadable dividends' };
    return parsed.value;
  }

  async usage(): Promise<ApiUsage | null> {
    const text = await this.call('get_api_usage', {}, false);
    return parseApiUsage(text);
  }
}

// ---------- candle cache (artifact database, shared, one document per symbol-year)

export interface CacheDb {
  collection(path: string): { get(): Promise<{ docs: { id: string; data(): Record<string, unknown> | undefined }[] }> };
  doc(path: string): { set(data: Record<string, unknown>): Promise<void>; delete(): Promise<void> };
}

export const HISTORY_START: Record<string, string> = { QQQ: '1999-03-01', TQQQ: '2010-02-01' };

function encode(bars: Bar[]): number[][] {
  return bars.map((b) => [Number(b.d.replace(/-/g, '')), b.o, b.h, b.l, b.c, b.v ?? -1]);
}
function decode(rows: unknown): Bar[] {
  if (!Array.isArray(rows)) return [];
  const out: Bar[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const s = String(r[0]);
    if (s.length !== 8) continue;
    out.push({ d: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) < 0 ? null : Number(r[5]) });
  }
  return out;
}

export interface LoadSeriesResult {
  bars: Bar[];
  source: 'cache+incremental' | 'full' | 'full-after-adjustment';
  calls: number;
  cacheWritable: boolean;
  note: string | null;
}

/**
 * Load a symbol's full Daily history: cached years from the database plus a small incremental
 * fetch, verified against the cache on overlapping dates. A disagreement (a split re-adjusted the
 * history) discards the cache and reloads everything.
 */
export async function loadHistory(td: TwelveData, db: CacheDb | null, symbol: string, nowMs: number, forceFull = false): Promise<LoadSeriesResult> {
  let cached: Bar[] = [];
  if (db && !forceFull) {
    try {
      const snap = await db.collection(`market/${symbol}/years`).get();
      for (const d of snap.docs) cached.push(...decode(d.data()?.bars));
      cached.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    } catch {
      cached = [];
    }
  }
  const today = etDate(nowMs);
  let calls = 0;
  let source: LoadSeriesResult['source'] = 'full';
  let note: string | null = null;
  let bars: Bar[] = [];

  const fullFetch = async (): Promise<Bar[]> => {
    const startYear = Number(HISTORY_START[symbol]?.slice(0, 4) ?? '2000');
    const endYear = Number(today.slice(0, 4));
    const all: Bar[] = [];
    for (let y = startYear; y <= endYear; y += 14) {
      const start = y === startYear ? HISTORY_START[symbol] ?? `${y}-01-01` : `${y}-01-01`;
      const end = Math.min(y + 13, endYear) === endYear ? today : `${y + 13}-12-31`;
      const chunk = await td.series(symbol, { start, end, outputsize: 5000, longCache: end !== today });
      calls++;
      all.push(...chunk);
    }
    const dedup = new Map<string, Bar>();
    for (const b of all) dedup.set(b.d, b);
    return [...dedup.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  };

  if (cached.length > 250) {
    const lastCached = cached[cached.length - 1].d;
    const gap = tradingDaysInclusive(lastCached, today).length;
    const fresh = await td.series(symbol, { outputsize: Math.min(5000, gap + 30) });
    calls++;
    const merged = mergeBars(cached, fresh);
    if (merged.consistent && fresh.length && fresh[0].d <= lastCached) {
      bars = merged.bars;
      source = 'cache+incremental';
    } else {
      note = merged.mismatchDate ? `Cached ${symbol} prices disagreed with Twelve Data on ${merged.mismatchDate} (likely a split re-adjustment); history reloaded.` : null;
      bars = await fullFetch();
      calls += 0;
      source = 'full-after-adjustment';
    }
  } else {
    bars = await fullFetch();
  }

  let cacheWritable = false;
  if (db) {
    // Store completed sessions only (the in-progress session is excluded by the caller's validation,
    // so drop today's date here to be safe), one document per year, only years that changed.
    const byYear = new Map<string, Bar[]>();
    for (const b of bars) {
      if (b.d >= today) continue;
      const y = b.d.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      (byYear.get(y) as Bar[]).push(b);
    }
    const cachedCount = new Map<string, number>();
    for (const b of cached) cachedCount.set(b.d.slice(0, 4), (cachedCount.get(b.d.slice(0, 4)) ?? 0) + 1);
    try {
      for (const [y, list] of byYear) {
        if (source === 'cache+incremental' && cachedCount.get(y) === list.length) continue;
        await db.doc(`market/${symbol}/years/${y}`).set({ symbol, year: Number(y), adjust: 'splits (Twelve Data default)', bars: encode(list), savedAt: new Date(nowMs).toISOString() });
      }
      cacheWritable = true;
    } catch {
      cacheWritable = false;
    }
  }
  return { bars, source, calls, cacheWritable, note };
}

export async function clearHistoryCache(db: CacheDb, symbol: string): Promise<number> {
  const snap = await db.collection(`market/${symbol}/years`).get();
  for (const d of snap.docs) await db.doc(`market/${symbol}/years/${d.id}`).delete();
  return snap.docs.length;
}
