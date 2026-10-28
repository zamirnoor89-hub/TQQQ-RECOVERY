// Browser test harness for V2: a mocked claude.ai runtime serving the fixed real Twelve Data inputs
// in research/data (test-only), plus a captured downloads capability.
import { readFileSync } from 'node:fs';
const D = new URL('../../research/data/', import.meta.url).pathname;
const bars = (sym) => readFileSync(D + sym + '_1day.csv', 'utf8').trim().split('\n').slice(1).map((l) => { const [d, o, h, lo, c, v] = l.split(','); return { d, o: +o, h: +h, l: +lo, c: +c, v: +v }; });
const divs = (sym) => readFileSync(D + sym + '_dividends.csv', 'utf8').trim().split('\n').slice(1).map((l) => { const [d, a] = l.split(','); return { ex_date: d, amount: +a }; });
export function realSeries(lastDate = '9999', { inProgress = null } = {}) {
  const q = bars('QQQ').filter((b) => b.d <= lastDate), t = bars('TQQQ').filter((b) => b.d <= lastDate);
  if (inProgress) {
    const lq = q[q.length - 1], lt = t[t.length - 1];
    q.push({ d: inProgress, o: lq.c * 1.002, h: lq.c * 1.008, l: lq.c * 0.998, c: lq.c * 1.004, v: 1e7 });
    t.push({ d: inProgress, o: lt.c * 1.006, h: lt.c * 1.024, l: lt.c * 0.994, c: lt.c * 1.012, v: 1e7 });
  }
  return { QQQ: q, TQQQ: t, DIV: { QQQ: divs('QQQ'), TQQQ: divs('TQQQ') } };
}
export function initScript(series, nowIso, seed = null) {
  return `
(() => {
  const SERIES = ${JSON.stringify(series)};
  const NOW = ${JSON.stringify(nowIso)};
  const SEED = ${JSON.stringify(seed)};
  window.__calls = []; window.__downloads = [];
  const csv = (bars) => 'datetime;open;high;low;close;volume\\n' + [...bars].reverse().map(b => [b.d,b.o,b.h,b.l,b.c,b.v].join(';')).join('\\n');
  const text = (t) => ({ content: [{ type: 'text', text: JSON.stringify({ result: t }) }], structuredContent: { result: t }, payload: { result: t } });
  const mcp = {
    async callTool(server, tool, input) {
      window.__calls.push({ server, tool, input });
      if (server !== 'Twelve Data') throw { code: 'server_not_connected', message: 'no' };
      await new Promise(r => setTimeout(r, 20));
      if (tool === 'get_time_series') {
        let bars = SERIES[input.symbol] || [];
        if (input.start_date) bars = bars.filter(b => b.d >= input.start_date);
        if (input.end_date) bars = bars.filter(b => b.d <= input.end_date);
        bars = bars.slice(-Math.min(5000, input.outputsize || 5000));
        return text(csv(bars));
      }
      if (tool === 'get_quote') {
        const bars = SERIES[input.symbol];
        const last = bars[bars.length - 1], prev = bars[bars.length - 2];
        const ts = Math.floor(Date.parse(NOW) / 1000);
        return text('symbol;name;exchange;currency;datetime;timestamp;last_quote_at;open;high;low;close;volume;previous_close;change;percent_change;is_market_open\\n' +
          [input.symbol, 'x', 'NASDAQ', 'USD', last.d, ts, ts, last.o, last.h, last.l, last.c, last.v, prev.c, (last.c - prev.c).toFixed(4), ((last.c / prev.c - 1) * 100).toFixed(4), 'false'].join(';'));
      }
      if (tool === 'get_dividends') return text(JSON.stringify({ meta: { symbol: input.symbol }, dividends: [...SERIES.DIV[input.symbol]].reverse() }));
      if (tool === 'get_api_usage') return text('timestamp;current_usage;plan_limit\\n2026-10-27 06:23:10;6;0\\n');
      throw { code: 'tool_error', message: 'unknown tool' };
    },
  };
  const KEY = 'mockdb';
  if (SEED && !localStorage.getItem('seeded')) { localStorage.setItem(KEY, JSON.stringify(SEED)); localStorage.setItem('seeded', '1'); }
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const save = (o) => localStorage.setItem(KEY, JSON.stringify(o));
  const snap = (path, data) => ({ id: path.split('/').pop(), exists: data !== undefined, data: () => data === undefined ? undefined : JSON.parse(JSON.stringify(data)), metadata: { fromCache: false, hasPendingWrites: false } });
  const db = {
    doc(path) {
      return {
        path,
        async get() { return snap(path, load()[path]); },
        async set(data) { const o = load(); o[path] = JSON.parse(JSON.stringify(data)); save(o); },
        async update(data) { const o = load(); o[path] = { ...(o[path] || {}), ...data }; save(o); },
        async delete() { const o = load(); delete o[path]; save(o); },
      };
    },
    collection(path) {
      return {
        path,
        async get() {
          const o = load();
          const docs = Object.keys(o).filter(k => k.startsWith(path + '/') && k.slice(path.length + 1).indexOf('/') === -1).sort().map(k => snap(k, o[k]));
          return { docs, size: docs.length, empty: !docs.length };
        },
      };
    },
  };
  const user = { async id() { return 'u_test'; }, isOwner() { return true; } };
  const downloads = { async save(r) { window.__downloads.push({ filename: r.filename, size: String(r.data).length, head: String(r.data).slice(0, 160) }); return { status: 'saved' }; } };
  window.claude = { use: async (name) => { await new Promise(r => setTimeout(r, 10)); return name === 'mcp' ? mcp : name === 'db' ? db : name === 'user' ? user : name === 'downloads' ? downloads : null; } };
})();`;
}
