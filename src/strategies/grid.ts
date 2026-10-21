import type { Timeframe } from "../config/schema.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import {
  candlesFor,
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
  type StrategyEval,
} from "./types.js";

/**
 * `grid` — un actif oscille dans une fourchette.
 *
 * L'ancre est la moyenne glissante. On achète par paliers sous l'ancre
 * (`step_pct` × niveau) et on sort au retour à l'ancre.
 *
 * Contrairement à `mean_reversion`, la grille **accumule** : chaque palier
 * franchi ajoute à la position (`allowAdd`). C'est le comportement qui la
 * distingue, et la raison pour laquelle elle est désactivée par défaut.
 */
export interface GridParams {
  /** Écart d'un palier, en %. */
  stepPct: number;
  /** Nombre maximal de paliers. */
  levels: number;
}

export const GRID_DEFAULTS: GridParams = {
  stepPct: 1.0,
  levels: 5,
};

export class GridStrategy implements Strategy {
  readonly name = "grid";

  readonly requires: DataRequirement[];

  constructor(
    private readonly params: GridParams = GRID_DEFAULTS,
    readonly timeframe: Timeframe = "15m",
    private readonly anchorWindow = 96,
  ) {
    this.requires = [{ timeframe, bars: anchorWindow }];
  }

  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval {
    const signals: Signal[] = [];
    const notes: string[] = [];
    const p = this.params;

    for (const asset of snapshot.assets) {
      const candles = candlesFor(asset, this.timeframe);
      if (candles.length < this.anchorWindow) {
        notes.push(`${asset.symbol} : historique insuffisant pour l'ancre`);
        continue;
      }

      const closes = candles.map((c) => c.close);
      const anchor =
        closes.slice(-this.anchorWindow).reduce((sum, c) => sum + c, 0) / this.anchorWindow;
      const price = asset.priceUsd;
      const position = portfolio.positions.find((pos) => pos.mint === asset.mint);

      if (position) {
        if (price >= anchor) {
          signals.push({
            assetMint: asset.mint,
            symbol: asset.symbol,
            side: "sell",
            confidence: 0.6,
            expectedMoveBps: 0,
            ttlMs: 90_000,
            reason: `retour à l'ancre (${price.toFixed(6)} ≥ ${anchor.toFixed(6)})`,
          });
        } else {
          notes.push(
            `${asset.symbol} : position tenue, ${price.toFixed(6)} sous l'ancre ${anchor.toFixed(6)}`,
          );
        }
        continue;
      }

      // Palier atteint : depth = nombre de paliers franchis sous l'ancre.
      const depthPct = ((anchor - price) / anchor) * 100;
      const depth = Math.floor(depthPct / p.stepPct);
      if (depth < 1) {
        notes.push(
          `${asset.symbol} : aucun palier franchi (${depthPct.toFixed(2)} % sous l'ancre)`,
        );
        continue;
      }
      if (depth > p.levels) {
        notes.push(`${asset.symbol} : au-delà de la grille (${depth} paliers > ${p.levels})`);
        continue;
      }

      signals.push({
        assetMint: asset.mint,
        symbol: asset.symbol,
        side: "buy",
        confidence: Math.min(0.8, 0.35 + 0.1 * depth),
        expectedMoveBps: (depthPct / 100) * 10_000,
        ttlMs: 90_000,
        reason: `palier ${depth} de la grille franchi (${depthPct.toFixed(2)} % sous l'ancre ${anchor.toFixed(6)})`,
        stopLossPct: p.levels * p.stepPct + 0.5,
        allowAdd: true,
        tags: ["regime:ranging"],
      });
    }

    return { signals, notes };
  }
}
