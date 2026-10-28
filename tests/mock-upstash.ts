// A stand-in for the Upstash Redis REST API, for tests only: POST / with one command and
// POST /pipeline with several, Bearer-token auth, and the handful of commands the site uses.
import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface MockRedis {
  url: string;
  token: string;
  commands: string[][];
  data: Map<string, string | Map<string, string>>;
  bodies: string[];
  close(): Promise<void>;
}

export async function startMockRedis(token: string): Promise<MockRedis> {
  const data = new Map<string, string | Map<string, string>>();
  const expiry = new Map<string, number>();
  const commands: string[][] = [];
  const bodies: string[] = [];
  const alive = (k: string) => {
    const e = expiry.get(k);
    if (e !== undefined && e <= Date.now()) {
      data.delete(k);
      expiry.delete(k);
    }
    return data.has(k);
  };
  const hash = (k: string, create: boolean): Map<string, string> | null => {
    alive(k);
    const v = data.get(k);
    if (v instanceof Map) return v;
    if (v !== undefined) throw new Error('WRONGTYPE');
    if (!create) return null;
    const m = new Map<string, string>();
    data.set(k, m);
    return m;
  };
  const run = (args: unknown[]): unknown => {
    const a = args.map(String);
    commands.push(a);
    const [cmd, k] = [a[0].toUpperCase(), a[1]];
    switch (cmd) {
      case 'HGET': return hash(k, false)?.get(a[2]) ?? null;
      case 'HSET': { const h = hash(k, true)!; let n = 0; for (let i = 2; i + 1 < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } return n; }
      case 'HSETNX': { const h = hash(k, true)!; if (h.has(a[2])) return 0; h.set(a[2], a[3]); return 1; }
      case 'HDEL': { const h = hash(k, false); let n = 0; for (const f of a.slice(2)) if (h?.delete(f)) n++; return n; }
      case 'HGETALL': { const h = hash(k, false); return h ? [...h].flat() : []; }
      case 'GET': { alive(k); const v = data.get(k); return typeof v === 'string' ? v : null; }
      case 'INCRBY': { alive(k); const v = Number(data.get(k) ?? 0) + Number(a[2]); data.set(k, String(v)); return v; }
      case 'EXPIRE': { if (!alive(k)) return 0; expiry.set(k, Date.now() + Number(a[2]) * 1000); return 1; }
      case 'TTL': { if (!alive(k)) return -2; const e = expiry.get(k); return e === undefined ? -1 : Math.ceil((e - Date.now()) / 1000); }
      case 'DEL': { let n = 0; for (const x of a.slice(1)) { if (alive(x)) n++; data.delete(x); expiry.delete(x); } return n; }
      default: throw new Error(`ERR unknown command '${cmd}'`);
    }
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      bodies.push(text);
      const send = (status: number, v: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return send(400, { error: 'ERR failed to parse command' });
      }
      const one = (c: unknown) => {
        try {
          return { result: run(c as unknown[]) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      };
      if (req.url === '/pipeline') return send(200, (body as unknown[]).map(one));
      const r = one(body);
      return send('error' in r ? 400 : 200, r);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, token, commands, data, bodies, close: () => new Promise((r) => server.close(() => r())) };
}
