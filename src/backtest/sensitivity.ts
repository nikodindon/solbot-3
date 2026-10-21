import type { AppConfig, Timeframe } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { runBacktest } from "./runner.js";
import type { PerformanceMetrics } from "./metrics.js";

/**
 * Sensibilité aux coûts.
 *
 * Un backtest qui ne survit pas à une hausse des coûts ne survivra pas au
 * slippage réel. Le garde-fou live exige (README §9.3) que le PnL ne chute
 * pas de plus de `guard.max_cost_sensitivity_drop_pct` quand les coûts
 * augmentent de 50 %.
 */

export interface SensitivityPoint {
  multiplier: number;
  netPnlUsd: number;
  netPnlPct: number | null;
  trades: number;
  feesUsd: number;
}

export interface SensitivityResult {
  points: SensitivityPoint[];
  /** Variation du PnL entre la référence (×1) et ×1,5, en %. */
  dropAt1_5Pct: number | null;
  /** Variation du PnL entre la référence (×1) et ×2, en %. */
  dropAt2Pct: number | null;
  /** La sensibilité est-elle acceptable ? */
  acceptable: boolean;
  reason: string | null;
}

export interface SensitivityOptions {
  sourceDb: DB;
  cfg: AppConfig;
  days: number;
  timeframe: Timeframe;
  initialUsdc?: number;
  mints?: string[];
  /** Multiplicateurs testés (défaut : 1, 1,5 et 2). */
  multipliers?: number[];
}

export async function runSensitivity(options: SensitivityOptions): Promise<SensitivityResult> {
  const multipliers = options.multipliers ?? [1, 1.5, 2];
  const points: SensitivityPoint[] = [];

  for (const multiplier of multipliers) {
    const result = await runBacktest({
      sourceDb: options.sourceDb,
      cfg: options.cfg,
      days: options.days,
      timeframe: options.timeframe,
      initialUsdc: options.initialUsdc,
      mints: options.mints,
      costMultiplier: multiplier,
    });

    if (result.ok) {
      points.push({
        multiplier,
        netPnlUsd: result.metrics.netPnlUsd,
        netPnlPct: result.metrics.netPnlPct,
        trades: result.metrics.trades,
        feesUsd: result.metrics.feesUsd,
      });
    }
    result.close();
  }

  const reference = points.find((p) => p.multiplier === 1);
  const at1_5 = points.find((p) => p.multiplier === 1.5);
  const at2 = points.find((p) => p.multiplier === 2);

  /**
   * Dégradation entre la référence (×1) et un coût supérieur.
   *
   * ⚠ La dégradation n'a de sens que si la référence est **positive**. Sur
   * une stratégie déjà perdante, « -189 % » ne veut rien dire : le run est
   * déjà non concluant, et c'est la conclusion qui compte.
   */
  const drop = (point: SensitivityPoint | undefined): number | null => {
    if (!reference || !point) return null;
    if (reference.netPnlUsd <= 0) return null;
    return ((point.netPnlUsd - reference.netPnlUsd) / reference.netPnlUsd) * 100;
  };

  const dropAt1_5Pct = drop(at1_5);
  const dropAt2Pct = drop(at2);
  const maxDrop = options.cfg.guard.max_cost_sensitivity_drop_pct;

  let acceptable = true;
  let reason: string | null = null;

  if (reference && reference.netPnlUsd <= 0) {
    reason = `sans objet : le PnL de référence est négatif (${reference.netPnlUsd.toFixed(2)} $)`;
  } else if (dropAt1_5Pct !== null && dropAt1_5Pct < -maxDrop) {
    acceptable = false;
    reason = `le PnL chute de ${Math.abs(dropAt1_5Pct).toFixed(1)} % à ×1,5 (max ${maxDrop} %)`;
  }

  return { points, dropAt1_5Pct, dropAt2Pct, acceptable, reason };
}

/** Métriques d'un run, pour l'affichage. */
export type RunMetrics = PerformanceMetrics;
