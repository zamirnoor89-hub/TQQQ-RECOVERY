// Persistent records: the user's holdings, confirmed transactions, settings and alert log.
// Stored in the artifact database under the viewer's private subtree. A generated signal is never
// written as a transaction; only the user's own confirmations are.
//
// Multi-strategy layout (V2): the original top-level holding fields are the Claude V2 sleeve, exactly
// as V1 stored them, so existing records read unchanged. The SMA crossover and monthly sleeves are
// stored beside them under `sleeves`, and total TQQQ is the sum of the three.
import type { Currency, PortfolioInput } from './allocation.ts';
import { equityAt, fromUsd, toUsd } from './allocation.ts';
import type { StrategyParams, UserPosition } from './strategy.ts';
import { CLAUDE_V2_BASELINE, PARAM_KEYS } from './strategy.ts';
import type { CrossParams, MonthlyParams, SleevePosition, StrategyId } from './strategies.ts';
import { MONTHLY_BASELINE, SMA_CROSS_BASELINE, STRATEGY_IDS, isStrategyId } from './strategies.ts';

export interface SleeveDoc {
  shares: number; // whole TQQQ shares
  avgCost: number | null; // USD
  firstEntryDate: string | null; // first purchase of the current holding period
  secondEntryDate: string | null; // Claude V2 only
  lastExitDate: string | null;
  lastExitSignalDate: string | null;
  lastTradeDate: string | null; // latest recorded transaction (marks a monthly rebalance as done)
}

export type ExtraSleeve = Exclude<StrategyId, 'CLAUDE_V2'>;
/** Which book a transaction belongs to: one of the strategy sleeves, or the QQQ core. */
export type Book = StrategyId | 'CORE';

export interface PortfolioDoc {
  v: 2;
  confirmed: boolean;
  currency: Currency;
  totalEquity: number | null;
  equityRefPrice: number | null;
  shares: number;
  avgCost: number | null;
  cash: number | null;
  feeFixed: number;
  feePct: number;
  usdMyr: number | null;
  firstEntryDate: string | null;
  secondEntryDate: string | null;
  lastExitDate: string | null;
  lastExitSignalDate: string | null;
  updatedAt: string | null;
  // ---- added in V2
  lastTradeDate: string | null; // Claude V2 sleeve
  qqqShares: number | null; // QQQ core, optional
  qqqRefPrice: number | null; // QQQ price (USD) when equity was last marked
  sleeves: Record<ExtraSleeve, SleeveDoc>;
  followed: StrategyId[]; // strategies run with real money
}

export type TradeKind = 'INITIAL' | 'ADD' | 'TRIM' | 'EXIT' | 'ENTRY' | 'REBALANCE' | 'OTHER_BUY' | 'OTHER_SELL';
export const TRADE_KINDS: TradeKind[] = ['INITIAL', 'ADD', 'TRIM', 'EXIT', 'ENTRY', 'REBALANCE', 'OTHER_BUY', 'OTHER_SELL'];

/** Transaction types that make sense in each book. */
export const KINDS_BY_BOOK: Record<Book, TradeKind[]> = {
  CLAUDE_V2: ['INITIAL', 'ADD', 'TRIM', 'EXIT', 'OTHER_BUY', 'OTHER_SELL'],
  SMA_CROSS: ['ENTRY', 'REBALANCE', 'EXIT', 'OTHER_BUY', 'OTHER_SELL'],
  MONTHLY: ['ENTRY', 'REBALANCE', 'OTHER_BUY', 'OTHER_SELL'],
  CORE: ['REBALANCE', 'OTHER_BUY', 'OTHER_SELL'],
};

export interface TradeDoc {
  id: string;
  strategy: Book; // records from V1 belong to Claude V2
  symbol: 'TQQQ' | 'QQQ';
  date: string; // execution date (US session)
  side: 'BUY' | 'SELL';
  kind: TradeKind;
  shares: number;
  price: number; // USD
  fee: number; // USD
  signalDate: string | null;
  note: string;
  realizedUsd: number | null;
  createdAt: string;
}

