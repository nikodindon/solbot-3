import { z } from "zod";
import { chunk } from "../utils/math.js";
import type { JupiterClient } from "./client.js";
import { priceV3Schema, type PriceRow } from "./client.js";

const priceResponseSchema = z.record(z.string(), priceV3Schema);

/** Jupiter Price v3 accepte 50 mints par requête. */
export const PRICE_BATCH = 50;

const TTL_MS = 8_000;

export interface PriceOptions {
  /** Contourne le cache TTL (le moteur veut des données fraîches). */
  fresh?: boolean;
}

/**
 * Price API v3 : lots de 50 mints, cache TTL court, débit contrôlé par le client.
 *
 * Les mints absents de la réponse (liquidité insuffisante, prix non fiable)
 * sont simplement omis de la map : le vérificateur d'univers les considère
 * comme non négociables.
 */
export class PriceApi {
  private lastFetchAll = 0;
  private readonly cache = new Map<string, PriceRow>();

  constructor(private readonly client: JupiterClient) {}

  async refresh(mints: string[], opts: PriceOptions = {}): Promise<Map<string, PriceRow>> {
    const now = Date.now();
    if (!opts.fresh && this.cache.size > 0 && now - this.lastFetchAll < TTL_MS) {
      const out = new Map<string, PriceRow>();
      for (const mint of mints) {
        const row = this.cache.get(mint);
        if (row) out.set(mint, row);
      }
      return out;
    }

    const map = new Map<string, PriceRow>();
    for (const part of chunk([...new Set(mints)], PRICE_BATCH)) {
      const raw = await this.client.get("/price/v3", { ids: part.join(",") }, (json) =>
        priceResponseSchema.parse(json),
      );
      for (const [mint, row] of Object.entries(raw)) {
        const price: PriceRow = { mint, ...row };
        map.set(mint, price);
        this.cache.set(mint, price);
      }
    }
    this.lastFetchAll = Date.now();
    return map;
  }

  cached(mint: string): PriceRow | undefined {
    return this.cache.get(mint);
  }

  /** Derniers prix connus — utile pour valoriser entre deux rafraîchissements. */
  cachedAll(mints: string[]): Map<string, PriceRow> {
    const out = new Map<string, PriceRow>();
    for (const mint of mints) {
      const row = this.cache.get(mint);
      if (row) out.set(mint, row);
    }
    return out;
  }
}
