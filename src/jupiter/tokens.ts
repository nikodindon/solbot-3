import { z } from "zod";
import type { JupiterClient } from "./client.js";

/**
 * Tokens API v2 — découverte de l'univers et vérification à chaud
 * (vérifié, décimales, liquidité, âge du pool).
 */

const tokenSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string().optional(),
  decimals: z.number(),
  isVerified: z.boolean().optional(),
  liquidity: z.number().optional(),
  usdPrice: z.number().optional(),
  organicScore: z.number().optional(),
  firstPool: z.object({ id: z.string(), createdAt: z.string().optional() }).nullish(),
  stats24h: z
    .object({ buyVolume: z.number().optional(), sellVolume: z.number().optional() })
    .optional(),
  tags: z.array(z.string()).optional(),
});

const tokenSearchSchema = z.array(tokenSchema);

export interface TokenInfo {
  mint: string;
  symbol: string;
  name?: string;
  decimals: number;
  isVerified: boolean;
  liquidity?: number;
  usdPrice?: number;
  organicScore?: number;
  poolCreatedMs: number | null;
  stats24h?: { buyVolume: number; sellVolume: number };
  tags?: string[];
}

export class TokensApi {
  constructor(private readonly client: JupiterClient) {}

  /** Recherche par mints (liste séparée par des virgules) ou par symbole. */
  async search(query: string): Promise<TokenInfo[]> {
    const raw = await this.client.get("/tokens/v2/search", { query }, (json) =>
      tokenSearchSchema.parse(json),
    );
    return raw.map(toTokenInfo);
  }

  /** Recherche par mints, par lots de 10 (limite de l'API). */
  async searchMints(mints: string[]): Promise<Map<string, TokenInfo>> {
    const out = new Map<string, TokenInfo>();
    for (let i = 0; i < mints.length; i += 10) {
      const batch = mints.slice(i, i + 10);
      const found = await this.search(batch.join(","));
      for (const token of found) out.set(token.mint, token);
    }
    return out;
  }
}

function toTokenInfo(token: z.infer<typeof tokenSchema>): TokenInfo {
  let poolCreatedMs: number | null = null;
  if (token.firstPool?.createdAt) {
    const parsed = Date.parse(token.firstPool.createdAt);
    if (Number.isFinite(parsed)) poolCreatedMs = parsed;
  }
  return {
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    isVerified: token.isVerified === true,
    liquidity: token.liquidity,
    usdPrice: token.usdPrice,
    organicScore: token.organicScore,
    poolCreatedMs,
    stats24h: token.stats24h
      ? {
          buyVolume: token.stats24h.buyVolume ?? 0,
          sellVolume: token.stats24h.sellVolume ?? 0,
        }
      : undefined,
    tags: token.tags,
  };
}
