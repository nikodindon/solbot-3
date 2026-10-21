import type { Timeframe } from "../config/schema.js";
import type { ImportedCandle } from "../state/imported-candles.js";

/**
 * Détection de régime de marché.
 *
 * Trois régimes, et surtout **un quatrième implicite** : ne rien faire.
 *
 * - `trending` : le prix s'est déplacé dans un sens sur la fenêtre — les
 *   stratégies de tendance ont un setup ;
 * - `ranging`  : le prix a bougé mais reste dans une fourchette étroite —
 *   les stratégies de retour à la moyenne ont un setup ;
 * - `idle`     : le prix a bougé *sans* direction et *hors* d'une fourchette
 *   étroite : aucun setup, on ne trade pas.
 *
 * « Ne rien faire » est une **décision valide et fréquente**. La distinction
 * explicitement vaut mieux que de forcer un signal sur un marché sans
 * qualité.
 */

export type Regime = "trending" | "ranging" | "idle";

export interface RegimeConfig {
  timeframe: Timeframe;
  /** Fenêtre d'observation, en bougies clôturées. */
  window: number;
  /** Variation minimale (en %) pour qualifier le marché de tendance. */
  trendThresholdPct: number;
  /** Amplitude maximale (en %) pour qualifier le marché de range. */
  rangeMaxPct: number;
}

export interface RegimeResult {
  regime: Regime;
  /** Variation signée sur la fenêtre, en %. */
  variationPct: number;
  /** Amplitude (plus haut − plus bas) sur la fenêtre, en %. */
  amplitudePct: number;
  /** La tendance est-elle haussière ? */
  direction: "up" | "down" | "none";
  /** Raison de la classification, journalisée telle quelle. */
  reason: string;
}

/** Nombre de bougies clôturées minimales pour classifier un régime. */
export const MIN_REGIME_BARS = 12;

/**
 * Classe le régime d'un actif à partir de ses bougies clôturées.
 *
 * Fonction **pure et déterministe** : mêmes bougies, même verdict. C'est ce
 * qui permet de la tester sur des séries synthétiques.
 */
export function classifyRegime(candles: ImportedCandle[], cfg: RegimeConfig): RegimeResult {
  if (candles.length < MIN_REGIME_BARS) {
    return {
      regime: "idle",
      variationPct: 0,
      amplitudePct: 0,
      direction: "none",
      reason: `historique insuffisant (${candles.length} bougies)`,
    };
  }

  const window = candles.slice(-cfg.window);
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last || first.close <= 0) {
    return {
      regime: "idle",
      variationPct: 0,
      amplitudePct: 0,
      direction: "none",
      reason: "série de prix inexploitable",
    };
  }

  const variationPct = ((last.close - first.close) / first.close) * 100;

  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const amplitudePct = minLow > 0 ? ((maxHigh - minLow) / minLow) * 100 : 0;

  const direction: "up" | "down" | "none" =
    variationPct > 0 ? "up" : variationPct < 0 ? "down" : "none";

  if (Math.abs(variationPct) >= cfg.trendThresholdPct) {
    return {
      regime: "trending",
      variationPct,
      amplitudePct,
      direction: direction === "none" ? "up" : direction,
      reason: `variation ${variationPct >= 0 ? "+" : ""}${variationPct.toFixed(2)} % sur ${window.length} bougies ≥ ${cfg.trendThresholdPct} %`,
    };
  }

  if (amplitudePct <= cfg.rangeMaxPct) {
    return {
      regime: "ranging",
      variationPct,
      amplitudePct,
      direction: "none",
      reason: `amplitude ${amplitudePct.toFixed(2)} % ≤ ${cfg.rangeMaxPct} %`,
    };
  }

  return {
    regime: "idle",
    variationPct,
    amplitudePct,
    direction: "none",
    reason: `variation ${variationPct.toFixed(2)} % sans direction et amplitude ${amplitudePct.toFixed(2)} % > ${cfg.rangeMaxPct} % — aucun setup`,
  };
}