export interface AlertPrefs {
  [type: string]: boolean;
}

export interface SettingsDoc {
  v: 1;
  params: StrategyParams;
  paramsUpdatedAt: string | null;
  cross: CrossParams;
  monthly: MonthlyParams;
  riskDrops: number[]; // TQQQ decline scenarios, %
  alerts: AlertPrefs;
  quoteRefreshMin: number; // 0 = manual only
  approachBand: number; // percentage points for "approaching" alerts
}

export interface AlertRec {
  key: string;
  type: string;
  session: string;
  text: string;
  createdAt: string;
}

export const ALERT_TYPES: { type: string; label: string }[] = [
  { type: 'APPROACH_ENTRY', label: 'QQQ approaches +2% above SMA200' },
  { type: 'CONFIRMATION_COMPLETE', label: 'Two consecutive entry confirmations complete' },
  { type: 'FIRST_ELIGIBLE', label: 'First purchase eligible' },
  { type: 'SECOND_ELIGIBLE', label: 'Second purchase eligible' },
  { type: 'TRIM_REQUIRED', label: 'TQQQ exposure exceeds 6%' },
  { type: 'APPROACH_EXIT', label: 'QQQ approaches −3% below SMA200' },
  { type: 'EXIT_CONFIRMED', label: 'Exit signal confirmed' },
  { type: 'DATA_UNAVAILABLE', label: 'Market data unavailable' },
  { type: 'CROSS_BULLISH', label: 'SMA50 crosses above SMA200' },
  { type: 'CROSS_BEARISH', label: 'SMA50 falls to or below SMA200' },
  { type: 'CROSS_REBALANCE_DUE', label: 'SMA50/SMA200 sleeve: monthly rebalance due (if followed)' },
  { type: 'MONTHLY_REBALANCE_DUE', label: 'Monthly 95/5: rebalance due (if followed)' },
];

export function emptySleeve(): SleeveDoc {
  return { shares: 0, avgCost: null, firstEntryDate: null, secondEntryDate: null, lastExitDate: null, lastExitSignalDate: null, lastTradeDate: null };
}

export function defaultPortfolio(): PortfolioDoc {
  return {
    v: 2, confirmed: false, currency: 'USD', totalEquity: null, equityRefPrice: null, shares: 0, avgCost: null, cash: null,
    feeFixed: 0, feePct: 0, usdMyr: null, firstEntryDate: null, secondEntryDate: null, lastExitDate: null, lastExitSignalDate: null, updatedAt: null,
    lastTradeDate: null, qqqShares: null, qqqRefPrice: null, sleeves: { SMA_CROSS: emptySleeve(), MONTHLY: emptySleeve() }, followed: ['CLAUDE_V2'],
  };
}

export function defaultSettings(): SettingsDoc {
  return {
    v: 1,
    params: { ...CLAUDE_V2_BASELINE },
    paramsUpdatedAt: null,
    cross: { ...SMA_CROSS_BASELINE },
    monthly: { ...MONTHLY_BASELINE },
    riskDrops: [20, 40, 60, 80],
    alerts: Object.fromEntries(ALERT_TYPES.map((a) => [a.type, true])),
    quoteRefreshMin: 2,
    approachBand: 0.5,
  };
}

const numOr = (x: unknown, d: number | null): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const strOr = (x: unknown): string | null => (typeof x === 'string' && x.length ? x : null);

const wholeOr0 = (x: unknown) => Math.max(0, Math.floor(numOr(x, 0) as number));

function readSleeve(raw: unknown): SleeveDoc {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const shares = wholeOr0(r.shares);
  return {
    shares,
    avgCost: shares > 0 ? numOr(r.avgCost, null) : null,
    firstEntryDate: strOr(r.firstEntryDate),
    secondEntryDate: strOr(r.secondEntryDate),
    lastExitDate: strOr(r.lastExitDate),
    lastExitSignalDate: strOr(r.lastExitSignalDate),
    lastTradeDate: strOr(r.lastTradeDate),
  };
}

