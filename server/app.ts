// The website's request handler, shared by the Node server (server/main.ts) and the Vercel function
// (server/vercel.ts). It speaks standard Web Request/Response, and reaches storage only through the
// small async interfaces below, so the same routes run on SQLite or on Upstash Redis.
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Auth } from './auth.ts';
import { TwelveDataRest } from './tdrest.ts';
import type { CreditBudget } from './tdrest.ts';
import { TwelveData, clearHistoryCache, loadHistory } from '../src/market.ts';
import type { CacheDb, LoadSeriesResult } from '../src/market.ts';
import type { Dividend, Quote } from '../src/data.ts';

/** JSON documents addressed by slash paths ("data/users/owner/portfolio"). */
export interface DocStore {
  read(path: string): Promise<Record<string, unknown> | undefined>;
  write(path: string, data: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /** Documents directly inside a collection, sorted by id. */
  list(collection: string): Promise<{ id: string; data: Record<string, unknown> }[]>;
  meta(k: string): Promise<string | null>;
  /** Stores `v` only if `k` has no value yet, and returns whichever value is stored. */
  setMetaIfMissing(k: string, v: string): Promise<string>;
}

/** Expiring counters (login attempts). `add` restarts the expiry. */
export interface Counters {
  add(key: string, by: number, ttlSec: number): Promise<number>;
  get(key: string): Promise<{ n: number; ttlSec: number }>;
  clear(key: string): Promise<void>;
}

export interface AppOptions {
  store: DocStore;
  counters: Counters;
  budget: CreditBudget;
  pages: { app: string; login: string };
  apiKey: string;
  tdBase: string;
  creditsPerMinute: number;
  maxWaitMs: number;
  /** null leaves the site open (local use only). */
  password: string | null;
  sessionSecret: string | null;
  forceSecureCookie: boolean;
  log: (msg: string) => void;
}

export interface HandleOptions {
  /** Path to route on when the platform rewrote the URL (Vercel). */
  path?: string;
  /** Client address when the platform knows it better than the headers (Node socket). */
  ip?: string;
}

export interface App {
  handle(request: Request, opts?: HandleOptions): Promise<Response>;
  readonly td: TwelveDataRest | null;
}

export const OWNER = 'owner';
const SYMBOLS = new Set(['QQQ', 'TQQQ']);
const DOC_PATH = /^data\/users\/owner\/(portfolio|trades|settings|alerts)$/;
const MAX_FAILS = 8;
const LOCK_SEC = 15 * 60;

/** CacheDb / collection shape the shared candle loader expects, over a DocStore. */
export function cacheDbOf(store: DocStore): CacheDb {
  return {
    collection: (path: string) => ({
      get: async () => ({ docs: (await store.list(path)).map((d) => ({ id: d.id, data: () => d.data })) }),
    }),
    doc: (path: string) => ({
      set: (data: Record<string, unknown>) => store.write(path, data),
      delete: () => store.remove(path),
    }),
  };
}

export class HttpError {
  status: number;
  code: string;
  message: string;
  constructor(status: number, code: string, message: string) {
    this.status = status;
    this.code = code;
    this.message = message;
  }
}

function securityHeaders(h: Headers, nonce: string | null): void {
  h.set('Content-Security-Policy', [
    "default-src 'self'",
    `script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function body(req: Request, status: number, text: string, type: string, headers: Headers): Response {
  headers.set('Content-Type', type);
  headers.set('Cache-Control', 'no-store');
  let buf: Uint8Array = Buffer.from(text);
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')) {
    buf = gzipSync(buf);
    headers.set('Content-Encoding', 'gzip');
    headers.set('Vary', 'Accept-Encoding');
  }
  return new Response(buf, { status, headers });
}

export function jsonResponse(req: Request, status: number, value: unknown, headers = new Headers()): Response {
  securityHeaders(headers, null);
  return body(req, status, JSON.stringify(value), 'application/json; charset=utf-8', headers);
}

export function errorResponse(req: Request, status: number, code: string, message: string): Response {
  return jsonResponse(req, status, { error: { code, message } });
}

export function htmlResponse(req: Request, page: string, status = 200): Response {
  const nonce = randomBytes(16).toString('base64');
  const headers = new Headers();
  securityHeaders(headers, nonce);
  return body(req, status, page.replace(/<script>/g, `<script nonce="${nonce}">`), 'text/html; charset=utf-8', headers);
}

function empty(status: number, headers = new Headers()): Response {
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status, headers });
}

async function readJson(req: Request, limit: number): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > limit) throw new HttpError(413, 'bad_request', 'Request too large');
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > limit) throw new HttpError(413, 'bad_request', 'Request too large');
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'Body must be JSON');
  }
}

/** Mutating requests must be same-origin JSON (cookies are SameSite=Strict as well). */
function sameOrigin(req: Request): boolean {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.headers.get('host') || host === req.headers.get('x-forwarded-host');
}

function clientIp(req: Request, fallback: string | undefined): string {
  const fwd = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  return fwd || req.headers.get('x-real-ip') || fallback || 'unknown';
}

function providerError(req: Request, e: unknown): Response {
  const err = (e ?? {}) as { code?: string; message?: string; retryable?: boolean };
  const code = err.code ?? 'upstream_error';
  const status = code === 'rate_limited' ? 429 : code === 'server_unavailable' ? 503 : code === 'bad_request' ? 400 : 502;
  return jsonResponse(req, status, { error: { code, message: err.message ?? 'Market data request failed', retryable: !!err.retryable } });
}

export async function createApp(o: AppOptions): Promise<App> {
  let secret = o.sessionSecret;
  if (!secret) secret = await o.store.setMetaIfMissing('session_secret', Auth.newSecret());
  const auth = new Auth(o.password, secret);
  const rest = o.apiKey ? new TwelveDataRest({ apiKey: o.apiKey, baseUrl: o.tdBase, creditsPerMinute: o.creditsPerMinute, maxWaitMs: o.maxWaitMs, budget: o.budget }) : null;
  const td = rest ? new TwelveData(rest) : null;
  const cacheDb = cacheDbOf(o.store);

  // Small in-process caches so several tabs or devices don't spend credits twice.
  const historyFlight = new Map<string, { at: number; p: Promise<LoadSeriesResult> }>();
  const quoteCache = new Map<string, { at: number; q: Quote }>();

  const history = (symbol: string, rebuild: boolean): Promise<LoadSeriesResult> => {
    const hit = historyFlight.get(symbol);
    if (!rebuild && hit && Date.now() - hit.at < 30000) return hit.p;
    const p = loadHistory(td as TwelveData, cacheDb, symbol, Date.now(), rebuild);
    historyFlight.set(symbol, { at: Date.now(), p });
    p.catch(() => historyFlight.delete(symbol));
    return p;
  };
  const quote = async (symbol: string): Promise<Quote> => {
    const hit = quoteCache.get(symbol);
    if (hit && Date.now() - hit.at < 15000) return hit.q;
    const q = await (td as TwelveData).quote(symbol);
    quoteCache.set(symbol, { at: Date.now(), q });
    return q;
  };
  const dividends = async (symbol: string): Promise<Dividend[]> => {
    const path = `cache/dividends/${symbol}`;
    const cached = (await o.store.read(path)) as { at: number; items: Dividend[] } | undefined;
    if (cached && Date.now() - cached.at < 24 * 3600000) return cached.items;
    const items = await (td as TwelveData).dividends(symbol);
    await o.store.write(path, { at: Date.now(), items });
    return items;
  };

  const secure = (req: Request): boolean => o.forceSecureCookie || req.headers.get('x-forwarded-proto') === 'https' || req.url.startsWith('https:');

  async function route(req: Request, opts: HandleOptions): Promise<Response> {
    const url = new URL(req.url);
    const p = opts.path ?? url.pathname;
    const method = req.method;
    if (p === '/healthz') return jsonResponse(req, 200, { ok: true });

    const authed = auth.valid(req.headers.get('cookie') ?? undefined);
    if (p === '/' || p === '/index.html') return htmlResponse(req, authed ? o.pages.app : o.pages.login);

    if (p === '/api/login' && method === 'POST') {
      if (!sameOrigin(req)) return errorResponse(req, 403, 'bad_request', 'Cross-site request refused');
      const key = 'login:' + clientIp(req, opts.ip);
      const f = await o.counters.get(key);
      if (f.n >= MAX_FAILS) return errorResponse(req, 429, 'rate_limited', `Too many attempts. Try again in ${Math.max(1, Math.ceil(f.ttlSec / 60))} minutes.`);
      const b = (await readJson(req, 4096)) as { password?: unknown };
      if (!auth.check(b.password)) {
        await o.counters.add(key, 1, LOCK_SEC);
        return errorResponse(req, 401, 'unauthorized', 'Wrong password.');
      }
      if (f.n) await o.counters.clear(key);
      const s = auth.issue();
      const h = new Headers();
      h.append('Set-Cookie', auth.cookie(s.value, s.maxAge, secure(req)));
      return empty(204, h);
    }
    if (p === '/api/logout' && method === 'POST') {
      const h = new Headers();
      h.append('Set-Cookie', auth.clearCookie(secure(req)));
      return empty(204, h);
    }
    if (!p.startsWith('/api/')) return errorResponse(req, 404, 'not_found', 'Not found');
    if (!authed) return errorResponse(req, 401, 'unauthorized', 'Sign in required');

    if (p === '/api/session') return jsonResponse(req, 200, { authRequired: auth.required, tdConfigured: !!td, owner: OWNER, creditsPerMinute: o.creditsPerMinute });

    if (p === '/api/doc') {
      const path = url.searchParams.get('path') ?? '';
      if (!DOC_PATH.test(path)) return errorResponse(req, 400, 'bad_request', 'Unknown record');
      if (method === 'GET') {
        const d = await o.store.read(path);
        return jsonResponse(req, 200, { exists: d !== undefined, data: d ?? null });
      }
      if (method === 'PUT') {
        if (!sameOrigin(req)) return errorResponse(req, 403, 'bad_request', 'Cross-site request refused');
        const b = (await readJson(req, 1024 * 1024)) as { data?: unknown };
        if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return errorResponse(req, 400, 'invalid_argument', 'Record must be an object');
        await o.store.write(path, b.data as Record<string, unknown>);
        return empty(204);
      }
      return errorResponse(req, 405, 'bad_request', 'Method not allowed');
    }

    // Market data
    if (!td || !rest) return errorResponse(req, 503, 'not_configured', 'The server has no Twelve Data key. Set TWELVE_DATA_API_KEY and restart.');
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
    try {
      if (p === '/api/history' && method === 'GET') {
        if (!SYMBOLS.has(symbol)) return errorResponse(req, 400, 'bad_request', 'Symbol must be QQQ or TQQQ');
        const r = await history(symbol, url.searchParams.get('rebuild') === '1');
        return jsonResponse(req, 200, { ...r, cacheWritable: true });
      }
      if (p === '/api/history/rebuild' && method === 'POST') {
        if (!sameOrigin(req)) return errorResponse(req, 403, 'bad_request', 'Cross-site request refused');
        for (const s of SYMBOLS) await clearHistoryCache(cacheDb, s);
        historyFlight.clear();
        return empty(204);
      }
      if (p === '/api/quote' && method === 'GET') {
        if (!SYMBOLS.has(symbol)) return errorResponse(req, 400, 'bad_request', 'Symbol must be QQQ or TQQQ');
        return jsonResponse(req, 200, await quote(symbol));
      }
      if (p === '/api/dividends' && method === 'GET') {
        if (!SYMBOLS.has(symbol)) return errorResponse(req, 400, 'bad_request', 'Symbol must be QQQ or TQQQ');
        return jsonResponse(req, 200, await dividends(symbol));
      }
      if (p === '/api/usage' && method === 'GET') {
        const u = await td.usage();
        return jsonResponse(req, 200, { ...(u ?? { plan: null, used: null, limit: null }), siteUsedThisMinute: await o.budget.used(), siteLimit: o.creditsPerMinute });
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if ((e as { code?: string }).code === 'storage_error') throw e;
      return providerError(req, e);
    }
    return errorResponse(req, 404, 'not_found', 'Not found');
  }

  return {
    td: rest,
    async handle(req: Request, opts: HandleOptions = {}): Promise<Response> {
      try {
        return await route(req, opts);
      } catch (e) {
        if (e instanceof HttpError) return errorResponse(req, e.status, e.code, e.message);
        const err = (e ?? {}) as { code?: string; message?: string };
        if (err.code === 'storage_error') {
          o.log('storage error: ' + (err.message ?? 'unknown'));
          return errorResponse(req, 503, 'storage_error', err.message ?? 'The database could not be reached.');
        }
        o.log('request failed: ' + (err.message ?? String(e)));
        return errorResponse(req, 500, 'server_error', 'Internal error');
      }
    },
  };
}
