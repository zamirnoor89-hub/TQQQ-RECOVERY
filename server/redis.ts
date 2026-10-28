// Upstash Redis over its REST API, for hosts without a disk (Vercel). Plain fetch, no packages.
// Vercel's Upstash integration sets KV_REST_API_URL and KV_REST_API_TOKEN; Upstash's own names
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN work too. The token is only ever sent in the
// Authorization header and is never logged or returned.
//
// Layout: each document collection is one hash ("<prefix>doc:<collection>", field = document id,
// value = JSON), so reading a symbol's whole candle cache is a single HGETALL.
import type { Counters, DocStore } from './app.ts';
import type { CreditBudget } from './tdrest.ts';

type Arg = string | number;

export interface RedisConfig {
  url: string;
  token: string;
  prefix: string;
}

export function redisConfigFromEnv(env: Record<string, string | undefined>): RedisConfig | null {
  const url = (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN ?? '').trim();
  if (!url || !token) return null;
  return { url, token, prefix: (env.REDIS_KEY_PREFIX ?? 'tqqq:').trim() };
}

function storageError(message: string): { code: string; message: string } {
  return { code: 'storage_error', message };
}

export class RedisRest {
  private url: string;
  private token: string;
  commands = 0;
  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw storageError('The database (Upstash Redis) could not be reached. Try again shortly.');
    }
    if (res.status === 401 || res.status === 403) throw storageError('The database rejected its access token. Check the Upstash connection in your Vercel project (KV_REST_API_URL and KV_REST_API_TOKEN).');
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw storageError(`The database sent an unreadable reply (HTTP ${res.status}).`);
    }
    if (!res.ok && !Array.isArray(json)) {
      const msg = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw storageError(`Database error: ${msg}`);
    }
    return json;
  }

  async cmd(...args: Arg[]): Promise<unknown> {
    this.commands++;
    const r = (await this.post('', args)) as { result?: unknown; error?: string };
    if (r && typeof r === 'object' && 'error' in r && r.error) throw storageError(`Database error: ${r.error}`);
    return r?.result ?? null;
  }

  async pipeline(cmds: Arg[][]): Promise<unknown[]> {
    this.commands += cmds.length;
    const r = (await this.post('/pipeline', cmds)) as { result?: unknown; error?: string }[];
    if (!Array.isArray(r)) throw storageError('The database sent an unexpected reply.');
    return r.map((x) => {
      if (x && x.error) throw storageError(`Database error: ${x.error}`);
      return x?.result ?? null;
    });
  }
}

function splitPath(path: string): { collection: string; id: string } {
  const i = path.lastIndexOf('/');
  if (i <= 0 || i === path.length - 1) throw storageError(`Bad document path ${path}`);
  return { collection: path.slice(0, i), id: path.slice(i + 1) };
}

export class RedisStore implements DocStore {
  private r: RedisRest;
  private prefix: string;
  constructor(r: RedisRest, prefix: string) {
    this.r = r;
    this.prefix = prefix;
  }
  private key(collection: string): string {
    return `${this.prefix}doc:${collection}`;
  }

  async read(path: string): Promise<Record<string, unknown> | undefined> {
    const { collection, id } = splitPath(path);
    const v = await this.r.cmd('HGET', this.key(collection), id);
    return typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : undefined;
  }

  async write(path: string, data: Record<string, unknown>): Promise<void> {
    const { collection, id } = splitPath(path);
    await this.r.cmd('HSET', this.key(collection), id, JSON.stringify(data));
  }

  async remove(path: string): Promise<void> {
    const { collection, id } = splitPath(path);
    await this.r.cmd('HDEL', this.key(collection), id);
  }

  async list(collection: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
    const flat = (await this.r.cmd('HGETALL', this.key(collection))) as string[] | null;
    const out: { id: string; data: Record<string, unknown> }[] = [];
    if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) out.push({ id: flat[i], data: JSON.parse(flat[i + 1]) as Record<string, unknown> });
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async meta(k: string): Promise<string | null> {
    const v = await this.r.cmd('HGET', `${this.prefix}meta`, k);
    return typeof v === 'string' ? v : null;
  }

  async setMetaIfMissing(k: string, v: string): Promise<string> {
    const [, got] = await this.r.pipeline([['HSETNX', `${this.prefix}meta`, k, v], ['HGET', `${this.prefix}meta`, k]]);
    return String(got);
  }
}

export class RedisCounters implements Counters {
  private r: RedisRest;
  private prefix: string;
  constructor(r: RedisRest, prefix: string) {
    this.r = r;
    this.prefix = prefix;
  }
  async add(key: string, by: number, ttlSec: number): Promise<number> {
    const k = `${this.prefix}n:${key}`;
    const [n] = await this.r.pipeline([['INCRBY', k, by], ['EXPIRE', k, ttlSec]]);
    return Number(n);
  }
  async get(key: string): Promise<{ n: number; ttlSec: number }> {
    const k = `${this.prefix}n:${key}`;
    const [n, ttl] = await this.r.pipeline([['GET', k], ['TTL', k]]);
    return { n: Number(n ?? 0) || 0, ttlSec: Math.max(0, Number(ttl ?? 0)) };
  }
  async clear(key: string): Promise<void> {
    await this.r.cmd('DEL', `${this.prefix}n:${key}`);
  }
}

/**
 * Twelve Data credits counted in Redis per clock minute, so every Vercel instance shares one
 * allowance. A call that would go over the limit is refunded and told to wait for the next minute.
 */
export class RedisBudget implements CreditBudget {
  private c: RedisCounters;
  private limit: number;
  constructor(c: RedisCounters, limit: number) {
    this.c = c;
    this.limit = limit;
  }
  async trySpend(w: number, now = Date.now()): Promise<number> {
    const key = `td:${Math.floor(now / 60000)}`;
    const n = await this.c.add(key, w, 120);
    if (n <= this.limit) return 0;
    await this.c.add(key, -w, 120);
    return 60000 - (now % 60000) + 50;
  }
  async used(now = Date.now()): Promise<number> {
    return (await this.c.get(`td:${Math.floor(now / 60000)}`)).n;
  }
}