/**
 * Read a stored portfolio defensively: unknown or malformed fields fall back to defaults. A V1
 * record (no sleeves) reads as the same Claude V2 holding with empty B and C sleeves; nothing is reset.
 */
export function readPortfolio(raw: Record<string, unknown> | undefined): PortfolioDoc {
  const d = defaultPortfolio();
  if (!raw) return d;
  const rs = (raw.sleeves && typeof raw.sleeves === 'object' ? raw.sleeves : {}) as Record<string, unknown>;
  const followed = Array.isArray(raw.followed) ? STRATEGY_IDS.filter((id) => (raw.followed as unknown[]).includes(id)) : ['CLAUDE_V2' as StrategyId];
  return {
    v: 2,
    confirmed: raw.confirmed === true,
    currency: raw.currency === 'MYR' ? 'MYR' : 'USD',
    totalEquity: numOr(raw.totalEquity, null),
    equityRefPrice: numOr(raw.equityRefPrice, null),
    shares: Math.max(0, Math.floor(numOr(raw.shares, 0) as number)),
    avgCost: numOr(raw.avgCost, null),
    cash: numOr(raw.cash, null),
    feeFixed: numOr(raw.feeFixed, 0) as number,
    feePct: numOr(raw.feePct, 0) as number,
    usdMyr: numOr(raw.usdMyr, null),
    firstEntryDate: strOr(raw.firstEntryDate),
    secondEntryDate: strOr(raw.secondEntryDate),
    lastExitDate: strOr(raw.lastExitDate),
    lastExitSignalDate: strOr(raw.lastExitSignalDate),
    updatedAt: strOr(raw.updatedAt),
    lastTradeDate: strOr(raw.lastTradeDate),
    qqqShares: raw.qqqShares === null || raw.qqqShares === undefined ? null : wholeOr0(raw.qqqShares),
    qqqRefPrice: numOr(raw.qqqRefPrice, null),
    sleeves: { SMA_CROSS: readSleeve(rs.SMA_CROSS), MONTHLY: readSleeve(rs.MONTHLY) },
    followed,
  };
}

/** One strategy's sleeve. Claude V2's is the original top-level holding. */
export function sleeveOf(p: PortfolioDoc, id: StrategyId): SleeveDoc {
  if (id === 'CLAUDE_V2') {
    return { shares: p.shares, avgCost: p.avgCost, firstEntryDate: p.firstEntryDate, secondEntryDate: p.secondEntryDate, lastExitDate: p.lastExitDate, lastExitSignalDate: p.lastExitSignalDate, lastTradeDate: p.lastTradeDate };
  }
  return p.sleeves[id];
}

export function withSleeve(p: PortfolioDoc, id: StrategyId, s: SleeveDoc): PortfolioDoc {
  if (id === 'CLAUDE_V2') {
    return { ...p, shares: s.shares, avgCost: s.avgCost, firstEntryDate: s.firstEntryDate, secondEntryDate: s.secondEntryDate, lastExitDate: s.lastExitDate, lastExitSignalDate: s.lastExitSignalDate, lastTradeDate: s.lastTradeDate };
  }
  return { ...p, sleeves: { ...p.sleeves, [id]: { ...s } } };
}

/** All TQQQ shares across the three sleeves. */
export function totalTqqqShares(p: PortfolioDoc): number {
  return p.shares + p.sleeves.SMA_CROSS.shares + p.sleeves.MONTHLY.shares;
}

export function sleevePosition(p: PortfolioDoc, id: StrategyId): SleevePosition {
  const s = sleeveOf(p, id);
  return { confirmed: p.confirmed, followed: p.followed.includes(id), shares: s.shares, lastTradeDate: s.lastTradeDate, entryDate: s.firstEntryDate };
}

