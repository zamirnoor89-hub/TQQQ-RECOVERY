// Position sizing for the user's real account. All maths in USD; MYR is converted at the user's rate.
import type { StrategyParams } from './strategy.ts';

export type Currency = 'USD' | 'MYR';

export interface PortfolioInput {
  currency: Currency;
  totalEquity: number | null; // in `currency`; includes the TQQQ position valued at equityRefPrice
  equityRefPrice: number | null; // TQQQ price (USD) when total equity was last entered
  shares: number;
  avgCost: number | null; // USD per share
  cash: number | null; // cash available for investing, in `currency`
  feeFixed: number; // USD per order
  feePct: number; // % of trade value
  usdMyr: number | null; // MYR per 1 USD
  /** QQQ core shares, when entered. Marked to the QQQ price like TQQQ is, from qqqRefPrice. */
  qqqShares?: number | null;
  qqqRefPrice?: number | null; // QQQ price (USD) when total equity was last entered
}

export interface OrderPlan {
  shares: number;
  valueUsd: number;
  feeUsd: number;
  totalUsd: number;
  limitedByCash: boolean;
  targetUsd: number;
  neededUsd: number;
}

export interface AllocationResult {
  ok: boolean;
  problems: string[];
  priceUsd: number;
  valueUsd: number;
  equityUsd: number | null;
  cashUsd: number | null;
  weightPct: number | null;
  firstTargetUsd: number | null;
  fullTargetUsd: number | null;
  initial: OrderPlan | null;
  add: OrderPlan | null;
  trim: { shares: number; valueUsd: number; feeUsd: number; proceedsUsd: number; weightAfterPct: number | null } | null;
  exit: { shares: number; valueUsd: number; feeUsd: number; proceedsUsd: number };
  unrealizedUsd: number | null;
  unrealizedPct: number | null;
}

export function toUsd(amount: number | null, inp: PortfolioInput): number | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  if (inp.currency === 'USD') return amount;
  if (!inp.usdMyr || inp.usdMyr <= 0) return null;
  return amount / inp.usdMyr;
}

export function fromUsd(amountUsd: number | null, inp: PortfolioInput): number | null {
  if (amountUsd === null) return null;
  if (inp.currency === 'USD') return amountUsd;
  if (!inp.usdMyr || inp.usdMyr <= 0) return null;
  return amountUsd * inp.usdMyr;
}

export function orderFee(valueUsd: number, inp: Pick<PortfolioInput, 'feeFixed' | 'feePct'>): number {
  if (valueUsd <= 0) return 0;
  return inp.feeFixed + (valueUsd * inp.feePct) / 100;
}

/**
 * Equity with the TQQQ position marked to `priceUsd` and, when QQQ shares, a QQQ reference price and
 * `qqqPriceUsd` are all known, the QQQ core marked too. Other holdings stay as entered.
 */
export function equityAt(inp: PortfolioInput, priceUsd: number, qqqPriceUsd?: number | null): number | null {
  const base = toUsd(inp.totalEquity, inp);
  if (base === null || base <= 0) return null;
  const ref = inp.equityRefPrice;
  let eq = ref && ref > 0 ? base + inp.shares * (priceUsd - ref) : base;
  const qs = inp.qqqShares ?? 0;
  const qref = inp.qqqRefPrice ?? null;
  if (qs > 0 && qref && qref > 0 && qqqPriceUsd && qqqPriceUsd > 0) eq += qs * (qqqPriceUsd - qref);
  return eq;
}

export function weightAt(inp: PortfolioInput, priceUsd: number, qqqPriceUsd?: number | null): number | null {
  const eq = equityAt(inp, priceUsd, qqqPriceUsd);
  if (eq === null || eq <= 0) return null;
  return (inp.shares * priceUsd) / eq;
}

/** Weight of one strategy sleeve (part of the TQQQ shares) in total equity. */
export function sleeveWeightAt(inp: PortfolioInput, sleeveShares: number, priceUsd: number, qqqPriceUsd?: number | null): number | null {
  if (sleeveShares === 0) return 0;
  const eq = equityAt(inp, priceUsd, qqqPriceUsd);
  if (eq === null || eq <= 0) return null;
  return (sleeveShares * priceUsd) / eq;
}

