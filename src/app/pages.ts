// Page renderers. Every number shown here comes from validated Twelve Data candles, the user's own
// saved records, or a simulation that is labelled as one. Each strategy is shown from its own
// evaluation and its own sleeve; nothing on one strategy's page reads another's signals.
import type { Derived, Page, StrategyView, OrderLine } from './state.ts';
import {
  S, PAGES, derive, params, crossParams, monthlyParams, rerender, toast, persist, loadMarket, refreshQuotes, checkUsage, rebuildCache, loadDividends,
  backtestWindow, markerRun, allTqqqShares,
} from './state.ts';
import type { CheckItem, CheckStatus, StrategyParams, LiveEvaluation } from '../strategy.ts';
import { CLAUDE_V2_BASELINE, PARAM_KEYS, isBaseline, validateParams } from '../strategy.ts';
import type { Action, CrossParams, StrategyId } from '../strategies.ts';
import {
  MONTHLY_BASELINE, SMA_CROSS_BASELINE, STRATEGY_IDS, STRATEGY_META, crossEvents, isCrossBaseline, isMonthlyBaseline, validateCross, validateMonthly,
} from '../strategies.ts';
import type { Bar } from '../data.ts';
import { checkBacktestInputs } from '../data.ts';
import { computeAllocation, fromUsd, orderFee, planSleeve } from '../allocation.ts';
import type { PortfolioInput } from '../allocation.ts';
import type { Book, PortfolioDoc, SleeveDoc, TradeDoc, TradeKind } from '../store.ts';
import { ALERT_TYPES, KINDS_BY_BOOK, applyTrade, portfolioInput, readPortfolio, sleeveOf, withSleeve } from '../store.ts';
import type { BacktestConfig, BacktestResult, ModelResult } from '../backtest.ts';
import { MODEL_SPECS, equityCsv, lookaheadCheck, simulate, specOf, tradesCsv } from '../backtest.ts';
import { METHOD_MODELS, PERIODS, SMA_PAIRS, methodology, periodTable, sensitivity, walkForward } from '../research.ts';
import {
  etDate, fmtDate, fmtDateShort, fmtMyt, fmtMytTime, fmtMytWeekday, isTradingDay, isYmd, marketStatus, monthEndOnOrBefore, nextTradingDay, prevTradingDay, sessionTimes,
} from '../time.ts';
import type { ChartMarker } from '../ui/charts.ts';
import { LineChart, PriceChart, distanceSpark } from '../ui/charts.ts';
import type { Child } from '../ui/dom.ts';
import { MINUS, clear, fmtCompactUsd, fmtMoney, fmtNum, fmtPct, fmtUsd, h, icon, readNum, storageSet } from '../ui/dom.ts';

// ---------- shared bits

const ACTIONABLE: Action[] = ['BUY', 'ADD', 'TRIM', 'EXIT', 'REBALANCE'];

function tag(text: string, tone: string): HTMLElement {
  return h('span', { class: `tag tone-${tone}` }, text);
}

function statusText(s: CheckStatus, dataDown: boolean): string {
  return s === 'pass' ? 'PASS' : s === 'pending' ? 'PENDING' : s === 'fail' ? 'FAIL' : dataDown ? 'DATA UNAVAILABLE' : 'N/A';
}

function statusMark(s: CheckStatus): HTMLElement {
  const name = s === 'pass' ? 'check' : s === 'pending' ? 'dots' : s === 'fail' ? 'cross' : 'dash';
  const label = s === 'pass' ? 'Pass' : s === 'pending' ? 'Pending' : s === 'fail' ? 'Fail or risk triggered' : 'Unavailable or not applicable';
  return h('span', { class: `mark mark-${s}`, title: label, role: 'img', 'aria-label': label }, icon(name, 14));
}

function section(title: string, sub: Child, ...body: Child[]): HTMLElement {
  return h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', null, title), sub ? h('p', { class: 'panel-sub' }, sub) : null), ...body);
}

function kv(label: string, value: Child, cls = ''): HTMLElement {
  return h('div', { class: 'kv ' + cls }, h('dt', null, label), h('dd', null, value));
}

function nextSession(asOf: string | null): string | null {
  if (!asOf) return null;
  return nextTradingDay(asOf);
}

function fmtSession(date: string | null): string {
  if (!date) return '—';
  return `opens ${fmtMytWeekday(sessionTimes(date).openUtc)}`;
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = control.getAttribute('id') ?? '';
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, help ? h('small', null, help) : null);
}

function selectStrategy(id: StrategyId): void {
  S.strategy = id;
  storageSet('tqqq-strategy', id);
  rerender();
}

/** The A/B/C selector. Switching only changes what is shown; no record is touched. */
function strategyBar(d: Derived, note?: string): HTMLElement {
  return h('div', { class: 'strat-bar' },
    h('div', { class: 'strat-tabs', role: 'tablist', 'aria-label': 'Strategy' }, ...STRATEGY_IDS.map((id) => {
      const v = d.views[id];
      const on = S.strategy === id;
      return h('button', { type: 'button', role: 'tab', class: 'strat-tab' + (on ? ' on' : ''), 'aria-selected': on, onclick: () => selectStrategy(id) },
        h('span', { class: 'strat-letter' }, v.letter),
        h('span', { class: 'strat-name' }, STRATEGY_META[id].short),
        h('i', { class: `tab-dot tone-${v.tone}`, title: `${v.action}${v.followed ? '' : ' (monitoring)'}` }));
    })),
    note ? h('span', { class: 'strat-note' }, note) : null);
}

// ---------- header + nav

export function renderHeader(): HTMLElement {
  const ms = marketStatus(S.now);
  const d = derive();
  const phaseText =
    ms.phase === 'open' ? `closes ${fmtMytTime(ms.closeUtc as number)}` :
    ms.phase === 'pre' ? `opens ${fmtMytTime(ms.nextOpenUtc)}` :
    ms.phase === 'post' ? `next open ${fmtMytWeekday(ms.nextOpenUtc)}` :
    `opens ${fmtMytWeekday(ms.nextOpenUtc)}`;
  const connTone = S.conn.state === 'ok' ? 'ok' : S.conn.state === 'checking' ? 'wait' : 'err';
  const connLabel = S.conn.state === 'ok' ? 'Twelve Data connected' : S.conn.state === 'checking' ? 'Connecting…' : 'Twelve Data unavailable';
  const theme = document.documentElement.getAttribute('data-theme');
  const dark = theme ? theme === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  const lastCandle = S.qqq.report?.lastCompleted ?? null;
  return h('header', { class: 'top' },
    h('div', { class: 'brand' },
      logo(),
      h('div', { class: 'brand-text' }, h('strong', null, 'TQQQ Recovery V2.0'), h('span', null, 'Multi-Strategy Investment Dashboard'))),
    h('div', { class: 'status-row' },
      h('span', { class: `phase phase-${ms.phase}`, title: ms.detail }, h('i', { class: 'dot' }), h('b', null, `US market ${ms.label.toLowerCase()}`), h('span', null, ms.phase === 'holiday' ? ms.detail : phaseText)),
      h('span', { class: 'meta' }, h('span', null, 'Daily close'), h('b', null, lastCandle ? fmtDate(lastCandle) : '—'), d.status === 'awaiting' ? h('em', null, 'awaiting next') : null),
      h('span', { class: 'meta' }, h('span', null, 'Refreshed'), h('b', null, S.lastRefresh ? fmtMytTime(S.lastRefresh) : '—')),
      h('span', { class: `conn conn-${connTone}`, title: S.conn.message }, h('i', { class: 'dot' }), connLabel),
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Refresh market data', 'aria-label': 'Refresh market data', disabled: !S.rt?.market || S.loadingMarket, onclick: () => void loadMarket(false) }, icon('refresh', 18, 'ico' + (S.loadingMarket ? ' spin' : ''))),
        S.rt?.logout ? h('button', { class: 'icon-btn', type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: () => void S.rt?.logout?.() }, icon('logout', 18)) : null,
        h('button', { class: 'icon-btn', type: 'button', title: dark ? 'Switch to light mode' : 'Switch to dark mode', 'aria-label': dark ? 'Switch to light mode' : 'Switch to dark mode', onclick: () => {
          const next = dark ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          storageSet('tqqq-theme', next);
          rerender();
        } }, icon(dark ? 'sun' : 'moon', 18)))),
  );
}

function logo(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('width', '34');
  s.setAttribute('height', '34');
  s.setAttribute('class', 'logo');
  s.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    s.appendChild(e);
  };
  add('rect', { x: '1', y: '1', width: '30', height: '30', rx: '8', fill: 'var(--logo-bg)' });
  add('path', { d: 'M5 18.5h22', stroke: 'var(--sma)', 'stroke-width': '2', 'stroke-linecap': 'round' });
  add('path', { d: 'M5 14l5 6 4.5-3.5 4 2.5L27 8', fill: 'none', stroke: 'var(--bull)', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  add('circle', { cx: '27', cy: '8', r: '2.2', fill: 'var(--bull)' });
  return s;
}

export function renderNav(): HTMLElement {
  const d = derive();
  // The overview dot reflects actions due in strategies you follow (exit outranks everything).
  const due = STRATEGY_IDS.map((id) => d.views[id]).filter((v) => v.followed && ACTIONABLE.includes(v.action));
  const top = due.find((v) => v.action === 'EXIT') ?? due[0] ?? null;
  const modified = !isBaseline(params()) || !isCrossBaseline(crossParams()) || !isMonthlyBaseline(monthlyParams());
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    h('div', { class: 'tabs-inner' }, ...PAGES.map((p) => {
      return h('a', { href: '#' + p.id, class: 'tab' + (S.page === p.id ? ' on' : ''), 'aria-current': S.page === p.id ? 'page' : null },
        p.label,
        p.id === 'parameters' && modified ? h('i', { class: 'tab-dot tone-wait', title: 'Modified configuration' }) : null,
        p.id === 'overview' && top ? h('i', { class: `tab-dot tone-${top.tone}`, title: due.map((v) => `${v.letter}: ${v.action}`).join(' · ') }) : null);
    })));
}

export function renderBanners(): HTMLElement | null {
  const out: HTMLElement[] = [];
  if (S.conn.state !== 'ok' && S.conn.state !== 'checking') {
    out.push(h('div', { class: 'banner banner-err', role: 'status' }, icon('plug', 18), h('div', null, h('b', null, 'Market data unavailable. '), S.conn.message,
      S.conn.state === 'not_connected' ? h('span', null, ' Every strategy shows DATA UNAVAILABLE until Twelve Data answers.') : h('span', null, ' Signals shown are not current.'))));
  }
  if (S.storeState === 'unavailable' || S.storeState === 'readonly') {
    out.push(h('div', { class: 'banner banner-wait', role: 'status' }, icon('info', 18), h('div', null, h('b', null, 'Your records are not being saved. '), S.storeMsg)));
  }
  return out.length ? h('div', { class: 'banners' }, ...out) : null;
}

export function renderPage(page: Page): HTMLElement {
  switch (page) {
    case 'checklist': return pageChecklist();
    case 'trend': return pageTrend();
    case 'portfolio': return pagePortfolio();
    case 'backtest': return pageBacktest();
    case 'research': return pageResearch();
    case 'history': return pageHistory();
    case 'parameters': return pageSettings();
    default: return pageOverview();
  }
}

// ---------- Overview

function pageOverview(): HTMLElement {
  const d = derive();
  const v = d.views[S.strategy];
  const unavailable = v.action === 'DATA UNAVAILABLE';
  return h('div', { class: 'page page-overview' },
    h('section', { class: 'compare', 'aria-label': 'Strategy comparison' },
      h('div', { class: 'compare-head' },
        h('h2', null, 'Strategy comparison'),
        h('p', { class: 'panel-sub' }, 'Market signal: what each strategy’s rules recommend from completed Daily closes. Portfolio action: what to do given that strategy’s own recorded sleeve. Each is calculated independently; suggested trades are never assumed to have been executed.')),
      h('div', { class: 'strat-grid' }, ...STRATEGY_IDS.map((id) => strategyCard(d, id)))),
    strategyBar(d, `Showing ${STRATEGY_META[S.strategy].name}`),
    h('div', { class: 'ov-grid' },
      actionCard(d, v),
      qqqCard(d),
      tqqqCard(d, v),
      S.strategy === 'CLAUDE_V2' ? regimeCard(d) : S.strategy === 'SMA_CROSS' ? crossCard(d) : monthlyCard(d)),
    h('div', { class: 'ov-lower' },
      S.strategy === 'CLAUDE_V2' ? timelinePanel(d) : S.strategy === 'SMA_CROSS' ? crossTimeline(d) : monthlyTimeline(d),
      alertsPanel(d)),
    unavailable && d.issues.length ? section('Why data is unavailable', null, h('ul', { class: 'issues' }, ...d.issues.slice(0, 6).map((i) => h('li', null, i)))) : null,
  );
}

function strategyCard(d: Derived, id: StrategyId): HTMLElement {
  const v = d.views[id];
  const meta = STRATEGY_META[id];
  const on = S.strategy === id;
  const loading = d.status === 'loading' && S.conn.state === 'checking';
  const rows: HTMLElement[] = [];
  const p = params();
  // While today's candle is awaited, the rows show the last confirmed close's values.
  if (id === 'CLAUDE_V2') {
    const ce = d.evPrev ?? d.ev;
    const last = d.points.length ? d.points[d.points.length - 1] : null;
    const e2 = ce.entry.find((x) => x.id === 'e2');
    rows.push(
      kv('QQQ vs SMA200', last && last.dist !== null && ce.action !== 'DATA UNAVAILABLE' ? h('b', { class: last.dist >= 0 ? 'up' : 'down' }, fmtPct(last.dist)) : '—'),
      kv('Entry confirmation', e2 && ce.action !== 'DATA UNAVAILABLE' ? e2.status === 'pass' ? `Confirmed ${fmtDateShort(ce.confirmedOn ?? ce.asOf ?? '')}` : e2.detail : '—'),
      kv('Position stage', ce.action === 'DATA UNAVAILABLE' ? '—' : ce.state),
      kv('TQQQ target', `${p.firstAllocPct}% → ${p.targetAllocPct}%`));
  } else if (id === 'SMA_CROSS') {
    const c = d.crossPrev ?? d.cross;
    const cp = crossParams();
    const ok = c.regime !== 'DATA UNAVAILABLE';
    rows.push(
      kv(`SMA${cp.fast}`, ok && c.fast !== null ? fmtNum(c.fast) : '—'),
      kv(`SMA${cp.slow}`, ok && c.slow !== null ? fmtNum(c.slow) : '—'),
      kv(`SMA${cp.fast} vs SMA${cp.slow}`, ok ? h('b', { class: (c.spreadPct ?? 0) > 0 ? 'up' : 'down' }, `${fmtPct(c.spreadPct)} · ${c.regime === 'BULLISH' ? 'above' : 'at or below'}`) : '—'),
      kv('Crossover regime', ok ? `${c.regime} since ${fmtDateShort(c.regimeSince ?? '')}` : '—'),
      kv('TQQQ target', `${cp.targetPct}% while bullish`));
  } else {
    const m = d.monthlyPrev ?? d.monthly;
    const plan = d.plans.MONTHLY;
    const ok = m.action !== 'DATA UNAVAILABLE';
    const sh = plan?.ok ? plan.rebalanceShares : null;
    rows.push(
      kv('Current TQQQ weight', ok && m.weightPct !== null ? fmtPct(m.weightPct, 2, false) : '—'),
      kv('Target allocation', `${monthlyParams().targetPct}%`),
      kv('Next scheduled rebalance', ok && m.schedule ? `${fmtDateShort(m.schedule.nextExec)} open` : '—'),
      kv('Amount to buy or sell', !ok || sh === null ? '—' : sh === 0 ? 'None' : `${sh > 0 ? 'Buy' : 'Sell'} ${Math.abs(sh)} · ${fmtUsd(Math.abs(plan!.rebalanceValueUsd ?? 0), 0)}`));
  }
  return h('article', { class: `card strat-card tone-${v.tone}` + (on ? ' on' : '') },
    h('div', { class: 'card-eyebrow' }, h('span', null, `${meta.letter} · ${meta.short}`),
      v.modified ? tag('Modified', 'wait') : null,
      tag(v.followed ? 'Followed' : 'Monitoring', v.followed ? 'hold' : 'na')),
    h('div', { class: 'sc-block' },
      h('span', { class: 'sc-k' }, 'Market signal'),
      loading ? h('b', { class: 'sc-sig' }, 'LOADING') : tag(v.signal.label, v.signal.tone),
      h('p', { class: 'sc-detail' }, loading ? 'Reading completed Daily candles…' : v.signal.detail)),
    h('div', { class: 'sc-block' },
      h('span', { class: 'sc-k' }, 'Portfolio action'),
      h('b', { class: 'sc-action' }, loading ? '—' : v.action),
      h('p', { class: 'sc-detail' }, loading ? '' : v.prevAction
        ? `Today’s Daily candle is not validated yet. Last confirmed action (${fmtDateShort(v.asOf ?? '')} close): ${v.prevAction}.`
        : v.followed ? v.headline : `Not followed with real money. For a new sleeve: ${v.headline.charAt(0).toLowerCase()}${v.headline.slice(1)}`)),
    h('dl', { class: 'kvs' }, ...rows),
    h('footer', { class: 'action-foot' },
      h('span', null, v.asOf ? `${fmtDate(v.asOf)} close` : 'No validated close'),
      on ? h('span', { class: 'muted' }, 'Shown below') : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => selectStrategy(id) }, 'View details')));
}

