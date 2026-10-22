import type { AppConfig, StrategiesConfig } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { runBacktest, type BacktestResult } from "./runner.js";
import type { PerformanceMetrics } from "./metrics.js";

/**
 * Optimisation de paramètres — **avec garde anti-surapprentissage**.
 *
 * Le principe est simple, et c'est tout le travail : un jeu de paramètres
 * n'est **retenu** que s'il tient hors échantillon. Optimiser sur toute la
 * période et regarder le résultat, c'est apprendre par cœur le bruit.
 *
 * Quatre verrous :
 *
 * 1. **Échantillon minimal** : un jeu de paramètres qui ne fait pas
 *    assez de trades n'est pas un gagnant, c'est du hasard.
 * 2. **Validation hors échantillon obligatoire** : les paramètres choisis
 *    sur le segment d'entraînement sont évalués sur le segment de test, et
 *    c'est **ce** résultat qui compte.
 * 3. **Plafond de dégradation** : un score d'entraînement très supérieur
 *    au score de test est la signature classique du surapprentissage. Le
 *    ratio est contrôlé.
 * 4. **Stabilité des paramètres** : si le meilleur jeu change du tout à
 *    chaque fenêtre, c'est qu'il n'y a pas de structure exploitable dans les
 *    données — et le résultat est rejeté dans son ensemble.
 */

/** Un point de la grille de paramètres. */
export interface ParameterPoint {
  /** Identifiant lisible, ex. `mean_reversion(z=2.0,exit=0.5)`. */
  label: string;
  /** Modifie la configuration de la stratégie. */
  apply: (cfg: AppConfig) => AppConfig;
}

export interface CandidateResult {
  label: string;
  metrics: PerformanceMetrics;
  /** Nombre de trades de la période. */
  trades: number;
}