/**
 * Whole-share purchase toward `targetPct` of equity. The position after the trade never exceeds the
 * target measured on post-fee equity, and the order never costs more than available cash.
 */
export function planBuy(targetPct: number, equityUsd: number, currentUsd: number, priceUsd: number, cashUsd: number | null, inp: PortfolioInput): OrderPlan {
  const targetUsd = (equityUsd * targetPct) / 100;
  const needed = Math.max(0, targetUsd - currentUsd);
  let shares = Math.floor(needed / priceUsd + 1e-9);
  const over = (n: number) => currentUsd + n * priceUsd > ((equityUsd - orderFee(n * priceUsd, inp)) * targetPct) / 100 + 1e-9;
  while (shares > 0 && over(shares)) shares -= 1;
  let limited = false;
  const cost = (n: number) => n * priceUsd + orderFee(n * priceUsd, inp);
  if (cashUsd !== null) {
    while (shares > 0 && cost(shares) > cashUsd + 1e-9) {
      shares -= 1;
      limited = true;
    }
  }
  const value = shares * priceUsd;
  const fee = orderFee(value, inp);
  return { shares, valueUsd: value, feeUsd: fee, totalUsd: value + fee, limitedByCash: limited, targetUsd, neededUsd: needed };
}

/**
 * Claude V2 sizing. `sleeve` is the part of the TQQQ holding that belongs to this strategy (all of
 * it when omitted); equity is always marked with the whole holding.
 */
export function computeAllocation(inp: PortfolioInput, priceUsd: number, p: StrategyParams, sleeve?: { shares: number; avgCost: number | null }, qqqPriceUsd?: number | null): AllocationResult {
  const problems: string[] = [];
  const own = sleeve ?? { shares: inp.shares, avgCost: inp.avgCost };
  if (!(priceUsd > 0)) problems.push('TQQQ price unavailable');
  if (!(own.shares >= 0) || !Number.isInteger(own.shares)) problems.push('TQQQ shares must be a whole number of zero or more');
  if (inp.currency === 'MYR' && !(inp.usdMyr && inp.usdMyr > 0)) problems.push('Enter the USD/MYR exchange rate');
  const value = own.shares * priceUsd;
  const equity = equityAt(inp, priceUsd, qqqPriceUsd);
  if (equity === null) problems.push('Enter total portfolio equity');
  const cashUsd = toUsd(inp.cash, inp);
  if (cashUsd === null) problems.push('Enter cash available for investing');
  const weight = equity ? value / equity : null;
  const firstTarget = equity ? (equity * p.firstAllocPct) / 100 : null;
  const fullTarget = equity ? (equity * p.targetAllocPct) / 100 : null;
  const canPrice = priceUsd > 0;

  const initial = equity !== null && canPrice ? planBuy(p.firstAllocPct, equity, value, priceUsd, cashUsd, inp) : null;
  const add = equity !== null && canPrice ? planBuy(p.targetAllocPct, equity, value, priceUsd, cashUsd, inp) : null;

  let trim: AllocationResult['trim'] = null;
  if (fullTarget !== null && weight !== null && canPrice && weight * 100 > p.trimThresholdPct) {
    const excess = value - fullTarget;
    const shares = Math.min(own.shares, Math.floor(excess / priceUsd + 1e-9));
    const v = shares * priceUsd;
    const fee = orderFee(v, inp);
    const eqAfter = equity !== null ? equity - fee : null;
    trim = { shares, valueUsd: v, feeUsd: fee, proceedsUsd: v - fee, weightAfterPct: eqAfter ? ((value - v) / eqAfter) * 100 : null };
  }
  const exitFee = orderFee(value, inp);
  const unrealized = own.avgCost && own.avgCost > 0 && own.shares > 0 && canPrice ? own.shares * (priceUsd - own.avgCost) : null;
  return {
    ok: problems.length === 0,
    problems,
    priceUsd,
    valueUsd: value,
    equityUsd: equity,
    cashUsd,
    weightPct: weight === null ? null : weight * 100,
    firstTargetUsd: firstTarget,
    fullTargetUsd: fullTarget,
    initial,
    add,
    trim,
    exit: { shares: own.shares, valueUsd: value, feeUsd: exitFee, proceedsUsd: value - exitFee },
    unrealizedUsd: unrealized,
    unrealizedPct: unrealized !== null && own.avgCost ? (priceUsd / own.avgCost - 1) * 100 : null,
  };
}