function actionCard(d: Derived, v: StrategyView): HTMLElement {
  const loading = d.status === 'loading' && S.conn.state === 'checking';
  const next = nextSession(v.asOf);
  const stateTag = v.id === 'CLAUDE_V2' ? d.ev.state : v.id === 'SMA_CROSS' ? d.cross.regime : v.signal.label;
  const rule = v.id === 'CLAUDE_V2' ? d.ev.activeRule : v.id === 'SMA_CROSS' ? `SMA${crossParams().fast}/SMA${crossParams().slow} rotation` : 'Monthly rebalance';
  return h('article', { class: `card action-card tone-${v.tone}`, 'aria-live': 'polite' },
    h('div', { class: 'card-eyebrow' }, h('span', null, `${v.letter} · ${STRATEGY_META[v.id].short} · portfolio action`), tag(stateTag, v.tone), v.modified ? tag('Modified configuration', 'wait') : null, !v.followed ? tag('Monitoring only', 'na') : null),
    h('div', { class: 'action-word' }, loading ? 'LOADING' : v.action),
    h('p', { class: 'action-headline' }, loading ? 'Reading completed Daily candles from Twelve Data…' : v.headline),
    loading ? null : h('ul', { class: 'reasons' }, ...v.reasons.map((r) => h('li', null, r))),
    !loading ? h('p', { class: 'signal-line' }, h('span', null, 'Market signal '), tag(v.signal.label, v.signal.tone), h('span', null, ` ${v.signal.detail}`)) : null,
    !v.followed && !loading ? h('p', { class: 'prev' }, 'You do not follow this strategy with real money, so its sleeve is empty and the action describes a new sleeve. Follow it on the Portfolio page to track your own holdings.') : null,
    v.prevAction ? h('p', { class: 'prev' }, `Last confirmed action (${fmtDate(v.asOf)} close): `, h('b', null, v.prevAction), '. It stays in force until the new candle is validated.') : null,
    orderLine(d, v),
    h('footer', { class: 'action-foot' },
      h('span', null, v.asOf ? `As of the ${fmtDate(v.asOf)} close · ${rule}` : 'No validated close'),
      next && v.action !== 'DATA UNAVAILABLE' ? h('span', null, `Next session ${fmtSession(next)}`) : null),
  );
}

function orderLine(d: Derived, v: StrategyView): HTMLElement | null {
  if (!ACTIONABLE.includes(v.action)) return null;
  const o = v.order;
  if (!o) {
    if (!v.orderProblem) return null;
    return h('div', { class: 'order order-missing' }, h('span', null, 'To size this order, complete your holdings on the '), h('a', { href: '#portfolio' }, 'Portfolio page'), h('span', null, ` (${v.orderProblem.toLowerCase()}).`));
  }
  return h('div', { class: 'order' },
    h('div', { class: 'order-main' },
      h('span', { class: 'order-k' }, 'Suggested order · not placed'),
      h('b', null, `${o.side === 'BUY' ? 'Buy' : 'Sell'} ${o.shares} TQQQ`),
      h('span', null, `≈ ${fmtUsd(o.valueUsd)} + ${fmtUsd(o.feeUsd)} fee, ${o.note}. Priced from the ${d.priceLabel}; executes at the next regular session’s open.`)),
    o.shares > 0 ? recordButton(v.id, o) : h('span', { class: 'muted' }, 'Nothing to trade at whole-share size.'),
  );
}

function recordButton(id: StrategyId, o: OrderLine): HTMLElement {
  return h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openTradeModal(o.kind, o.shares, undefined, id, o.side) }, 'Record execution');
}

function quoteIsLive(): boolean {
  const ph = marketStatus(S.now).phase;
  return ph === 'open' || ph === 'pre' || ph === 'post';
}

function qqqCard(d: Derived): HTMLElement {
  const last = d.points.length ? d.points[d.points.length - 1] : null;
  const prev = d.points.length > 1 ? d.points[d.points.length - 2] : null;
  const q = S.quotes.QQQ;
  const ok = d.ev.action !== 'DATA UNAVAILABLE' || d.status === 'awaiting';
  const confChange = last && prev ? (last.c / prev.c - 1) * 100 : null;
  const cp = d.crossPts.length ? d.crossPts[d.crossPts.length - 1] : null;
  const fastLabel = `SMA${crossParams().fast}`;
  return h('article', { class: 'card tick-card' },
    h('div', { class: 'card-eyebrow' }, h('span', null, 'QQQ · signal asset'), q ? tag(quoteIsLive() ? 'Live' : 'Last quote', quoteIsLive() ? 'live' : 'na') : null),
    h('div', { class: 'big-price' }, q ? fmtNum(q.price) : '—', q && q.percentChange !== null ? h('span', { class: 'chg ' + (q.percentChange >= 0 ? 'up' : 'down') }, fmtPct(q.percentChange)) : null),
    h('p', { class: 'tick-note' }, q ? `${quoteIsLive() ? 'Live indicative quote' : 'Last quote'} · ${fmtMytTime(q.timestampMs ?? (S.quotes.at as number))}. Not used for signals.` : 'Live quote unavailable'),
    h('dl', { class: 'kvs' },
      kv('Confirmed Daily close', last && ok ? h('span', null, fmtNum(last.c), h('small', null, ` ${fmtDateShort(last.d)}`)) : 'DATA UNAVAILABLE'),
      kv('Daily change (confirmed)', ok && confChange !== null ? h('span', { class: confChange >= 0 ? 'up' : 'down' }, fmtPct(confChange)) : '—'),
      kv(fastLabel, cp && cp.fast !== null && ok ? fmtNum(cp.fast) : '—'),
      kv(`SMA${params().smaPeriod}`, last && last.sma && ok ? fmtNum(last.sma) : '—'),
      kv(`Distance from SMA${params().smaPeriod}`, last && last.dist !== null && ok ? h('b', { class: last.dist >= 0 ? 'up' : 'down' }, fmtPct(last.dist)) : '—')),
  );
}

function tqqqCard(d: Derived, v: StrategyView): HTMLElement {
  const q = S.quotes.TQQQ;
  const pf = S.data.portfolio;
  const sl = sleeveOf(pf, v.id);
  const held = sl.shares > 0;
  const total = allTqqqShares();
  const inp = portfolioInput(pf);
  const price = d.priceUsd;
  const unreal = held && price !== null && sl.avgCost ? sl.shares * (price - sl.avgCost) : null;
  return h('article', { class: 'card tick-card' },
    h('div', { class: 'card-eyebrow' }, h('span', null, 'TQQQ · investment asset'), q ? tag(quoteIsLive() ? 'Live' : 'Last quote', quoteIsLive() ? 'live' : 'na') : null),
    h('div', { class: 'big-price' }, q ? fmtNum(q.price) : d.tqqqClose ? fmtNum(d.tqqqClose) : '—', q && q.percentChange !== null ? h('span', { class: 'chg ' + (q.percentChange >= 0 ? 'up' : 'down') }, fmtPct(q.percentChange)) : null),
    h('p', { class: 'tick-note' }, q ? `${quoteIsLive() ? 'Live indicative quote' : 'Last quote'} · ${fmtMytTime(q.timestampMs ?? (S.quotes.at as number))}` : d.tqqqClose ? `Confirmed close ${fmtDateShort(d.tqqqCloseDate as string)}` : 'Price unavailable'),
    h('dl', { class: 'kvs' },
      kv(`${v.letter} sleeve`, !pf.confirmed ? h('a', { href: '#portfolio' }, 'Not confirmed yet') : held ? `${sl.shares} shares` : 'None held'),
      kv('Sleeve value', held && price !== null ? fmtMoney(fromUsd(sl.shares * price, inp), pf.currency) : held ? '—' : fmtMoney(0, pf.currency)),
      kv('Sleeve weight of equity', v.weightPct !== null ? h('b', { class: v.id === 'CLAUDE_V2' && v.weightPct > params().trimThresholdPct ? 'warnc' : '' }, fmtPct(v.weightPct, 2, false)) : '—'),
      kv('Unrealised P/L', unreal !== null ? h('span', { class: unreal >= 0 ? 'up' : 'down' }, `${fmtUsd(unreal)} (${fmtPct((price! / sl.avgCost! - 1) * 100)})`) : '—'),
      total !== sl.shares ? kv('All TQQQ (every sleeve)', `${total} shares${d.risk ? ` · ${fmtPct(d.risk.tqqqPct, 2, false)}` : ''}`) : null),
  );
}

function regimeCard(d: Derived): HTMLElement {
  const p = params();
  const ev = d.ev;
  const regime = d.status === 'awaiting' && d.evPrev ? d.evPrev.regime : ev.regime;
  const tone = regime === 'BULLISH' ? 'bull' : regime === 'BEARISH' ? 'risk' : regime === 'NEUTRAL' ? 'wait' : 'na';
  const last = d.points.length ? d.points[d.points.length - 1] : null;
  const recent = d.points.slice(-126).filter((x) => x.dist !== null);
  return h('article', { class: `card regime-card tone-${tone}` },
    h('div', { class: 'card-eyebrow' }, h('span', null, 'Claude V2 regime'), h('span', { class: 'muted' }, 'QQQ vs SMA200')),
    h('div', { class: 'regime-row' },
      h('div', { class: 'regime-word' }, regime),
      last && last.dist !== null && regime !== 'DATA UNAVAILABLE' ? gauge(last.dist, d.live ? d.live.dist : null, p) : null),
    h('ul', { class: 'regime-key' },
      h('li', { class: regime === 'BULLISH' ? 'on' : '' }, h('i', { class: 'sw bull' }), h('b', null, 'Bullish'), ` close at or above +${p.entryBufferPct}%`),
      h('li', { class: regime === 'NEUTRAL' ? 'on' : '' }, h('i', { class: 'sw wait' }), h('b', null, 'Neutral'), ` between ${MINUS}${p.exitBufferPct}% and +${p.entryBufferPct}%`),
      h('li', { class: regime === 'BEARISH' ? 'on' : '' }, h('i', { class: 'sw risk' }), h('b', null, 'Bearish'), ` close at or below ${MINUS}${p.exitBufferPct}% (exit zone)`)),
    recent.length > 20 ? h('figure', { class: 'spark-wrap' },
      distanceSpark(recent.map((x) => x.dist as number), recent.map((x) => x.d), p.entryBufferPct, p.exitBufferPct),
      h('figcaption', null, `Distance from SMA200, last ${recent.length} completed sessions`)) : null,
    d.live ? h('p', { class: 'pending-line' }, tag('Pending', 'wait'), ` Live ${fmtPct(d.live.dist)} vs an SMA200 that includes today’s live price. The Daily candle is incomplete, so this is not a signal.`) : null,
  );
}

function crossCard(d: Derived): HTMLElement {
  const c = d.crossPrev ?? d.cross;
  const cp = crossParams();
  const tone = c.regime === 'BULLISH' ? 'bull' : c.regime === 'BEARISH' ? 'risk' : 'na';
  const recent = d.crossPts.slice(-252).filter((x) => x.fast !== null && x.slow !== null);
  const spreads = recent.map((x) => ((x.fast as number) / (x.slow as number) - 1) * 100);
  return h('article', { class: `card regime-card tone-${tone}` },
    h('div', { class: 'card-eyebrow' }, h('span', null, 'Crossover regime'), h('span', { class: 'muted' }, `SMA${cp.fast} vs SMA${cp.slow}`)),
    h('div', { class: 'regime-row' },
      h('div', { class: 'regime-word' }, c.regime),
      c.regime !== 'DATA UNAVAILABLE' ? h('dl', { class: 'kvs cross-kvs' },
        kv(`SMA${cp.fast}`, fmtNum(c.fast)), kv(`SMA${cp.slow}`, fmtNum(c.slow)), kv('Spread', h('b', { class: (c.spreadPct ?? 0) > 0 ? 'up' : 'down' }, fmtPct(c.spreadPct))),
        kv('Since', c.regimeSince ? fmtDate(c.regimeSince) : '—')) : null),
    h('ul', { class: 'regime-key' },
      h('li', { class: c.regime === 'BULLISH' ? 'on' : '' }, h('i', { class: 'sw bull' }), h('b', null, 'Bullish'), ` SMA${cp.fast} strictly above SMA${cp.slow}: hold ${cp.targetPct}% TQQQ`),
      h('li', { class: c.regime === 'BEARISH' ? 'on' : '' }, h('i', { class: 'sw risk' }), h('b', null, 'Bearish'), ` SMA${cp.fast} at or below SMA${cp.slow}: sleeve in cash`)),
    spreads.length > 20 ? h('figure', { class: 'spark-wrap' },
      distanceSpark(spreads, recent.map((x) => x.d), 0, 0),
      h('figcaption', null, `SMA${cp.fast} minus SMA${cp.slow} (% of SMA${cp.slow}), last ${spreads.length} completed sessions`)) : null,
    h('p', { class: 'fine' }, 'Moving-average crossovers lag turning points. A bearish crossover often comes after much of a decline, so the rule limits exposure in long downtrends but does not protect against sudden losses.'),
  );
}

function monthlyCard(d: Derived): HTMLElement {
  const m = d.monthlyPrev ?? d.monthly;
  const mp = monthlyParams();
  const tone = m.action === 'DATA UNAVAILABLE' ? 'na' : m.action === 'REBALANCE' || m.action === 'BUY' ? 'wait' : 'hold';
  const w = m.weightPct;
  const scale = Math.max(mp.targetPct * 2, (w ?? 0) * 1.1, 1);
  const pos = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  return h('article', { class: `card regime-card tone-${tone}` },
    h('div', { class: 'card-eyebrow' }, h('span', null, 'Allocation drift'), h('span', { class: 'muted' }, 'No trend signals')),
    h('div', { class: 'regime-row' },
      h('div', { class: 'regime-word' }, w === null ? '—' : fmtPct(w, 2, false)),
      w !== null ? h('div', { class: 'gauge', role: 'img', 'aria-label': `TQQQ weight ${w.toFixed(2)}% against a ${mp.targetPct}% target` },
        h('div', { class: 'gauge-value' }, h('span', null, `TQQQ weight vs ${mp.targetPct}% target`), h('b', null, `${(m.driftPts ?? 0) >= 0 ? '+' : MINUS}${Math.abs(m.driftPts ?? 0).toFixed(2)} pts`)),
        h('div', { class: 'gauge-track' }, h('span', { class: 'gz gz-wait', style: `left:0;width:${pos(w)}` }), h('span', { class: 'gauge-pin', style: `left:${pos(mp.targetPct)}` })),
        h('div', { class: 'gauge-scale' }, h('span', null, '0%'), h('span', { style: `left:${pos(mp.targetPct)}` }, `target ${mp.targetPct}%`), h('span', null, `${scale.toFixed(0)}%`))) : null),
    h('dl', { class: 'kvs kvs-2' },
      kv('Last month-end close', m.schedule ? fmtDate(m.schedule.signalDate) : '—'),
      kv('Its rebalance', m.schedule ? `${fmtDateShort(m.schedule.execDate)} open · ${m.schedule.done ? 'recorded' : m.schedule.overdue ? 'not recorded' : 'due'}` : '—'),
      kv('Next month-end close', m.schedule ? fmtDate(m.schedule.nextSignal) : '—'),
      kv('Next rebalance', m.schedule ? `${fmtDateShort(m.schedule.nextExec)} open` : '—')),
    h('p', { class: 'fine' }, `Weights drift between month-ends. The sleeve is never sold for market conditions, so in a bear market it is topped back up to ${mp.targetPct}% each month: rebalancing buys TQQQ after it falls.`),
  );
}

function gauge(dist: number, live: number | null, p: StrategyParams): HTMLElement {
  const lo = -10, hi = 10;
  const pos = (v: number) => `${((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100}%`;
  return h('div', { class: 'gauge', role: 'img', 'aria-label': `QQQ is ${fmtPct(dist)} from SMA200` },
    h('div', { class: 'gauge-value' }, h('span', null, 'Last close vs SMA200'), h('b', null, fmtPct(dist))),
    h('div', { class: 'gauge-track' },
      h('span', { class: 'gz gz-risk', style: `left:0;width:${pos(-p.exitBufferPct)}` }),
      h('span', { class: 'gz gz-wait', style: `left:${pos(-p.exitBufferPct)};width:calc(${pos(p.entryBufferPct)} - ${pos(-p.exitBufferPct)})` }),
      h('span', { class: 'gz gz-bull', style: `left:${pos(p.entryBufferPct)};right:0` }),
      live !== null ? h('span', { class: 'gauge-live', style: `left:${pos(live)}`, title: `Live ${fmtPct(live)} (pending)` }) : null,
      h('span', { class: 'gauge-pin', style: `left:${pos(dist)}` })),
    h('div', { class: 'gauge-scale' }, h('span', null, `${MINUS}10%`), h('span', { style: `left:${pos(-p.exitBufferPct)}` }, `${MINUS}${p.exitBufferPct}`), h('span', { style: `left:${pos(0)}` }, 'SMA'), h('span', { style: `left:${pos(p.entryBufferPct)}` }, `+${p.entryBufferPct}`), h('span', null, '+10%')));
}

function lastTradeLine(book: Book): string {
  const t = [...S.data.trades].reverse().find((x) => x.strategy === book);
  return t ? `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.shares} ${t.symbol} on ${fmtDateShort(t.date)} (your trade)` : '—';
}

function steps(items: [string, string][], cur: string, done: (i: number, curIdx: number) => boolean, unavailable: boolean, riskIds: string[] = []): HTMLElement {
  const curIdx = items.findIndex((s) => s[0] === cur);
  return h('ol', { class: 'timeline' + (unavailable ? ' dim' : ''), style: `--n:${items.length}` }, ...items.map(([id, label], i) => {
    const state = unavailable ? '' : i === curIdx ? 'now' : done(i, curIdx) ? 'done' : '';
    return h('li', { class: `tl-step ${state} ${riskIds.includes(id) && i === curIdx ? 'risk' : ''}` }, h('span', { class: 'tl-dot' }), h('span', { class: 'tl-label' }, label));
  }));
}

function timelinePanel(d: Derived): HTMLElement {
  const ev = d.ev;
  const p = params();
  const stages: [LiveEvaluation['stage'], string][] = [
    ['WAITING', 'Waiting'], ['CONFIRMED', 'Confirmed'], ['BUY', `Buy ${p.firstAllocPct}%`], ['WAIT_SESSIONS', `Wait ${p.addWaitSessions} sessions`],
    ['ADD', `Add to ${p.targetAllocPct}%`], ['HOLD', 'Hold'], ['EXIT', 'Exit'],
  ];
  const pf = S.data.portfolio;
  const holding = pf.shares > 0;
  const lastAlert = S.data.alerts.length ? S.data.alerts[S.data.alerts.length - 1] : null;
  const unavailable = ev.action === 'DATA UNAVAILABLE';
  const lastTrade = [...S.data.trades].reverse().find((x) => x.strategy === 'CLAUDE_V2') ?? null;
  return section('Claude V2 recovery cycle', unavailable ? 'Shown once market data is validated.' : holding ? 'Your active cycle, from your recorded entry.' : 'The current qualifying run and your next step.',
    steps(stages, ev.stage, (i, c) => i < c, unavailable, ['EXIT']),
    h('dl', { class: 'kvs kvs-2' },
      kv('Qualifying run began', ev.runStart ? fmtDate(ev.runStart) : '—'),
      kv('Confirmation date', ev.confirmedOn ? fmtDate(ev.confirmedOn) : '—'),
      kv('First entry date', pf.firstEntryDate ? fmtDate(pf.firstEntryDate) : holding ? 'Not recorded' : '—'),
      kv('Trading sessions elapsed', ev.sessionsElapsed !== null ? `${ev.sessionsElapsed} of ${p.addWaitSessions}` : '—'),
      kv('Next eligible second entry', pf.secondEntryDate ? `Done ${fmtDate(pf.secondEntryDate)}` : ev.nextAddDate ? `${fmtDate(ev.nextAddDate)} close` : '—'),
      kv('Current active rule', ev.activeRule),
      kv('Latest action event', lastTrade && (!lastAlert || lastTrade.createdAt >= lastAlert.createdAt)
        ? lastTradeLine('CLAUDE_V2')
        : lastAlert ? `${lastAlert.text} (${fmtDateShort(lastAlert.session)})` : '—'),
      ev.exitTriggeredOn ? kv('Exit triggered', h('b', { class: 'down' }, fmtDate(ev.exitTriggeredOn))) : null),
  );
}

