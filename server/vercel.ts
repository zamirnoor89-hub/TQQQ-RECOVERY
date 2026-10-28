// Vercel function entry. build.mjs bundles this file, the shared routes and both pages into
// api/index.mjs; vercel.json rewrites every path to it. Records, the candle cache, the session
// secret, login-attempt counters and the shared Twelve Data credit count live in Upstash Redis.
//   TWELVE_DATA_API_KEY      required for market data (Sensitive environment variable)
//   DASHBOARD_PASSWORD       required (Sensitive); the site will not open without it
//   KV_REST_API_URL / _TOKEN set by Vercel's Upstash for Redis integration
//   TD_CREDITS_PER_MINUTE    optional, default 50 of the Grow plan's 55
//   SESSION_SECRET           optional; otherwise generated once and kept in Redis
import { createApp, errorResponse, htmlResponse, jsonResponse } from './app.ts';
import type { App } from './app.ts';
import { RedisBudget, RedisCounters, RedisRest, RedisStore, redisConfigFromEnv } from './redis.ts';

declare const __PAGES__: { app: string; login: string };

const env = process.env;
const CREDITS = Math.max(5, Number(env.TD_CREDITS_PER_MINUTE ?? 50) || 50);

function missing(): { name: string; fix: string }[] {
  const out: { name: string; fix: string }[] = [];
  if (!redisConfigFromEnv(env)) out.push({ name: 'Database', fix: 'In your Vercel project open Storage, create an Upstash for Redis database and connect it to this project. That adds KV_REST_API_URL and KV_REST_API_TOKEN.' });
  if (!env.DASHBOARD_PASSWORD) out.push({ name: 'DASHBOARD_PASSWORD', fix: 'Add it under Settings, Environment Variables (mark it Sensitive). It is the password you will sign in with.' });
  if (!(env.TWELVE_DATA_API_KEY ?? '').trim()) out.push({ name: 'TWELVE_DATA_API_KEY', fix: 'Add your Twelve Data API key under Settings, Environment Variables (mark it Sensitive). Without it the dashboard opens but shows DATA UNAVAILABLE.' });
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

function setupPage(items: { name: string; fix: string }[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Setup needed · TQQQ Recovery</title>
<style>:root{color-scheme:light dark;--bg:#f7f5f0;--panel:#fffefb;--line:#dad3c7;--fg:#262420;--fg-3:#746d62;--risk:#994a3f}@media (prefers-color-scheme:dark){:root{--bg:#08111f;--panel:#0d192b;--line:#283e5d;--fg:#e8eef7;--fg-3:#8b9bb3;--risk:#ff7378}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "Helvetica Neue",Helvetica,Arial,sans-serif;padding:40px max(16px,env(safe-area-inset-left,0px)) 40px max(16px,env(safe-area-inset-right,0px))}
main{max-width:620px;margin:0 auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px;display:flex;flex-direction:column;gap:14px}h1{font-size:20px;margin:0}p{margin:0;color:var(--fg-3)}ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px}b{color:var(--risk)}</style></head>
<body><main><h1>TQQQ Recovery needs setting up</h1><p>The site is deployed, but these settings are missing. Add them in Vercel, then redeploy (Deployments, ⋯, Redeploy) so the function picks them up.</p>
<ul>${items.map((i) => `<li><b>${esc(i.name)}</b>: ${esc(i.fix)}</li>`).join('')}</ul></main></body></html>`;
}

let appP: Promise<App> | null = null;
function getApp(): Promise<App> {
  if (!appP) {
    const rc = redisConfigFromEnv(env);
    if (!rc) throw new Error('unreachable: storage checked first');
    const redis = new RedisRest(rc.url, rc.token);
    const counters = new RedisCounters(redis, rc.prefix);
    appP = createApp({
      store: new RedisStore(redis, rc.prefix),
      counters,
      budget: new RedisBudget(counters, CREDITS),
      pages: __PAGES__,
      apiKey: (env.TWELVE_DATA_API_KEY ?? '').trim(),
      tdBase: (env.TD_BASE_URL ?? 'https://api.twelvedata.com').replace(/\/+$/, ''),
      creditsPerMinute: CREDITS,
      maxWaitMs: Math.max(0, Number(env.TD_MAX_WAIT_MS ?? 65000)),
      password: env.DASHBOARD_PASSWORD as string,
      sessionSecret: env.SESSION_SECRET || null,
      forceSecureCookie: env.COOKIE_SECURE !== 'false',
      log: (m) => console.error(m),
    });
    appP.catch(() => {
      appP = null; // the database was unreachable; try again on the next request
    });
  }
  return appP;
}

/** vercel.json sends every path here as /api/index?__path=/original/path. */
function routedPath(url: URL): string {
  const routed = url.searchParams.get('__path');
  if (routed !== null && routed.startsWith('/')) return routed;
  return url.pathname;
}

export const handler = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = routedPath(url);
    const gaps = missing().filter((m) => m.name !== 'TWELVE_DATA_API_KEY');
    if (gaps.length) {
      if (path === '/healthz') return jsonResponse(request, 503, { ok: false, missing: gaps.map((g) => g.name) });
      if (path.startsWith('/api/')) return errorResponse(request, 503, 'not_configured', `Setup needed: ${gaps.map((g) => g.name).join(', ')}. Open the site's home page for the steps.`);
      return htmlResponse(request, setupPage(missing()), 503);
    }
    let app: App;
    try {
      app = await getApp();
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? 'The database could not be reached.';
      console.error('startup failed: ' + msg);
      if (path.startsWith('/api/') || path === '/healthz') return errorResponse(request, 503, 'storage_error', msg);
      return htmlResponse(request, setupPage([{ name: 'Database', fix: msg }]), 503);
    }
    return app.handle(request, { path });
  },
};
