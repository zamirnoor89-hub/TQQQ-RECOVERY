// SQLite storage for the Node server (Node's built-in node:sqlite). One table of JSON documents
// addressed by path, used for the user's records and the candle cache, plus a small key/value table
// for server settings. Calls are synchronous underneath; the async methods match DocStore.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Counters, DocStore } from './app.ts';

export class Store implements DocStore {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  async read(path: string): Promise<Record<string, unknown> | undefined> {
    const row = this.db.prepare('SELECT data FROM docs WHERE path = ?').get(path) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined;
  }

  async write(path: string, data: Record<string, unknown>): Promise<void> {
    this.db.prepare('INSERT INTO docs (path, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(path, JSON.stringify(data), new Date().toISOString());
  }

  async remove(path: string): Promise<void> {
    this.db.prepare('DELETE FROM docs WHERE path = ?').run(path);
  }

  async list(collection: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
    const rows = this.db.prepare("SELECT path, data FROM docs WHERE path LIKE ? ESCAPE '\\' ORDER BY path").all(collection.replace(/[%_]/g, (m) => '\\' + m) + '/%') as { path: string; data: string }[];
    return rows
      .filter((r) => !r.path.slice(collection.length + 1).includes('/'))
      .map((r) => ({ id: r.path.slice(collection.length + 1), data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  async meta(k: string): Promise<string | null> {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
    return row ? row.v : null;
  }

  async setMetaIfMissing(k: string, v: string): Promise<string> {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING').run(k, v);
    return (await this.meta(k)) as string;
  }

  close(): void {
    this.db.close();
  }
}

/** Login-attempt counters for a single long-running process. */
export class MemoryCounters implements Counters {
  private m = new Map<string, { n: number; until: number }>();
  async add(key: string, by: number, ttlSec: number): Promise<number> {
    const now = Date.now();
    const cur = this.m.get(key);
    const n = (cur && cur.until > now ? cur.n : 0) + by;
    this.m.set(key, { n, until: now + ttlSec * 1000 });
    if (this.m.size > 10000) for (const [k, v] of this.m) if (v.until <= now) this.m.delete(k);
    return n;
  }
  async get(key: string): Promise<{ n: number; ttlSec: number }> {
    const cur = this.m.get(key);
    const now = Date.now();
    return cur && cur.until > now ? { n: cur.n, ttlSec: Math.ceil((cur.until - now) / 1000) } : { n: 0, ttlSec: 0 };
  }
  async clear(key: string): Promise<void> {
    this.m.delete(key);
  }
}