function crossTimeline(d: Derived): HTMLElement {
  const c = d.crossPrev ?? d.cross;
  const cp = crossParams();
  const sl = sleeveOf(S.data.portfolio, 'SMA_CROSS');
  const holding = sl.shares > 0;
  const unavailable = c.regime === 'DATA UNAVAILABLE';
  const items: [string, string][] = [['CASH', 'Bearish · cash'], ['CROSS_UP', `SMA${cp.fast} crosses above`], ['BUY', `Buy ${cp.targetPct}%`], ['HOLD', 'Hold · monthly reset'], ['CROSS_DOWN', `SMA${cp.fast} at/below`], ['EXIT', 'Exit sleeve']];
  const cur = unavailable ? '' : c.regime === 'BEARISH' ? (holding ? 'EXIT' : 'CASH') : holding ? 'HOLD' : c.lastCross?.signalDate === c.asOf ? 'CROSS_UP' : 'BUY';
  const evs = d.crossPts.length ? crossEvents(d.crossPts) : [];
  const lastBull = [...evs].reverse().find((e) => e.kind === 'BULLISH_CROSS');
  const lastBear = [...evs].reverse().find((e) => e.kind === 'BEARISH_CROSS');
  return section('SMA crossover cycle', unavailable ? 'Shown once market data is validated.' : 'Regime from completed closes; sleeve state from your records.',
    steps(items, cur, (i, ci) => (cur === 'EXIT' ? i < ci : cur === 'CASH' ? false : i < ci), unavailable, ['EXIT']),
    h('dl', { class: 'kvs kvs-2' },
      kv('Current regime', unavailable ? '—' : `${c.regime} since ${fmtDate(c.regimeSince)}`),
      kv('Spread', unavailable ? '—' : fmtPct(c.spreadPct)),
      kv('Latest bullish crossover', lastBull ? `${fmtDate(lastBull.signalDate)} close` : '—'),
      kv('Latest bearish crossover', lastBear ? `${fmtDate(lastBear.signalDate)} close` : '—'),
      kv('Sleeve entry date', sl.firstEntryDate ? fmtDate(sl.firstEntryDate) : holding ? 'Not recorded' : '—'),
      kv('Next monthly check', c.schedule ? `${fmtDate(c.schedule.nextSignal)} close` : '—'),
      kv('Latest action event', lastTradeLine('SMA_CROSS'))));
}

function monthlyTimeline(d: Derived): HTMLElement {
  const m = d.monthlyPrev ?? d.monthly;
  const sl = sleeveOf(S.data.portfolio, 'MONTHLY');
  const unavailable = m.action === 'DATA UNAVAILABLE' || !m.schedule;
  const items: [string, string][] = [['SIGNAL', 'Month-end close'], ['EXEC', 'Rebalance at next open'], ['DRIFT', 'Weights drift'], ['NEXT', 'Next month-end']];
  const s = m.schedule;
  const cur = unavailable ? '' : sl.shares === 0 ? 'EXEC' : s && !s.done ? 'EXEC' : 'DRIFT';
  return section('Monthly rebalance cycle', unavailable ? 'Shown once market data is validated.' : 'Calendar-driven; no market signal can skip or add a rebalance.',
    steps(items, cur, (i, ci) => i < ci, unavailable),
    h('dl', { class: 'kvs kvs-2' },
      kv('Month-end signal close', s ? fmtDate(s.signalDate) : '—'),
      kv('Execution open', s ? fmtDate(s.execDate) : '—'),
      kv('Recorded', s ? (s.done ? `Yes (${fmtDateShort(sl.lastTradeDate ?? '')})` : s.overdue ? 'No — overdue' : 'Not yet') : '—'),
      kv('Next month-end close', s ? fmtDate(s.nextSignal) : '—'),
      kv('Then executes', s ? `${fmtDate(s.nextExec)} open` : '—'),
      kv('Latest action event', lastTradeLine('MONTHLY'))));
}

function alertsPanel(d: Derived): HTMLElement {
  const pending: { text: string }[] = [];
  const p = params();
  const band = S.data.settings.approachBand;
  if (d.live && S.strategy === 'CLAUDE_V2') {
    if (d.live.qual && !(d.points.length && d.points[d.points.length - 1].qual)) pending.push({ text: `QQQ is above +${p.entryBufferPct}% live (${fmtPct(d.live.dist)}). A qualifying close is not confirmed until the session ends.` });
    else if (!d.live.qual && d.live.dist >= p.entryBufferPct - band) pending.push({ text: `QQQ is approaching +${p.entryBufferPct}% live (${fmtPct(d.live.dist)}).` });
    if (d.live.exit && S.data.portfolio.shares > 0) pending.push({ text: `QQQ is at or below ${MINUS}${p.exitBufferPct}% live (${fmtPct(d.live.dist)}). The exit needs a completed close.` });
    else if (!d.live.exit && d.live.dist <= -p.exitBufferPct + band) pending.push({ text: `QQQ is approaching ${MINUS}${p.exitBufferPct}% live (${fmtPct(d.live.dist)}).` });
  }
  const recent = [...S.data.alerts].reverse().slice(0, 8);
  return section('Alerts', 'All strategies. In-app only, checked while this page is open. No background notifications are set up.',
    pending.length || recent.length
      ? h('ul', { class: 'alerts' },
        ...pending.map((a) => h('li', { class: 'alert pending' }, tag('Pending', 'wait'), h('span', null, a.text))),
        ...recent.map((a) => h('li', { class: 'alert' }, h('span', { class: 'alert-date' }, fmtDateShort(a.session)), h('span', null, a.text))))
      : h('p', { class: 'empty' }, S.storeState === 'ok' ? 'No alerts yet. Confirmed signals appear here with the session that triggered them.' : 'Alerts are recorded once saving is available.'),
  );
}

// ---------- Strategy checklist

function checkGroup(title: string, items: CheckItem[], note: string, dataDown: boolean): HTMLElement {
  const passed = items.filter((i) => i.status === 'pass').length;
  return section(title, `${passed} of ${items.length} pass · ${note}`,
    h('ul', { class: 'checklist' }, ...items.map((it) => h('li', { class: `check check-${it.status}` }, statusMark(it.status),
      h('div', null, h('b', null, it.label, h('span', { class: `check-st st-${it.status}` }, statusText(it.status, dataDown))), h('span', null, it.detail))))));
}

function pageChecklist(): HTMLElement {
  const d = derive();
  const v = d.views[S.strategy];
  const dataDown = v.action === 'DATA UNAVAILABLE';
  const page = h('div', { class: 'page' },
    strategyBar(d),
    h('div', { class: 'legend-row' },
      h('span', null, statusMark('pass'), 'PASS'), h('span', null, statusMark('pending'), 'PENDING'),
      h('span', null, statusMark('fail'), 'FAIL (or risk triggered)'), h('span', null, statusMark('na'), 'DATA UNAVAILABLE / not applicable'),
      h('span', { class: 'muted' }, v.asOf ? `Calculated from the ${fmtDate(v.asOf)} close and your saved ${STRATEGY_META[v.id].short} sleeve. Nothing is ticked by hand.` : 'Nothing is marked as passed until it is verified.')));
  if (S.strategy === 'CLAUDE_V2') {
    const ev = d.ev;
    page.append(h('div', { class: 'check-grid' },
      checkGroup('Entry checklist', ev.entry, 'Rule A', dataDown),
      checkGroup('Second entry checklist', ev.second, 'Rule B', dataDown),
      checkGroup('Hold / exit checklist', ev.hold, 'Rules C, D, E', dataDown)));
    if (d.live) {
      page.append(section('Live check (pending)', 'Uses the live QQQ quote and an SMA200 that includes it. The session is not complete, so nothing here is a signal.',
        h('dl', { class: 'kvs kvs-2' },
          kv('Live QQQ', fmtNum(d.live.price)),
          kv('SMA200 incl. live price', fmtNum(d.live.sma)),
          kv('Live distance', fmtPct(d.live.dist)),
          kv('If it closed here', d.live.exit ? 'Exit level reached' : d.live.qual ? 'Would be a qualifying close' : 'Neither entry nor exit level'))));
    }
  } else if (S.strategy === 'SMA_CROSS') {
    const c = d.crossPrev ?? d.cross;
    page.append(h('div', { class: 'two-col' },
      checkGroup('SMA50/SMA200 checklist', c.checklist, 'Strategy B', dataDown),
      section('Action', null, h('p', { class: 'action-headline' }, `${v.action} · ${v.headline}`), h('ul', { class: 'reasons' }, ...v.reasons.map((r) => h('li', null, r))),
        h('p', { class: 'fine' }, 'Averages are computed from completed Daily closes only; an unfinished session can never complete a crossover. Exit (SMA50 at or below SMA200) takes priority over buying and rebalancing.'))));
  } else {
    const m = d.monthlyPrev ?? d.monthly;
    page.append(h('div', { class: 'two-col' },
      checkGroup('Monthly rebalancing checklist', m.checklist, 'Strategy C', dataDown),
      section('Action', null, h('p', { class: 'action-headline' }, `${v.action} · ${v.headline}`), h('ul', { class: 'reasons' }, ...v.reasons.map((r) => h('li', null, r))),
        h('p', { class: 'fine' }, 'The rebalance is decided at the last completed close of each month and executed at the next session’s open. Purchases are capped at available cash; no margin is used.'))));
  }
  return page;
}

// ---------- QQQ trend

let priceChart: PriceChart | null = null;

function pageTrend(): HTMLElement {
  const d = derive();
  const p = params();
  const cp = crossParams();
  const sid = S.strategy;
  const ranges: [typeof S.chart.range, string, number][] = [['6M', '6M', 126], ['1Y', '1Y', 252], ['3Y', '3Y', 756], ['5Y', '5Y', 1260], ['MAX', 'Max', Infinity]];
  const host = h('div', { class: 'chart-host chart-price' });
  const toggle = (id: string, label: string, on: boolean, set: (v: boolean) => void) =>
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', id, checked: on, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); rerender(); } }), label);
  const controls = h('div', { class: 'chart-controls' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Range' }, ...ranges.map(([id, label]) => h('button', { type: 'button', class: S.chart.range === id ? 'on' : '', 'aria-pressed': S.chart.range === id, onclick: () => { S.chart.range = id; if (id === 'MAX' || id === '5Y') S.chart.log = true; rerender(); } }, label))),
    toggle('chart-log', 'Log scale', S.chart.log, (v) => { S.chart.log = v; }),
    sid !== 'SMA_CROSS' ? toggle('chart-fast', `SMA${cp.fast}`, S.chart.sma50, (v) => { S.chart.sma50 = v; }) : null,
    sid !== 'MONTHLY' ? toggle('chart-algo', 'Algorithm signals', S.chart.algo, (v) => { S.chart.algo = v; }) : null,
    toggle('chart-real', 'Your trades', S.chart.real, (v) => { S.chart.real = v; }));
  const page = h('div', { class: 'page' }, strategyBar(d, 'The chart, markers and signal table follow the selected strategy.'));
  if (!d.points.length) {
    page.append(section('QQQ Daily', null, h('p', { class: 'empty tall' }, d.status === 'loading' ? 'Loading QQQ Daily candles…' : 'DATA UNAVAILABLE. QQQ Daily candles could not be validated.')));
    return page;
  }
  const n = ranges.find((r) => r[0] === S.chart.range)![2];
  const from = Number.isFinite(n) ? Math.max(0, d.points.length - n) : 0;
  const pts = d.points.slice(from);
  const cpts = d.crossPts.slice(from);
  const bars: Bar[] = S.qqq.report!.completed.slice(from);
  const idxOf = new Map<string, number>();
  bars.forEach((b, i) => idxOf.set(b.d, i));
  const markers: ChartMarker[] = [];
  if (S.chart.algo && sid === 'CLAUDE_V2') {
    for (const e of d.signals) {
      const at = e.kind === 'QUALIFIED' ? e.signalDate : e.execDate;
      if (!at || !idxOf.has(at) || e.kind === 'ADD_AT_TARGET' || e.kind === 'TRIM') continue;
      const kind = e.kind === 'QUALIFIED' ? 'QUAL' : e.kind === 'ADD' ? 'ADD' : e.kind;
      const label = e.kind === 'QUALIFIED' ? `Entry qualification (${p.confirmCloses} closes)` : `Algorithm ${e.kind === 'ENTRY' ? 'first purchase' : e.kind === 'ADD' ? 'second purchase' : 'exit'} · signal ${fmtDateShort(e.signalDate)}, next-open execution`;
      markers.push({ idx: idxOf.get(at) as number, kind: kind as ChartMarker['kind'], real: false, label });
    }
    const mr = markerRun();
    const model = mr?.models.find((m) => m.id === (isBaseline(p) ? 'CLAUDE_V2' : 'CLAUDE_V2_MOD'));
    for (const e of model?.events ?? []) {
      if (e.kind !== 'TRIM' || !e.execDate || !idxOf.has(e.execDate)) continue;
      markers.push({ idx: idxOf.get(e.execDate) as number, kind: 'TRIM', real: false, label: `Algorithm rebalance (trim) · signal ${fmtDateShort(e.signalDate)}` });
    }
  }
  if (S.chart.algo && sid === 'SMA_CROSS') {
    for (const e of crossEvents(d.crossPts)) {
      if (!idxOf.has(e.execDate)) continue;
      markers.push({ idx: idxOf.get(e.execDate) as number, kind: e.kind === 'BULLISH_CROSS' ? 'ENTRY' : 'EXIT', real: false, label: `${e.kind === 'BULLISH_CROSS' ? `SMA${cp.fast} crossed above SMA${cp.slow}: buy` : `SMA${cp.fast} fell to or below SMA${cp.slow}: exit`} · signal ${fmtDateShort(e.signalDate)}, next-open execution` });
    }
  }
  if (S.chart.real) {
    for (const t of S.data.trades) {
      if (t.strategy !== sid || t.symbol !== 'TQQQ' || !idxOf.has(t.date)) continue;
      const kind: ChartMarker['kind'] = t.side === 'BUY' ? (t.kind === 'ADD' ? 'ADD' : 'ENTRY') : t.kind === 'EXIT' ? 'EXIT' : 'TRIM';
      markers.push({ idx: idxOf.get(t.date) as number, kind, real: true, label: `Your trade: ${t.side === 'BUY' ? 'bought' : 'sold'} ${t.shares} TQQQ at ${fmtUsd(t.price)}` });
    }
  }
  const live = d.live && from + pts.length === d.points.length ? { price: d.live.price, at: 'live' } : null;
  const slowLabel = sid === 'SMA_CROSS' ? `SMA${cp.slow}` : `SMA${p.smaPeriod}`;
  const fast = sid === 'SMA_CROSS' || S.chart.sma50 ? { values: cpts.map((x) => x.fast), label: `SMA${cp.fast}` } : null;
  const bands = sid === 'CLAUDE_V2';
  const title = sid === 'CLAUDE_V2' ? 'QQQ Daily with SMA200 and Claude V2 thresholds' : sid === 'SMA_CROSS' ? `QQQ Daily with SMA${cp.fast} and SMA${cp.slow}` : 'QQQ Daily with SMA200 (context only)';
  page.append(
    section(title, `Completed regular-session candles from Twelve Data${S.qqq.report?.completed.length ? `, ${fmtDate(S.qqq.report.completed[0].d)} to ${fmtDate(S.qqq.report.lastCompleted)}` : ''}. Signals come from QQQ only.${sid === 'MONTHLY' ? ' Strategy C uses no trend signal; the averages are shown for context.' : ''}`,
      controls, host,
      h('div', { class: 'chart-legend' },
        h('span', null, h('i', { class: 'lk lk-sma' }), slowLabel),
        fast ? h('span', null, h('i', { class: 'lk lk-fast' }), fast.label) : null,
        bands ? h('span', null, h('i', { class: 'lk lk-bull' }), `Entry level (SMA200 +${p.entryBufferPct}%)`) : null,
        bands ? h('span', null, h('i', { class: 'lk lk-risk' }), `Exit level (SMA200 ${MINUS}${p.exitBufferPct}%)`) : null,
        bands ? h('span', null, h('i', { class: 'mk mk-qual' }), 'Qualification') : null,
        h('span', null, h('i', { class: 'mk mk-up' }), sid === 'CLAUDE_V2' ? 'First purchase' : 'Buy'),
        sid === 'CLAUDE_V2' ? h('span', null, h('i', { class: 'mk mk-up2' }), 'Second purchase') : null,
        sid !== 'SMA_CROSS' ? h('span', null, h('i', { class: 'mk mk-trim' }), sid === 'MONTHLY' ? 'Sale (rebalance)' : 'Rebalance') : null,
        sid !== 'MONTHLY' ? h('span', null, h('i', { class: 'mk mk-exit' }), 'Exit') : null,
        h('span', { class: 'legend-note' }, 'Hollow = algorithm signal on history · Solid = your recorded trade in this strategy’s sleeve' + (live ? ' · Open circle = live price, not confirmed' : ''))),
    ),
    sid === 'CLAUDE_V2' ? signalTable(d) : sid === 'SMA_CROSS' ? crossTable(d) : monthlyTable(d),
  );
  queueMicrotask(() => {
    priceChart?.destroy();
    priceChart = new PriceChart(host);
    priceChart.set({ bars, sma: sid === 'SMA_CROSS' ? cpts.map((x) => x.slow) : pts.map((x) => x.sma), smaLabel: slowLabel, fast, bands, entryPct: p.entryBufferPct, exitPct: p.exitBufferPct, markers, log: S.chart.log, live });
  });
  return page;
}

function signalTable(d: Derived): HTMLElement {
  const rows = d.signals.filter((e) => e.kind !== 'QUALIFIED').slice(-24).reverse();
  const ptBy = new Map(d.points.map((x) => [x.d, x]));
  const name: Record<string, string> = { ENTRY: 'First purchase', ADD: 'Second purchase', ADD_AT_TARGET: 'Second stage at target', TRIM: 'Rebalance', EXIT: 'Exit' };
  return section('Claude V2 signal history', 'Generated by the rules on historical QQQ closes. These are not your transactions; trims need portfolio weights and appear on the chart from the backtest.',
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Signal'), h('th', null, 'Signal close'), h('th', null, 'Execution (next open)'), h('th', { class: 'num' }, 'QQQ close'), h('th', { class: 'num' }, 'vs SMA200'))),
      h('tbody', null, ...rows.map((e) => {
        const pt = ptBy.get(e.signalDate);
        return h('tr', null, h('td', null, tag(name[e.kind] ?? e.kind, e.kind === 'EXIT' ? 'risk' : 'bull')), h('td', null, fmtDate(e.signalDate)), h('td', null, e.execDate ? fmtDate(e.execDate) : 'Pending'), h('td', { class: 'num' }, pt ? fmtNum(pt.c) : '—'), h('td', { class: 'num' }, pt ? fmtPct(pt.dist) : '—'));
      })))) : h('p', { class: 'empty' }, 'No signals in the available history.'));
}

