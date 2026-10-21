import { z } from "zod";

/**
 * Client GeckoTerminal — import d'historique OHLCV.
 *
 * Deux endpoints sont utilisés :
 * - `/networks/solana/pools` pour trouver le **pool principal** (plus grande
 *   réserve USD) d'un mint ;
 * - `/networks/solana/pools/{pool}/ohlcv/{aggregate}` pour l'historique.
 *
 * ⚠ Le budget IP de l'API publique est faible (~30 requêtes/minute). Le client
 * applique donc une pause de politesse entre deux requêtes et respecte le
 * `retry-after` en cas de 429.
 *
 * L'endpoint OHLCV accepte un paramètre `currency=usd` ; sans lui, les
 * valeurs sont dans le token de base, ce qui rendrait les prix incomparables.
 */

export const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

/**
 * GeckoTerminal renvoie certains nombres sous forme de **chaîne**
 * (`reserve_in_usd`, par exemple). On accepte les deux formes.
 */
const numberLike = z.preprocess(
  (value) => (typeof value === "string" ? Number(value) : value),
  z.number(),
);

const poolSchema = z.object({
  id: z.string(),
  attributes: z.object({
    name: z.string().optional(),
    reserve_in_usd: numberLike.optional(),
    base_token_price_usd: z.string().optional(),
  }),
});

const poolsResponseSchema = z.object({
  data: z.array(poolSchema),
});

const ohlcvResponseSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.array(z.number())),
    }),
  }),
});

/** Une ligne OHLCV : [timestamp (s), open, high, low, close, volume]. */
export type OhlcvRow = [number, number, number, number, number, number];

export interface GeckoPool {
  /** Adresse du pool, **sans** le préfixe réseau (`solana_`). */
  address: string;
  reserveUsd: number;
  name: string;
}

export interface GeckoCfg {
  base?: string;
  /**
   * Pause entre deux requêtes (politesse).
   *
   * Le quota de l'API publique est d'environ **30 requêtes/minute** : une
   * pause de 2,1 s reste sous la limite. En cas de 429, le client attend
   * plus longtemps et réessaie.
   */
  pauseMs?: number;
  /** Nombre maximum de pages par actif. */
  maxPages?: number;
  /** Nombre de retries sur erreur rejouable. */
  maxRetries?: number;
  timeoutMs?: number;
}

export interface FetchLike {
  (
    input: string,
    init?: RequestInit,
  ): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export class GeckoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "GeckoError";
  }
}

/** Agrégats GeckoTerminal acceptés pour l'OHLCV. */
export type GeckoAggregate = "minute" | "hour";

/** Correspondance entre nos timeframes et les agrégats GeckoTerminal. */
export const AGGREGATE_FOR_TF: Record<string, { aggregate: GeckoAggregate; every: number }> = {
  "1m": { aggregate: "minute", every: 1 },
  "5m": { aggregate: "minute", every: 5 },
  "15m": { aggregate: "minute", every: 15 },
  "1h": { aggregate: "hour", every: 1 },
};

export class GeckoClient {
  private readonly base: string;
  private readonly pauseMs: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;