export interface SellPlan {
  shares: number;
  valueUsd: number;
  feeUsd: number;
  proceedsUsd: number;
  weightAfterPct: number | null;
}

/** Sizing for a sleeve held at a fixed target (strategies B and C). */
export interface SleevePlan {
  ok: boolean;
  problems: string[];
  priceUsd: number;
  sleeveShares: number;
  valueUsd: number;
  equityUsd: number | null;
  cashUsd: number | null;
  weightPct: number | null;
  targetPct: number;
  targetUsd: number | null;
  /** Purchase toward the target, whole shares, never above it after fees and never above cash. */
  buy: OrderPlan | null;
  /** Sale down to the target, whole shares rounded down. */
  sell: SellPlan | null;
  /** Signed shares that the rebalance trades (+ buy, − sell); 0 when within one share. */
  rebalanceShares: number | null;
  rebalanceValueUsd: number | null;
  /** Cost of the uncapped purchase, fees included (0 when the rebalance sells). */
  cashRequiredUsd: number | null;
  exit: SellPlan;
  unrealizedUsd: number | null;
  unrealizedPct: number | null;
}

export function planSleeve(inp: PortfolioInput, sleeve: { shares: number; avgCost: number | null }, priceUsd: number, targetPct: number, qqqPriceUsd?: number | null): SleevePlan {
  const problems: string[] = [];
  if (!(priceUsd > 0)) problems.push('TQQQ price unavailable');
  if (inp.currency === 'MYR' && !(inp.usdMyr && inp.usdMyr > 0)) problems.push('Enter the USD/MYR exchange rate');
  const equity = equityAt(inp, priceUsd, qqqPriceUsd);
  if (equity === null) problems.push('Enter total portfolio equity');
  const cashUsd = toUsd(inp.cash, inp);
  if (cashUsd === null) problems.push('Enter cash available for investing');
  const value = sleeve.shares * priceUsd;
  const weight = equity ? value / equity : null;
  const targetUsd = equity ? (equity * targetPct) / 100 : null;
  let buy: OrderPlan | null = null;
  let sell: SellPlan | null = null;
  let rebalanceShares: number | null = null;
  let rebalanceValueUsd: number | null = null;
  let cashRequiredUsd: number | null = null;
  if (equity !== null && targetUsd !== null && priceUsd > 0) {
    if (value < targetUsd) {
      buy = planBuy(targetPct, equity, value, priceUsd, cashUsd, inp);
      const uncapped = planBuy(targetPct, equity, value, priceUsd, null, inp);
      cashRequiredUsd = uncapped.totalUsd;
      rebalanceShares = buy.shares;
      rebalanceValueUsd = buy.valueUsd;
    } else {
      const shares = Math.min(sleeve.shares, Math.floor((value - targetUsd) / priceUsd + 1e-9));
      const v = shares * priceUsd;
      const fee = orderFee(v, inp);
      sell = { shares, valueUsd: v, feeUsd: fee, proceedsUsd: v - fee, weightAfterPct: ((value - v) / (equity - fee)) * 100 };
      cashRequiredUsd = 0;
      rebalanceShares = -shares;
      rebalanceValueUsd = -v;
    }
  }
  const exitFee = orderFee(value, inp);
  const unrealized = sleeve.avgCost && sleeve.avgCost > 0 && sleeve.shares > 0 && priceUsd > 0 ? sleeve.shares * (priceUsd - sleeve.avgCost) : null;
  return {
    ok: problems.length === 0,
    problems,
    priceUsd,
    sleeveShares: sleeve.shares,
    valueUsd: value,
    equityUsd: equity,
    cashUsd,
    weightPct: weight === null ? null : weight * 100,
    targetPct,
    targetUsd,
    buy,
    sell,
    rebalanceShares,
    rebalanceValueUsd,
    cashRequiredUsd,
    exit: { shares: sleeve.shares, valueUsd: value, feeUsd: exitFee, proceedsUsd: value - exitFee, weightAfterPct: 0 },
    unrealizedUsd: unrealized,
    unrealizedPct: unrealized !== null && sleeve.avgCost ? (priceUsd / sleeve.avgCost - 1) * 100 : null,
  };
}