function crossTable(d: Derived): HTMLElement {
  const cp = crossParams();
  const by = new Map(d.crossPts.map((x) => [x.d, x]));
  const rows = crossEvents(d.crossPts).slice(-24).reverse();
  return section(`SMA${cp.fast}/SMA${cp.slow} crossover history`, 'Every change of regime on completed QQQ closes. These are signals, not your transactions.',
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Crossover'), h('th', null, 'Signal close'), h('th', null, 'Execution (next open)'), h('th', { class: 'num' }, `SMA${cp.fast}`), h('th', { class: 'num' }, `SMA${cp.slow}`), h('th', { class: 'num' }, 'Days in prior regime'))),
      h('tbody', null, ...rows.map((e, i, all) => {
        const pt = by.get(e.signalDate);
        const prevEv = all[i + 1];
        const daysPrior = prevEv ? d.crossPts.findIndex((x) => x.d === e.signalDate) - d.crossPts.findIndex((x) => x.d === prevEv.signalDate) : null;
        const future = e.execDate > (S.qqq.report?.lastCompleted ?? '');
        return h('tr', null, h('td', null, tag(e.kind === 'BULLISH_CROSS' ? 'Bullish: buy' : 'Bearish: exit', e.kind === 'BULLISH_CROSS' ? 'bull' : 'risk')),
          h('td', null, fmtDate(e.signalDate)), h('td', null, future ? `${fmtDate(e.execDate)} (pending)` : fmtDate(e.execDate)),
          h('td', { class: 'num' }, pt ? fmtNum(pt.fast) : '—'), h('td', { class: 'num' }, pt ? fmtNum(pt.slow) : '—'), h('td', { class: 'num' }, daysPrior === null ? '—' : String(daysPrior)));
      })))) : h('p', { class: 'empty' }, 'No crossovers in the available history.'));
}

function monthlyTable(d: Derived): HTMLElement {
  const last = S.tqqq.report?.lastCompleted ?? S.qqq.report?.lastCompleted ?? null;
  if (!last) return section('Rebalance schedule', null, h('p', { class: 'empty' }, 'Needs validated Daily candles.'));
  const rows: { signal: string; exec: string; trades: TradeDoc[] }[] = [];
  let sig = monthEndOnOrBefore(last);
  for (let i = 0; i < 12; i++) {
    const exec = nextTradingDay(sig);
    const nextSig = i === 0 ? null : rows[rows.length - 1]?.signal ?? null;
    rows.push({ signal: sig, exec, trades: S.data.trades.filter((t) => t.strategy === 'MONTHLY' && t.date >= exec && (!nextSig || t.date < nextTradingDay(nextSig))) });
    sig = monthEndOnOrBefore(prevTradingDay(sig.slice(0, 7) + '-01'));
  }
  return section('Rebalance schedule', 'Month-end signal closes and the opens that execute them, with the trades you recorded in this sleeve.',
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Month-end close'), h('th', null, 'Rebalance open'), h('th', null, 'Your recorded trades'))),
      h('tbody', null, ...rows.map((r) => h('tr', null, h('td', null, fmtDate(r.signal)), h('td', null, r.exec > last ? `${fmtDate(r.exec)} (next)` : fmtDate(r.exec)),
        h('td', { class: 'note' }, r.trades.length ? r.trades.map((t) => `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.shares} on ${fmtDateShort(t.date)}`).join(' · ') : '—')))))));
}

// ---------- Portfolio and risk