  constructor(
    cfg: GeckoCfg = {},
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {
    this.base = cfg.base ?? GECKO_BASE;
    this.pauseMs = cfg.pauseMs ?? 2_500;
    this.maxPages = cfg.maxPages ?? 12;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  /**
   * Pool principal d'un mint : celui dont la **réserve USD** est la plus
   * grande. C'est le pool le plus liquide, donc le moins manipulable.
   */
  async bestPool(mint: string): Promise<GeckoPool | null> {
    const url = `${this.base}/networks/solana/tokens/${mint}/pools?page=1`;
    const raw = await this.request(url);
    const parsed = poolsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // Une réponse illisible (erreur API, quota, format changé) n'est pas
      // « pas de pool » : il faut le signaler, sinon l'import masque la
      // vraie cause derrière un mensonge.
      throw new GeckoError(
        `réponse inattendue de geckoterminal (${parsed.error.issues[0]?.message ?? "format inconnu"})`,
        200,
        url,
      );
    }

    const pools = parsed.data.data.map((pool) => ({
      address: pool.id.replace(/^solana_/, ""),
      reserveUsd: pool.attributes.reserve_in_usd ?? 0,
      name: pool.attributes.name ?? "",
    }));

    if (pools.length === 0) return null;
    return pools.sort((a, b) => b.reserveUsd - a.reserveUsd)[0] ?? null;
  }

  /**
   * Historique OHLCV d'un pool, en remontant le temps.
   *
   * `before_timestamp` (secondes) permet de paginer vers le passé. Les
   * timestamps renvoyés sont en **secondes** : ils sont convertis en ms par
   * l'appelant.
   *
   * ⚠ Les bougies ont des **trous** : un pool DEX sans trade sur un
   * intervalle n'a pas de bougie. La couverture est donc irrégulière — c'est
   * une caractéristique du marché, pas un défaut de l'import. Le backtest la
   * gère en portant le dernier prix connu.
   */
  async ohlcv(poolAddress: string, tf: string, sinceMs: number): Promise<OhlcvRow[]> {
    const spec = AGGREGATE_FOR_TF[tf];
    if (!spec) throw new GeckoError(`timeframe non supporté par GeckoTerminal : ${tf}`, 0, tf);

    const rows: OhlcvRow[] = [];
    let beforeSeconds: number | undefined;
    const sinceSeconds = Math.floor(sinceMs / 1000);

    for (let page = 0; page < this.maxPages; page++) {
      // ⚠ Pas de paramètre `token` : il fait déclencher un 429 sur l'API
      // publique. Sans lui, `currency=usd` suffit (valeurs côté base).
      const params = new URLSearchParams({
        aggregate: String(spec.every),
        limit: "1000",
        currency: "usd",
      });
      if (beforeSeconds !== undefined) params.set("before_timestamp", String(beforeSeconds));

      const url = `${this.base}/networks/solana/pools/${poolAddress}/ohlcv/${spec.aggregate}?${params.toString()}`;
      const raw = await this.request(url);
      const parsed = ohlcvResponseSchema.safeParse(raw);
      if (!parsed.success) break;

      const list = parsed.data.data.attributes.ohlcv_list;
      if (list.length === 0) break;

      rows.push(...(list as OhlcvRow[]));

      const oldest = Math.min(...list.map((row) => row[0]));
      if (oldest <= sinceSeconds) break;
      if (list.length < 1000) break;

      beforeSeconds = oldest - 1;
    }

    return rows.filter((row) => row[0] * 1000 >= sinceMs);
  }

  /** Une requête, avec pause de politesse et retries sur 429/5xx. */
  private async request(url: string): Promise<unknown> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      await this.pause();

      try {
        const res = await this.fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.status === 429 || res.status >= 500) {
          lastError = new GeckoError(`geckoterminal ${res.status}`, res.status, url);
          if (attempt <= this.maxRetries) {
            // Un 429 doit être patient : le quota se recharge à la minute.
            const wait =
              res.status === 429
                ? Math.max(10_000, retryDelayMs(res.headers, attempt))
                : retryDelayMs(res.headers, attempt);
            await this.wait(wait);
            continue;
          }
          throw lastError;
        }

        const text = await res.text();
        if (!res.ok) {
          throw new GeckoError(
            `geckoterminal ${res.status} — ${text.slice(0, 200)}`,
            res.status,
            url,
          );
        }

        try {
          return JSON.parse(text);
        } catch {
          throw new GeckoError("réponse non-JSON", res.status, url);
        }
      } catch (error) {
        if (error instanceof GeckoError && error.status !== 429 && error.status < 500) throw error;
        lastError = error;
        if (attempt <= this.maxRetries) {
          await this.wait(retryDelayMs({ get: () => null }, attempt));
          continue;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Pause de politesse : garantit l'espacement minimal entre deux appels. */
  private async pause(): Promise<void> {
    const since = Date.now() - this.lastRequestAt;
    if (since < this.pauseMs) await this.wait(this.pauseMs - since);
    this.lastRequestAt = Date.now();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}

/** Backoff exponentiel, en honourant `retry-after` quand il est présent. */
export function retryDelayMs(
  headers: { get(name: string): string | null },
  attempt: number,
): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(60_000, seconds * 1_000);
  }
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
}
