// Browser test (Playwright): desktop and phone layouts, V1-record migration, every strategy view,
// trade recording, backtest, research, CSV export, disconnected and awaiting states.
// Run after `node build.mjs`:  node tests/e2e/browser.mjs   (screenshots go to tests/e2e/out/)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { realSeries, initScript } from './mock.mjs';

const OUT = process.env.E2E_OUT ?? new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const frag = readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8');
const skeleton = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>${frag}</body></html>`;
const file = OUT + 'page.html';
writeFileSync(file, skeleton);
const url = 'file://' + file;
const log = (k, v) => console.log(k.padEnd(40), typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 600) : JSON.stringify(v).slice(0, 600));
const browser = await chromium.launch();
const V1_SEED = {
  'data/users/u_test/portfolio': { v: 1, confirmed: true, currency: 'USD', totalEquity: 200000, equityRefPrice: 66.29, shares: 140, avgCost: 52.1, cash: 15000, feeFixed: 1, feePct: 0, usdMyr: null, firstEntryDate: '2025-05-14', secondEntryDate: '2025-06-12', lastExitDate: '2025-04-07', lastExitSignalDate: '2025-04-04', updatedAt: '2026-10-24T01:00:00Z' },
  'data/users/u_test/trades': { v: 1, items: [
    { id: 't1', date: '2025-05-14', side: 'BUY', kind: 'INITIAL', shares: 70, price: 45, fee: 1, signalDate: '2025-05-13', note: 'v1 record', realizedUsd: null, createdAt: '2025-05-14T14:00:00Z' },
    { id: 't2', date: '2025-06-12', side: 'BUY', kind: 'ADD', shares: 70, price: 59.2, fee: 1, signalDate: '2025-06-11', note: 'v1 add', realizedUsd: null, createdAt: '2025-06-12T14:00:00Z' }] },
  'data/users/u_test/settings': { v: 1, params: { entryBufferPct: 2, confirmCloses: 2, firstAllocPct: 2.5, addWaitSessions: 20, targetAllocPct: 5, trimThresholdPct: 6, exitBufferPct: 3, smaPeriod: 200 }, paramsUpdatedAt: null, alerts: {}, quoteRefreshMin: 5, approachBand: 0.5 },
};
async function ctx(opts, series, nowIso, patch = '', seed = null) {
  const c = await browser.newContext({ viewport: opts.viewport, colorScheme: opts.scheme, deviceScaleFactor: opts.dpr ?? 1 });
  const page = await c.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.clock.setFixedTime(new Date(nowIso));
  await page.addInitScript(initScript(series, nowIso, seed) + patch);
  return { c, page, errors };
}
const settle = async (page) => { await page.waitForFunction(() => !document.querySelector('.action-word') || document.querySelector('.action-word').textContent !== 'LOADING', null, { timeout: 30000 }); await page.waitForTimeout(500); };
const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
const cards = (page) => page.evaluate(() => [...document.querySelectorAll('.strat-card')].map((c) => `${c.querySelector('.card-eyebrow span').textContent} | sig ${c.querySelector('.sc-block .tag')?.textContent} | act ${c.querySelector('.sc-action')?.textContent} | ${[...c.querySelectorAll('.kv')].map((k) => k.textContent).join(' ; ')}`).join('  ##  '));
const pick = async (page, i) => { await page.click(`.strat-tabs .strat-tab:nth-child(${i + 1})`); await page.waitForTimeout(350); };

// ---------- A: desktop dark, morning in Malaysia after the 26 Oct close, with a V1 record saved
{
  const series = realSeries('2026-10-26');
  const { c, page, errors } = await ctx({ viewport: { width: 1320, height: 950 }, scheme: 'dark' }, series, '2026-10-27T03:00:00Z', '', V1_SEED);
  await page.goto(url);
  await settle(page);
  log('A cards', await cards(page));
  log('A selected action', await page.textContent('.action-word'));
  log('A action headline', await page.textContent('.action-headline'));
  log('A signal line', await page.textContent('.signal-line'));
  log('A tqqq card (migrated)', await page.evaluate(() => document.querySelectorAll('.tick-card')[1].querySelector('.kvs').textContent));
  log('A overflow', await overflow(page));
  await page.screenshot({ path: OUT + 'A1-overview-A.png', fullPage: true });
  await pick(page, 1);
  log('A[B] action', await page.textContent('.action-word'));
  log('A[B] reasons', await page.textContent('.reasons'));
  log('A[B] order', await page.evaluate(() => document.querySelector('.order')?.textContent ?? 'none'));
  await page.screenshot({ path: OUT + 'A2-overview-B.png', fullPage: true });
  await pick(page, 2);
  log('A[C] action', await page.textContent('.action-word'));
  log('A[C] order', await page.evaluate(() => document.querySelector('.order')?.textContent ?? 'none'));
  await page.screenshot({ path: OUT + 'A3-overview-C.png', fullPage: true });
  for (const [i, n] of [[0, 'A'], [1, 'B'], [2, 'C']]) {
    await page.goto(url + '#checklist');
    await page.waitForTimeout(250);
    await pick(page, i);
    log(`A checklist ${n}`, await page.evaluate(() => [...document.querySelectorAll('.check')].map((e) => e.querySelector('.check-st').textContent + ':' + e.querySelector('b').firstChild.textContent).join(' | ')));
    if (n === 'B') await page.screenshot({ path: OUT + 'A4-checklist-B.png', fullPage: true });
  }
  await page.goto(url + '#trend');
  await page.waitForTimeout(300);
  await pick(page, 1);
  await page.waitForTimeout(500);
  const box = await page.$('.chart-price canvas');
  const bb = await box.boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.6, bb.y + bb.height * 0.5);
  await page.waitForTimeout(200);
  log('A[B] trend legend', await page.textContent('.chart-legend'));
  log('A[B] tooltip', await page.evaluate(() => document.querySelector('.chart-tip')?.textContent ?? 'none'));
  log('A[B] cross table', await page.evaluate(() => [...document.querySelectorAll('.grid tbody tr')].slice(0, 4).map((r) => r.textContent).join(' | ')));
  await page.screenshot({ path: OUT + 'A5-trend-B.png' });
  // Portfolio: follow C, enter QQQ core
  await page.goto(url + '#portfolio');
  await page.waitForTimeout(300);
  await pick(page, 2);
  await page.check('#pf-follow-MONTHLY');
  await page.fill('#pf-qqq', '230');
  await page.waitForTimeout(150);
  log('A[C] sleeve view', await page.evaluate(() => [...document.querySelectorAll('.alloc-list .kv')].map((e) => e.textContent).join(' | ')));
  await page.click('#pf-form button[type=submit]');
  await page.waitForTimeout(400);
  log('A toast', await page.evaluate(() => document.querySelector('.toast')?.textContent ?? 'none'));
  log('A risk panel', await page.evaluate(() => document.querySelector('.risk-panel')?.textContent.slice(0, 900)));
  await page.screenshot({ path: OUT + 'A6-portfolio-C.png', fullPage: true });
  // Record the monthly entry from the overview
  await page.goto(url + '#overview');
  await page.waitForTimeout(400);
  log('A[C] order before', await page.evaluate(() => document.querySelector('.order')?.textContent ?? 'none'));
  await page.click('.order .btn-primary');
  await page.waitForSelector('.modal');
  log('A modal defaults', await page.evaluate(() => ['tr-book', 'tr-kind', 'tr-date', 'tr-shares', 'tr-price', 'tr-fee'].map((id) => id + '=' + document.getElementById(id).value).join(' ')));
  await page.fill('#tr-date', '2026-10-26');
  await page.click('.modal button[type=submit]');
  await page.waitForTimeout(500);
  log('A modal closed', await page.evaluate(() => (document.querySelector('.modal') ? document.querySelector('.form-err').textContent : 'closed')));
  log('A[C] action after trade', await page.textContent('.action-word'));
  log('A cards after', await cards(page));
  // A switch back to A: Claude sleeve unchanged
  await pick(page, 0);
  log('A[A] tqqq card after C trade', await page.evaluate(() => document.querySelectorAll('.tick-card')[1].querySelector('.kvs').textContent));
  await page.reload();
  await settle(page);
  await page.goto(url + '#history');
  await page.waitForTimeout(300);
  log('A history', await page.evaluate(() => [...document.querySelectorAll('.grid tbody tr')].slice(0, 5).map((r) => [...r.children].slice(0, 5).map((x) => x.textContent).join(' ~ ')).join(' | ')));
  await page.click('.seg button:nth-child(4)');
  await page.waitForTimeout(200);
  log('A history C filter rows', await page.evaluate(() => document.querySelectorAll('.panel:first-child .grid tbody tr').length));
  await page.screenshot({ path: OUT + 'A7-history.png', fullPage: true });
  log('A stored portfolio', await page.evaluate(() => { const o = JSON.parse(localStorage.getItem('mockdb'))['data/users/u_test/portfolio']; return { v: o.v, shares: o.shares, first: o.firstEntryDate, second: o.secondEntryDate, followed: o.followed, monthly: o.sleeves.MONTHLY, cross: o.sleeves.SMA_CROSS.shares, qqq: o.qqqShares }; }));
  // Backtest
  await page.goto(url + '#backtest');
  await page.waitForTimeout(300);
  await page.click('.bt-form button[type=submit]');
  await page.waitForSelector('.run-meta', { timeout: 60000 });
  await page.waitForTimeout(600);
  log('A backtest meta', await page.textContent('.run-meta'));
  log('A backtest rows', await page.evaluate(() => [...document.querySelectorAll('.metrics tbody tr')].map((r) => [...r.children].slice(1, 6).map((c) => c.textContent.trim()).join(' ~ ')).join(' || ')));
  log('A compare chips on', await page.evaluate(() => [...document.querySelectorAll('.chip.on')].map((c) => c.textContent).join(', ')));
  await page.click('.chip:not(.on)');
  await page.waitForTimeout(400);
  log('A compare after 4th click', await page.evaluate(() => [...document.querySelectorAll('.chip.on')].map((c) => c.textContent).join(', ')));
  await page.click('text=Trades CSV');
  await page.waitForTimeout(300);
  await page.click('text=Daily equity CSV');
  await page.waitForTimeout(300);
  log('A downloads', await page.evaluate(() => window.__downloads));
  await page.screenshot({ path: OUT + 'A8-backtest.png', fullPage: true });
  // Research
  await page.goto(url + '#research');
  await page.waitForTimeout(300);
  await page.click('.bt-form button[type=submit]');
  await page.waitForSelector('text=1 · SMA pair sensitivity', { timeout: 90000 });
  await page.waitForTimeout(500);
  log('A research sections', await page.evaluate(() => [...document.querySelectorAll('.panel-head h2')].map((x) => x.textContent).join(' | ')));
  log('A research sens', await page.evaluate(() => [...document.querySelectorAll('.panel')[1].querySelectorAll('tbody tr')].map((r) => [...r.children].slice(0, 3).map((x) => x.textContent).join(' ~ ')).join(' || ')));
  log('A research walk foot', await page.evaluate(() => document.querySelector('tfoot')?.textContent));
  await page.screenshot({ path: OUT + 'A9-research.png', fullPage: true });
  // Settings: modify B
  await page.goto(url + '#parameters');
  await page.waitForTimeout(300);
  await page.fill('#sx-fast', '40');
  await page.click('text=Save B and C parameters');
  await page.waitForTimeout(400);
  log('A settings B modified', await page.evaluate(() => [...document.querySelectorAll('.panel-sub .tag')].map((t) => t.textContent).join(', ')));
  await page.goto(url + '#overview');
  await page.waitForTimeout(400);
  log('A cards with B modified', await cards(page));
  await page.goto(url + '#parameters');
  await page.waitForTimeout(300);
  await page.click('text=Reset B and C to defaults');
  await page.waitForTimeout(300);
  log('A settings reset', await page.evaluate(() => [...document.querySelectorAll('.panel-sub .tag')].map((t) => t.textContent).join(', ')));
  await page.screenshot({ path: OUT + 'A10-settings.png', fullPage: true });
  log('A errors', errors);
  await c.close();
}

// ---------- B: phone, light, during the 27 Oct session (in-progress candle + live quote)
{
  const series = realSeries('2026-10-26', { inProgress: '2026-10-27' });
  const { c, page, errors } = await ctx({ viewport: { width: 390, height: 844 }, scheme: 'light', dpr: 2 }, series, '2026-10-27T15:00:00Z', '', V1_SEED);
  await page.goto(url);
  await settle(page);
  log('B cards', await cards(page));
  log('B overflow overview', await overflow(page));
  await page.screenshot({ path: OUT + 'B1-overview-phone.png', fullPage: true });
  const res = [];
  for (const p of ['overview', 'checklist', 'trend', 'portfolio', 'backtest', 'research', 'history', 'parameters']) {
    await page.goto(url + '#' + p);
    await page.waitForTimeout(350);
    for (let i = 0; i < 3; i++) {
      if (await page.$('.strat-tabs')) { await pick(page, i); }
      res.push(`${p}${await page.$('.strat-tabs') ? '/' + 'ABC'[i] : ''}:${await overflow(page)}`);
      if (!(await page.$('.strat-tabs'))) break;
    }
  }
  log('B overflow all', res.join(' '));
  await page.goto(url + '#portfolio');
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + 'B2-portfolio-phone.png', fullPage: true });
  await page.goto(url + '#checklist');
  await page.waitForTimeout(300);
  await pick(page, 2);
  await page.screenshot({ path: OUT + 'B3-checklist-C-phone.png', fullPage: true });
  log('B errors', errors);
  await c.close();
}

// ---------- C: connector not connected → every strategy DATA UNAVAILABLE
{
  const series = realSeries('2026-10-26');
  const patch = `;(() => { const u = window.claude.use; window.claude = { use: async (n) => { const x = await u(n); if (n !== 'mcp') return x; return { callTool: async () => { throw { code: 'server_not_connected', message: 'x' }; } }; } }; })();`;
  const { c, page, errors } = await ctx({ viewport: { width: 1280, height: 800 }, scheme: 'dark' }, series, '2026-10-27T03:00:00Z', patch, V1_SEED);
  await page.goto(url);
  await page.waitForTimeout(1800);
  log('C cards', await cards(page));
  log('C banner', await page.evaluate(() => document.querySelector('.banner')?.textContent));
  await page.goto(url + '#checklist');
  await page.waitForTimeout(300);
  await pick(page, 1);
  log('C checklist B', await page.evaluate(() => [...new Set([...document.querySelectorAll('.check-st')].map((e) => e.textContent))].join(',')));
  await page.screenshot({ path: OUT + 'C1-unavailable.png' });
  log('C errors', errors);
  await c.close();
}

// ---------- D: candle awaited after the 27 Oct close
{
  const series = realSeries('2026-10-26');
  const { c, page, errors } = await ctx({ viewport: { width: 1280, height: 800 }, scheme: 'dark' }, series, '2026-10-27T20:40:00Z', '', V1_SEED);
  await page.goto(url);
  await settle(page);
  log('D cards', await cards(page));
  await pick(page, 1);
  log('D[B] prev line', await page.evaluate(() => [...document.querySelectorAll('.prev')].map((x) => x.textContent).join(' | ')));
  log('D errors', errors);
  await c.close();
}
await browser.close();