function pagePortfolio(): HTMLElement {
  const pf = S.data.portfolio;
  const d = derive();
  const sid = S.strategy;
  const sl = sleeveOf(pf, sid);
  const f = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const results = h('div', { class: 'alloc-results' });
  const follow = h('div', { class: 'toggles' }, ...STRATEGY_IDS.map((id) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', id: 'pf-follow-' + id, checked: pf.followed.includes(id) }), `${STRATEGY_META[id].letter} · ${STRATEGY_META[id].name}`)));
  const form = h('form', { class: 'form', id: 'pf-form', novalidate: true },
    h('fieldset', { class: 'fs' }, h('legend', null, 'Account'),
      h('div', { class: 'form-grid' },
        field('Currency', h('select', { id: 'pf-currency', value: pf.currency }, h('option', { value: 'USD' }, 'USD'), h('option', { value: 'MYR' }, 'MYR'))),
        field('USD/MYR rate', h('input', { id: 'pf-fx', type: 'number', step: '0.0001', min: '0', inputmode: 'decimal', value: pf.usdMyr ?? '', placeholder: 'e.g. 4.20' }), 'MYR per US dollar. Used only when the currency is MYR.'),
        field('Total portfolio equity', h('input', { id: 'pf-equity', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: pf.totalEquity ?? '' }), 'Everything investable: QQQ, TQQQ (all sleeves) and cash.'),
        field('Cash available for investing', h('input', { id: 'pf-cash', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: pf.cash ?? '' }), 'Purchases are capped at this amount. No margin is assumed.'),
        field('QQQ shares (core)', h('input', { id: 'pf-qqq', type: 'number', step: '1', min: '0', inputmode: 'numeric', value: pf.qqqShares ?? '', placeholder: 'optional' }), 'Optional. Enables QQQ exposure and marks equity to QQQ’s price.'),
        field('Fee per order (USD)', h('input', { id: 'pf-feefixed', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: pf.feeFixed })),
        field('Fee (% of trade value)', h('input', { id: 'pf-feepct', type: 'number', step: '0.001', min: '0', inputmode: 'decimal', value: pf.feePct }))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Strategies you follow with real money'), follow,
        h('small', null, 'Each followed strategy keeps its own TQQQ sleeve. Following more than one stacks their targets.'))),
    h('fieldset', { class: 'fs' }, h('legend', null, `${STRATEGY_META[sid].letter} · ${STRATEGY_META[sid].name} sleeve`),
      h('div', { class: 'form-grid' },
        field('TQQQ shares in this sleeve', h('input', { id: 'pf-shares', type: 'number', step: '1', min: '0', inputmode: 'numeric', value: sl.shares })),
        field('Average purchase cost (USD)', h('input', { id: 'pf-avg', type: 'number', step: '0.0001', min: '0', inputmode: 'decimal', value: sl.avgCost ?? '' })),
        field(sid === 'CLAUDE_V2' ? 'Confirmed entry date' : 'Sleeve entry date', h('input', { id: 'pf-entry', type: 'date', value: sl.firstEntryDate ?? '' }), sid === 'CLAUDE_V2' ? 'The session your first purchase in this cycle executed. Starts the 20-session timer.' : 'The session this holding period began.'),
        sid === 'CLAUDE_V2'
          ? field('Second purchase date', h('input', { id: 'pf-second', type: 'date', value: sl.secondEntryDate ?? '' }), 'Leave empty until the add is done.')
          : field('Last rebalance or trade date', h('input', { id: 'pf-lasttrade', type: 'date', value: sl.lastTradeDate ?? '' }), 'Marks this month’s rebalance as done. Recording a trade sets it automatically.')),
      sid !== 'MONTHLY' ? h('details', { class: 'advanced' }, h('summary', null, 'Cycle record (advanced)'),
        h('div', { class: 'form-grid' },
          field('Last full exit date', h('input', { id: 'pf-exit', type: 'date', value: sl.lastExitDate ?? '' })),
          field('Exit signal close', h('input', { id: 'pf-exitsig', type: 'date', value: sl.lastExitSignalDate ?? '' }), sid === 'CLAUDE_V2' ? 'A new cycle needs QQQ to lose +2% after this close, then re-qualify.' : 'For reference.'))) : null),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn-primary', type: 'submit', disabled: S.storeState !== 'ok' }, 'Save holdings'),
      h('button', { class: 'btn', type: 'button', onclick: () => { S.formDirty = false; rerender(); } }, 'Discard changes'),
      h('span', { class: 'form-note' }, 'Saving updates holdings without creating a transaction. Use Record execution for trades. Other sleeves are not changed.')),
  );
  const readForm = (): PortfolioDoc => {
    const date = (id: string) => { const v = f(id)?.value ?? ''; return isYmd(v) ? v : null; };
    const followed = STRATEGY_IDS.filter((id) => f('pf-follow-' + id)?.checked);
    const base = readPortfolio({
      ...pf,
      confirmed: true,
      currency: (document.getElementById('pf-currency') as HTMLSelectElement | null)?.value ?? pf.currency,
      usdMyr: readNum(f('pf-fx')),
      totalEquity: readNum(f('pf-equity')),
      cash: readNum(f('pf-cash')),
      qqqShares: readNum(f('pf-qqq')),
      qqqRefPrice: d.qqqPriceUsd,
      feeFixed: readNum(f('pf-feefixed')) ?? 0,
      feePct: readNum(f('pf-feepct')) ?? 0,
      equityRefPrice: d.priceUsd,
      followed,
    } as unknown as Record<string, unknown>);
    const shares = readNum(f('pf-shares')) ?? 0;
    const next: SleeveDoc = {
      ...sl,
      shares,
      avgCost: readNum(f('pf-avg')),
      firstEntryDate: date('pf-entry'),
      secondEntryDate: sid === 'CLAUDE_V2' ? date('pf-second') : null,
      lastTradeDate: sid === 'CLAUDE_V2' ? sl.lastTradeDate : date('pf-lasttrade'),
      lastExitDate: sid !== 'MONTHLY' ? date('pf-exit') : sl.lastExitDate,
      lastExitSignalDate: sid !== 'MONTHLY' ? date('pf-exitsig') : sl.lastExitSignalDate,
    };
    return withSleeve(base, sid, next);
  };
  const update = () => {
    clear(results);
    const next = readForm();
    results.append(sid === 'CLAUDE_V2' ? allocationView(next, d.priceUsd, d.priceLabel, params(), d.qqqPriceUsd) : sleeveView(next, sid, d));
  };
  form.addEventListener('input', () => { S.formDirty = true; update(); });
  form.addEventListener('change', () => { S.formDirty = true; update(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = readForm();
    const ns = sleeveOf(next, sid);
    const problems: string[] = [];
    if (!Number.isInteger(ns.shares) || ns.shares < 0) problems.push('TQQQ shares must be a whole number.');
    if (next.qqqShares !== null && (!Number.isInteger(next.qqqShares) || next.qqqShares < 0)) problems.push('QQQ shares must be a whole number.');
    if (sid === 'CLAUDE_V2' && ns.shares > 0 && !ns.firstEntryDate) problems.push('Add the confirmed entry date so the 20-session timer can run.');
    if (ns.firstEntryDate && !isTradingDay(ns.firstEntryDate)) problems.push(`${ns.firstEntryDate} is not a US trading session.`);
    if (next.currency === 'MYR' && !next.usdMyr) problems.push('Enter the USD/MYR rate.');
    if (allTqqqShares() + ns.shares - sl.shares > 0 && d.priceUsd === null) problems.push('TQQQ price is unavailable, so equity cannot be marked to market yet.');
    if (problems.length) { toast(problems[0], 'err'); return; }
    next.updatedAt = new Date().toISOString();
    const ok = await persist('Holdings', (st) => st.savePortfolio(next));
    if (ok) {
      S.data.portfolio = next;
      S.formDirty = false;
      toast('Holdings saved');
      rerender();
    }
  });
  queueMicrotask(update);
  return h('div', { class: 'page' },
    strategyBar(d, 'The sleeve fields and sizing follow the selected strategy; account fields are shared.'),
    h('div', { class: 'two-col' },
      section('Your holdings', pf.updatedAt ? `Last saved ${fmtMyt(Date.parse(pf.updatedAt))}` : 'Not saved yet. The dashboard needs to know what you hold.', form),
      section(`Allocation · ${STRATEGY_META[sid].short}`, d.priceUsd ? `Priced from the ${d.priceLabel} (${fmtUsd(d.priceUsd)}).` : 'TQQQ price unavailable.', results)),
    riskPanel(d),
  );
}

function money(pf: PortfolioDoc, inp: PortfolioInput) {
  return (usd: number | null): Child => {
    if (usd === null) return '—';
    const local = fromUsd(usd, inp);
    return pf.currency === 'MYR' ? h('span', null, fmtMoney(local, 'MYR'), h('small', null, ` ${fmtUsd(usd)}`)) : fmtUsd(usd);
  };
}

function allocationView(pf: PortfolioDoc, price: number | null, priceLabel: string, p: StrategyParams, qqqPrice: number | null): HTMLElement {
  if (price === null) return h('p', { class: 'empty' }, 'TQQQ price unavailable, so sizes cannot be calculated.');
  const inp: PortfolioInput = portfolioInput(pf);
  const a = computeAllocation(inp, price, p, { shares: pf.shares, avgCost: pf.avgCost }, qqqPrice);
  const m = money(pf, inp);
  const rows: [string, Child][] = [
    ['Claude V2 sleeve market value', m(a.valueUsd)],
    ['Claude V2 sleeve weight', a.weightPct === null ? '—' : h('b', { class: a.weightPct > p.trimThresholdPct ? 'warnc' : '' }, fmtPct(a.weightPct, 2, false))],
    ['Total equity (marked to price)', m(a.equityUsd)],
    [`Target position at ${p.firstAllocPct}%`, m(a.firstTargetUsd)],
    [`Target position at ${p.targetAllocPct}%`, m(a.fullTargetUsd)],
    [`Additional cash required to reach ${p.firstAllocPct}%`, a.initial ? m(a.initial.neededUsd) : '—'],
    [`Additional cash required to reach ${p.targetAllocPct}%`, a.add ? m(a.add.neededUsd) : '—'],
    [`Shares to buy for ${p.firstAllocPct}%`, a.initial ? h('span', null, h('b', null, String(a.initial.shares)), a.initial.shares ? ` · ${fmtUsd(a.initial.valueUsd)} + ${fmtUsd(a.initial.feeUsd)} fee` : '', a.initial.limitedByCash ? h('em', { class: 'warnc' }, ' limited by cash') : null) : '—'],
    [`Shares to buy for ${p.targetAllocPct}%`, a.add ? h('span', null, h('b', null, String(a.add.shares)), a.add.shares ? ` · ${fmtUsd(a.add.valueUsd)} + ${fmtUsd(a.add.feeUsd)} fee` : '', a.add.limitedByCash ? h('em', { class: 'warnc' }, ' limited by cash') : null) : '—'],
    ['Amount to sell when trimming', a.trim ? h('span', null, h('b', null, `${a.trim.shares} shares`), ` · ${fmtUsd(a.trim.valueUsd)} → ${fmtPct(a.trim.weightAfterPct, 2, false)}`) : a.weightPct === null ? '—' : `None: weight is at or below ${p.trimThresholdPct}%`],
    ['Exit proceeds (all sleeve shares)', pf.shares ? h('span', null, `${pf.shares} shares · ${fmtUsd(a.exit.proceedsUsd)} after fees`) : '—'],
    ['Unrealised profit / loss', a.unrealizedUsd === null ? '—' : h('span', { class: a.unrealizedUsd >= 0 ? 'up' : 'down' }, `${fmtUsd(a.unrealizedUsd)} (${fmtPct(a.unrealizedPct)})`)],
  ];
  return h('div', null,
    a.problems.length ? h('ul', { class: 'issues' }, ...a.problems.map((x) => h('li', null, x))) : null,
    h('dl', { class: 'alloc-list' }, ...rows.map(([k, v]) => kv(k, v))),
    h('p', { class: 'fine' }, `Whole shares, rounded down. Buys never exceed cash or the target on post-fee equity. Price: ${priceLabel}. Equity is re-marked for all TQQQ sleeves${pf.qqqShares ? ' and the QQQ core' : ''}; other holdings are taken as entered.`));
}

function sleeveView(pf: PortfolioDoc, sid: StrategyId, d: Derived): HTMLElement {
  const price = d.priceUsd;
  if (price === null) return h('p', { class: 'empty' }, 'TQQQ price unavailable, so sizes cannot be calculated.');
  const inp = portfolioInput(pf);
  const target = sid === 'SMA_CROSS' ? crossParams().targetPct : monthlyParams().targetPct;
  const sl = sleeveOf(pf, sid);
  const a = planSleeve(inp, sl, price, target, d.qqqPriceUsd);
  const m = money(pf, inp);
  const rows: [string, Child][] = [
    ['Sleeve market value', m(a.valueUsd)],
    ['Sleeve weight', a.weightPct === null ? '—' : h('b', null, fmtPct(a.weightPct, 2, false))],
    ['Total equity (marked to price)', m(a.equityUsd)],
    [`Target position at ${target}%`, m(a.targetUsd)],
    ['Cash required (uncapped, incl. fees)', a.cashRequiredUsd === null ? '—' : m(a.cashRequiredUsd)],
    ['Cash available', m(a.cashUsd)],
    [`Shares to buy for ${target}%`, a.buy ? h('span', null, h('b', null, String(a.buy.shares)), a.buy.shares ? ` · ${fmtUsd(a.buy.valueUsd)} + ${fmtUsd(a.buy.feeUsd)} fee` : '', a.buy.limitedByCash ? h('em', { class: 'warnc' }, ' limited by cash') : null) : 'None: at or above target'],
    [`Shares to sell to return to ${target}%`, a.sell ? (a.sell.shares ? h('span', null, h('b', null, String(a.sell.shares)), ` · ${fmtUsd(a.sell.valueUsd)} → ${fmtPct(a.sell.weightAfterPct, 2, false)}`) : 'None: within one share') : 'None: below target'],
    [sid === 'SMA_CROSS' ? 'Exit proceeds (whole sleeve)' : 'Value of the whole sleeve after fees', sl.shares ? h('span', null, `${sl.shares} shares · ${fmtUsd(a.exit.proceedsUsd)}`) : '—'],
    ['Unrealised profit / loss', a.unrealizedUsd === null ? '—' : h('span', { class: a.unrealizedUsd >= 0 ? 'up' : 'down' }, `${fmtUsd(a.unrealizedUsd)} (${fmtPct(a.unrealizedPct)})`)],
  ];
  const short = a.buy && a.cashRequiredUsd !== null && a.cashUsd !== null && a.cashRequiredUsd > a.cashUsd + 1e-9;
  return h('div', null,
    a.problems.length ? h('ul', { class: 'issues' }, ...a.problems.map((x) => h('li', null, x))) : null,
    h('dl', { class: 'alloc-list' }, ...rows.map(([k, v]) => kv(k, v))),
    short ? h('p', { class: 'fine warnc' }, `Cash is ${fmtUsd((a.cashRequiredUsd ?? 0) - (a.cashUsd ?? 0))} short of the full purchase. ${sid === 'MONTHLY' ? 'In Strategy C the QQQ core is sold to fund the TQQQ top-up; record that QQQ sale first, or the purchase stays limited to cash.' : 'The purchase is limited to available cash; no margin is used.'}`) : null,
    h('p', { class: 'fine' }, `Whole shares, rounded down. Purchases never exceed cash or the ${target}% target on post-fee equity. Price: ${d.priceLabel}.`));
}

function riskPanel(d: Derived): HTMLElement {
  const r = d.risk;
  const pf = S.data.portfolio;
  const st = S.data.settings;
  const drops = st.riskDrops;
  const body: Child[] = [];
  if (!r) {
    body.push(h('p', { class: 'empty' }, 'Enter total equity (and a TQQQ price must be available) to see exposure and scenarios.'));
  } else {
    const share = (x: number | null) => (x === null ? '—' : fmtPct(x, 1, false));
    const bySleeve = STRATEGY_IDS.map((id) => ({ id, sh: sleeveOf(pf, id).shares })).filter((x) => x.sh > 0);
    body.push(
      h('div', { class: `banner ${r.concentration === 'ok' ? '' : r.concentration === 'high' ? 'banner-err' : 'banner-wait'}`, role: 'status' }, icon('info', 18),
        h('div', null, h('b', null, r.concentration === 'ok' ? 'Concentration within target. ' : r.concentration === 'high' ? 'High TQQQ concentration. ' : 'TQQQ above target. '), r.concentrationNote,
          pf.followed.length > 1 ? ` You follow ${pf.followed.length} strategies, so their sleeves stack to a combined ${d.combinedTargetPct}% target.` : '')),
      h('div', { class: 'risk-grid' },
        h('dl', { class: 'kvs' },
          kv('Total portfolio equity', fmtUsd(r.equityUsd, 0)),
          kv('QQQ exposure', r.qqqUsd === null ? h('a', { href: '#portfolio' }, 'Enter QQQ shares') : `${fmtUsd(r.qqqUsd, 0)} · ${share(r.qqqPct)}`),
          kv('TQQQ exposure', `${fmtUsd(r.tqqqUsd, 0)} · ${fmtPct(r.tqqqPct, 2, false)}`),
          ...bySleeve.map((x) => kv(`  ${STRATEGY_META[x.id].letter} sleeve`, `${x.sh} shares`, 'kv-sub')),
          kv('Uninvested cash', r.cashUsd === null ? '—' : `${fmtUsd(r.cashUsd, 0)} · ${share(r.cashPct)}`),
          r.otherUsd !== null && Math.abs(r.otherUsd) > 1 ? kv('Other / unexplained', fmtUsd(r.otherUsd, 0)) : null),
        h('dl', { class: 'kvs' },
          kv('TQQQ portfolio weight', h('b', { class: r.concentration === 'ok' ? '' : 'warnc' }, fmtPct(r.tqqqPct, 2, false))),
          kv('TQQQ daily Nasdaq-100 exposure (3×)', fmtPct(r.tqqqContributionPct, 1, false)),
          kv('Effective daily Nasdaq-100 exposure', r.effectivePct === null ? 'Needs QQQ shares' : h('b', null, fmtPct(r.effectivePct, 1, false))),
          kv('Combined TQQQ target (followed)', `${d.combinedTargetPct}%`))),
      h('p', { class: 'explain-line' }, `A 5% TQQQ position adds roughly 15% of one-day Nasdaq-100 exposure (3 × 5%), on top of whatever QQQ you hold. That 3× holds for a single day only: over weeks and months TQQQ’s result depends on the path, and in choppy markets it can lose value even when QQQ ends flat. Moving-average signals reduce time spent in long downtrends but do not prevent losses from sudden drops or gaps.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'TQQQ decline'), h('th', { class: 'num' }, 'TQQQ loss'), h('th', { class: 'num' }, '% of equity'), h('th', { class: 'num' }, 'With QQQ falling'), h('th', { class: 'num' }, 'Combined loss'), h('th', { class: 'num' }, '% of equity'))),
        h('tbody', null, ...r.scenarios.map((s) => h('tr', null,
          h('th', { scope: 'row' }, `${MINUS}${s.tqqqDropPct}%`),
          h('td', { class: 'num down' }, fmtUsd(-s.tqqqOnlyLossUsd, 0)),
          h('td', { class: 'num' }, fmtPct(-(s.tqqqOnlyLossUsd / r.equityUsd) * 100, 2)),
          h('td', { class: 'num' }, r.qqqUsd === null ? '—' : `${MINUS}${s.qqqDropPct.toFixed(1)}%`),
          h('td', { class: 'num down' }, r.qqqUsd === null ? '—' : fmtUsd(-s.lossUsd, 0)),
          h('td', { class: 'num' }, r.qqqUsd === null ? '—' : fmtPct(-s.lossPctOfEquity, 2))))))),
      h('p', { class: 'fine' }, 'Scenarios are illustrations, not forecasts. “With QQQ falling” pairs each TQQQ decline with the QQQ decline a steady path implies, 1 − (1 − d)^⅓ (for example −80% with −41%); over a single day the pairing is closer to d ÷ 3, and in 2022 TQQQ fell about 79% while QQQ fell about 35%.'));
  }
  const dropsForm = h('form', { class: 'form inline-form', novalidate: true },
    h('div', { class: 'form-grid form-grid-4' },
      ...[0, 1, 2, 3].map((i) => field(`Scenario ${i + 1} (% TQQQ decline)`, h('input', { id: 'rk-' + i, type: 'number', min: '1', max: '99', step: '1', value: drops[i] ?? '' }))),
      h('div', { class: 'field field-btn' }, h('button', { class: 'btn', type: 'submit', disabled: S.storeState !== 'ok' }, 'Save scenarios'))));
  dropsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vals = [0, 1, 2, 3].map((i) => readNum(dropsForm.querySelector('#rk-' + i) as HTMLInputElement)).filter((x): x is number => x !== null);
    if (!vals.length || vals.some((x) => !(x > 0 && x < 100))) { toast('Each scenario must be between 1% and 99%.', 'err'); return; }
    const next = { ...st, riskDrops: vals.sort((a, b) => a - b) };
    if (await persist('Risk scenarios', (s) => s.saveSettings(next))) { S.data.settings = next; toast('Scenarios saved'); rerender(); }
  });
  return h('details', { class: 'panel risk-panel', open: S.riskOpen },
    h('summary', { onclick: () => { S.riskOpen = !S.riskOpen; } }, h('span', { class: 'risk-title' }, 'Risk analysis'), h('span', { class: 'panel-sub' }, 'Exposure, concentration and hypothetical TQQQ declines for the whole account.')),
    ...body,
    dropsForm);
}

// ---------- trade record modal

export function openTradeModal(kind: TradeKind, shares: number, editDate?: string, book: Book = S.strategy, sideHint?: 'BUY' | 'SELL'): void {
  const d = derive();
  const pf = S.data.portfolio;
  const today = etDate(Date.now());
  const ms = marketStatus(Date.now());
  const asOf = d.views.CLAUDE_V2.asOf ?? d.monthly.asOf;
  const nxt = asOf ? nextTradingDay(asOf) : today;
  const execDefault = editDate ?? (nxt <= today ? (isTradingDay(today) && (ms.phase === 'open' || ms.phase === 'post' || ms.phase === 'closed') && sessionTimes(today).openUtc <= Date.now() ? today : nxt) : nxt);
  const priceFor = (b: Book) => (b === 'CORE' ? S.quotes.QQQ?.price ?? d.qqqClose ?? null : S.quotes.TQQQ?.price ?? d.tqqqClose ?? null);
  const sideOf = (k: TradeKind): 'BUY' | 'SELL' | null => (k === 'INITIAL' || k === 'ADD' || k === 'ENTRY' || k === 'OTHER_BUY' ? 'BUY' : k === 'REBALANCE' ? null : 'SELL');
  const kindLabel: Record<TradeKind, string> = {
    INITIAL: 'First purchase (Rule A)', ADD: 'Second purchase (Rule B)', TRIM: 'Trim (Rule E)', EXIT: 'Exit all', ENTRY: 'Entry purchase', REBALANCE: 'Monthly rebalance', OTHER_BUY: 'Other buy', OTHER_SELL: 'Other sell',
  };
  const bookLabel: Record<Book, string> = { CLAUDE_V2: 'A · Claude V2 sleeve (TQQQ)', SMA_CROSS: 'B · SMA50/SMA200 sleeve (TQQQ)', MONTHLY: 'C · Monthly 95/5 sleeve (TQQQ)', CORE: 'QQQ core' };
  const err = h('p', { class: 'form-err', role: 'alert' });
  const close = () => overlay.remove();
  const kindSel = h('select', { id: 'tr-kind' }) as HTMLSelectElement;
  const sideSel = h('select', { id: 'tr-side' }, h('option', { value: 'BUY' }, 'Buy'), h('option', { value: 'SELL' }, 'Sell')) as HTMLSelectElement;
  const sideField = field('Side', sideSel);
  const bookSel = h('select', { id: 'tr-book' }, ...(['CLAUDE_V2', 'SMA_CROSS', 'MONTHLY', 'CORE'] as Book[]).map((b) => h('option', { value: b }, bookLabel[b]))) as HTMLSelectElement;
  const priceIn = h('input', { id: 'tr-price', type: 'number', step: '0.0001', min: '0', inputmode: 'decimal', required: true }) as HTMLInputElement;
  const sharesIn = h('input', { id: 'tr-shares', type: 'number', step: '1', min: '1', inputmode: 'numeric', value: shares || '', required: true }) as HTMLInputElement;
  const feeIn = h('input', { id: 'tr-fee', type: 'number', step: '0.01', min: '0', inputmode: 'decimal' }) as HTMLInputElement;
  const fillKinds = (b: Book, pick?: TradeKind) => {
    clear(kindSel);
    for (const k of KINDS_BY_BOOK[b]) kindSel.append(h('option', { value: k }, kindLabel[k]));
    kindSel.value = pick && KINDS_BY_BOOK[b].includes(pick) ? pick : KINDS_BY_BOOK[b][0];
    syncSide();
  };
  const syncSide = () => {
    const s = sideOf(kindSel.value as TradeKind);
    sideField.hidden = s !== null;
    if (s) sideSel.value = s;
  };
  const syncPrice = () => {
    const px = priceFor(bookSel.value as Book);
    priceIn.value = px ? px.toFixed(2) : '';
    const sh = readNum(sharesIn) ?? 0;
    feeIn.value = (px && sh ? orderFee(px * sh, pf) : pf.feeFixed).toFixed(2);
  };
  bookSel.value = book;
  bookSel.addEventListener('change', () => { fillKinds(bookSel.value as Book); syncPrice(); });
  kindSel.addEventListener('change', syncSide);
  fillKinds(book, kind);
  if (sideHint) sideSel.value = sideHint;
  syncPrice();
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'form-grid' },
      field('Book', bookSel, 'A TQQQ trade changes only that strategy’s sleeve.'),
      field('Transaction', kindSel),
      sideField,
      field('Execution date', h('input', { id: 'tr-date', type: 'date', value: execDefault, required: true }), 'The US session your order filled.'),
      field('Shares', sharesIn),
      field('Fill price (USD)', priceIn),
      field('Fee (USD)', feeIn),
      field('Signal close', h('input', { id: 'tr-signal', type: 'date', value: asOf ?? '' }), 'The completed close that generated the signal, if any.'),
      field('Note', h('input', { id: 'tr-note', type: 'text', maxlength: '280', value: '' }))),
    err,
    h('p', { class: 'fine' }, 'This records a transaction you actually made, with its own date, shares, price and fee. Signals and simulations are never recorded automatically.'),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit', disabled: S.storeState !== 'ok' }, 'Save transaction'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (id: string) => form.querySelector('#' + id) as HTMLInputElement;
    const b = bookSel.value as Book;
    const k = kindSel.value as TradeKind;
    const side = sideOf(k) ?? (sideSel.value as 'BUY' | 'SELL');
    const date = g('tr-date').value;
    const sh = readNum(sharesIn);
    const px = readNum(priceIn);
    const fe = readNum(feeIn) ?? 0;
    const sig = g('tr-signal').value;
    if (!isYmd(date)) { err.textContent = 'Enter the execution date.'; return; }
    if (!isTradingDay(date)) { err.textContent = `${date} is not a US trading session.`; return; }
    if (date > etDate(Date.now())) { err.textContent = `The ${fmtDate(date)} session hasn’t happened yet. Record the trade once your order has filled.`; return; }
    if (sh === null || px === null) { err.textContent = 'Enter shares and price.'; return; }
    const symbol: 'TQQQ' | 'QQQ' = b === 'CORE' ? 'QQQ' : 'TQQQ';
    const tr = { strategy: b, symbol, date, side, kind: k, shares: sh, price: px, fee: fe, signalDate: isYmd(sig) ? sig : null, note: g('tr-note').value.slice(0, 280) };
    if (k === 'EXIT' && b !== 'CORE' && sh !== sleeveOf(S.data.portfolio, b).shares) { err.textContent = `An exit sells all ${sleeveOf(S.data.portfolio, b).shares} shares of this sleeve. Use Other sell for a partial sale.`; return; }
    const r = applyTrade(S.data.portfolio, tr, new Date().toISOString());
    if (r.error) { err.textContent = r.error; return; }
    const rec: TradeDoc = { ...tr, id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString(), realizedUsd: r.realizedUsd };
    const trades = [...S.data.trades, rec];
    const ok1 = await persist('Transaction', (st) => st.saveTrades(trades));
    if (!ok1) return;
    const wasFollowed = b === 'CORE' || S.data.portfolio.followed.includes(b);
    const ok2 = await persist('Holdings', (st) => st.savePortfolio(r.portfolio));
    S.data.trades = trades;
    if (ok2) S.data.portfolio = r.portfolio;
    close();
    toast(`${side === 'BUY' ? 'Purchase' : 'Sale'} of ${sh} ${symbol} recorded${wasFollowed ? '' : `; ${STRATEGY_META[b as StrategyId].short} is now marked as followed`}`);
    rerender();
  });
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Record a transaction', onclick: (e: Event) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal' }, h('header', { class: 'modal-head' }, h('h2', null, 'Record a transaction'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 18))), form));
  overlay.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') close(); });
  document.body.appendChild(overlay);
  sharesIn.focus();
}

// ---------- Backtesting

let growthChart: LineChart | null = null;
const MODEL_COLORS: Record<string, string> = {
  QQQ100: '--c1', QQQ_CASH: '--c2', QQQ_TQQQ_M: '--c3', QQQ_TQQQ_M_MOD: '--c3', SMA200_ROT: '--c4', CLAUDE_V2: '--c5', CLAUDE_V2_MOD: '--c6', SMA_CROSS: '--fast', SMA_CROSS_MOD: '--fast', QQQ_TQQQ_BH: '--fg-3',
};
const MODEL_ORDER = ['QQQ100', 'QQQ_CASH', 'QQQ_TQQQ_M', 'QQQ_TQQQ_M_MOD', 'SMA200_ROT', 'CLAUDE_V2', 'CLAUDE_V2_MOD', 'SMA_CROSS', 'SMA_CROSS_MOD', 'MIKE_V2', 'QQQ_TQQQ_BH'];
const color = (id: string) => `var(${MODEL_COLORS[id] ?? '--c7'})`;

function btConfig(): BacktestConfig {
  const F = S.bt.form;
  const p = params(), cp = crossParams(), mp = monthlyParams();
  return {
    start: F.start, end: F.end, initialCapital: F.capital, feeBps: F.feeBps, feeFixed: F.feeFixed, cashRatePct: F.cashRate,
    useDividends: F.dividends && S.divs.status === 'ok', baseline: { ...CLAUDE_V2_BASELINE }, modified: isBaseline(p) ? null : { ...p },
    cross: { ...SMA_CROSS_BASELINE }, crossModified: isCrossBaseline(cp) ? null : { ...cp },
    monthly: { ...MONTHLY_BASELINE }, monthlyModified: isMonthlyBaseline(mp) ? null : { ...mp },
  };
}

function btForm(onRun: (form: HTMLElement) => void, label: string): HTMLElement {
  const win = backtestWindow();
  const F = S.bt.form;
  if (win) {
    if (!F.start || F.start < win.start) F.start = win.start;
    if (!F.end || F.end > win.end) F.end = win.end;
  }
  const running = S.bt.running || S.research.running;
  const form = h('form', { class: 'form bt-form', novalidate: true },
    h('div', { class: 'form-grid form-grid-4' },
      field('Start', h('input', { id: 'bt-start', type: 'date', value: F.start, min: win?.start ?? '', max: win?.end ?? '' })),
      field('End', h('input', { id: 'bt-end', type: 'date', value: F.end, min: win?.start ?? '', max: win?.end ?? '' })),
      field('Starting capital (USD)', h('input', { id: 'bt-cap', type: 'number', min: '1000', step: '1000', value: F.capital })),
      field('Cost per trade (bps)', h('input', { id: 'bt-bps', type: 'number', min: '0', step: '0.5', value: F.feeBps }), 'Commission and slippage. 5 bps = 0.05% of value.'),
      field('Fixed fee per trade (USD)', h('input', { id: 'bt-fixed', type: 'number', min: '0', step: '0.01', value: F.feeFixed })),
      field('Cash interest (% a year)', h('input', { id: 'bt-rate', type: 'number', min: '0', step: '0.1', value: F.cashRate }), 'Also the risk-free rate in Sharpe and Sortino.'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Dividends'), h('label', { class: 'toggle' }, h('input', { id: 'bt-div', type: 'checkbox', checked: F.dividends }), 'Credit dividends on ex-dates')),
      h('div', { class: 'field field-btn' }, h('button', { class: 'btn btn-primary', type: 'submit', disabled: !win || running }, running ? 'Running…' : label))),
  );
  form.addEventListener('submit', (e) => { e.preventDefault(); onRun(form); });
  return form;
}

function readBtForm(form: HTMLElement): boolean {
  const g = (id: string) => form.querySelector('#' + id) as HTMLInputElement;
  const F = S.bt.form;
  F.start = g('bt-start').value;
  F.end = g('bt-end').value;
  F.capital = readNum(g('bt-cap')) ?? 100000;
  F.feeBps = readNum(g('bt-bps')) ?? 0;
  F.feeFixed = readNum(g('bt-fixed')) ?? 0;
  F.cashRate = readNum(g('bt-rate')) ?? 0;
  F.dividends = g('bt-div').checked;
  return isYmd(F.start) && isYmd(F.end) && F.start < F.end;
}

function inputCheck() {
  const q = S.qqq.report!.completed, t = S.tqqq.report!.completed;
  return checkBacktestInputs(q, t, S.bt.form.start, S.bt.form.end, { QQQ: S.qqq.report!.historyIssues, TQQQ: S.tqqq.report!.historyIssues });
}

function pageBacktest(): HTMLElement {
  const win = backtestWindow();
  const page = h('div', { class: 'page' });
  page.append(section('Historical backtest', win
    ? `Simulation on Twelve Data Daily history. QQQ from ${fmtDate(win.qFirst)}, TQQQ from ${fmtDate(win.tFirst)}; the common window with valid moving averages runs ${fmtDate(win.start)} to ${fmtDate(win.end)}.`
    : 'Needs validated QQQ and TQQQ history from Twelve Data.', btForm((f) => void runBacktest(f), 'Run backtest'),
    h('p', { class: 'sim-flag' }, tag('Simulation', 'na'), ' Hypothetical results on past data, kept apart from your recorded transactions. Past performance does not guarantee future results, and no strategy is ranked best by its historical return.')));
  const r = S.bt.result;
  if (S.bt.error) page.append(h('div', { class: 'banner banner-err' }, icon('info', 18), h('div', null, S.bt.error)));
  if (S.bt.inputs && !S.bt.inputs.ok) page.append(h('div', { class: 'banner banner-err' }, icon('info', 18), h('div', null, h('b', null, 'Input data failed validation; the backtest was not run. '), h('ul', { class: 'issues' }, ...S.bt.inputs.issues.map((x) => h('li', null, x))))));
  if (!r) {
    page.append(section('Results', null, h('p', { class: 'empty tall' }, win ? 'Choose a window and press Run backtest. Nothing is shown until a run completes on the actual data.' : 'Waiting for validated history.')));
    return page;
  }
  page.append(resultsView(r));
  return page;
}

async function runBacktest(form: HTMLElement): Promise<void> {
  if (!readBtForm(form)) { S.bt.error = 'Choose a start date before the end date.'; rerender(); return; }
  S.bt.running = true;
  S.bt.error = null;
  rerender();
  let divNote: string | null = null;
  if (S.bt.form.dividends) {
    const ok = await loadDividends();
    if (!ok) divNote = `Dividends could not be loaded (${S.divs.error}); this run uses price returns only.`;
  }
  await new Promise((res) => setTimeout(res, 20));
  try {
    S.bt.inputs = inputCheck();
    if (!S.bt.inputs.ok) {
      S.bt.result = null;
    } else {
      const cfg = btConfig();
      const q = S.qqq.report!.completed;
      const t = S.tqqq.report!.completed;
      const divs = { QQQ: S.divs.QQQ, TQQQ: S.divs.TQQQ };
      const res = simulate(q, t, divs, cfg);
      if (divNote) res.notes.unshift(divNote);
      res.notes.push(...S.bt.inputs.notes);
      S.bt.result = res;
      S.bt.look = res.models.length ? lookaheadCheck(q, t, divs, cfg, res, 8) : null;
    }
  } catch (e) {
    S.bt.error = 'Backtest failed: ' + ((e as Error)?.message ?? String(e));
  }
  S.bt.running = false;
  rerender();
}

async function offerCsv(name: string, text: string): Promise<void> {
  if (!S.rt?.download) { toast('Downloads are not available in this view.', 'err'); return; }
  const msg = await S.rt.download(name, text);
  toast(msg, /saved|downloaded/.test(msg) ? 'ok' : 'err');
}

function resultsView(r: BacktestResult): HTMLElement {
  const wrap = h('div', { class: 'stack' });
  if (!r.models.length) {
    wrap.append(section('Results', null, h('p', { class: 'empty' }, r.notes[0] ?? 'No results.')));
    return wrap;
  }
  const look = S.bt.look;
  const byId = new Map(r.models.map((m) => [m.id as string, m]));
  const N = r.dates.length;
  wrap.append(h('div', { class: 'run-meta' },
    h('span', null, `${fmtDate(r.dates[0])} to ${fmtDate(r.dates[N - 1])} · ${N.toLocaleString('en-US')} sessions`),
    h('span', null, `Data ${r.dataFingerprint} · result ${r.resultFingerprint}`),
    look ? h('span', { class: look.passed ? 'up' : 'down' }, look.passed ? `No-look-ahead check passed (${look.checked} truncation points)` : `No-look-ahead check FAILED: ${look.failures[0]}`) : null,
    h('span', null, r.config.useDividends ? `Dividends credited (QQQ ${r.dividendsUsed.QQQ}, TQQQ ${r.dividendsUsed.TQQQ} payments)` : 'Price returns only (no dividends)')));

  const shown = MODEL_ORDER.filter((id) => byId.has(id));
  S.bt.compare = S.bt.compare.filter((id) => byId.has(id)).slice(0, 3);
  if (!S.bt.compare.length) S.bt.compare = shown.slice(0, 3);
  const toggleCompare = (id: string, on: boolean) => {
    let c = S.bt.compare.filter((x) => x !== id);
    if (on) c = [...c, id].slice(-3);
    S.bt.compare = c;
    rerender();
  };
  const metricRow = (id: string) => {
    const spec = MODEL_SPECS.find((s) => s.id === id) ?? specOf(id);
    const m = byId.get(id);
    if (id === 'MIKE_V2') return h('tr', { class: 'row-off' }, h('td', null), h('th', { scope: 'row' }, h('i', { class: 'lk', style: 'background:var(--fg-3)' }), spec.name), h('td', { colspan: '15' }, 'Not run: the Mike V2 confirmation rules have not been supplied.'));
    if (!m) return null;
    const inCmp = S.bt.compare.includes(id);
    return h('tr', { class: id === 'CLAUDE_V2' || id === 'SMA_CROSS' || id === 'QQQ_TQQQ_M' ? 'row-focus' : spec.reference ? 'row-ref' : '' },
      h('td', { class: 'cmp' }, h('input', { type: 'checkbox', checked: inCmp, 'aria-label': `Compare ${m.short} on the chart`, onchange: (e: Event) => toggleCompare(id, (e.target as HTMLInputElement).checked) })),
      h('th', { scope: 'row', title: spec.description }, h('i', { class: 'lk', style: `background:${color(id)}` }), m.name, spec.reference ? h('small', null, ' reference') : null),
      h('td', { class: 'num' }, fmtUsd(m.final, 0)),
      h('td', { class: 'num' }, fmtPct(m.totalReturn, 0)),
      h('td', { class: 'num' }, fmtPct(m.cagr)),
      h('td', { class: 'num down', title: `Peak ${m.maxDDPeak}, trough ${m.maxDDTrough}` }, fmtPct(m.maxDD, 1)),
      h('td', { class: 'num' }, fmtPct(m.vol, 1, false)),
      h('td', { class: 'num' }, m.sharpe === null ? '—' : fmtNum(m.sharpe)),
      h('td', { class: 'num' }, m.sortino === null ? '—' : fmtNum(m.sortino)),
      h('td', { class: 'num' }, m.calmar === null ? '—' : fmtNum(m.calmar)),
      h('td', { class: 'num ' + ((m.worstYear?.ret ?? 0) < 0 ? 'down' : '') }, m.worstYear ? `${fmtPct(m.worstYear.ret, 1)} (${m.worstYear.year})` : '—'),
      h('td', { class: 'num' }, m.kind === 'ROTATION' || m.kind === 'CLAUDE_V2' ? String(m.completedCycles) : '—'),
      h('td', { class: 'num' }, fmtPct(m.investedPct, 0, false)),
      h('td', { class: 'num' }, `${fmtNum(m.avgWeight, 1)} / ${fmtNum(m.maxWeight, 1)}%`),
      h('td', { class: 'num' }, fmtUsd(m.totalCosts, 0)),
      h('td', { class: 'num' }, `${m.tqqqTrades}`));
  };
  wrap.append(section('Results by model', 'Same window, capital, costs, data and next-session execution for every model. Hover a name for its definition; tick up to three to compare on the chart.',
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid metrics' },
      h('thead', null, h('tr', null, h('th', null, 'Chart'), h('th', null, 'Model'), h('th', { class: 'num' }, 'Final value'), h('th', { class: 'num' }, 'Total return'), h('th', { class: 'num' }, 'CAGR'), h('th', { class: 'num' }, 'Max drawdown'),
        h('th', { class: 'num' }, 'Volatility'), h('th', { class: 'num' }, 'Sharpe'), h('th', { class: 'num' }, 'Sortino'), h('th', { class: 'num' }, 'Calmar'), h('th', { class: 'num' }, 'Worst year'),
        h('th', { class: 'num' }, 'Completed cycles'), h('th', { class: 'num' }, 'Time in TQQQ'), h('th', { class: 'num' }, 'Avg / max TQQQ weight'), h('th', { class: 'num' }, 'Costs'), h('th', { class: 'num' }, 'TQQQ trades'))),
      h('tbody', null, ...MODEL_ORDER.map(metricRow)))),
    h('p', { class: 'fine' }, 'Read the columns together: a higher CAGR that comes with a deeper drawdown, a worse worst year or more trades is a different risk, not a better strategy. Results are in-sample on one historical path; see Strategy Research for robustness checks.')));

  const host = h('div', { class: 'chart-host chart-growth' });
  const cmp = S.bt.compare;
  wrap.append(section('Portfolio growth', `Daily closing equity from ${fmtUsd(r.config.initialCapital, 0)}. Comparing ${cmp.length} of ${shown.length} models.`,
    h('div', { class: 'chart-controls' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Scale' },
        h('button', { type: 'button', class: S.bt.log ? '' : 'on', 'aria-pressed': !S.bt.log, onclick: () => { S.bt.log = false; rerender(); } }, 'Normal'),
        h('button', { type: 'button', class: S.bt.log ? 'on' : '', 'aria-pressed': S.bt.log, onclick: () => { S.bt.log = true; rerender(); } }, 'Logarithmic')),
      h('div', { class: 'chips' }, ...shown.map((id) => h('button', { type: 'button', class: 'chip' + (cmp.includes(id) ? ' on' : ''), 'aria-pressed': cmp.includes(id), onclick: () => toggleCompare(id, !cmp.includes(id)) },
        h('i', { class: 'lk', style: `background:${color(id)}` }), byId.get(id)!.short)))),
    host,
    h('div', { class: 'chart-legend' }, ...cmp.map((id) => h('span', null, h('i', { class: 'lk', style: `background:${color(id)}` }), byId.get(id)!.short)))));
  queueMicrotask(() => {
    growthChart?.destroy();
    growthChart = new LineChart(host, 'Portfolio value by model');
    const cs = getComputedStyle(document.documentElement);
    growthChart.set(r.dates, cmp.map((id) => ({ id, name: byId.get(id)!.short, color: cs.getPropertyValue(MODEL_COLORS[id] ?? '--c7').trim(), values: byId.get(id)!.equity })), S.bt.log, (v) => fmtCompactUsd(v));
  });

  const years = byId.get('QQQ100')!.years.map((y) => y.year);
  wrap.append(section('Annual performance', 'Calendar-year returns. Partial years are marked; the annualised rate (CAGR) is in the table above.',
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Year'), ...shown.map((id) => h('th', { class: 'num' }, byId.get(id)!.short)))),
      h('tbody', null, ...years.map((y) => h('tr', null,
        h('th', { scope: 'row' }, String(y), byId.get('QQQ100')!.years.find((x) => x.year === y)?.partial ? h('small', null, ' partial') : null),
        ...shown.map((id) => {
          const v = byId.get(id)!.years.find((x) => x.year === y)?.ret ?? null;
          return h('td', { class: 'num ' + (v !== null && v < 0 ? 'down' : '') }, fmtPct(v, 1));
        }))))))));

  const cycleTable = (m: ModelResult | undefined, open: boolean) => {
    if (!m) return null;
    const wins = m.cycles.filter((c) => (c.returnPct ?? 0) > 0).length;
    return section(`${m.name}: entries and exits`, `${m.completedCycles} completed cycle${m.completedCycles === 1 ? '' : 's'}${m.cycles.length > m.completedCycles ? ' plus one open' : ''}, ${wins} with a positive TQQQ sleeve return after costs.`,
      m.cycles.length ? h('details', { class: 'advanced', open: open }, h('summary', null, open ? 'Cycle list' : `Show all ${m.cycles.length} cycles`), h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Entry signal'), h('th', null, 'Bought'), h('th', null, 'Added'), h('th', { class: 'num' }, 'Trims'), h('th', null, 'Exit signal'), h('th', null, 'Sold'), h('th', { class: 'num' }, 'Sleeve return'))),
        h('tbody', null, ...m.cycles.map((c, i) => h('tr', null,
          h('td', null, String(i + 1)), h('td', null, fmtDateShort(c.entrySignal)), h('td', null, fmtDateShort(c.entryDate)), h('td', null, c.addDate ? fmtDateShort(c.addDate) : '—'),
          h('td', { class: 'num' }, String(c.trims)), h('td', null, c.exitSignal ? fmtDateShort(c.exitSignal) : c.open ? 'Open' : '—'), h('td', null, c.exitDate ? fmtDateShort(c.exitDate) : 'Held at end'),
          h('td', { class: 'num ' + ((c.returnPct ?? 0) < 0 ? 'down' : 'up') }, fmtPct(c.returnPct, 1)))))))) : h('p', { class: 'empty' }, 'No TQQQ entries in this window.'));
  };
  wrap.append(cycleTable(byId.get('CLAUDE_V2'), true) as HTMLElement);
  if (byId.has('CLAUDE_V2_MOD')) wrap.append(cycleTable(byId.get('CLAUDE_V2_MOD'), false) as HTMLElement);
  wrap.append(cycleTable(byId.get('SMA_CROSS'), false) as HTMLElement);
  if (byId.has('SMA_CROSS_MOD')) wrap.append(cycleTable(byId.get('SMA_CROSS_MOD'), false) as HTMLElement);
  wrap.append(cycleTable(byId.get('SMA200_ROT'), false) as HTMLElement);

  // Trade log per model, with CSV export.
  if (!byId.has(S.bt.tradeModel)) S.bt.tradeModel = 'CLAUDE_V2';
  const tm = byId.get(S.bt.tradeModel) ?? r.models[0];
  const tradeRows = [...tm.trades].reverse().slice(0, 25);
  wrap.append(section('Simulated trade log', 'Every simulated execution: signal close, next-open fill price, shares, cost and the TQQQ weight after purchases. Simulated only; never your transactions.',
    h('div', { class: 'chart-controls' },
      field('Model', h('select', { id: 'bt-trades', value: tm.id, onchange: (e: Event) => { S.bt.tradeModel = (e.target as HTMLSelectElement).value; rerender(); } }, ...shown.map((id) => h('option', { value: id }, byId.get(id)!.short)))),
      h('button', { class: 'btn', type: 'button', onclick: () => void offerCsv(`backtest-trades-${tm.id.toLowerCase()}-${r.dates[0]}-${r.dates[N - 1]}.csv`, tradesCsv(tm)) }, icon('download', 16), `Trades CSV (${tm.trades.length})`),
      h('button', { class: 'btn', type: 'button', onclick: () => void offerCsv(`backtest-equity-${r.dates[0]}-${r.dates[N - 1]}.csv`, equityCsv(r)) }, icon('download', 16), 'Daily equity CSV (all models)')),
    tradeRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Executed'), h('th', null, 'Signal close'), h('th', null, 'Type'), h('th', null, 'Symbol'), h('th', { class: 'num' }, 'Shares'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Value'), h('th', { class: 'num' }, 'Cost'), h('th', { class: 'num' }, 'TQQQ weight after'))),
      h('tbody', null, ...tradeRows.map((t) => h('tr', null, h('td', null, fmtDateShort(t.date)), h('td', null, t.signalDate ? fmtDateShort(t.signalDate) : '—'),
        h('td', null, tag(`${t.side} ${t.kind}`, t.side === 'BUY' ? 'bull' : t.kind === 'EXIT' ? 'risk' : 'wait')), h('td', null, t.symbol),
        h('td', { class: 'num' }, fmtNum(t.shares, 2)), h('td', { class: 'num' }, fmtNum(t.price, 4)), h('td', { class: 'num' }, fmtUsd(t.value, 0)), h('td', { class: 'num' }, fmtUsd(t.fee)),
        h('td', { class: 'num' }, t.postWeight === undefined ? '—' : fmtPct(t.postWeight * 100, 3, false))))))) : h('p', { class: 'empty' }, 'No trades.'),
    tm.trades.length > 25 ? h('p', { class: 'fine' }, `Latest 25 of ${tm.trades.length} trades shown; the CSV has all of them.`) : null));

  const reb = byId.get('QQQ_TQQQ_M');
  const bh = byId.get('QQQ_TQQQ_BH');
  if (reb && bh) {
    const lastBhW = bh.weights[N - 1] * 100;
    wrap.append(section('Keeping 5% versus starting with 5%', null,
      h('div', { class: 'explain' },
        h('p', null, 'Strategy C keeps TQQQ at 5% by rebalancing every month. Buying 5% once and never touching it is a different bet: the slice drifts with TQQQ, growing far past 5% after a long rally and shrinking after a crash, so the risk changes without any decision from you. It is shown only as a high-risk reference, never as a maintained 5% allocation.'),
        h('p', null, `In this window the untouched slice ended at ${fmtPct(lastBhW, 1, false)} of the portfolio and peaked at ${fmtPct(bh.maxWeight, 1, false)} (final ${fmtUsd(bh.final, 0)}, max drawdown ${fmtPct(bh.maxDD)}). The monthly-rebalanced version averaged ${fmtPct(reb.avgWeight, 2, false)} with a ${fmtPct(reb.maxWeight, 1, false)} peak between rebalances (${reb.tqqqTrades} TQQQ trades; final ${fmtUsd(reb.final, 0)}, max drawdown ${fmtPct(reb.maxDD)}).`),
        h('p', null, 'Rebalancing back to 5% after a TQQQ crash means buying more of a 3× fund on the way down. Claude V2 and the SMA rotation avoid that by moving the sleeve to cash in downtrends; the monthly strategy accepts it in exchange for always being invested.'))));
  }
  wrap.append(section('Assumptions', null, h('ul', { class: 'assume' },
    h('li', null, 'Signals are taken at completed Daily closes and executed at the next session’s open. Nothing executes at the signal close.'),
    h('li', null, 'Actual TQQQ prices are used (not 3× QQQ). Prices are split-adjusted by Twelve Data and not dividend-adjusted; dividends, when enabled, are credited once as cash on the ex-date to shares held at the prior close and reinvested at the next month-end rebalance.'),
    h('li', null, `Every trade pays ${fmtNum(r.config.feeBps, 1)} bps plus ${fmtUsd(r.config.feeFixed)} fixed. Fractional shares are used in simulations because split-adjusted history has no meaningful whole-share counts.`),
    h('li', null, 'The QQQ core is 95% (100% for buy-and-hold). Month-end rebalancing is decided at the last close of each month and executed at the next open; trades under 0.1% of equity are skipped. In the Claude V2 models, rebalancing only moves QQQ and cash; TQQQ changes only through its own rules.'),
    h('li', null, 'Plain SMA200 rotation: 5% TQQQ after any close above SMA200, cash after a close at or below it. SMA50/SMA200 rotation: 5% TQQQ while SMA50 is strictly above SMA200, cash when it is at or below; both reset the sleeve to 5% monthly while held. Monthly 95/5: TQQQ reset to 5% every month, never liquidated.'),
    h('li', null, 'No margin, no short selling. Cash earns the chosen rate. CAGR uses calendar time (days ÷ 365.25); Sharpe, Sortino and volatility use daily returns over 252 sessions; Calmar is CAGR ÷ |max drawdown|.'),
    h('li', null, 'Mike V2 confirmation is listed but not simulated until its TQQQ rules are supplied.'),
    ...r.notes.map((n) => h('li', null, n)))));
  return wrap;
}

// ---------- Strategy Research

function exploratory(): HTMLElement {
  return tag('Exploratory · in-sample', 'wait');
}

function pageResearch(): HTMLElement {
  const win = backtestWindow();
  const R = S.research;
  const page = h('div', { class: 'page' });
  page.append(section('Strategy research', 'How sensitive the trend strategies are to nearby settings, how each strategy behaved in specific market periods, what a walk-forward choice would have done, and how much each methodology assumption moves the results. The default strategies are never changed here.',
    btForm((f) => void runResearch(f), 'Run research'),
    h('p', { class: 'sim-flag' }, tag('Simulation', 'na'), ' Uses the same validated candles, engine, costs and execution as the Backtesting page (the settings above are shared with it). Parameter tests chosen after looking at history are exploratory, not out-of-sample.')));
  if (R.error) page.append(h('div', { class: 'banner banner-err' }, icon('info', 18), h('div', null, R.error)));
  if (R.inputs && !R.inputs.ok) page.append(h('div', { class: 'banner banner-err' }, icon('info', 18), h('div', null, h('b', null, 'Input data failed validation; research was not run. '), h('ul', { class: 'issues' }, ...R.inputs.issues.map((x) => h('li', null, x))))));
  if (!R.sens) {
    page.append(section('Results', null, h('p', { class: 'empty tall' }, win ? 'Press Run research. It runs about a dozen full simulations, which takes a few seconds.' : 'Waiting for validated history.')));
    page.append(methodologyDoc());
    return page;
  }
  const s = R.sens;
  page.append(h('div', { class: 'run-meta' }, h('span', null, R.cfgNote), h('span', null, R.ranAt ? `Run ${fmtMytTime(R.ranAt)}` : '')));
  const metricHead = () => h('thead', null, h('tr', null, h('th', null, 'Setting'), h('th', { class: 'num' }, 'CAGR'), h('th', { class: 'num' }, 'Max drawdown'), h('th', { class: 'num' }, 'Sharpe'), h('th', { class: 'num' }, 'Sortino'), h('th', { class: 'num' }, 'Calmar'), h('th', { class: 'num' }, 'Worst year'), h('th', { class: 'num' }, 'Cycles'), h('th', { class: 'num' }, 'Time in TQQQ'), h('th', { class: 'num' }, 'Final value')));
  const metricTr = (r: typeof s.pairs[number], ref = false) => h('tr', { class: r.isDefault ? 'row-focus' : ref ? 'row-ref' : '' },
    h('th', { scope: 'row' }, r.label, r.isDefault ? h('small', null, ' default') : null),
    h('td', { class: 'num' }, fmtPct(r.cagr)), h('td', { class: 'num down' }, fmtPct(r.maxDD, 1)), h('td', { class: 'num' }, r.sharpe === null ? '—' : fmtNum(r.sharpe, 3)),
    h('td', { class: 'num' }, r.sortino === null ? '—' : fmtNum(r.sortino, 3)), h('td', { class: 'num' }, r.calmar === null ? '—' : fmtNum(r.calmar, 3)),
    h('td', { class: 'num ' + ((r.worstYear ?? 0) < 0 ? 'down' : '') }, fmtPct(r.worstYear, 1)), h('td', { class: 'num' }, ref && r.id === 'QQQ100' ? '—' : String(r.completedCycles)),
    h('td', { class: 'num' }, fmtPct(r.investedPct, 0, false)), h('td', { class: 'num' }, fmtUsd(r.final, 0)));
  page.append(section('1 · SMA pair sensitivity', h('span', null, exploratory(), ` The five pairs listed in the brief, run on one shared window (${fmtDate(s.run.dates[0])} to ${fmtDate(s.run.dates[s.run.dates.length - 1])}).`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, metricHead(), h('tbody', null, ...s.pairs.map((r) => metricTr(r)), h('tr', { class: 'row-sep' }, h('th', { colspan: '10' }, 'Reference models, same window')), ...s.references.map((r) => metricTr(r, true))))),
    h('p', { class: 'explain-line' }, s.summary),
    h('p', { class: 'fine' }, `Spread across pairs: CAGR ${fmtNum(s.cagrRange[1] - s.cagrRange[0], 2)} points, max drawdown ${fmtNum(s.ddRange[1] - s.ddRange[0], 1)} points, Sharpe ${fmtNum(s.sharpeRange[1] - s.sharpeRange[0], 3)}. The default stays SMA50/SMA200 whatever this table shows.`)));

  const periods = R.periods ?? [];
  const ids = ['QQQ100', 'QQQ_TQQQ_M', 'SMA200_ROT', 'CLAUDE_V2', 'SMA_CROSS', 'QQQ_TQQQ_BH'].filter((id) => periods.some((p) => p.cells[id]));
  page.append(section('2 · Historical periods', 'Read from one continuous run, so each strategy enters a period in the state its rules had actually reached. Return from the prior close · maximum drawdown inside the period.',
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Period'), ...ids.map((id) => h('th', { class: 'num' }, specOf(id).short)))),
      h('tbody', null, ...periods.map((p) => h('tr', null,
        h('th', { scope: 'row', title: p.period.note }, p.period.label, h('small', null, p.covered ? ` ${fmtDateShort(p.from)} → ${fmtDateShort(p.to)}` : ' not in window')),
        ...ids.map((id) => {
          const c = p.cells[id];
          return h('td', { class: 'num' }, c ? h('span', null, h('b', { class: c.ret < 0 ? 'down' : '' }, fmtPct(c.ret, 1)), h('small', null, ` · ${fmtPct(c.maxDD, 1)}`)) : '—');
        })))))),
    h('ul', { class: 'assume' }, ...PERIODS.map((p) => h('li', null, h('b', null, p.label + ': '), p.note)))));

  const w = R.walk;
  if (w) {
    page.append(section('3 · Walk-forward test', h('span', null, tag('Partly out-of-sample', 'hold'), ` ${w.label}`),
      h('p', { class: 'explain-line' }, `Rule: ${w.criterion}. At least ${w.minTrainYears} years of history before the first test year. Each test year’s return is taken from the chosen pair’s continuous run, so switching pairs has no extra cost here.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Test year'), h('th', null, 'Chosen from earlier data'), h('th', { class: 'num' }, 'Its Sharpe (train)'), h('th', { class: 'num' }, 'Chosen pair'), h('th', { class: 'num' }, 'SMA50/200 (default)'), h('th', { class: 'num' }, 'Claude V2'), h('th', { class: 'num' }, 'Monthly 95/5'), h('th', { class: 'num' }, 'QQQ 100%'))),
        h('tbody', null, ...w.steps.map((x) => h('tr', null, h('th', { scope: 'row' }, String(x.testYear)), h('td', null, x.chosenLabel),
          h('td', { class: 'num' }, fmtNum(x.scores.find((y) => y.id === x.chosen)?.sharpe ?? null, 3)),
          ...[x.chosenRet, x.defaultRet, x.refRets.CLAUDE_V2, x.refRets.QQQ_TQQQ_M, x.refRets.QQQ100].map((v) => h('td', { class: 'num ' + (v < 0 ? 'down' : '') }, fmtPct(v, 1)))))),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row', colspan: '3' }, `Annualised over the test years (${w.testFrom ? fmtDateShort(w.testFrom) : ''} → ${w.testTo ? fmtDateShort(w.testTo) : ''})`),
          ...[w.chosenCagr, w.defaultCagr, w.refCagr.CLAUDE_V2, w.refCagr.QQQ_TQQQ_M, w.refCagr.QQQ100].map((v) => h('td', { class: 'num' }, h('b', null, fmtPct(v)))))))),
      h('p', { class: 'fine' }, 'If the walk-forward choice does not beat the fixed default on unseen years, re-optimising the pair would not have added value; if it does, the gain should be weighed against the risk that the candidate list itself was picked with hindsight.')));
  }

  const m = R.method;
  if (m) {
    page.append(section('4 · Methodology sensitivity', 'The same strategies under alternative assumptions, to show which choices move results and help reconcile with other backtests (such as a Python script). CAGR · max drawdown.',
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Assumption'), h('th', null, 'Window start'), ...METHOD_MODELS.map((id) => h('th', { class: 'num' }, specOf(id).short)))),
        h('tbody', null, ...m.map((row) => h('tr', { class: row.variant.id === 'default' ? 'row-focus' : '' },
          h('th', { scope: 'row', title: row.variant.explain }, row.variant.label),
          h('td', null, fmtDateShort(row.start)),
          ...METHOD_MODELS.map((id) => {
            const c = row.cells[id];
            const base = m[0].cells[id];
            const delta = c && base && row.variant.id !== 'default' ? c.cagr - base.cagr : null;
            const flat = delta !== null && Math.abs(delta) < 0.005;
            return h('td', { class: 'num' }, c ? h('span', null, h('b', null, fmtPct(c.cagr)), delta !== null ? h('small', { class: flat ? '' : delta >= 0 ? 'up' : 'down' }, flat ? ' ±0.00' : ` ${delta >= 0 ? '+' : MINUS}${Math.abs(delta).toFixed(2)}`) : null, h('small', null, ` · ${fmtPct(c.maxDD, 1)}`)) : '—');
          }))),
          h('tr', { class: 'row-ref' }, h('th', { scope: 'row' }, 'Default, CAGR on 252 sessions a year'), h('td', null, '—'),
            ...METHOD_MODELS.map((id) => h('td', { class: 'num' }, m[0].cells[id] ? fmtPct(m[0].cells[id].cagr252) : '—')))))),
      h('ul', { class: 'assume' }, ...m.map((row) => h('li', null, h('b', null, row.variant.label + ': '), row.variant.explain)))));
  }
  page.append(methodologyDoc());
  return page;
}

