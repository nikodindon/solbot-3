import type { Timeframe } from "../config/schema.js";
import type { Candle, PriceTick } from "../state/market-data.js";

/**
 * Agrégation OHLCV interne.
 *
 * Jupiter ne fournit pas d'historique de prix : on reconstruit les bougies à
 * partir des ticks collectés. Chaque tick produit une bougie « dégénérée »
 * (open = high = low = close = prix), que l'upsert SQL fusionne ensuite :
 * `open` reste le premier tick du seau, `high`/`low` s'élargissent, `close`
 * devient le dernier.
 *
 * Limite assumée et documentée (README §9.5) : le volume par bougie est une
 * **approximation**, déduite de la variation du volume 24 h entre deux polls.
 */

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

export const ALL_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h"];

export function tfMs(tf: Timeframe): number {
  return TIMEFRAME_MS[tf];
}

/** Début du seau temporel contenant `ts`. */
export function bucketStart(ts: number, tf: Timeframe): number {
  const step = TIMEFRAME_MS[tf];
  return Math.floor(ts / step) * step;
}

/**
 * Convertit des ticks en mises à jour de bougies (une par timeframe).
 *
 * Les ticks doivent être triés par ordre chronologique pour que le volume
 * soit imputé au bon seau.
 */
export function ticksToCandleUpdates(
  ticks: PriceTick[],
  timeframes: Timeframe[] = ALL_TIMEFRAMES,
): Candle[] {
  const out: Candle[] = [];
  for (const tick of ticks) {
    for (const tf of timeframes) {
      out.push({
        mint: tick.mint,
        tf,
        ts: bucketStart(tick.tsMs, tf),
        open: tick.priceUsd,
        high: tick.priceUsd,
        low: tick.priceUsd,
        close: tick.priceUsd,
        volumeUsd: tick.volumeDeltaUsd ?? 0,
        ticks: 1,
      });
    }
  }
  return out;
}

/**
 * Une bougie est *clôturée* quand la fin de son seau est atteinte.
 * Une bougie en cours ne doit jamais servir à une décision.
 */
export function isClosed(candleTs: number, tf: Timeframe, nowMs: number): boolean {
  return candleTs + TIMEFRAME_MS[tf] <= nowMs;
}
