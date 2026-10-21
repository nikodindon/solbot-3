import type { Timeframe } from "../config/schema.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import {
  atr,
  clamp,
  ema,
  emaSeries,
  highestHigh,
  lowestLow,
  median,
  rsi,
  volBpsPerBar,
} from "./indicators.js";
import {
  candlesFor,
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
  type StrategyEval,
} from "./types.js";

/**
 * `trend_breakout` — les cassures de plus hauts sur volume confirmé continuent.
 *
 * Entrée : cassure du plus haut des `breakout_lookback` bougies **hors bougie
 * courante**, EMA haussière, RSI sous le seuil, volume au-dessus de la
 * médiane. Sortie : EMA inverse.
 *
 * Le stop initial est calibré sur l'ATR : un stop fixe serait soit trop
 * serré (sorties en bruit), soit trop large (pertes inutiles).
 */
export interface TrendBreakoutParams {
  emaFast: number;
  emaSlow: number;
  breakoutLookback: number;
  rsiPeriod: number;
  rsiMax: number;
  volumeMult: number;
  atrStopMult: number;
}

export const TREND_BREAKOUT_DEFAULTS: TrendBreakoutParams = {
  emaFast: 12,
  emaSlow: 26,
  breakoutLookback: 20,
  rsiPeriod: 14,
  rsiMax: 68,
  volumeMult: 1.5,
  atrStopMult: 2.0,
};

export class TrendBreakoutStrategy implements Strategy {
  readonly name = "trend_breakout";

  readonly requires: DataRequirement[];

  constructor(
    private readonly params: TrendBreakoutParams = TREND_BREAKOUT_DEFAULTS,
    readonly timeframe: Timeframe = "15m",
  ) {
    this.requires = [{ timeframe, bars: params.emaSlow + 1 }];
  }

  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval {
    const signals: Signal[] = [];
    const notes: string[] = [];
    const p = this.params;

    for (const asset of snapshot.assets) {
      const candles = candlesFor(asset, this.timeframe);
      if (candles.length < p.emaSlow + 1) {
        notes.push(`${asset.symbol} : historique insuffisant (${candles.length} bougies)`);
        continue;
      }

      const closes = candles.map((c) => c.close);
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const volumes = candles.map((c) => c.volumeUsd ?? 0);

      const emaFast = ema(closes, p.emaFast);
      const emaSlow = ema(closes, p.emaSlow);
      const rsiValue = rsi(closes, p.rsiPeriod);
      const atrValue = atr(highs, lows, closes, p.rsiPeriod);

      if (emaFast === null || emaSlow === null || rsiValue === null) {
        notes.push(`${asset.symbol} : indicateurs incomplets`);
        continue;
      }

      const price = asset.priceUsd;
      const position = portfolio.positions.find((pos) => pos.mint === asset.mint);

      // ── Sortie : la tendance s'inverse ────────────────────────────────
      if (position) {
        if (emaFast < emaSlow) {
          signals.push({
            assetMint: asset.mint,
            symbol: asset.symbol,
            side: "sell",
            confidence: 0.6,
            expectedMoveBps: 0,
            ttlMs: 90_000,
            reason: `EMA ${p.emaFast} (${emaFast.toFixed(6)}) croise sous EMA ${p.emaSlow} (${emaSlow.toFixed(6)})`,
          });
        } else {
          notes.push(`${asset.symbol} : position tenue, tendance toujours haussière`);
        }
        continue;
      }

      // ── Entrée ─────────────────────────────────────────────────────────
      const priorHigh = highestHigh(highs, p.breakoutLookback);
      const priorLow = lowestLow(lows, p.breakoutLookback);
      if (priorHigh === null) {
        notes.push(`${asset.symbol} : pas assez de bougies pour le plus haut`);
        continue;
      }

      if (price <= priorHigh) {
        notes.push(
          `${asset.symbol} : pas de cassure (${price.toFixed(6)} ≤ plus haut ${priorHigh.toFixed(6)})`,
        );
        continue;
      }
      if (emaFast <= emaSlow) {
        notes.push(`${asset.symbol} : EMA ${p.emaFast} non haussière`);
        continue;
      }
      if (rsiValue > p.rsiMax) {
        notes.push(`${asset.symbol} : RSI ${rsiValue.toFixed(1)} > ${p.rsiMax} (suracheté)`);
        continue;
      }

      const recentVolumes = volumes.slice(-(p.breakoutLookback + 1), -1);
      const medianVolume = median(recentVolumes);
      const lastVolume = volumes[volumes.length - 1] ?? 0;
      if (medianVolume > 0 && lastVolume < medianVolume * p.volumeMult) {
        notes.push(
          `${asset.symbol} : volume insuffisant (${lastVolume.toFixed(0)} < ${p.volumeMult}×${medianVolume.toFixed(0)})`,
        );
        continue;
      }

      // ── Mouvement attendu ──────────────────────────────────────────────
      // Le mouvement attendu est le **mouvement mesuré** de la cassure : la
      // hauteur de la zone de consolidation projetée depuis la cassure.
      //
      // C'est ce que la cassure peut *réellement* rapporter. La distance à
      // l'EMA lente (utilisée avant) ne veut rien dire comme edge : elle est
      // presque toujours au-dessus du seuil de coût, et le filtre d'edge ne
      // mordait donc jamais — le seuil était mal calibré, pas les signaux.
      //
      // Repli : l'ATR, quand la zone de consolidation est dégénérée.
      const measuredMoveBps =
        priorLow !== null && priorLow > 0 ? ((priorHigh - priorLow) / priorLow) * 10_000 : 0;
      const atrBps = atrValue !== null && price > 0 ? (atrValue / price) * 10_000 : 0;
      const expectedMoveBps = measuredMoveBps > 0 ? measuredMoveBps : atrBps;
      const stopLossPct =
        atrValue !== null && price > 0 ? clamp((p.atrStopMult * atrValue * 100) / price, 1, 50) : 6;

      const gapPct = ((price - priorHigh) / priorHigh) * 100;
      const confidence = clamp(
        0.4 + (gapPct > 0.2 ? 0.15 : 0) + (rsiValue >= 60 ? 0.1 : 0),
        0,
        0.9,
      );

      signals.push({
        assetMint: asset.mint,
        symbol: asset.symbol,
        side: "buy",
        confidence,
        expectedMoveBps,
        ttlMs: 90_000,
        reason: `cassure ${priorHigh.toFixed(6)} (+${gapPct.toFixed(2)} %) avec EMA ${p.emaFast}/${p.emaSlow} haussière, RSI ${rsiValue.toFixed(1)}`,
        stopLossPct,
        tags: ["regime:trending"],
      });
    }

    return { signals, notes };
  }
}

/** Volatilité récente, en bps par bougie — utilisée par d'autres modules. */
export function realizedVolatility(closes: number[], window: number): number | null {
  return volBpsPerBar(closes, window);
}

/** Série d'EMA exposée pour les tests. */
export { emaSeries };