async function runResearch(form: HTMLElement): Promise<void> {
  if (!readBtForm(form)) { S.research.error = 'Choose a start date before the end date.'; rerender(); return; }
  const R = S.research;
  R.running = true;
  R.error = null;
  rerender();
  if (S.bt.form.dividends) await loadDividends();
  await new Promise((res) => setTimeout(res, 30));
  try {
    R.inputs = inputCheck();
    if (R.inputs.ok) {
      const cfg = btConfig();
      const q = S.qqq.report!.completed, t = S.tqqq.report!.completed;
      const divs = { QQQ: S.divs.QQQ, TQQQ: S.divs.TQQQ };
      R.sens = sensitivity(q, t, divs, cfg, SMA_PAIRS);
      const main = simulate(q, t, divs, { ...cfg, modified: null, crossModified: null, monthlyModified: null });
      R.periods = periodTable(main);
      R.walk = walkForward(R.sens, cfg.cashRatePct);
      R.method = methodology(q, t, divs, cfg);
      R.ranAt = Date.now();
      R.cfgNote = `${fmtUsd(cfg.initialCapital, 0)} · ${fmtNum(cfg.feeBps, 1)} bps${cfg.feeFixed ? ` + ${fmtUsd(cfg.feeFixed)}` : ''} per trade · cash ${fmtNum(cfg.cashRatePct, 1)}% · ${cfg.useDividends ? 'dividends credited' : 'price return'} · next-open execution`;
    } else {
      R.sens = null;
    }
  } catch (e) {
    R.error = 'Research run failed: ' + ((e as Error)?.message ?? String(e));
  }
  R.running = false;
  rerender();
}

