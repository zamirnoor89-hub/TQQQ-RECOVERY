// Where the app gets market data and keeps records. Two implementations share every page:
// the claude.ai page (Twelve Data connector + artifact database) and the standalone website
// (the site's own server, which holds the Twelve Data key).
import type { ApiUsage, Dividend, Quote } from '../data.ts';
import type { CacheDb, ConnState, LoadSeriesResult, McpLike } from '../market.ts';
import { TwelveData, clearHistoryCache, loadHistory } from '../market.ts';
import type { DbLike } from '../store.ts';

export type Symbol2 = 'QQQ' | 'TQQQ';

export interface MarketApi {
  history(symbol: Symbol2, nowMs: number, forceFull: boolean): Promise<LoadSeriesResult>;
  quote(symbol: Symbol2): Promise<Quote>;
  dividends(symbol: Symbol2): Promise<Dividend[]>;
  usage(): Promise<ApiUsage | null>;
  clearCache(): Promise<void>;
  calls(): number;
}

export interface Runtime {
  kind: 'claude' | 'site';
  market: MarketApi | null;
  marketUnavailable: { state: ConnState; message: string } | null;
  store: { db: DbLike; uid: string } | null;
  storeUnavailable: string | null;
  /** Shown in Settings: where the data comes from and where the key lives. */
  providerNote: string;
  cacheNote: (writable: boolean) => string;
  logout: (() => Promise<void>) | null;
  /** Offer a generated text file (CSV) to the viewer. Resolves with a short outcome message. */
  download: ((filename: string, text: string) => Promise<string>) | null;
}

/** Plain-browser download (the standalone website). */
export function browserDownload(filename: string, text: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return Promise.resolve(`${filename} downloaded`);
}

interface ClaudeLike {
  use(name: string): Promise<unknown>;
}

/** The claude.ai page: Twelve Data through the viewer's connector, records in the artifact database. */
export async function claudeRuntime(): Promise<Runtime> {
  const base = {
    kind: 'claude' as const,
    providerNote: 'Twelve Data, through your claude.ai connector. Calls run on the server under your Twelve Data login; this page never holds an API key.',
    cacheNote: (w: boolean) => (w ? 'Saved by year in this page’s database; later visits fetch only recent sessions.' : 'Not cached (read-only or unavailable); each visit downloads history.'),
    logout: null,
    download: null,
  };
  const claude = (window as unknown as { claude?: ClaudeLike }).claude;
  if (!claude || typeof claude.use !== 'function') {
    return {
      ...base, market: null, store: null,
      marketUnavailable: { state: 'no_runtime', message: 'Open this page in claude.ai to load Twelve Data and your saved positions.' },
      storeUnavailable: 'Saving is only available when the page is opened in claude.ai.',
    };
  }
  const [mcp, db, user] = await Promise.all([
    claude.use('mcp').catch(() => null),
    claude.use('db').catch(() => null),
    claude.use('user').catch(() => null),
  ]);
  let uid: string | null = null;
  if (user) {
    try {
      uid = (await (user as { id(): Promise<string | null> }).id()) ?? null;
    } catch {
      uid = null;
    }
  }
  let market: MarketApi | null = null;
  if (mcp) {
    const td = new TwelveData(mcp as McpLike);
    const cache = (db as CacheDb | null) ?? null;
    market = {
      history: (s, now, full) => loadHistory(td, cache, s, now, full),
      quote: (s) => td.quote(s),
      dividends: (s) => td.dividends(s),
      usage: () => td.usage(),
      clearCache: async () => {
        if (!cache) return;
        try {
          await clearHistoryCache(cache, 'QQQ');
          await clearHistoryCache(cache, 'TQQQ');
        } catch {
          /* not writable: a full reload still refreshes this view */
        }
      },
      calls: () => td.credits,
    };
  }
  // Downloads are resolved on first use, so a missing capability never delays the page.
  let dl: Promise<unknown> | null = null;
  const download = async (filename: string, text: string): Promise<string> => {
    dl ??= claude.use('downloads').catch(() => null);
    const d = (await dl) as { save(r: { filename: string; data: string }): Promise<unknown> } | null;
    if (!d) return 'Downloads are not available in this view.';
    try {
      await d.save({ filename, data: text });
      return `${filename} saved`;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return code === 'declined' ? 'Download cancelled' : code === 'rate_limited' ? 'Another download prompt is open' : 'Downloads are not available in this view.';
    }
  };
  return {
    ...base,
    download,
    market,
    marketUnavailable: market ? null : { state: 'no_runtime', message: 'Connector access is not available in this view. Open the page in claude.ai with Twelve Data connected.' },
    store: db && uid ? { db: db as DbLike, uid } : null,
    storeUnavailable: db && uid ? null : db ? 'Sign in to claude.ai to save your holdings and transactions.' : 'Saving is not available in this view.',
  };
}
