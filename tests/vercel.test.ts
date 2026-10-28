// Vercel deployment tests: runs the BUILT function (api/index.mjs) through tests/vercel-local.mjs,
// which applies vercel.json's rewrite and Vercel's limits, against stand-in Upstash Redis and
// Twelve Data servers. Several instances share one database, as Vercel's do. Run `node build.mjs` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { startMockTd } from './mock-twelvedata.ts';
import { startMockRedis } from './mock-upstash.ts';
import { lastCompletedSession } from '../src/time.ts';

const FN = 'api/index.mjs';
const KEY = 'TD-KEY-vercel-5c1e';
const TOKEN = 'UPSTASH-TOKEN-a81f22';
const PASSWORD = 'vercel horse battery';

interface Inst { proc: ChildProcess; base: string; out: string[] }

async function startFn(env: Record<string, string>, mode: 'destination' | 'original' = 'destination'): Promise<Inst> {
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const out: string[] = [];
  const proc = spawn(process.execPath, ['tests/vercel-local.mjs'], { env: { PATH: process.env.PATH ?? '', PORT: port, REWRITE_URL: mode, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 100 && !out.join('').includes('vercel-local ready'); i++) await new Promise((r) => setTimeout(r, 50));
  return { proc, base: `http://127.0.0.1:${port}`, out };
}

function stop(i: Inst): Promise<void> {
  return new Promise((r) => {
    if (i.proc.exitCode !== null || i.proc.signalCode !== null) return r();
    i.proc.once('exit', () => r());
    i.proc.kill('SIGTERM');
  });
}

const seen: string[] = [];
async function call(i: Inst, path: string, init: RequestInit & { cookie?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  if (init.ip) headers.set('X-Test-IP', init.ip);
  const r = await fetch(i.base + path, { ...init, headers, redirect: 'manual' });
  const text = await r.text();
  seen.push(text, JSON.stringify([...r.headers]));
  return { r, text, json: () => JSON.parse(text) };
}
const jsonPost = (body: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

async function signIn(i: Inst, ip?: string): Promise<string> {
  const ok = await call(i, '/api/login', { ...jsonPost({ password: PASSWORD }), ip });
  assert.equal(ok.r.status, 204);
  return (ok.r.headers.get('set-cookie') ?? '').split(';')[0];
}

test('vercel function', { skip: !existsSync(FN) && 'build first' }, async (t) => {
  const td = await startMockTd(lastCompletedSession(Date.now()), KEY);
  const redis = await startMockRedis(TOKEN);
  const env = { TWELVE_DATA_API_KEY: KEY, DASHBOARD_PASSWORD: PASSWORD, KV_REST_API_URL: redis.url, KV_REST_API_TOKEN: TOKEN, TD_BASE_URL: td.url };
  const all: Inst[] = [];
  const start = async (e: Record<string, string>, mode?: 'destination' | 'original') => {
    const i = await startFn(e, mode);
    all.push(i);
    return i;
  };

  await t.test('explains what is missing instead of opening without a database or password', async () => {
    const i = await start({ TWELVE_DATA_API_KEY: KEY });
    const home = await call(i, '/');
    assert.equal(home.r.status, 503);
    assert.match(home.text, /Upstash for Redis/);
    assert.match(home.text, /DASHBOARD_PASSWORD/);
    assert.doesNotMatch(home.text, /<title>TQQQ Recovery V2\.0<\/title>/);
    const s = await call(i, '/api/session');
    assert.equal(s.r.status, 503);
    assert.equal(s.json().error.code, 'not_configured');
    assert.deepEqual((await call(i, '/healthz')).json(), { ok: false, missing: ['Database', 'DASHBOARD_PASSWORD'] });
    assert.equal((await call(i, '/robots.txt')).text, 'User-agent: *\nDisallow: /\n', 'static files come from public/');
    await stop(i);
  });

  const a = await start(env, 'destination');
  const b = await start(env, 'original');
  let cookie = '';

  await t.test('serves the sign-in page, not the app, before sign-in', async () => {
    const { r, text } = await call(a, '/');
    assert.equal(r.status, 200);
    assert.match(text, /Sign in/);
    assert.doesNotMatch(text, /<title>TQQQ Recovery V2\.0<\/title>/);
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'nonce-/);
    assert.match(text, /<script nonce="/);
    assert.equal((await call(a, '/api/session')).r.status, 401);
    assert.equal((await call(b, '/api/history?symbol=QQQ')).r.status, 401);
  });

  await t.test('signs in on one instance and stays signed in on another', async () => {
    assert.equal((await call(a, '/api/login', jsonPost({ password: 'nope' }))).r.status, 401);
    assert.equal((await call(a, '/api/login', jsonPost({ password: PASSWORD }, { Origin: 'https://evil.example' }))).r.status, 403);
    const ok = await call(a, '/api/login', jsonPost({ password: PASSWORD }));
    assert.equal(ok.r.status, 204);
    const set = ok.r.headers.get('set-cookie') ?? '';
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Secure/);
    cookie = set.split(';')[0];
    assert.match((await call(b, '/', { cookie })).text, /<title>TQQQ Recovery V2\.0<\/title>/);
    assert.deepEqual((await call(b, '/api/session', { cookie })).json(), { authRequired: true, tdConfigured: true, owner: 'owner', creditsPerMinute: 50 });
    const forged = await call(b, '/api/session', { cookie: cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) });
    assert.equal(forged.r.status, 401);
  });

  await t.test('loads full history once, then every instance reads it from Redis', async () => {
    const h1 = await call(a, '/api/history?symbol=QQQ', { cookie });
    assert.equal(h1.r.status, 200);
    const j1 = h1.json();
    assert.equal(j1.source, 'full');
    assert.equal(j1.bars.length, td.series.QQQ.length);
    assert.ok(Number(h1.r.headers.get('x-test-wire-bytes')) < 4.5 * 1024 * 1024, 'response within Vercel’s 4.5 MB limit');
    const hitsBefore = td.hits.filter((x) => x.path === '/time_series').length;
    const h2 = (await call(b, '/api/history?symbol=QQQ', { cookie })).json();
    assert.equal(h2.source, 'cache+incremental');
    assert.equal(h2.bars.length, j1.bars.length);
    assert.equal(td.hits.filter((x) => x.path === '/time_series').length - hitsBefore, 1, 'one small incremental call');
    const t1 = (await call(b, '/api/history?symbol=TQQQ', { cookie })).json();
    assert.equal(t1.bars.length, td.series.TQQQ.length);
    assert.equal((await call(a, '/api/quote?symbol=TQQQ', { cookie })).json().price, td.series.TQQQ.at(-1)!.c);
    assert.equal((await call(a, '/api/quote?symbol=AAPL', { cookie })).r.status, 400);
    assert.equal((await call(a, '/api/dividends?symbol=QQQ', { cookie })).json().length, 2);
    const divHits = td.hits.filter((x) => x.path === '/dividends').length;
    assert.equal((await call(b, '/api/dividends?symbol=QQQ', { cookie })).json().length, 2);
    assert.equal(td.hits.filter((x) => x.path === '/dividends').length, divHits, 'dividends cached in Redis for all instances');
    const u = (await call(b, '/api/usage', { cookie })).json();
    assert.equal(u.siteLimit, 50);
    assert.ok(u.siteUsedThisMinute >= 1, 'credits counted in Redis across instances');
    assert.ok([...redis.data.keys()].some((k) => k.startsWith('tqqq:doc:market/QQQ/years')), 'candle cache in Redis');
  });

  await t.test('stores records in Redis and keeps them across cold starts', async () => {
    const put = await call(a, '/api/doc?path=data/users/owner/portfolio', { cookie, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { shares: 41, confirmed: true } }) });
    assert.equal(put.r.status, 204);
    assert.deepEqual((await call(b, '/api/doc?path=data/users/owner/portfolio', { cookie })).json(), { exists: true, data: { shares: 41, confirmed: true } });
    assert.equal((await call(a, '/api/doc?path=data/users/owner/portfolio', { cookie, method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{"data":{}}' })).r.status, 403);
    assert.equal((await call(a, '/api/doc?path=market/QQQ/years/2020', { cookie })).r.status, 400);
    const big = JSON.stringify({ data: { blob: 'x'.repeat(1100 * 1024) } });
    assert.equal((await call(a, '/api/doc?path=data/users/owner/settings', { cookie, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: big })).r.status, 413);
    await stop(a);
    await stop(b);
    const c = await start(env);
    assert.deepEqual((await call(c, '/api/doc?path=data/users/owner/portfolio', { cookie })).json(), { exists: true, data: { shares: 41, confirmed: true } }, 'session and record survive');
    assert.equal((await call(c, '/api/history?symbol=QQQ', { cookie })).json().source, 'cache+incremental');
    await stop(c);
  });

  await t.test('locks an address out after 8 wrong passwords, on every instance', async () => {
    const c = await start(env);
    const d = await start(env, 'original');
    for (let i = 0; i < 8; i++) assert.equal((await call(i % 2 ? c : d, '/api/login', { ...jsonPost({ password: 'guess' + i }), ip: '198.51.100.9' })).r.status, 401);
    const locked = await call(c, '/api/login', { ...jsonPost({ password: PASSWORD }), ip: '198.51.100.9' });
    assert.equal(locked.r.status, 429);
    assert.match(locked.json().error.message, /Try again in 15 minutes/);
    assert.equal((await call(d, '/api/login', { ...jsonPost({ password: PASSWORD }), ip: '198.51.100.10' })).r.status, 204, 'other addresses unaffected');
    await stop(c);
    await stop(d);
  });

  await t.test('instances share one Twelve Data credit allowance', async () => {
    const sec = new Date().getUTCSeconds();
    if (sec > 50) await new Promise((r) => setTimeout(r, (61 - sec) * 1000)); // stay inside one clock minute
    const e2 = { ...env, TD_CREDITS_PER_MINUTE: '5', TD_MAX_WAIT_MS: '0', REDIS_KEY_PREFIX: 'budget:' };
    const e = await start(e2);
    const f = await start(e2, 'original');
    const ck = await signIn(e);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call(i % 2 ? e : f, '/api/usage', { cookie: ck })).r.status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    await stop(e);
    await stop(f);
  });

  await t.test('without a key, market routes say so and records still work', async () => {
    const g = await start({ ...env, TWELVE_DATA_API_KEY: '' });
    const ck = await signIn(g);
    const r = await call(g, '/api/history?symbol=QQQ', { cookie: ck });
    assert.equal(r.r.status, 503);
    assert.equal(r.json().error.code, 'not_configured');
    assert.equal((await call(g, '/api/doc?path=data/users/owner/portfolio', { cookie: ck })).r.status, 200);
    await stop(g);
  });

  await t.test('a wrong database token is reported, not hidden', async () => {
    const h = await start({ ...env, KV_REST_API_TOKEN: 'wrong-token' });
    const r = await call(h, '/');
    assert.equal(r.r.status, 503);
    assert.match(r.text, /rejected its access token/);
    const api = await call(h, '/api/session');
    assert.equal(api.json().error.code, 'storage_error');
    await stop(h);
  });

  await t.test('signing out ends the session', async () => {
    const k = await start(env);
    const r = await call(k, '/api/logout', { cookie, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.match(r.r.headers.get('set-cookie') ?? '', /Max-Age=0/);
    await stop(k);
  });

  await t.test('neither secret leaves the server', async () => {
    for (const s of seen) {
      assert.ok(!s.includes(KEY), 'Twelve Data key in a response');
      assert.ok(!s.includes(TOKEN), 'Redis token in a response');
    }
    for (const h of td.hits) {
      assert.equal(h.auth, `apikey ${KEY}`);
      assert.ok(!h.query.includes(KEY), 'key never in a URL');
    }
    for (const i of all) {
      const log = i.out.join('');
      assert.ok(!log.includes(KEY) && !log.includes(TOKEN), 'secret in a log');
    }
    assert.ok(!redis.bodies.some((x) => x.includes(KEY)), 'key never stored');
    assert.ok(!readFileSync(FN, 'utf8').includes(KEY), 'nothing baked into the bundle');
  });

  for (const i of all) await stop(i);
  await td.close();
  await redis.close();
});
