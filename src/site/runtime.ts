// The standalone website: every call goes to this site's own server under /api. The server holds
// the Twelve Data key and the database; the browser only ever sees prices and the user's records.
import type { ApiUsage, Bar, Dividend, Quote } from '../data.ts';
import type { LoadSeriesResult } from '../market.ts';
import type { DbLike, SnapLike } from '../store.ts';
import type { MarketApi, Runtime, Symbol2 } from '../app/runtime.ts';
import { browserDownload } from '../app/runtime.ts';

interface ApiError {
  code: string;
  message: string;
  retryable?: boolean;
}

async function api<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw { code: 'server_unavailable', message: 'The dashboard server could not be reached. Check your connection and refresh.' } as ApiError;
  }
  if (res.status === 401) {
    // Session expired: back to the sign-in page.
    location.reload();
    throw { code: 'unauthorized', message: 'Please sign in again.' } as ApiError;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw { code: 'upstream_error', message: `Unexpected server response (${res.status})` } as ApiError;
  }
  if (!res.ok) {
    const e = (json as { error?: ApiError } | null)?.error;
    throw (e ?? { code: 'upstream_error', message: `Server error ${res.status}` }) as ApiError;
  }
  return json as T;
}

const q = (s: string) => encodeURIComponent(s);

function httpDb(): DbLike {
  return {
    doc(path: string) {
      return {
        async get(): Promise<SnapLike> {
          const r = await api<{ exists: boolean; data: Record<string, unknown> | null }>('GET', `/api/doc?path=${q(path)}`);
          return { exists: r.exists, data: () => (r.exists && r.data ? r.data : undefined) };
        },
        async set(data: Record<string, unknown>): Promise<void> {
          await api<void>('PUT', `/api/doc?path=${q(path)}`, { data });
        },
      };
    },
  };
}

export async function siteRuntime(): Promise<Runtime> {
  let calls = 0;
  const session = await api<{ authRequired: boolean; tdConfigured: boolean; owner: string }>('GET', '/api/session').catch(() => null);
  const market: MarketApi = {
    async history(symbol: Symbol2, _now: number, forceFull: boolean): Promise<LoadSeriesResult> {
      const r = await api<LoadSeriesResult & { bars: Bar[] }>('GET', `/api/history?symbol=${q(symbol)}${forceFull ? '&rebuild=1' : ''}`);
      calls += r.calls;
      return r;
    },
    async quote(symbol: Symbol2): Promise<Quote> {
      calls += 1;
      return api<Quote>('GET', `/api/quote?symbol=${q(symbol)}`);
    },
    async dividends(symbol: Symbol2): Promise<Dividend[]> {
      return api<Dividend[]>('GET', `/api/dividends?symbol=${q(symbol)}`);
    },
    async usage(): Promise<ApiUsage | null> {
      return api<ApiUsage | null>('GET', '/api/usage');
    },
    async clearCache(): Promise<void> {
      await api<void>('POST', '/api/history/rebuild', {});
    },
    calls: () => calls,
  };
  const configured = session ? session.tdConfigured : true;
  return {
    kind: 'site',
    market: session && configured ? market : null,
    marketUnavailable: !session
      ? { state: 'unavailable', message: 'The dashboard server could not be reached.' }
      : configured ? null : { state: 'not_connected', message: 'The server has no Twelve Data key. Set TWELVE_DATA_API_KEY in the host’s environment and restart.' },
    store: session ? { db: httpDb(), uid: session.owner } : null,
    storeUnavailable: session ? null : 'The dashboard server could not be reached, so nothing can be saved.',
    providerNote: 'Twelve Data REST API, called by this site’s server with the key from its TWELVE_DATA_API_KEY setting. The browser never receives the key.',
    cacheNote: () => 'Stored by year in the server’s SQLite database; later loads fetch only recent sessions. Shared by every device you sign in from.',
    download: browserDownload,
    logout: session && session.authRequired ? async () => {
      await api<void>('POST', '/api/logout', {});
      location.reload();
    } : null,
  };
}