/** The standardized methodology, written out item by item for reconciling with other backtests. */
function methodologyDoc(): HTMLElement {
  const items: [string, string][] = [
    ['CAGR and start date', 'Valuation starts at the first session’s open, when the opening allocation is bought; CAGR = (final ÷ capital)^(1 ÷ years) − 1 with years = calendar days between the first and last session ÷ 365.25.'],
    ['First eligible SMA date and warm-up', 'Moving averages use QQQ history from 1999, so SMA200 (and SMA50) already exist on TQQQ’s first session (11 Feb 2010). The window starts at the latest of: your start date, TQQQ’s first session, and the first session where every model’s averages exist.'],
    ['Starting allocations', '100% QQQ for buy-and-hold; 95% QQQ + 5% cash for 95/5 cash, Claude V2 and the rotations (whose sleeve starts in cash and is bought on the first signal); 95% QQQ + 5% TQQQ for the monthly and the once-only reference.'],
    ['Dividends and splits', 'Twelve Data prices are split-adjusted and not dividend-adjusted (verified). Dividends are credited once, as cash, on the ex-date, to shares held at the prior close. Twelve Data’s dividend history begins mid-2012 (QQQ) and mid-2014 (TQQQ); earlier payments are missing and noted in the run.'],
    ['Cash and accounting', 'Cash earns the chosen rate (0% by default), compounded daily by calendar days. No margin: purchases are cut to the cash available, fees included. Equity = shares × close + cash.'],
    ['Monthly rebalancing', 'Decided at the last completed close of each month, executed at the next open. Trades smaller than 0.1% of equity are skipped. Claude V2 rebalances only QQQ and cash; the rotations reset the TQQQ sleeve to 5% only while it is held.'],
    ['Fees and slippage', '5 bps of traded value per transaction by default (configurable), plus an optional fixed fee. No separate bid–ask model.'],
    ['Signal close vs execution', 'Every decision uses completed closes up to the signal session and executes at the next session’s open price. The research page shows the effect of trading at the signal close instead.'],
    ['Session counting', 'A built-in NYSE calendar (holidays, special closures, early closes). Claude V2’s 20-session wait counts completed sessions from the first purchase’s session, inclusive.'],
    ['Execution prices', 'The next session’s official open for every symbol. Exits sell the whole sleeve at that open; there are no intraday stops.'],
    ['Portfolio values', 'Daily equity at each close; drawdown from the running peak of daily closes; volatility, Sharpe and Sortino from daily returns × √252.'],
    ['Rounding and shares', 'Fractional shares in simulations (split-adjusted prices make whole-share counts meaningless historically); whole shares, rounded down, for your real orders.'],
  ];
  return section('Standard methodology', 'The 12 items a different backtest most often treats differently. If your Python results differ, compare these first.',
    h('ol', { class: 'rules' }, ...items.map(([k, v]) => h('li', null, h('b', null, k + '. '), v))),
    h('p', { class: 'fine' }, 'Likely sources of a gap with a Python backtest: Adjusted Close (which includes dividends) instead of split-only prices plus dividends; synthetic 3× QQQ instead of actual TQQQ; trading at the signal close; QQQ history that starts in 2010 (SMA200 only from November 2010); a different start date, fee level or CAGR convention. The methodology sensitivity table above quantifies each one on your data.'));
}

// ---------- Trade history