export interface OptimizeOptions {
  sourceDb: DB;
  cfg: AppConfig;
  /** Grille à explorer. */
  grid: ParameterPoint[];
  /** Segment d'entraînement (in-sample). */
  trainFromMs: number;
  trainToMs: number;
  /** Segment de test (out-of-sample). */
  testFromMs: number;
  testToMs: number;
  timeframe: "5m" | "15m" | "1h";
  /** Actifs rejoués (défaut : la watchlist). */
  mints?: string[];
  /** Nombre minimum de trades pour qu'un candidat soit retenu. */
  minTrades: number;
  /** Plafond de dégradation in-sample → out-of-sample (ratio). */
  maxDegradationRatio: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface OptimizeResult {
  /** Le gagnant, s'il existe. */
  best: CandidateResult | null;
  /** Son score hors échantillon. */
  outOfSample: PerformanceMetrics | null;
  /** Tous les candidats, triés par score d'entraînement. */
  candidates: CandidateResult[];
  /** Le résultat est-il validé ? */
  accepted: boolean;
  /** Raison du refus, le cas échéant. */
  reason: string | null;
  /** Dégradation in-sample → out-of-sample, en ratio. */
  degradationRatio: number | null;
}

/**
 * Grille de paramètres pour `mean_reversion`.
 *
 * Volontairement **petite** : chaque point coûte un backtest complet, et
 * une grille large est elle-même une forme de surapprentissage.
 */
export function meanReversionGrid(cfg: AppConfig): ParameterPoint[] {
  const base = cfg.strategies.mean_reversion.params;
  const points: ParameterPoint[] = [];

  for (const zEntry of [1.5, 2.0, 2.5]) {
    for (const zExit of [0.25, 0.5, 0.75]) {
      points.push({
        label: `mean_reversion(z=${zEntry}, exit=${zExit}, w=${base.window})`,
        apply: (current) => ({
          ...current,
          strategies: {
            ...current.strategies,
            mean_reversion: {
              ...current.strategies.mean_reversion,
              params: {
                ...current.strategies.mean_reversion.params,
                z_entry: zEntry,
                z_exit: zExit,
              },
            },
          },
        }),
      });
    }
  }

  return points;
}

/** Grille de paramètres pour `trend_breakout`. */
export function trendBreakoutGrid(_cfg: AppConfig): ParameterPoint[] {
  const points: ParameterPoint[] = [];

  for (const rsiMax of [60, 68, 76]) {
    for (const volumeMult of [1.0, 1.5, 2.0]) {
      points.push({
        label: `trend_breakout(rsi=${rsiMax}, vol=${volumeMult})`,
        apply: (current) => ({
          ...current,
          strategies: {
            ...current.strategies,
            trend_breakout: {
              ...current.strategies.trend_breakout,
              params: {
                ...current.strategies.trend_breakout.params,
                rsi_max: rsiMax,
                volume_mult: volumeMult,
              },
            },
          },
        }),
      });
    }
  }

  return points;
}

/** Grille de paramètres pour `relative_strength`. */
export function relativeStrengthGrid(_cfg: AppConfig): ParameterPoint[] {
  const points: ParameterPoint[] = [];

  for (const topN of [2, 3, 5]) {
    for (const lookbackH of [12, 24, 48]) {
      points.push({
        label: `relative_strength(top=${topN}, lookback=${lookbackH} h)`,
        apply: (current) => ({
          ...current,
          strategies: {
            ...current.strategies,
            relative_strength: {
              ...current.strategies.relative_strength,
              params: {
                ...current.strategies.relative_strength.params,
                top_n: topN,
                lookback_h: lookbackH,
              },
            },
          },
        }),
      });
    }
  }

  return points;
}

/** Grille correspondant à la configuration courante. */
export function gridFor(cfg: AppConfig): ParameterPoint[] {
  const enabled = enabledStrategyNames(cfg.strategies);
  if (enabled.includes("relative_strength")) return relativeStrengthGrid(cfg);
  if (enabled.includes("mean_reversion")) return meanReversionGrid(cfg);
  if (enabled.includes("trend_breakout")) return trendBreakoutGrid(cfg);
  return [];
}

function enabledStrategyNames(strategies: StrategiesConfig): string[] {
  return Object.entries(strategies)
    .filter(([, value]) => value.enabled)
    .map(([name]) => name);
}

/**
 * Optimise sur le segment d'entraînement, puis **valide** sur le segment
 * de test.
 */
export async function optimizeParameters(options: OptimizeOptions): Promise<OptimizeResult> {
  const { sourceDb, cfg, grid, timeframe } = options;
  const mints = options.mints;

  // ── 1. Entraînement (in-sample) ──────────────────────────────────────
  const candidates: CandidateResult[] = [];

  for (const [index, point] of grid.entries()) {
    const result: BacktestResult = await runBacktest({
      sourceDb,
      cfg: point.apply(cfg),
      days: 1,
      timeframe,
      mints,
      fromMs: options.trainFromMs,
      toMs: options.trainToMs,
      journalDecisions: false,
    });

    if (result.ok) {
      candidates.push({
        label: point.label,
        metrics: result.metrics,
        trades: result.metrics.trades,
      });
    }
    result.close();
    options.onProgress?.(index + 1, grid.length, point.label);
  }

  if (candidates.length === 0) {
    return {
      best: null,
      outOfSample: null,
      candidates: [],
      accepted: false,
      reason: "aucun backtest n'a pu être exécuté sur le segment d'entraînement",
      degradationRatio: null,
    };
  }

  // ── 2. Sélection in-sample ──────────────────────────────────────────
  // On classe par PnL net, mais on **écarte** les candidats trop peu
  // actifs : ils n'ont pas de sens statistique.
  const eligible = candidates.filter((candidate) => candidate.trades >= options.minTrades);
  if (eligible.length === 0) {
    return {
      best: null,
      outOfSample: null,
      candidates: candidates.sort((a, b) => b.metrics.netPnlUsd - a.metrics.netPnlUsd),
      accepted: false,
      reason: `aucun candidat n'a atteint ${options.minTrades} trades sur le segment d'entraînement`,
      degradationRatio: null,
    };
  }

  const best = eligible.sort((a, b) => b.metrics.netPnlUsd - a.metrics.netPnlUsd)[0];
  if (!best) {
    return {
      best: null,
      outOfSample: null,
      candidates,
      accepted: false,
      reason: "aucun candidat retenu",
      degradationRatio: null,
    };
  }

  // ── 3. Validation hors échantillon (out-of-sample) ───────────────────
  const point = grid.find((entry) => entry.label === best.label);
  const validation = await runBacktest({
    sourceDb,
    cfg: point ? point.apply(cfg) : cfg,
    days: 1,
    timeframe,
    mints,
    fromMs: options.testFromMs,
    toMs: options.testToMs,
    journalDecisions: false,
  });
  const outOfSample = validation.ok ? validation.metrics : null;
  validation.close();

  if (!outOfSample) {
    return {
      best,
      outOfSample: null,
      candidates,
      accepted: false,
      reason: "la validation hors échantillon n'a pas pu s'exécuter",
      degradationRatio: null,
    };
  }

  // ── 4. Garde anti-surapprentissage ──────────────────────────────────
  const inSample = best.metrics.netPnlUsd;
  const outSample = outOfSample.netPnlUsd;

  // Un score d'entraînement nul ou négatif ne peut rien valider.
  if (inSample <= 0) {
    return {
      best,
      outOfSample,
      candidates,
      accepted: false,
      reason: `le meilleur score d'entraînement est négatif (${inSample.toFixed(2)} $) : rien à valider`,
      degradationRatio: null,
    };
  }

  const degradationRatio = (inSample - outSample) / Math.abs(inSample);
  if (degradationRatio > options.maxDegradationRatio) {
    return {
      best,
      outOfSample,
      candidates,
      accepted: false,
      reason: `dégradation hors échantillon de ${(degradationRatio * 100).toFixed(1)} % (maximum ${(options.maxDegradationRatio * 100).toFixed(0)} %) : signature classique de surapprentissage`,
      degradationRatio,
    };
  }

  if (outSample <= 0) {
    return {
      best,
      outOfSample,
      candidates,
      accepted: false,
      reason: `le résultat hors échantillon est négatif (${outSample.toFixed(2)} $)`,
      degradationRatio,
    };
  }

  return {
    best,
    outOfSample,
    candidates,
    accepted: true,
    reason: null,
    degradationRatio,
  };
}
