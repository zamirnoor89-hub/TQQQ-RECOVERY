// A stand-in for the Twelve Data REST API, for tests only. It serves SYNTHETIC candles by default,
// or real responses saved locally when TD_FIXTURE_QQQ / TD_FIXTURE_TQQQ point at them.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Bar } from '../src/data.ts';
import { parseTimeSeries, resultText } from '../src/data.ts';
import { nextTradingDay } from '../src/time.ts';

export interface MockTd {
  server: Server;
  url: string;
  hits: { path: string; query: string; auth: string | undefined }[];
  series: Record<string, Bar[]>;
  close(): Promise<void>;
}

function synthetic(symbol: string, last: string): Bar[] {
  let seed = symbol === 'QQQ' ? 11 : 23;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: Bar[] = [];
  let d = symbol === 'QQQ' ? '1999-03-10' : '2010-02-11';
  let px = symbol === 'QQQ' ? 50 : 0.25;
  const vol = symbol === 'QQQ' ? 0.012 : 0.036;
  while (d <= last) {
    const o = px * (1 + (r() - 0.5) * vol * 0.3);
    const c = px * (1 + 0.0005 * (symbol === 'QQQ' ? 1 : 3) + (r() - 0.5) * vol * 2);
    out.push({ d, o: +o.toFixed(4), h: +(Math.max(o, c) * 1.004).toFixed(4), l: +(Math.min(o, c) * 0.996).toFixed(4), c: +c.toFixed(4), v: 1000000 });
    px = c;
    d = nextTradingDay(d);
  }
  return out;
}

function load(symbol: string, last: string): Bar[] {
  const f = process.env[`TD_FIXTURE_${symbol}`];
  if (f) {
    const p = parseTimeSeries(resultText(readFileSync(f, 'utf8')));
    if (p.ok) return p.value;
  }
  return synthetic(symbol, last);
}

const csv = (bars: Bar[]) => 'datetime;open;high;low;close;volume\n' + [...bars].reverse().map((b) => [b.d, b.o, b.h, b.l, b.c, b.v ?? 0].join(';')).join('\n') + '\n';

export async function startMockTd(lastDate: string, apiKey: string): Promise<MockTd> {
  const series: Record<string, Bar[]> = { QQQ: load('QQQ', lastDate), TQQQ: load('TQQQ', lastDate) };
  const hits: MockTd['hits'] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push({ path: u.pathname, query: u.search, auth: req.headers.authorization });
    const send = (status: number, body: string, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (req.headers.authorization !== `apikey ${apiKey}`) return send(401, JSON.stringify({ code: 401, message: 'Invalid API key', status: 'error' }));
    const sym = u.searchParams.get('symbol') ?? '';
    const bars = series[sym];
    if (u.pathname === '/api_usage') return send(200, JSON.stringify({ timestamp: '2026-10-27 06:23:10', current_usage: 4, plan_limit: 55, plan_category: 'grow' }));
    if (!bars) return send(200, JSON.stringify({ code: 404, message: `**symbol** ${sym} not found`, status: 'error' }));
    if (u.pathname === '/time_series') {
      let b = bars;
      const s = u.searchParams.get('start_date'), e = u.searchParams.get('end_date');
      if (s) b = b.filter((x) => x.d >= s);
      if (e) b = b.filter((x) => x.d <= e);
      const n = Number(u.searchParams.get('outputsize') ?? 30);
      b = b.slice(-Math.min(5000, n));
      return send(200, csv(b), 'text/csv');
    }
    if (u.pathname === '/quote') {
      const l = bars[bars.length - 1], p = bars[bars.length - 2];
      return send(200, 'symbol;name;exchange;mic_code;currency;datetime;timestamp;last_quote_at;open;high;low;close;volume;previous_close;change;percent_change;average_volume;is_market_open\n' +
        [sym, sym, 'NASDAQ', 'XNMS', 'USD', l.d, 1793021400, 1793044740, l.o, l.h, l.l, l.c, l.v, p.c, (l.c - p.c).toFixed(5), ((l.c / p.c - 1) * 100).toFixed(5), 1, 'false'].join(';') + '\n', 'text/csv');
    }
    if (u.pathname === '/dividends') {
      return send(200, JSON.stringify({ meta: { symbol: sym }, dividends: [{ ex_date: '2026-09-21', amount: 0.75143 }, { ex_date: '2026-06-22', amount: 0.81349 }] }));
    }
    return send(404, JSON.stringify({ code: 404, message: 'not found', status: 'error' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}`, hits, series, close: () => new Promise((r) => server.close(() => r())) };
}
