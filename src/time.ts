// Time and US exchange calendar.
// All dates are 'YYYY-MM-DD' strings in New York (exchange) time. All instants are UTC epoch ms.
// Time-zone conversion uses Intl only, so US daylight-saving changes are handled by the browser's
// tz database rather than by hand-written offsets.

export const ET_ZONE = 'America/New_York';
export const MYT_ZONE = 'Asia/Kuala_Lumpur';
const DAY_MS = 86400000;

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function parseYmd(date: string): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

export function isYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parseYmd(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parseYmd(date);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  const [y, m, d] = parseYmd(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = parseYmd(a);
  const [y2, m2, d2] = parseYmd(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

function nthWeekday(y: number, m: number, wd: number, n: number): string {
  const first = weekday(ymd(y, m, 1));
  const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  return ymd(y, m, day);
}

function lastWeekday(y: number, m: number, wd: number): string {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lw = weekday(ymd(y, m, lastDay));
  return ymd(y, m, lastDay - ((lw - wd + 7) % 7));
}

/** Gregorian Easter Sunday (anonymous Gregorian algorithm). */
export function easterSunday(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}

/** Saturday holidays move to Friday, Sunday holidays to Monday. */
function observed(date: string): string {
  const wd = weekday(date);
  if (wd === 6) return addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

/** Unscheduled full-day closures of US equity markets since 1999. */
const SPECIAL_CLOSURES: Record<string, string> = {
  '2001-09-11': 'September 11 closure',
  '2001-09-12': 'September 11 closure',
  '2001-09-13': 'September 11 closure',
  '2001-09-14': 'September 11 closure',
  '2004-06-11': 'National Day of Mourning (Reagan)',
  '2007-01-02': 'National Day of Mourning (Ford)',
  '2012-10-29': 'Hurricane Sandy closure',
  '2012-10-30': 'Hurricane Sandy closure',
  '2018-12-05': 'National Day of Mourning (G.H.W. Bush)',
  '2025-01-09': 'National Day of Mourning (Carter)',
};

const holidayCache = new Map<number, Map<string, string>>();

/** NYSE/Nasdaq full-day holidays for a year: date -> name. */
export function usMarketHolidays(y: number): Map<string, string> {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const out = new Map<string, string>();
  // New Year's Day: a Saturday Jan 1 is NOT observed on the preceding Friday (NYSE rule).
  const ny = ymd(y, 1, 1);
  if (weekday(ny) === 0) out.set(ymd(y, 1, 2), "New Year's Day (observed)");
  else if (weekday(ny) !== 6) out.set(ny, "New Year's Day");
  if (y >= 1998) out.set(nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day');
  out.set(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  out.set(addDays(easterSunday(y), -2), 'Good Friday');
  out.set(lastWeekday(y, 5, 1), 'Memorial Day');
  if (y >= 2022) out.set(observed(ymd(y, 6, 19)), 'Juneteenth');
  out.set(observed(ymd(y, 7, 4)), 'Independence Day');
  out.set(nthWeekday(y, 9, 1, 1), 'Labor Day');
  out.set(nthWeekday(y, 11, 4, 4), 'Thanksgiving Day');
  out.set(observed(ymd(y, 12, 25)), 'Christmas Day');
  for (const [d, name] of Object.entries(SPECIAL_CLOSURES)) if (d.startsWith(String(y))) out.set(d, name);
  holidayCache.set(y, out);
  return out;
}

export function holidayName(date: string): string | null {
  return usMarketHolidays(parseYmd(date)[0]).get(date) ?? null;
}

/** Scheduled 1:00 pm ET early closes. */
export function isEarlyClose(date: string): boolean {
  if (!isTradingDay(date)) return false;
  const [y, m, d] = parseYmd(date);
  const wd = weekday(date);
  if (m === 7 && d === 3 && wd >= 1 && wd <= 4) return true;
  if (m === 12 && d === 24 && wd >= 1 && wd <= 4) return true;
  if (m === 11 && date === addDays(nthWeekday(y, 11, 4, 4), 1)) return true;
  return false;
}

export function isTradingDay(date: string): boolean {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return false;
  return holidayName(date) === null;
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

export function prevTradingDay(date: string): string {
  let d = addDays(date, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** True when `date` is the last US trading session of its calendar month. */
export function lastSessionOfMonth(date: string): boolean {
  return nextTradingDay(date).slice(0, 7) !== date.slice(0, 7);
}

/** The latest month-end trading session on or before `date`. */
export function monthEndOnOrBefore(date: string): string {
  if (isTradingDay(date) && lastSessionOfMonth(date)) return date;
  let d = addDays(date.slice(0, 7) + '-01', -1); // last calendar day of the previous month
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** The first month-end trading session strictly after `date`. */
export function monthEndAfter(date: string): string {
  let d = nextTradingDay(date);
  while (!lastSessionOfMonth(d)) d = nextTradingDay(d);
  return d;
}

/** The date `n` trading sessions after `date` (n >= 0). */
export function addTradingDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}

/** Trading sessions in [from, to], both inclusive. */
export function tradingDaysInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  if (from > to) return out;
  let d = from;
  while (d <= to) {
    if (isTradingDay(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

// ---------- time zones

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function zoneParts(fmt: Intl.DateTimeFormat, utcMs: number): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return parts;
}

function etOffsetMinutes(utcMs: number): number {
  const p = zoneParts(etFmt, utcMs);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** UTC ms of a New York wall-clock time on a date (DST-aware). */
export function etWallToUtc(date: string, hour: number, minute: number): number {
  const [y, m, d] = parseYmd(date);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - etOffsetMinutes(guess) * 60000;
  return guess - etOffsetMinutes(first) * 60000;
}

/** The New York calendar date at an instant. */
export function etDate(utcMs: number): string {
  const p = zoneParts(etFmt, utcMs);
  return `${p.year}-${p.month}-${p.day}`;
}

export function etOffsetLabel(utcMs: number): string {
  const off = etOffsetMinutes(utcMs);
  return off === -240 ? 'EDT' : off === -300 ? 'EST' : `UTC${off / 60}`;
}

export interface SessionTimes {
  date: string;
  openUtc: number;
  closeUtc: number;
  earlyClose: boolean;
}

export function sessionTimes(date: string): SessionTimes {
  const early = isEarlyClose(date);
  return {
    date,
    openUtc: etWallToUtc(date, 9, 30),
    closeUtc: etWallToUtc(date, early ? 13 : 16, 0),
    earlyClose: early,
  };
}

/** Minutes after the official close before a Daily candle counts as completed. */
export const CLOSE_GRACE_MIN = 15;

/** The most recent session whose close (plus grace) is at or before `nowMs`. */
export function lastCompletedSession(nowMs: number, graceMin = CLOSE_GRACE_MIN): string {
  let d = etDate(nowMs);
  for (let i = 0; i < 15; i++) {
    if (isTradingDay(d) && sessionTimes(d).closeUtc + graceMin * 60000 <= nowMs) return d;
    d = addDays(d, -1);
  }
  return prevTradingDay(etDate(nowMs));
}

export type MarketPhase = 'open' | 'pre' | 'post' | 'closed' | 'holiday' | 'weekend';

export interface MarketStatus {
  phase: MarketPhase;
  label: string;
  detail: string;
  sessionDate: string | null; // the session today, if a trading day
  nextOpenUtc: number;
  closeUtc: number | null;
  earlyClose: boolean;
}

export function marketStatus(nowMs: number): MarketStatus {
  const today = etDate(nowMs);
  const nextOpenDay = (d: string) => (isTradingDay(d) && sessionTimes(d).openUtc > nowMs ? d : nextTradingDay(d));
  if (!isTradingDay(today)) {
    const wd = weekday(today);
    const hol = holidayName(today);
    const nd = nextTradingDay(today);
    return {
      phase: wd === 0 || wd === 6 ? 'weekend' : 'holiday',
      label: hol ? 'Closed · holiday' : 'Closed · weekend',
      detail: hol ?? 'Weekend',
      sessionDate: null,
      nextOpenUtc: sessionTimes(nd).openUtc,
      closeUtc: null,
      earlyClose: false,
    };
  }
  const st = sessionTimes(today);
  const preStart = etWallToUtc(today, 4, 0);
  const postEnd = etWallToUtc(today, 20, 0);
  const base = { sessionDate: today, closeUtc: st.closeUtc, earlyClose: st.earlyClose };
  if (nowMs >= st.openUtc && nowMs < st.closeUtc) {
    return { ...base, phase: 'open', label: st.earlyClose ? 'Open · early close' : 'Open', detail: 'Regular session', nextOpenUtc: sessionTimes(nextTradingDay(today)).openUtc };
  }
  if (nowMs >= preStart && nowMs < st.openUtc) {
    return { ...base, phase: 'pre', label: 'Pre-market', detail: 'Regular session not started', nextOpenUtc: st.openUtc };
  }
  if (nowMs >= st.closeUtc && nowMs < postEnd) {
    return { ...base, phase: 'post', label: 'After hours', detail: 'Regular session closed', nextOpenUtc: sessionTimes(nextTradingDay(today)).openUtc };
  }
  const nd = nextOpenDay(today);
  return { ...base, phase: 'closed', label: 'Closed', detail: 'Outside trading hours', nextOpenUtc: sessionTimes(nd).openUtc };
}

// ---------- Malaysian time formatting (user-facing timestamps)

const mytDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: MYT_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const mytTime = new Intl.DateTimeFormat('en-GB', { timeZone: MYT_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const mytWeekdayTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: MYT_ZONE, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function fmtMyt(utcMs: number): string {
  return mytDateTime.format(new Date(utcMs)) + ' MYT';
}
export function fmtMytTime(utcMs: number): string {
  return mytTime.format(new Date(utcMs)) + ' MYT';
}
export function fmtMytWeekday(utcMs: number): string {
  return mytWeekdayTime.format(new Date(utcMs)) + ' MYT';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-23' -> '23 Oct 2026' (a US session date, no zone conversion). */
export function fmtDate(date: string | null | undefined): string {
  if (!date) return '—';
  const [y, m, d] = parseYmd(date);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
export function fmtDateShort(date: string): string {
  const [y, m, d] = parseYmd(date);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}
