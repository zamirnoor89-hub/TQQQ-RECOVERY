// Runs the built Vercel function (api/index.mjs) the way Vercel does, for tests only: static files
// from public/ first, then every other path rewritten to the function as /api/index?__path=/...
// (vercel.json), forwarded-for/proto/host headers added, and the 4.5 MB body limits enforced.
//   PORT          listen port
//   REWRITE_URL   "destination" (function sees /api/index?__path=...) or "original" (sees the
//                 original URL plus __path); Vercel's exact choice doesn't matter to the function.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
const fn = (await import(join(root, 'api', 'index.mjs'))).default;
const LIMIT = 4.5 * 1024 * 1024;
const mode = process.env.REWRITE_URL ?? 'destination';

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (body.length > LIMIT) return res.writeHead(413).end('FUNCTION_PAYLOAD_TOO_LARGE');
  const original = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const file = normalize(join(root, 'public', original.pathname));
  if (file.startsWith(join(root, 'public')) && existsSync(file) && statSync(file).isFile()) {
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(readFileSync(file));
  }
  let target;
  if (mode === 'original') {
    target = new URL(original);
    target.searchParams.set('__path', original.pathname);
  } else {
    target = new URL(`/api/index?__path=${original.pathname}`, original);
    for (const [k, v] of original.searchParams) if (k !== '__path') target.searchParams.append(k, v);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const ip = req.headers['x-test-ip'] ?? '203.0.113.7';
  headers.set('x-forwarded-for', String(ip));
  headers.set('x-real-ip', String(ip));
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-forwarded-host', String(req.headers.host));
  const request = new Request(target, { method: req.method, headers, body: body.length ? body : undefined });
  let r;
  try {
    r = await fn.fetch(request);
  } catch (e) {
    console.error('FUNCTION_INVOCATION_FAILED', e);
    return res.writeHead(500).end('FUNCTION_INVOCATION_FAILED');
  }
  const out = Buffer.from(await r.arrayBuffer());
  if (out.length > LIMIT) {
    console.error('FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE', out.length);
    return res.writeHead(500).end('FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE');
  }
  const h = {};
  r.headers.forEach((v, k) => {
    if (k !== 'set-cookie') h[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) h['set-cookie'] = cookies;
  h['x-test-body-bytes'] = String(r.headers.get('content-encoding') === 'gzip' ? gunzipSync(out).length : out.length);
  h['x-test-wire-bytes'] = String(out.length);
  res.writeHead(r.status, h).end(r.status === 204 ? undefined : out);
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => console.log('vercel-local ready'));