// ---------- risk

export interface RiskScenario {
  tqqqDropPct: number;
  qqqDropPct: number; // the QQQ move that roughly corresponds, for context only
  lossUsd: number;
  lossPctOfEquity: number;
  tqqqOnlyLossUsd: number;
}

export interface RiskSummary {
  equityUsd: number;
  qqqUsd: number | null; // null when QQQ shares were not entered
  tqqqUsd: number;
  cashUsd: number | null;
  otherUsd: number | null; // equity not explained by QQQ, TQQQ and cash
  qqqPct: number | null;
  tqqqPct: number;
  cashPct: number | null;
  /** Approximate one-day Nasdaq-100 exposure: QQQ weight + 3 × TQQQ weight (% of equity). */
  effectivePct: number | null;
  tqqqContributionPct: number; // 3 × TQQQ weight
  concentration: 'ok' | 'elevated' | 'high';
  concentrationNote: string;
  scenarios: RiskScenario[];
}

/**
 * Exposure summary and simple shock scenarios. Each scenario applies a TQQQ decline together with
 * the QQQ decline that a steady (low-volatility) path would pair with it, 1 − (1 − d)^(1/3). Over a
 * single day the pairing is closer to d / 3; choppy paths sit in between and lose more to
 * volatility decay. These are illustrations, not forecasts.
 */
export function riskSummary(inp: PortfolioInput, tqqqPriceUsd: number, qqqPriceUsd: number | null, targetPct: number, drops: number[]): RiskSummary | null {
  const equity = equityAt(inp, tqqqPriceUsd, qqqPriceUsd);
  if (equity === null || equity <= 0 || !(tqqqPriceUsd > 0)) return null;
  const tqqqUsd = inp.shares * tqqqPriceUsd;
  const qs = inp.qqqShares ?? null;
  const qqqUsd = qs !== null && qs >= 0 && qqqPriceUsd && qqqPriceUsd > 0 ? qs * qqqPriceUsd : null;
  const cashUsd = toUsd(inp.cash, inp);
  const otherUsd = qqqUsd !== null && cashUsd !== null ? equity - qqqUsd - tqqqUsd - cashUsd : null;
  const tqqqPct = (tqqqUsd / equity) * 100;
  const qqqPct = qqqUsd === null ? null : (qqqUsd / equity) * 100;
  const effective = qqqPct === null ? null : qqqPct + 3 * tqqqPct;
  const concentration: RiskSummary['concentration'] = tqqqPct > Math.max(targetPct * 2, 10) ? 'high' : tqqqPct > targetPct * 1.2 + 1e-9 ? 'elevated' : 'ok';
  const concentrationNote = concentration === 'high'
    ? `TQQQ is ${tqqqPct.toFixed(1)}% of equity, more than twice the ${targetPct}% satellite target. Leveraged-fund losses at this size can dominate the portfolio.`
    : concentration === 'elevated'
      ? `TQQQ is ${tqqqPct.toFixed(1)}% of equity, above the ${targetPct}% target. Check whether more than one strategy sleeve is held.`
      : `TQQQ is ${tqqqPct.toFixed(1)}% of equity, within the ${targetPct}% satellite target.`;
  const scenarios = drops.map((d) => {
    const qd = (1 - Math.pow(1 - d / 100, 1 / 3)) * 100;
    const tLoss = tqqqUsd * (d / 100);
    const qLoss = (qqqUsd ?? 0) * (qd / 100);
    return { tqqqDropPct: d, qqqDropPct: qd, lossUsd: tLoss + qLoss, lossPctOfEquity: ((tLoss + qLoss) / equity) * 100, tqqqOnlyLossUsd: tLoss };
  });
  return {
    equityUsd: equity, qqqUsd, tqqqUsd, cashUsd, otherUsd, qqqPct, tqqqPct, cashPct: cashUsd === null ? null : (cashUsd / equity) * 100,
    effectivePct: effective, tqqqContributionPct: 3 * tqqqPct, concentration, concentrationNote, scenarios,
  };
}