export function readSettings(raw: Record<string, unknown> | undefined): SettingsDoc {
  const d = defaultSettings();
  if (!raw) return d;
  const rp = (raw.params ?? {}) as Record<string, unknown>;
  const params = { ...CLAUDE_V2_BASELINE } as StrategyParams;
  for (const k of PARAM_KEYS) {
    const v = rp[k];
    if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
  }
  const rc = (raw.cross ?? {}) as Record<string, unknown>;
  const cross = { ...SMA_CROSS_BASELINE } as CrossParams;
  for (const k of ['fast', 'slow', 'targetPct'] as const) if (typeof rc[k] === 'number' && Number.isFinite(rc[k])) cross[k] = rc[k] as number;
  const rm = (raw.monthly ?? {}) as Record<string, unknown>;
  const monthly = { ...MONTHLY_BASELINE } as MonthlyParams;
  if (typeof rm.targetPct === 'number' && Number.isFinite(rm.targetPct)) monthly.targetPct = rm.targetPct;
  const alerts = { ...d.alerts };
  const ra = (raw.alerts ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(alerts)) if (typeof ra[k] === 'boolean') alerts[k] = ra[k] as boolean;
  return {
    v: 1,
    params,
    paramsUpdatedAt: strOr(raw.paramsUpdatedAt),
    cross,
    monthly,
    riskDrops: Array.isArray(raw.riskDrops) && raw.riskDrops.length && raw.riskDrops.every((x) => typeof x === 'number' && x > 0 && x < 100)
      ? (raw.riskDrops as number[]).slice(0, 6) : d.riskDrops,
    alerts,
    quoteRefreshMin: [0, 1, 2, 5, 15].includes(raw.quoteRefreshMin as number) ? (raw.quoteRefreshMin as number) : d.quoteRefreshMin,
    approachBand: numOr(raw.approachBand, d.approachBand) as number,
  };
}

export function readTrades(raw: Record<string, unknown> | undefined): TradeDoc[] {
  const items = raw && Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  const out: TradeDoc[] = [];
  for (const r of items) {
    if (!r || typeof r !== 'object') continue;
    const side = r.side === 'SELL' ? 'SELL' : r.side === 'BUY' ? 'BUY' : null;
    const date = strOr(r.date);
    const shares = numOr(r.shares, null);
    const price = numOr(r.price, null);
    if (!side || !date || shares === null || price === null) continue;
    out.push({
      id: strOr(r.id) ?? `t${out.length}`,
      strategy: isStrategyId(r.strategy) || r.strategy === 'CORE' ? (r.strategy as Book) : 'CLAUDE_V2',
      symbol: r.symbol === 'QQQ' ? 'QQQ' : 'TQQQ',
      date,
      side,
      kind: TRADE_KINDS.includes(r.kind as TradeKind) ? (r.kind as TradeKind) : side === 'BUY' ? 'OTHER_BUY' : 'OTHER_SELL',
      shares,
      price,
      fee: numOr(r.fee, 0) as number,
      signalDate: strOr(r.signalDate),
      note: typeof r.note === 'string' ? r.note.slice(0, 280) : '',
      realizedUsd: numOr(r.realizedUsd, null),
      createdAt: strOr(r.createdAt) ?? '',
    });
  }
  return out.sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date < b.date ? -1 : 1));
}

export function readAlerts(raw: Record<string, unknown> | undefined): AlertRec[] {
  const items = raw && Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  return items
    .filter((r) => r && typeof r.key === 'string' && typeof r.type === 'string')
    .map((r) => ({ key: String(r.key), type: String(r.type), session: String(r.session ?? ''), text: String(r.text ?? ''), createdAt: String(r.createdAt ?? '') }));
}

/** Account-level sizing input: `shares` is every TQQQ share held, so equity is marked with all of them. */
export function portfolioInput(p: PortfolioDoc): PortfolioInput {
  return {
    currency: p.currency, totalEquity: p.totalEquity, equityRefPrice: p.equityRefPrice, shares: totalTqqqShares(p), avgCost: p.avgCost,
    cash: p.cash, feeFixed: p.feeFixed, feePct: p.feePct, usdMyr: p.usdMyr, qqqShares: p.qqqShares, qqqRefPrice: p.qqqRefPrice,
  };
}

