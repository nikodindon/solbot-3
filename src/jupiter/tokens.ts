import { z } from "zod";
import type { JupiterClient } from "./client.js";

/**
 * Tokens API v2 — découverte de l'univers et vérification à chaud.
 *
 * Le schéma est volontairement **tolérant** (champs optionnels, unknown keys
 * acceptées) : Jupiter fait évoluer la réponse sans préavis, et un token
 * inhabituel ne doit pas faire tomber le scan complet.
 */

const statsSchema = z.looseObject({
  priceChange: z.number().optional(),
  buyVolume: z.number().optional(),
  sellVolume: z.number().optional(),
  numBuys: z.number().optional(),
  numSells: z.number().optional(),
  numTraders: z.number().optional(),
});

const firstPoolSchema = z.looseObject({
  id: z.string().optional(),
  createdAt: z.string().optional(),
});

const auditSchema = z.looseObject({
  mintAuthorityDisabled: z.boolean().optional(),
  freezeAuthorityDisabled: z.boolean().optional(),
  topHoldersPercentage: z.number().optional(),
});

export const tokenInfoSchema = z.looseObject({
  id: z.string(),
  name: z.string().default(""),
  symbol: z.string().default(""),
  decimals: z.number().int().nullish(),
  isVerified: z.boolean().optional(),
  organicScore: z.number().nullish(),
  organicScoreLabel: z.string().nullish(),
  usdPrice: z.number().nullish(),
  liquidity: z.number().nullish(),
  mcap: z.number().nullish(),
  fdv: z.number().nullish(),
  holderCount: z.number().nullish(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().nullish(),
  firstPool: firstPoolSchema.nullish(),
  audit: auditSchema.nullish(),
  stats5m: statsSchema.optional(),
  stats1h: statsSchema.optional(),
  stats6h: statsSchema.optional(),
  stats24h: statsSchema.optional(),
});

export type TokenInfoRaw = z.infer<typeof tokenInfoSchema>;

const tokenListSchema = z.array(tokenInfoSchema);

export const TOKEN_CATEGORIES = ["toporganicscore", "toptraded", "toptrending"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

export const CATEGORY_INTERVALS = ["5m", "1h", "6h", "24h"] as const;
export type CategoryInterval = (typeof CATEGORY_INTERVALS)[number];

export const TOKEN_TAGS = ["lst", "verified", "stocks"] as const;
export type TokenTag = (typeof TOKEN_TAGS)[number];

/** Nombre de mints acceptés par l'endpoint de recherche. */
export const SEARCH_BATCH = 50;

/** Information token normalisée, telle que consommée par le reste du projet. */
export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number | null;
  isVerified: boolean;
  organicScore: number | null;
  usdPrice: number | null;
  liquidityUsd: number | null;
  /** Date de création du **premier pool** (proxy de l'âge du token). */
  poolCreatedMs: number | null;
  /** Date de création du token lui-même. */
  createdAtMs: number | null;
  /** Volume acheté + vendu sur 24 h, en USD. */
  volume24hUsd: number | null;
  tags: string[];
  topHoldersPct: number | null;
}

export class TokensApi {
  constructor(private readonly client: JupiterClient) {}

  /** Recherche par symbole, nom ou mint. Un lot de mints séparés par des virgules est accepté. */
  async search(query: string): Promise<TokenInfo[]> {
    const raw = await this.client.get("/tokens/v2/search", { query }, (json) =>
      tokenListSchema.parse(json),
    );
    return raw.map(toTokenInfo);
  }

  /** Recherche par mints, par lots (l'API limite la taille de la requête). */
  async searchMints(mints: string[]): Promise<Map<string, TokenInfo>> {
    const out = new Map<string, TokenInfo>();
    const unique = [...new Set(mints)];
    for (let i = 0; i < unique.length; i += SEARCH_BATCH) {
      const batch = unique.slice(i, i + SEARCH_BATCH);
      const found = await this.search(batch.join(","));
      for (const token of found) out.set(token.mint, token);
    }
    return out;
  }

  /** Tokens par tag : `lst`, `verified`, `stocks`. */
  async byTag(tag: TokenTag): Promise<TokenInfo[]> {
    const raw = await this.client.get("/tokens/v2/tag", { query: tag }, (json) =>
      tokenListSchema.parse(json),
    );
    return raw.map(toTokenInfo);
  }

  /** Classement par catégorie (`toporganicscore` | `toptraded` | `toptrending`). */
  async byCategory(
    category: TokenCategory,
    interval: CategoryInterval,
    limit = 100,
  ): Promise<TokenInfo[]> {
    const raw = await this.client.get(`/tokens/v2/${category}/${interval}`, { limit }, (json) =>
      tokenListSchema.parse(json),
    );
    return raw.map(toTokenInfo);
  }

  /** Tokens dont le premier pool vient d'être créé. */
  async recent(): Promise<TokenInfo[]> {
    const raw = await this.client.get("/tokens/v2/recent", {}, (json) =>
      tokenListSchema.parse(json),
    );
    return raw.map(toTokenInfo);
  }
}

export function toTokenInfo(token: TokenInfoRaw): TokenInfo {
  return {
    mint: token.id,
    symbol: token.symbol || token.id.slice(0, 6),
    name: token.name,
    decimals: token.decimals ?? null,
    isVerified: token.isVerified === true,
    organicScore: token.organicScore ?? null,
    usdPrice: token.usdPrice ?? null,
    liquidityUsd: token.liquidity ?? null,
    poolCreatedMs: parseIsoDate(token.firstPool?.createdAt),
    createdAtMs: parseIsoDate(token.createdAt),
    volume24hUsd: volumeOf(token.stats24h),
    tags: token.tags ?? [],
    topHoldersPct: token.audit?.topHoldersPercentage ?? null,
  };
}

function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Volume 24 h (achats + ventes) en USD. */
function volumeOf(stats: TokenInfoRaw["stats24h"]): number | null {
  if (!stats) return null;
  const buy = stats.buyVolume ?? 0;
  const sell = stats.sellVolume ?? 0;
  const total = buy + sell;
  return total > 0 ? total : null;
}
