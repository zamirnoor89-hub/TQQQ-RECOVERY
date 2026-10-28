// TQQQ Recovery website server for a long-running Node host (Docker, Render, Railway, a VPS).
// Zero npm dependencies: Node's http, crypto, zlib and sqlite. The routes live in app.ts and are
// shared with the Vercel function (vercel.ts).
//   TWELVE_DATA_API_KEY   required for market data (kept on the server only)
//   DASHBOARD_PASSWORD    required unless ALLOW_NO_PASSWORD=true (local use)
//   DATA_DIR              where tqqq.db lives (default ./data); mount persistent storage here
//   PORT, HOST            listen address (default 8080, 0.0.0.0)
//   TD_CREDITS_PER_MINUTE credits this site may use per minute (default 50 of the Grow plan's 55)
//   SESSION_SECRET        optional; otherwise a random secret is generated and kept in the database
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, MemoryCounters } from './sqlite.ts';
import { MemoryBudget } from './tdrest.ts';
import { createApp } from './app.ts';

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const HOST = env.HOST ?? '0.0.0.0';
const DATA_DIR = env.DATA_DIR ?? join(process.cwd(), 'data');
const KEY = (env.TWELVE_DATA_API_KEY ?? '').trim();
const PASSWORD = env.DASHBOARD_PASSWORD ?? '';
const ALLOW_OPEN = env.ALLOW_NO_PASSWORD === 'true';
const CREDITS = Math.max(5, Number(env.TD_CREDITS_PER_MINUTE ?? 50));
const MAX_BODY = 2 * 1024 * 1024;

if (!PASSWORD && !ALLOW_OPEN) {
  console.error('Refusing to start: set DASHBOARD_PASSWORD (or ALLOW_NO_PASSWORD=true for local-only use).');
  process.exit(1);
}

const here = new URL('.', import.meta.url).pathname;
const store = new Store(join(DATA_DIR, 'tqqq.db'));
const appReady = createApp({
  store,
  counters: new MemoryCounters(),
  budget: new MemoryBudget(CREDITS),
  pages: { app: readFileSync(join(here, 'public', 'index.html'), 'utf8'), login: readFileSync(join(here, 'public', 'login.html'), 'utf8') },
  apiKey: KEY,
  tdBase: (env.TD_BASE_URL ?? 'https://api.twelvedata.com').replace(/\/+$/, ''),
  creditsPerMinute: CREDITS,
  maxWaitMs: 65000,
  password: PASSWORD || null,
  sessionSecret: env.SESSION_SECRET ?? null,
  forceSecureCookie: env.COOKIE_SECURE === 'true',
  log: (m) => console.error(m),
});
appReady.catch((e) => {
  console.error('Could not start:', (e as Error)?.message ?? e);
  process.exit(1);
});

/** Node request -> Web Request (body buffered, capped). */
async function toRequest(req: IncomingMessage): Promise<Request | null> {
  const method = req.method ?? 'GET';
  const chunks: Buffer[] = [];
  let size = 0;
  if (method !== 'GET' && method !== 'HEAD') {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(c as Buffer);
    }
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  return new Request(url, { method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 204 && r.status !== 304) headers['content-length'] = String(buf.length);
  res.writeHead(r.status, headers);
  res.end(r.status === 204 ? undefined : buf);
}

const server = createServer((req, res) => {
  (async () => {
    const request = await toRequest(req);
    if (!request) {
      res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'bad_request', message: 'Request too large' } }));
      return;
    }
    const app = await appReady;
    await send(res, await app.handle(request, { ip: req.socket.remoteAddress }));
  })().catch((e) => {
    console.error('request failed:', (e as Error)?.message ?? e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'server_error', message: 'Internal error' } }));
  });
});
server.headersTimeout = 30000;
server.requestTimeout = 120000;
server.listen(PORT, HOST, () => {
  console.log(`TQQQ Recovery listening on http://${HOST}:${PORT} · data in ${DATA_DIR} · Twelve Data ${KEY ? 'configured' : 'NOT configured'} · sign-in ${PASSWORD ? 'required' : 'off'}`);
});
const shutdown = () => server.close(() => { store.close(); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