/** Claude V2's view of its own sleeve (the original holding). */
export function positionOf(p: PortfolioDoc): UserPosition {
  return {
    confirmed: p.confirmed,
    shares: p.shares,
    firstEntryDate: p.firstEntryDate,
    secondEntryDate: p.secondEntryDate,
    lastExitDate: p.lastExitDate,
    lastExitSignalDate: p.lastExitSignalDate,
  };
}

export type TradeInput = Omit<TradeDoc, 'id' | 'createdAt' | 'realizedUsd' | 'strategy' | 'symbol'> & { strategy?: Book; symbol?: 'TQQQ' | 'QQQ' };

/**
 * Apply a confirmed real transaction to the holdings. Equity is re-marked at the trade price and
 * reduced by the fee; cash moves by the trade value plus or minus the fee. A TQQQ trade changes only
 * its own strategy's sleeve; a QQQ trade changes only the core.
 */
export function applyTrade(p: PortfolioDoc, tr: TradeInput, nowIso: string): { portfolio: PortfolioDoc; realizedUsd: number | null; error: string | null } {
  const book: Book = tr.strategy ?? 'CLAUDE_V2';
  const symbol = tr.symbol ?? 'TQQQ';
  if (!(tr.shares > 0) || !Number.isInteger(tr.shares)) return { portfolio: p, realizedUsd: null, error: 'Shares must be a whole number above zero.' };
  if (!(tr.price > 0)) return { portfolio: p, realizedUsd: null, error: 'Price must be above zero.' };
  if (symbol === 'QQQ' && book !== 'CORE') return { portfolio: p, realizedUsd: null, error: 'QQQ trades belong to the QQQ core.' };
  if (symbol === 'TQQQ' && book === 'CORE') return { portfolio: p, realizedUsd: null, error: 'Choose which strategy sleeve this TQQQ trade belongs to.' };
  const inp = portfolioInput(p);
  if (p.currency === 'MYR' && !(p.usdMyr && p.usdMyr > 0)) return { portfolio: p, realizedUsd: null, error: 'Enter the USD/MYR rate on the Portfolio page first.' };
  const value = tr.shares * tr.price;
  const cashUsd = toUsd(p.cash, inp);
  let next: PortfolioDoc = { ...p, confirmed: true, updatedAt: nowIso };
  let realized: number | null = null;

  if (symbol === 'QQQ') {
    const held = p.qqqShares ?? 0;
    if (tr.side === 'SELL' && tr.shares > held) return { portfolio: p, realizedUsd: null, error: `You hold ${held} QQQ shares; cannot sell ${tr.shares}. Enter your QQQ shares on the Portfolio page.` };
    const base = toUsd(p.totalEquity, inp);
    if (base !== null && base > 0) {
      const mark = held > 0 && p.qqqRefPrice && p.qqqRefPrice > 0 ? held * (tr.price - p.qqqRefPrice) : 0;
      next.totalEquity = fromUsd(base + mark - tr.fee, inp);
    }
    next.qqqShares = tr.side === 'BUY' ? held + tr.shares : held - tr.shares;
    next.qqqRefPrice = tr.price;
    if (cashUsd !== null) next.cash = fromUsd(tr.side === 'BUY' ? cashUsd - value - tr.fee : cashUsd + value - tr.fee, inp);
    return { portfolio: next, realizedUsd: null, error: null };
  }

  const id = book as StrategyId;
  const sl = sleeveOf(p, id);
  if (tr.side === 'SELL' && tr.shares > sl.shares) return { portfolio: p, realizedUsd: null, error: `This sleeve holds ${sl.shares} shares; cannot sell ${tr.shares}.` };
  const eqUsd = equityAt(inp, tr.price);
  if (eqUsd !== null) {
    next.totalEquity = fromUsd(eqUsd - tr.fee, inp);
    next.equityRefPrice = tr.price;
  }
  const s2: SleeveDoc = { ...sl, lastTradeDate: tr.date };
  if (tr.side === 'BUY') {
    const newShares = sl.shares + tr.shares;
    s2.avgCost = ((sl.avgCost ?? tr.price) * sl.shares + tr.price * tr.shares) / newShares;
    s2.shares = newShares;
    if (cashUsd !== null) next.cash = fromUsd(cashUsd - value - tr.fee, inp);
    if (sl.shares === 0) {
      s2.firstEntryDate = tr.date;
      s2.secondEntryDate = null;
    }
    if (tr.kind === 'ADD') s2.secondEntryDate = tr.date;
  } else {
    realized = sl.avgCost !== null ? tr.shares * (tr.price - sl.avgCost) - tr.fee : null;
    s2.shares = sl.shares - tr.shares;
    if (cashUsd !== null) next.cash = fromUsd(cashUsd + value - tr.fee, inp);
    if (s2.shares === 0) {
      s2.avgCost = null;
      s2.lastExitDate = tr.date;
      s2.lastExitSignalDate = tr.signalDate;
      s2.firstEntryDate = null;
      s2.secondEntryDate = null;
    }
  }
  next = withSleeve(next, id, s2);
  if (!next.followed.includes(id)) next.followed = STRATEGY_IDS.filter((x) => x === id || next.followed.includes(x));
  return { portfolio: next, realizedUsd: realized, error: null };
}

