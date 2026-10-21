import type { Timeframe } from "../config/schema.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import { zScore } from "./indicators.js";
import {
  candlesFor,
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
  type StrategyEval,
} from "./types.js";

/**
 * `mean_reversion` — un écart important à la moyenne revient.
 *
 * Entrée : z-score ≤ −z_entry. Sortie : le z-score revient au-dessus de
 * −z_exit (le prix a rattrapé sa moyenne).
 *
 * L'edge attendu est la **distance restante jusqu'à la moyenne** : c'est
 * exactement ce que la stratégie parie.
 */
export interface MeanReversionParams {
  /** Fenêtre de la moyenne glissante, en bougies. */
  window: number;
  /** Seuil d'entrée (z-score négatif). */
  zEntry: number;
  /** Seuil de sortie (z-score). */
  zExit: number;
}

export const MEAN_REVERSION_DEFAULTS: MeanReversionParams = {
  window: 96,
  zEntry: 2.0,
  zExit: 0.5,
};

export class MeanReversionStrategy implements Strategy {
  readonly name = "mean_reversion";

  readonly requires: DataRequirement[];

  constructor(
    private readonly params: MeanReversionParams = MEAN_REVERSION_DEFAULTS,
    readonly timeframe: Timeframe = "15m",
  ) {
    this.requires = [{ timeframe, bars: params.window }];
  }

  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval {
    const signals: Signal[] = [];
    const notes: string[] = [];
    const p = this.params;

    for (const asset of snapshot.assets) {
      const candles = candlesFor(asset, this.timeframe);
      if (candles.length < p.window) {
        notes.push(`${asset.symbol} : historique insuffisant (${candles.length}/${p.window})`);
        continue;
      }

      const closes = candles.map((c) => c.close);
      const z = zScore(closes, p.window);
      if (z === null) {
        notes.push(`${asset.symbol} : z-score indisponible`);
        continue;
      }

      const price = asset.priceUsd;
      const mean = closes.slice(-p.window).reduce((sum, c) => sum + c, 0) / p.window;
      const position = portfolio.positions.find((pos) => pos.mint === asset.mint);

      // ── Sortie : le prix a rattrapé la moyenne ─────────────────────────
      if (position) {
        if (z >= -p.zExit) {
          signals.push({
            assetMint: asset.mint,
            symbol: asset.symbol,
            side: "sell",
            confidence: 0.65,
            expectedMoveBps: 0,
            ttlMs: 90_000,
            reason: `z-score ${z.toFixed(2)} revenu au-dessus de ${(-p.zExit).toFixed(2)} (moyenne rattrapée)`,
          });
        } else {
          notes.push(`${asset.symbol} : position tenue, z-score ${z.toFixed(2)} encore enfoncé`);
        }
        continue;
      }

      // ── Entrée : écart important à la moyenne ──────────────────────────
      if (z > -p.zEntry) {
        notes.push(
          `${asset.symbol} : z-score ${z.toFixed(2)} > seuil d'entrée ${(-p.zEntry).toFixed(2)}`,
        );
        continue;
      }

      // Edge = distance restante jusqu'à la moyenne.
      const expectedMoveBps = mean > 0 ? ((mean - price) / price) * 10_000 : 0;
      const sigma = mean > 0 ? (mean - price) / (z || 1) : 0;
      const stopLossPct =
        price > 0 ? Math.min(50, Math.max(1, ((p.zEntry * sigma * 100) / price) * -1)) : 5;

      signals.push({
        assetMint: asset.mint,
        symbol: asset.symbol,
        side: "buy",
        confidence: Math.min(0.85, 0.4 + 0.12 * Math.min(3, Math.abs(z) - p.zEntry)),
        expectedMoveBps,
        ttlMs: 90_000,
        reason: `z-score ${z.toFixed(2)} ≤ ${(-p.zEntry).toFixed(2)} — écart de ${((100 * (price - mean)) / mean).toFixed(2)} % à la moyenne ${mean.toFixed(6)}`,
        stopLossPct,
        tags: ["regime:ranging"],
      });
    }

    return { signals, notes };
  }
}
