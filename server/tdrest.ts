// Twelve Data REST client for the server. It implements the same call interface the browser uses
// with the claude.ai connector, so the shared loaders and parsers run unchanged. The API key is sent
// in the Authorization header and never appears in a URL, a log line or a response.
import type { McpLike } from '../src/market.ts';

export interface TdRestOptions {
  apiKey: string;
  baseUrl: string;
  creditsPerMinute: number;
  maxWaitMs: number;
  /** Where credits are counted. Defaults to this process's own sliding window. */
  budget?: CreditBudget;
}

/** Counts Twelve Data credits against the per-minute allowance, possibly across server instances. */
export interface CreditBudget {
  /** Spends `w` credits and returns 0, or returns the milliseconds to wait before trying again. */
  trySpend(w: number): Promise<number>;
  /** Credits spent in the current minute. */
  used(): Promise<number>;
}

const ENDPOINTS: Record<string, { path: string; weight: number; csv: boolean }> = {
  get_time_series: { path: 'time_series', weight: 1, csv: true },
  get_quote: { path: 'quote', weight: 1, csv: true },
  get_dividends: { path: 'dividends', weight: 20, csv: false },
  get_api_usage: { path: 'api_usage', weight: 1, csv: false },
};

const ALLOWED_PARAMS = new Set(['symbol', 'interval', 'outputsize', 'start_date', 'end_date']);

/** Sliding one-minute window so the site stays under the plan's per-minute credit limit. */
export class CreditLimiter {
  private spent: { at: number; w: number }[] = [];
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  used(now = Date.now()): number {
    this.spent = this.spent.filter((x) => now - x.at < 60000);
    return this.spent.reduce((s, x) => s + x.w, 0);
  }
  /** Milliseconds until `w` credits fit, or 0 if they fit now. */
  waitFor(w: number, now = Date.now()): number {
    if (this.used(now) + w <= this.limit) return 0;
    let total = this.used(now);
    for (const x of this.spent) {
      total -= x.w;
      if (total + w <= this.limit) return Math.max(0, x.at + 60000 - now) + 50;
    }
    return 60050;
  }
  take(w: number, now = Date.now()): void {
    this.spent.push({ at: now, w });
  }
}

/** One process's budget: the sliding window above. Right for a single long-running server. */
export class MemoryBudget implements CreditBudget {
  readonly limiter: CreditLimiter;
  constructor(limit: number) {
    this.limiter = new CreditLimiter(limit);
  }
  async trySpend(w: number): Promise<number> {
    const wait = this.limiter.waitFor(w);
    if (wait === 0) this.limiter.take(w);
    return wait;
  }
  async used(): Promise<number> {
    return this.limiter.used();
  }
}

export class TwelveDataRest implements McpLike {
  readonly budget: CreditBudget;
  calls = 0;
  private opts: TdRestOptions;
  constructor(opts: TdRestOptions) {
    this.opts = opts;
    this.budget = opts.budget ?? new MemoryBudget(opts.creditsPerMinute);
  }

  async callTool(server: string, tool: string, input?: unknown): Promise<unknown> {
    const ep = ENDPOINTS[tool];
    if (server !== 'Twelve Data' || !ep) throw { code: 'bad_request', message: `Unsupported tool ${tool}` };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
      if (!ALLOWED_PARAMS.has(k) || v === null || v === undefined || v === '') continue;
      params.set(k, String(v));
    }
    if (ep.csv) params.set('format', 'CSV');
    if (tool === 'get_dividends') params.set('range', 'full');
    const deadline = Date.now() + this.opts.maxWaitMs;
    for (;;) {
      const wait = await this.budget.trySpend(ep.weight);
      if (wait === 0) break;
      if (Date.now() + wait > deadline) {
        throw { code: 'rate_limited', retryable: true, retryAfterMs: wait, message: `This site’s Twelve Data limit of ${this.opts.creditsPerMinute} credits a minute is used up. Try again in ${Math.ceil(wait / 1000)} seconds.` };
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    this.calls++;
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/${ep.path}?${params.toString()}`, {
        headers: { Authorization: `apikey ${this.opts.apiKey}`, Accept: ep.csv ? 'text/csv, application/json' : 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw { code: 'server_unavailable', retryable: true, message: 'Twelve Data could not be reached from the server. Try again shortly.' };
    }
    const text = await res.text();
    let envelope: { code?: number; message?: string; status?: string } | null = null;
    if (text.trim().startsWith('{')) {
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = null;
      }
    }
    const code = envelope && envelope.status === 'error' ? Number(envelope.code) : res.ok ? 200 : res.status;
    if (code === 429) {
      const now = new Date();
      throw { code: 'rate_limited', retryable: true, retryAfterMs: (60 - now.getUTCSeconds()) * 1000 + 500, message: 'Twelve Data’s per-minute credit limit was reached. Try again in a minute.' };
    }
    if (code === 401 || code === 403) {
      throw { code: 'tool_error', message: `Twelve Data refused the request: ${envelope?.message ?? res.statusText}. Check TWELVE_DATA_API_KEY and your plan.` };
    }
    if (code >= 500) throw { code: 'server_unavailable', retryable: true, message: 'Twelve Data had a server error. Try again shortly.' };
    if (code >= 400) throw { code: 'tool_error', message: envelope?.message ?? `Twelve Data error ${code}` };
    return { content: [{ type: 'text', text }] };
  }
}