function pageHistory(): HTMLElement {
  const filter = S.histFilter;
  const all = [...S.data.trades].reverse();
  const trades = filter === 'ALL' ? all : all.filter((t) => t.strategy === filter);
  const realized = trades.reduce((s, t) => s + (t.realizedUsd ?? 0), 0);
  const fees = trades.reduce((s, t) => s + t.fee, 0);
  const label: Record<TradeKind, string> = { INITIAL: 'First purchase', ADD: 'Second purchase', TRIM: 'Trim', EXIT: 'Exit', ENTRY: 'Entry', REBALANCE: 'Rebalance', OTHER_BUY: 'Other buy', OTHER_SELL: 'Other sell' };
  const bookShort: Record<Book, string> = { CLAUDE_V2: 'A · Claude V2', SMA_CROSS: 'B · SMA50/200', MONTHLY: 'C · Monthly', CORE: 'QQQ core' };
  const page = h('div', { class: 'page' });
  page.append(section('Your transactions', `Real trades you recorded · realised P/L ${fmtUsd(realized)} · fees ${fmtUsd(fees)}${filter === 'ALL' ? '' : ` · ${bookShort[filter]}`}`,
    h('div', { class: 'chart-controls' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter by book' }, ...(['ALL', 'CLAUDE_V2', 'SMA_CROSS', 'MONTHLY', 'CORE'] as const).map((b) =>
        h('button', { type: 'button', class: filter === b ? 'on' : '', 'aria-pressed': filter === b, onclick: () => { S.histFilter = b; rerender(); } }, b === 'ALL' ? 'All' : bookShort[b]))),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: S.storeState !== 'ok', onclick: () => openTradeModal('OTHER_BUY', 0, undefined, filter === 'ALL' ? S.strategy : filter) }, icon('plus', 16), 'Record a transaction')),
    trades.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Strategy'), h('th', null, 'Type'), h('th', null, 'Symbol'), h('th', { class: 'num' }, 'Shares'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Value'), h('th', { class: 'num' }, 'Fee'), h('th', { class: 'num' }, 'Realised P/L'), h('th', null, 'Signal close'), h('th', null, 'Note'), h('th', null, ''))),
      h('tbody', null, ...trades.map((t) => {
        const del = h('td', { class: 'row-act' });
        const ask = () => {
          clear(del);
          del.append(h('span', { class: 'confirm' }, 'Delete record? Holdings stay as they are. ',
            h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async () => {
              const items = S.data.trades.filter((x) => x.id !== t.id);
              if (await persist('Transaction list', (st) => st.saveTrades(items))) { S.data.trades = items; toast('Record deleted'); rerender(); }
            } }, 'Delete'),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { clear(del); del.append(trash()); } }, 'Keep')));
        };
        const trash = () => h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete the ${t.date} record`, disabled: S.storeState !== 'ok', onclick: ask }, icon('trash', 16));
        del.append(trash());
        return h('tr', null, h('td', null, fmtDate(t.date)), h('td', null, bookShort[t.strategy]), h('td', null, tag(label[t.kind], t.side === 'BUY' ? 'bull' : t.kind === 'EXIT' ? 'risk' : 'wait')), h('td', null, t.symbol),
          h('td', { class: 'num' }, `${t.side === 'SELL' ? MINUS : ''}${t.shares}`), h('td', { class: 'num' }, fmtUsd(t.price)), h('td', { class: 'num' }, fmtUsd(t.shares * t.price)),
          h('td', { class: 'num' }, fmtUsd(t.fee)), h('td', { class: 'num ' + ((t.realizedUsd ?? 0) < 0 ? 'down' : t.realizedUsd ? 'up' : '') }, t.realizedUsd === null ? '—' : fmtUsd(t.realizedUsd)),
          h('td', null, t.signalDate ? fmtDateShort(t.signalDate) : '—'), h('td', { class: 'note' }, t.note || ''), del);
      })))) : h('p', { class: 'empty' }, filter === 'ALL' ? 'No transactions recorded. Use Record execution on the Overview after you trade, or add a past trade here.' : 'No transactions in this book.')));
  const alerts = [...S.data.alerts].reverse();
  const typeLabel = new Map(ALERT_TYPES.map((a) => [a.type, a.label]));
  page.append(section('Signal log', 'Algorithm-generated signals from completed Daily closes, kept with the session that triggered them. These are not transactions and never change your holdings.',
    alerts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Session'), h('th', null, 'Alert'), h('th', null, 'Detail'), h('th', null, 'Logged'))),
      h('tbody', null, ...alerts.slice(0, 100).map((a) => h('tr', null, h('td', null, fmtDate(a.session)), h('td', null, typeLabel.get(a.type) ?? a.type), h('td', null, a.text), h('td', null, a.createdAt ? fmtMyt(Date.parse(a.createdAt)) : '—')))))) : h('p', { class: 'empty' }, 'No signals logged yet.')));
  page.append(h('p', { class: 'fine' }, 'Three kinds of record are kept apart: simulated trades (Backtesting, never saved), algorithm signals (Signal log) and your confirmed transactions (above). Switching strategies changes what is shown, never these records.'));
  return page;
}

// ---------- Settings

function pageSettings(): HTMLElement {
  const st = S.data.settings;
  const p = st.params;
  const base = CLAUDE_V2_BASELINE;
  const meta: Record<keyof StrategyParams, [string, string, string]> = {
    entryBufferPct: ['Entry buffer', '%', '0.1'], confirmCloses: ['Entry confirmation', 'completed Daily closes', '1'], firstAllocPct: ['First allocation', '% of equity', '0.1'],
    addWaitSessions: ['Second-entry waiting period', 'trading sessions', '1'], targetAllocPct: ['Target TQQQ allocation', '% of equity', '0.1'],
    trimThresholdPct: ['Trim threshold', '% (above)', '0.1'], exitBufferPct: ['Exit threshold', '% below SMA200', '0.1'], smaPeriod: ['Moving average', 'sessions', '1'],
  };
  const resetDerived = () => { S.markerRun = null; S.bt.result = null; S.research.sens = null; };
  const err = h('p', { class: 'form-err', role: 'alert' });
  const pform = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid params' },
      h('thead', null, h('tr', null, h('th', null, 'Parameter'), h('th', { class: 'num' }, 'Claude V2 default'), h('th', null, 'Current'), h('th', null, 'Unit'))),
      h('tbody', null,
        ...PARAM_KEYS.map((k) => h('tr', { class: p[k] !== base[k] ? 'row-mod' : '' },
          h('th', { scope: 'row' }, meta[k][0]), h('td', { class: 'num' }, String(base[k])),
          h('td', null, h('input', { id: 'pa-' + k, type: 'number', step: meta[k][2], value: p[k], 'aria-label': meta[k][0] })), h('td', null, meta[k][1]))),
        h('tr', null, h('th', { scope: 'row' }, 'Technical timeframe'), h('td', { class: 'num' }, 'Daily'), h('td', null, 'Daily'), h('td', null, 'fixed')),
        h('tr', null, h('th', { scope: 'row' }, 'Signal asset'), h('td', { class: 'num' }, 'QQQ'), h('td', null, 'QQQ'), h('td', null, 'fixed')),
        h('tr', null, h('th', { scope: 'row' }, 'Investment asset'), h('td', { class: 'num' }, 'TQQQ'), h('td', null, 'TQQQ'), h('td', null, 'fixed'))))),
    err,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn-primary', type: 'submit', disabled: S.storeState !== 'ok' }, 'Save Claude V2 parameters'),
      h('button', { class: 'btn', type: 'button', disabled: S.storeState !== 'ok' || isBaseline(p), onclick: async () => {
        const next = { ...st, params: { ...base }, paramsUpdatedAt: new Date().toISOString() };
        if (await persist('Parameters', (s) => s.saveSettings(next))) { S.data.settings = next; resetDerived(); toast('Reset to the Claude V2 baseline'); rerender(); }
      } }, 'Reset to Claude V2 baseline')));
  pform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const np = { ...p };
    for (const k of PARAM_KEYS) {
      const v = readNum(pform.querySelector('#pa-' + k) as HTMLInputElement);
      if (v === null) { err.textContent = `Enter a value for ${meta[k][0]}.`; return; }
      np[k] = v;
    }
    const problems = validateParams(np);
    if (problems.length) { err.textContent = problems[0]; return; }
    const next = { ...st, params: np, paramsUpdatedAt: new Date().toISOString() };
    if (await persist('Parameters', (s) => s.saveSettings(next))) { S.data.settings = next; resetDerived(); toast(isBaseline(np) ? 'Claude V2 baseline in use' : 'Modified configuration saved'); rerender(); }
  });

  const cp = st.cross, mp = st.monthly;
  const err2 = h('p', { class: 'form-err', role: 'alert' });
  const row = (id: string, label: string, def: number, cur: number, unit: string, step: string) => h('tr', { class: def !== cur ? 'row-mod' : '' },
    h('th', { scope: 'row' }, label), h('td', { class: 'num' }, String(def)), h('td', null, h('input', { id, type: 'number', step, value: cur, 'aria-label': label })), h('td', null, unit));
  const sform = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid params' },
      h('thead', null, h('tr', null, h('th', null, 'Parameter'), h('th', { class: 'num' }, 'Default'), h('th', null, 'Current'), h('th', null, 'Unit'))),
      h('tbody', null,
        h('tr', { class: 'row-sep' }, h('th', { colspan: '4' }, 'B · SMA50/SMA200 rotation')),
        row('sx-fast', 'Fast moving average', SMA_CROSS_BASELINE.fast, cp.fast, 'sessions', '1'),
        row('sx-slow', 'Slow moving average', SMA_CROSS_BASELINE.slow, cp.slow, 'sessions', '1'),
        row('sx-target', 'TQQQ sleeve target', SMA_CROSS_BASELINE.targetPct, cp.targetPct, '% of equity', '0.1'),
        h('tr', { class: 'row-sep' }, h('th', { colspan: '4' }, 'C · Monthly rebalanced')),
        row('mo-target', 'TQQQ target', MONTHLY_BASELINE.targetPct, mp.targetPct, '% of equity', '0.1')))),
    err2,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn-primary', type: 'submit', disabled: S.storeState !== 'ok' }, 'Save B and C parameters'),
      h('button', { class: 'btn', type: 'button', disabled: S.storeState !== 'ok' || (isCrossBaseline(cp) && isMonthlyBaseline(mp)), onclick: async () => {
        const next = { ...st, cross: { ...SMA_CROSS_BASELINE }, monthly: { ...MONTHLY_BASELINE } };
        if (await persist('Parameters', (s) => s.saveSettings(next))) { S.data.settings = next; resetDerived(); toast('Strategies B and C reset to defaults'); rerender(); }
      } }, 'Reset B and C to defaults')));
  sform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (id: string) => readNum(sform.querySelector('#' + id) as HTMLInputElement);
    const nc: CrossParams = { fast: g('sx-fast') ?? NaN, slow: g('sx-slow') ?? NaN, targetPct: g('sx-target') ?? NaN };
    const nm = { targetPct: g('mo-target') ?? NaN };
    const problems = [...validateCross(nc), ...validateMonthly(nm)];
    if (problems.length) { err2.textContent = problems[0]; return; }
    const next = { ...st, cross: nc, monthly: nm };
    if (await persist('Parameters', (s) => s.saveSettings(next))) { S.data.settings = next; resetDerived(); toast(isCrossBaseline(nc) && isMonthlyBaseline(nm) ? 'Defaults in use' : 'Modified configuration saved'); rerender(); }
  });

  const alertForm = h('div', { class: 'toggles' }, ...ALERT_TYPES.map((a) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', id: 'al-' + a.type, checked: st.alerts[a.type] !== false, disabled: S.storeState !== 'ok', onchange: async (e: Event) => {
      const next = { ...st, alerts: { ...st.alerts, [a.type]: (e.target as HTMLInputElement).checked } };
      if (await persist('Alert settings', (s) => s.saveSettings(next))) S.data.settings = next;
    } }), a.label.replace('+2%', `+${p.entryBufferPct}%`).replace('−3%', `${MINUS}${p.exitBufferPct}%`).replace('6%', `${p.trimThresholdPct}%`).replace('SMA50', `SMA${cp.fast}`).replace('SMA200', `SMA${cp.slow}`))));
  const refreshSel = h('select', { id: 'set-refresh', value: String(st.quoteRefreshMin), disabled: S.storeState !== 'ok', onchange: async (e: Event) => {
    const next = { ...st, quoteRefreshMin: Number((e.target as HTMLSelectElement).value) };
    if (await persist('Refresh setting', (s) => s.saveSettings(next))) { S.data.settings = next; toast('Live quote refresh updated'); }
  } }, ...[[0, 'Manual only'], [1, 'Every minute'], [2, 'Every 2 minutes'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes']].map(([v, l]) => h('option', { value: String(v) }, String(l))));

  const series = (label: string, s: typeof S.qqq) => kv(label, s.report
    ? `${s.report.completed.length.toLocaleString('en-US')} completed candles, ${fmtDateShort(s.report.completed[0]?.d ?? '')} to ${s.report.lastCompleted ? fmtDateShort(s.report.lastCompleted) : '—'} · ${s.source === 'cache+incremental' ? 'cached history + incremental update' : 'full download'} · ${s.report.status.toUpperCase()}`
    : s.error ? s.error.message : 'Not loaded');
  const usage = S.conn.usage;
  const histIssues = [...(S.qqq.report?.historyIssues ?? []), ...(S.tqqq.report?.historyIssues ?? [])];
  return h('div', { class: 'page' },
    section('A · Claude V2 parameters', isBaseline(p) ? h('span', null, tag('Claude V2 baseline', 'bull'), ' The exact strategy as specified.') : h('span', null, tag('Modified configuration', 'wait'), ` Saved ${st.paramsUpdatedAt ? fmtMyt(Date.parse(st.paramsUpdatedAt)) : ''}. Backtests show it separately from the baseline.`),
      pform,
      h('p', { class: 'fine' }, 'Changing parameters never rewrites recorded transactions or the signal log. Live evaluation and chart markers use the saved parameters; the CLAUDE_V2_BASELINE model always runs with the original values.')),
    section('B and C parameters', isCrossBaseline(cp) && isMonthlyBaseline(mp) ? h('span', null, tag('Defaults', 'bull'), ' SMA50/SMA200 with a 5% sleeve; monthly 95/5.') : h('span', null, tag('Modified configuration', 'wait'), ' Backtests run the defaults and the modified version side by side.'),
      sform,
      h('p', { class: 'fine' }, 'No buffer, stop-loss or extra indicator is added to Strategy B; a variant with any of those would be a separately named strategy.')),
    h('div', { class: 'two-col' },
      section('Alerts', 'Shown in the app while it is open, deduplicated by type and session. Background notifications are not set up.', alertForm),
      section('Live quotes', 'Live quotes are indicative and never used for signals. Each refresh uses 2 Twelve Data credits; Daily candles reload once after each close.', field('Refresh during the regular session', refreshSel))),
    section('Data and connection', null,
      h('dl', { class: 'kvs' },
        kv('Provider', S.rt?.providerNote ?? 'Twelve Data'),
        kv('Status', h('span', { class: S.conn.state === 'ok' ? 'up' : 'down' }, S.conn.message)),
        kv('API credits', usage ? `${usage.used ?? '—'} used in the current minute${usage.limit ? ` of ${usage.limit}` : ''}${usage.plan ? ` · ${usage.plan} plan` : ''}` : h('button', { class: 'btn btn-sm', type: 'button', disabled: !S.rt?.market, onclick: () => void checkUsage() }, 'Check credits')),
        kv('Twelve Data calls this visit', `${S.rt?.market?.calls() ?? 0}`),
        series('QQQ history', S.qqq),
        series('TQQQ history', S.tqqq),
        kv('Price adjustment', 'Split-adjusted, not dividend-adjusted (Twelve Data default); dividends are credited separately in backtests'),
        kv('Price cache', S.rt ? S.rt.cacheNote(S.qqq.cacheWritable) : '—'),
        ...histIssues.slice(0, 3).map((n) => kv('History check', h('span', { class: 'warnc' }, n))),
        ...[S.qqq.note, S.tqqq.note].filter(Boolean).map((n) => kv('Note', n as string)),
        ...derive().notes.slice(0, 3).map((n) => kv('Calendar', n))),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', type: 'button', disabled: !S.rt?.market || S.loadingMarket, onclick: () => void refreshQuotes(false) }, 'Refresh live quotes'),
        h('button', { class: 'btn', type: 'button', disabled: !S.rt?.market || S.loadingMarket, onclick: () => void rebuildCache() }, 'Rebuild price history'))),
    section('How the rules are applied', 'Exact definitions used by every page and the backtest.',
      h('ol', { class: 'rules' },
        h('li', null, 'A Daily candle counts once its regular session has closed (4:00 pm New York, 1:00 pm on early-close days) plus 15 minutes, using a built-in US exchange calendar with holidays and early closes. Times are shown in Malaysian time; US daylight saving is handled automatically.'),
        h('li', null, `Claude V2 qualifying close: QQQ close ≥ SMA200 × ${(1 + p.entryBufferPct / 100).toFixed(3)}. Exit close: QQQ close ≤ SMA200 × ${(1 - p.exitBufferPct / 100).toFixed(3)}. SMA200 is the plain average of the last ${p.smaPeriod} completed closes.`),
        h('li', null, `Claude V2 entry: the latest ${p.confirmCloses} completed closes qualify, no TQQQ is held, no exit is outstanding, and the qualifying run began after the last exit. Second purchase: counted in completed sessions from the first purchase’s session (inclusive); eligible from the ${p.addWaitSessions}th once the latest ${p.confirmCloses} closes qualify again. Trim above ${p.trimThresholdPct}% toward ${p.targetAllocPct}%. Exit on one close at or below the exit level; it overrides entry, add and trim.`),
        h('li', null, `SMA${cp.fast}/SMA${cp.slow}: buy to ${cp.targetPct}% when SMA${cp.fast} is strictly above SMA${cp.slow} at a completed close and the sleeve is empty; reset to ${cp.targetPct}% at the open after each month-end close while held; sell the whole sleeve when SMA${cp.fast} is at or below SMA${cp.slow}. Exit has priority.`),
        h('li', null, `Monthly 95/5: establish ${mp.targetPct}% TQQQ, then reset to ${mp.targetPct}% at the open after each month-end close, buying or selling whole shares within available cash. No signals and no liquidation.`),
        h('li', null, 'Orders are sized from your own recorded sleeve, in whole shares, within cash and never above the target after fees. The app never places or routes orders.'),
        h('li', null, 'Missing, stale or inconsistent data shows DATA UNAVAILABLE; nothing is estimated or substituted. A history check flags price jumps beyond plausibility (QQQ 25%, TQQQ 45% in a day) and TQQQ moves inconsistent with 3× QQQ.'))),
    section('About', null, h('p', { class: 'fine' }, 'Investment decision support only. This page does not place or route orders, and a signal is never recorded as a trade. Backtests are hypothetical. Not financial advice.')),
  );
}