export function newAlerts(existing: AlertRec[], fired: { type: string; session: string; text: string }[], prefs: AlertPrefs, nowIso: string): AlertRec[] {
  const have = new Set(existing.map((a) => a.key));
  const out: AlertRec[] = [];
  for (const f of fired) {
    if (prefs[f.type] === false) continue;
    const key = `${f.type}:${f.session}`;
    if (have.has(key)) continue;
    have.add(key);
    out.push({ key, type: f.type, session: f.session, text: f.text, createdAt: nowIso });
  }
  return out;
}

// ---------- database binding

export interface SnapLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface DocLike {
  get(): Promise<SnapLike>;
  set(data: Record<string, unknown>): Promise<void>;
}
export interface DbLike {
  doc(path: string): DocLike;
}

export interface Loaded {
  portfolio: PortfolioDoc;
  trades: TradeDoc[];
  settings: SettingsDoc;
  alerts: AlertRec[];
}

export class UserStore {
  private base: string;
  private queue: Promise<unknown> = Promise.resolve();
  private db: DbLike;
  constructor(db: DbLike, uid: string) {
    this.db = db;
    this.base = `data/users/${uid}`;
  }
  private ref(name: string): DocLike {
    return this.db.doc(`${this.base}/${name}`);
  }
  async load(): Promise<Loaded> {
    const [p, t, s, a] = await Promise.all(['portfolio', 'trades', 'settings', 'alerts'].map((n) => this.ref(n).get()));
    return { portfolio: readPortfolio(p.data()), trades: readTrades(t.data()), settings: readSettings(s.data()), alerts: readAlerts(a.data()) };
  }
  /** Writes are serialised so one document never has two writes in flight. */
  private write(name: string, data: Record<string, unknown>): Promise<void> {
    const run = this.queue.then(() => this.ref(name).set(data));
    this.queue = run.catch(() => undefined);
    return run;
  }
  savePortfolio(p: PortfolioDoc): Promise<void> {
    return this.write('portfolio', { ...p, sleeves: { SMA_CROSS: { ...p.sleeves.SMA_CROSS }, MONTHLY: { ...p.sleeves.MONTHLY } }, followed: [...p.followed] });
  }
  saveTrades(items: TradeDoc[]): Promise<void> {
    return this.write('trades', { v: 1, items: items.map((t) => ({ ...t })) });
  }
  saveSettings(s: SettingsDoc): Promise<void> {
    return this.write('settings', { ...s, params: { ...s.params }, cross: { ...s.cross }, monthly: { ...s.monthly }, riskDrops: [...s.riskDrops], alerts: { ...s.alerts } });
  }
  saveAlerts(items: AlertRec[]): Promise<void> {
    return this.write('alerts', { v: 1, items: items.slice(-300).map((a) => ({ ...a })) });
  }
}
