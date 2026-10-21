import type { Timeframe } from "../config/schema.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";
import type { TokenInfo } from "../jupiter/tokens.js";
import {
  insertTicks,
  knownVolumes24h,
  latestDiscoveryTick,
  listWatchlistMints,
  upsertCandles,
  upsertTokenMeta,
  type PriceTick,
} from "../state/market-data.js";
import type { DB } from "../state/db.js";
import { messageOf } from "../utils/errors.js";
import { ticksToCandleUpdates } from "./ohlcv.js";

/**
 * Collecte des prix et reconstruit les bougies.
 *
 * Un tick de collecte = 2 appels API pour toute la watchlist :
 * - Price v3 (lots de 50 mints) → prix et liquidité ;
 * - Tokens v2 (recherche par lots) → volume 24 h et métadonnées.
 *
 * Le volume est **optionnel** : son absence ne doit pas empêcher la collecte
 * des prix (le filtre de volume d'une stratégie sera simplement inopérant).
 */

export interface PolledPrice {
  mint: string;
  priceUsd: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  decimals: number | null;
}

export interface PollResult {
  ok: boolean;
  prices: Map<string, PolledPrice>;
  /** Le volume 24 h a-t-il pu être récupéré ? */
  volumesKnown: boolean;
  /** Nombre de bougies mises à jour. */
  candles: number;
  error?: string;
}

/**
 * Interface d'accès au marché — le *seam* que le moteur consommera.
 * Le backtest injectera une implémentation based sur l'historique.
 */
export interface MarketSource {
  pollOnce(tsMs: number): Promise<PollResult>;
}

/**
 * Interfaces d'accès aux données de marché.
 *
 * Le `Poller` ne dépend que de ces deux contrats : les implémentations
 * réelles (Price v3, Tokens v2) sont injectables, donc testables sans réseau.
 */
export interface PriceFetcher {
  refresh(
    mints: string[],
    opts?: { fresh?: boolean },
  ): Promise<Map<string, { mint: string; usdPrice: number; liquidity?: number }>>;
}

export interface TokenFetcher {
  searchMints(mints: string[]): Promise<Map<string, TokenInfo>>;
}

export interface PollerDeps {
  db: DB;
  priceApi: PriceFetcher;
  tokensApi: TokenFetcher;
  /** Timeframes agrégés à chaque tick. */
  timeframes: Timeframe[];
}

export class Poller implements MarketSource {
  constructor(private readonly deps: PollerDeps) {}

  /** Mints à suivre : la watchlist, plus les deux actifs de base. */
  mints(): string[] {
    const watchlist = listWatchlistMints(this.deps.db);
    const mints = new Set<string>(watchlist);
    mints.add(SOL_MINT);
    mints.add(USDC_MINT);
    return [...mints];
  }

  async pollOnce(tsMs: number = Date.now()): Promise<PollResult> {
    const mints = this.mints();

    let prices: Map<string, { mint: string; usdPrice: number; liquidity?: number }>;
    try {
      prices = await this.deps.priceApi.refresh(mints, { fresh: true });
    } catch (error) {
      return {
        ok: false,
        prices: new Map(),
        volumesKnown: false,
        candles: 0,
        error: `price v3 : ${messageOf(error)}`,
      };
    }

    if (prices.size === 0) {
      return {
        ok: false,
        prices: new Map(),
        volumesKnown: false,
        candles: 0,
        error: "price v3 a renvoyé aucun prix",
      };
    }

    // Les métadonnées (volume, décimales, âge) sont un bonus : leur échec
    // ne doit pas faire perdre le tick.
    let tokens = new Map<string, TokenInfo>();
    let volumesKnown = false;
    try {
      tokens = await this.deps.tokensApi.searchMints(mints);
      volumesKnown = true;
    } catch {
      // On continue sans volume : les prix restent exploitables.
    }

    // Volume *écoulé* = variation du volume 24 h depuis le tick précédent.
    const previousVolumes = knownVolumes24h(this.deps.db, [...prices.keys()]);

    const ticks: PriceTick[] = [];
    const polled: PolledPrice[] = [];
    for (const [mint, row] of prices) {
      const token = tokens.get(mint);
      const volume24h = token?.volume24hUsd ?? null;
      const previous = previousVolumes.get(mint);
      const volumeDelta =
        volume24h !== null && previous !== undefined ? Math.max(0, volume24h - previous) : null;

      ticks.push({
        tsMs,
        mint,
        priceUsd: row.usdPrice,
        liquidityUsd: row.liquidity ?? token?.liquidityUsd ?? null,
        volumeDeltaUsd: volumeDelta,
        src: "discovery",
      });

      polled.push({
        mint,
        priceUsd: row.usdPrice,
        liquidityUsd: row.liquidity ?? token?.liquidityUsd ?? null,
        volume24hUsd: volume24h,
        decimals: token?.decimals ?? null,
      });
    }

    insertTicks(this.deps.db, ticks);
    const candles = upsertCandles(this.deps.db, ticksToCandleUpdates(ticks, this.deps.timeframes));

    // On enregistre les métadonnées **après** avoir calculé les deltas :
    // la valeur stockée sert de référence au tick suivant.
    const metas = [...tokens.values()];
    upsertTokenMeta(this.deps.db, metas, tsMs);

    return {
      ok: true,
      prices: new Map(polled.map((p) => [p.mint, p])),
      volumesKnown,
      candles,
    };
  }

  /**
   * Dernier prix fiable connu d'un mint (origine `discovery`, donc adossé à
   * une liquidité réelle). Utilisé pour valoriser hors cycle de collecte.
   */
  lastReliablePrice(mint: string): number | null {
    const tick = latestDiscoveryTick(this.deps.db, mint);
    return tick ? tick.priceUsd : null;
  }
}
