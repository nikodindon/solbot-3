import { z } from "zod";
import { TokenBucket } from "../utils/rate-limit.js";
import { sleep } from "../utils/time.js";

/**
 * Client HTTP partagé pour toutes les API Jupiter.
 *
 * - token bucket respectant le débit du plan (0,5 req/s sans clé, 1 req/s avec) ;
 * - backoff 429 piloté par `x-ratelimit-reset` (timestamp unix absolu) ;
 * - retries sur 5xx et erreurs réseau (exponentiel + jitter), **jamais** sur 4xx ;
 * - chaque réponse est validée par un schéma zod (fail-fast en cas de dérive d'API).
 */

export const priceV3Schema = z.object({
  usdPrice: z.number(),
  priceChange24h: z.number().optional(),
  blockId: z.number().optional(),
  decimals: z.number().optional(),
  liquidity: z.number().optional(),
  createdAt: z.string().optional(),
});
export type PriceV3Row = z.infer<typeof priceV3Schema>;

export type PriceRow = PriceV3Row & { mint: string };

export interface JupiterStats {
  requests: number;
  retries: number;
  rateLimited: number;
  errors: number;
  lastErrorAt: number | null;
}

export interface JupiterCfg {
  apiKey?: string | null;
  /** Débit du bucket principal (req/s). Défaut : 0,5 sans clé, 1 avec. */
  rps?: number;
  base?: string;
  timeoutMs?: number;
  /** Nombre de retries pour les échecs rejouables (429 et 5xx). */
  retries?: number;
}

export interface FetchLike {
  (
    input: string,
    init?: RequestInit,
  ): Promise<{
    ok: boolean;
    status: number;
    headers: Headers | { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export type QueryParams = Record<string, string | number | (string | number)[] | undefined>;

export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "JupiterError";
    if (body && body.length > 300) {
      this.message = `${message} — body: ${body.slice(0, 300)}…`;
    }
  }
}

export class JupiterClient {
  private readonly bucket: TokenBucket;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  readonly apiKey: string | null;
  readonly stats: JupiterStats = {
    requests: 0,
    retries: 0,
    rateLimited: 0,
    errors: 0,
    lastErrorAt: null,
  };

  constructor(
    cfg: JupiterCfg,
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {
    this.apiKey = cfg.apiKey ?? null;
    this.base = cfg.base ?? "https://api.jup.ag";
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.retries = Math.max(0, cfg.retries ?? 3);
    const rps = cfg.rps ?? (cfg.apiKey ? 1 : 0.5);
    this.bucket = new TokenBucket(rps, Math.max(1, Math.ceil(rps)));
  }

  bucketStats(): TokenBucket["stats"] {
    return this.bucket.stats;
  }

  private headers(withKey: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (withKey && this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  async get<T>(
    path: string,
    params: QueryParams,
    parse: (raw: unknown) => T,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const query = search.toString();
    const url = `${this.base}${path}${query ? `?${query}` : ""}`;
    return this.request(url, "GET", this.headers(true), undefined, parse, opts);
  }

  async post<T>(
    path: string,
    body: unknown,
    parse: (raw: unknown) => T,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const headers = { ...this.headers(true), "content-type": "application/json" };
    return this.request(url, "POST", headers, JSON.stringify(body), parse, opts);
  }

  private async request<T>(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    parse: (raw: unknown) => T,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const maxAttempts = this.retries + 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.bucket.acquire();
      this.stats.requests += 1;

      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });

        if (res.status === 429) {
          this.stats.rateLimited += 1;
          lastError = new JupiterError("rate limited", 429, url);
          if (attempt < maxAttempts) {
            this.stats.retries += 1;
            await sleep(backoffFromHeaders(res.headers));
            continue;
          }
          throw lastError;
        }

        if (res.status >= 500) {
          lastError = new JupiterError(`jupiter ${res.status}`, res.status, url);
          if (attempt < maxAttempts) {
            this.stats.retries += 1;
            await sleep(retryDelayMs(attempt));
            continue;
          }
          throw lastError;
        }

        const text = await res.text();
        if (!res.ok) {
          this.stats.errors += 1;
          this.stats.lastErrorAt = Date.now();
          throw new JupiterError(
            `jupiter ${res.status} on ${method} ${shortUrl(url)}`,
            res.status,
            shortUrl(url),
            text,
          );
        }

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          this.stats.errors += 1;
          this.stats.lastErrorAt = Date.now();
          throw new JupiterError(
            `réponse non-JSON (${shortUrl(url)})`,
            res.status,
            shortUrl(url),
            text,
          );
        }
        return parse(json);
      } catch (error) {
        if (error instanceof JupiterError) throw error;
        // Erreurs réseau / timeout : rejouables.
        this.stats.errors += 1;
        this.stats.lastErrorAt = Date.now();
        lastError = error;
        if (attempt < maxAttempts) {
          this.stats.retries += 1;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function retryDelayMs(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  return Math.min(60_000, base + Math.floor(Math.random() * 120));
}

/** `x-ratelimit-reset` est un timestamp unix absolu (secondes) — on attend jusqu'à cette échéance. */
export function backoffFromHeaders(headers: { get(name: string): string | null }): number {
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.max(100, Math.min(120_000, resetMs - Date.now()));
    }
  }
  return Math.min(2000, 250 * (1 + Math.floor(Math.random() * 2)));
}

export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${
      parsed.search.length > 60 ? `${parsed.search.slice(0, 60)}…` : parsed.search
    }`;
  } catch {
    return url;
  }
}
