// Website server tests: runs the BUILT server (dist/site/server.mjs) against a stand-in Twelve Data
// API. Run `node build.mjs` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTd } from './mock-twelvedata.ts';
import { CreditLimiter } from '../server/tdrest.ts';
import { lastCompletedSession } from '../src/time.ts';

const KEY = 'TEST-KEY-7f3a9c';
const PASSWORD = 'correct horse battery';
const SERVER = 'dist/site/server.mjs';

async function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string; out: string[] }> {
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const out: string[] = [];
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], { env: { PATH: process.env.PATH ?? '', PORT: port, HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return { proc, base, out };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, base, out };
}

function stop(proc: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (proc.exitCode !== null) return r();
    proc.once('exit', () => r());
    proc.kill('SIGTERM');
  });
}

test('website server', { skip: !existsSync(SERVER) && 'build first' }, async (t) => {
  const mock = await startMockTd(lastCompletedSession(Date.now()), KEY);
  const dataDir = mkdtempSync(join(tmpdir(), 'tqqq-'));
  const env = { TWELVE_DATA_API_KEY: KEY, DASHBOARD_PASSWORD: PASSWORD, DATA_DIR: dataDir, TD_BASE_URL: mock.url };
  let s = await startServer(env);
  const bodies: string[] = [];
  const req = async (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('Cookie', init.cookie);
    const r = await fetch(s.base + path, { ...init, headers, redirect: 'manual' });
    const text = await r.text();
    bodies.push(text, JSON.stringify([...r.headers]));
    return { r, text, json: () => JSON.parse(text) };
  };
  let cookie = '';

  await t.test('serves the sign-in page, not the app, before sign-in', async () => {
    const { r, text } = await req('/');
    assert.equal(r.status, 200);
    assert.match(text, /Sign in/);
    assert.doesNotMatch(text, /<title>TQQQ Recovery V2\.0<\/title>/); // app page not served before sign-in
    assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'nonce-/);
    assert.match(text, /<script nonce="/);
    assert.equal((await req('/api/session')).r.status, 401);
    assert.equal((await req('/api/history?symbol=QQQ')).r.status, 401);
  });

  await t.test('signs in with the password only, from the same site', async () => {
    const bad = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    assert.equal(bad.r.status, 401);
    const cross = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(cross.r.status, 403);
    const ok = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(ok.r.status, 204);
    const set = ok.r.headers.get('set-cookie') ?? '';
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    cookie = set.split(';')[0];
    const app = await req('/', { cookie });
    assert.match(app.text, /<title>TQQQ Recovery V2\.0<\/title>/); // renamed by the V2.0 upgrade
    assert.deepEqual((await req('/api/session', { cookie })).json(), { authRequired: true, tdConfigured: true, owner: 'owner', creditsPerMinute: 50 });
    const forged = await req('/api/session', { cookie: cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) });
    assert.equal(forged.r.status, 401);
  });

  await t.test('loads full history through the server, then serves it from the cache', async () => {
    const a = await req('/api/history?symbol=QQQ', { cookie });
    assert.equal(a.r.status, 200);
    const h1 = a.json();
    assert.equal(h1.source, 'full');
    assert.equal(h1.bars.length, mock.series.QQQ.length);
    assert.equal(h1.bars.at(-1).d, mock.series.QQQ.at(-1)!.d);
    const callsAfterFirst = mock.hits.filter((x) => x.path === '/time_series').length;
    assert.ok(callsAfterFirst >= 2, 'history fetched in date windows');
    const b = (await req('/api/history?symbol=QQQ&rebuild=0', { cookie })).json();
    assert.equal(b.bars.length, h1.bars.length);
    const t1 = (await req('/api/history?symbol=TQQQ', { cookie })).json();
    assert.equal(t1.bars.length, mock.series.TQQQ.length);
    const q = (await req('/api/quote?symbol=TQQQ', { cookie })).json();
    assert.equal(q.price, mock.series.TQQQ.at(-1)!.c);
    assert.equal((await req('/api/quote?symbol=AAPL', { cookie })).r.status, 400);
    const dv = (await req('/api/dividends?symbol=QQQ', { cookie })).json();
    assert.equal(dv.length, 2);
    const u = (await req('/api/usage', { cookie })).json();
    assert.equal(u.used, 4);
    assert.equal(u.siteLimit, 50);
  });

  await t.test('stores records and keeps them across a restart', async () => {
    const put = await req('/api/doc?path=data/users/owner/portfolio', { cookie, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { shares: 41, confirmed: true } }) });
    assert.equal(put.r.status, 204);
    assert.equal((await req('/api/doc?path=data/users/owner/portfolio', { cookie, method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{"data":{}}' })).r.status, 403, 'non-JSON writes refused');
    assert.equal((await req('/api/doc?path=market/QQQ/years/2020', { cookie })).r.status, 400, 'only the four record documents are reachable');
    await stop(s.proc);
    const hitsBefore = mock.hits.length;
    s = await startServer(env);
    const got = (await req('/api/doc?path=data/users/owner/portfolio', { cookie })).json();
    assert.deepEqual(got, { exists: true, data: { shares: 41, confirmed: true } }, 'session and record survive the restart');
    const h2 = (await req('/api/history?symbol=QQQ', { cookie })).json();
    assert.equal(h2.source, 'cache+incremental');
    assert.equal(h2.bars.length, mock.series.QQQ.length);
    const newCalls = mock.hits.slice(hitsBefore).filter((x) => x.path === '/time_series');
    assert.equal(newCalls.length, 1, 'one small incremental call after a restart');
    assert.ok(Number(new URLSearchParams(newCalls[0].query).get('outputsize')) < 100);
  });

  await t.test('the API key never leaves the server', async () => {
    for (const b of bodies) assert.ok(!b.includes(KEY), 'key in a response');
    for (const h of mock.hits) {
      assert.equal(h.auth, `apikey ${KEY}`, 'key sent in the Authorization header');
      assert.ok(!h.query.includes(KEY), 'key never in a URL');
    }
    assert.ok(!s.out.join('').includes(KEY), 'key never logged');
  });

  await t.test('signing out ends the session', async () => {
    const r = await req('/api/logout', { cookie, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.match(r.r.headers.get('set-cookie') ?? '', /Max-Age=0/);
  });

  await stop(s.proc);

  await t.test('without a key, market routes say so instead of guessing', async () => {
    const s2 = await startServer({ DASHBOARD_PASSWORD: PASSWORD, DATA_DIR: mkdtempSync(join(tmpdir(), 'tqqq-')) });
    const login = await fetch(s2.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const c = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const r = await fetch(s2.base + '/api/history?symbol=QQQ', { headers: { Cookie: c } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'not_configured');
    assert.equal((await (await fetch(s2.base + '/api/session', { headers: { Cookie: c } })).json()).tdConfigured, false);
    await stop(s2.proc);
  });

  await t.test('refuses to start without a password', async () => {
    const s3 = await startServer({ TWELVE_DATA_API_KEY: KEY, DATA_DIR: mkdtempSync(join(tmpdir(), 'tqqq-')) });
    await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(s3.proc.exitCode, null);
    assert.match(s3.out.join(''), /DASHBOARD_PASSWORD/);
  });

  await mock.close();
});

test('credit limiter keeps calls within the per-minute allowance', () => {
  const l = new CreditLimiter(5);
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(l.waitFor(1, t0 + i), 0);
    l.take(1, t0 + i);
  }
  const w = l.waitFor(1, t0 + 10);
  assert.ok(w > 59000 && w <= 60100, `waits for the oldest credit to expire (${w})`);
  assert.equal(l.waitFor(1, t0 + 60001), 0);
  assert.ok(l.waitFor(20, t0 + 10) > 0);
});
