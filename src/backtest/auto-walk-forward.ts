import type { AppConfig } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { optimizeParameters, type OptimizeResult, type ParameterPoint } from "./optimizer.js";
import type { PerformanceMetrics } from "./metrics.js";

/**
 * Walk-forward **automatisé**.
 *
 * Pour chaque fenêtre de marché :
 * 1. on optimise les paramètres sur la **première moitié** (entraînement) ;
 * 2. on évalue le gagnant sur la **seconde moitié** (test) ;
 * 3. on n'accumule que le résultat **hors échantillon**.
 *
 * Le rapport final présente donc le PnL hors échantillon **agrégé** — pas le
 * meilleur score d'entraînement, qui serait une illusion.
 *
 * Un garde supplémentaire : si le jeu de paramètres gagnant change
 * complètement d'une fenêtre à l'autre, c'est qu'il n'y a pas de structure
 * stable dans les données, et l'ensemble de la validation est rejeté.
 */

export interface AutoWalkForwardOptions {
  sourceDb: DB;
  cfg: AppConfig;
  /** Profondeur historique, en jours. */
  days: number;
  /** Nombre de fenêtres. */
  windows: number;
  timeframe: "5m" | "15m" | "1h";
  grid: ParameterPoint[];
  /** Actifs rejoués (défaut : la watchlist). */
  mints?: string[];
  /** Nombre minimum de trades pour qu'un candidat soit retenu. */
  minTrades?: number;
  /** Plafond de dégradation in-sample → out-of-sample. */
  maxDegradationRatio?: number;
  /**
   * Fraction minimale de fenêtres qui doivent être validées.
   *
   * Sans ce seuil, **une seule** fenêtre fortunate suffirait à valider
   * l'ensemble — c'est-à-dire à valider du bruit.
   */
  minAcceptedWindowRatio?: number;
  /** Nombre minimal de trades hors échantillon pour valider. */
  minOutOfSampleTrades?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface AutoWindowResult {
  index: number;
  trainFromMs: number;
  trainToMs: number;
  testFromMs: number;
  testToMs: number;
  /** Paramètres retenus sur la fenêtre d'entraînement. */
  chosen: string | null;
  /** Résultat hors échantillon. */
  outOfSample: PerformanceMetrics | null;
  /** Diagnostic de l'optimisation. */
  optimization: OptimizeResult;
  /** La fenêtre est-elle validée ? */
  accepted: boolean;
  reason: string | null;
}

export interface AutoWalkForwardResult {
  windows: AutoWindowResult[];
  /** PnL hors échantillon agrégé. */
  aggregatePnlUsd: number;
  aggregateTrades: number;
  /** Fenêtres validées. */
  acceptedWindows: number;
  /** Les paramètres retenus étaient-ils stables ? */
  stable: boolean;
  /** Verdict global. */
  conclusive: boolean;
  reason: string | null;
}

export async function runAutoWalkForward(
  options: AutoWalkForwardOptions,
): Promise<AutoWalkForwardResult> {
  const { sourceDb, cfg, days, windows, timeframe, grid } = options;
  const minTrades = options.minTrades ?? 5;
  const maxDegradationRatio = options.maxDegradationRatio ?? 0.5;

  const toMs = Date.now();
  const fromMs = toMs - days * 86_400_000;
  const windowMs = (toMs - fromMs) / windows;

  const results: AutoWindowResult[] = [];
  let aggregatePnlUsd = 0;
  let aggregateTrades = 0;
  let acceptedWindows = 0;

  for (let index = 0; index < windows; index++) {
    const windowFrom = fromMs + index * windowMs;
    const windowTo = index === windows - 1 ? toMs : fromMs + (index + 1) * windowMs;
    const trainTo = windowFrom + (windowTo - windowFrom) / 2;

    const optimization = await optimizeParameters({
      sourceDb,
      cfg,
      grid,
      trainFromMs: windowFrom,
      trainToMs: trainTo,
      testFromMs: trainTo,
      testToMs: windowTo,
      timeframe,
      mints: options.mints,
      minTrades,
      maxDegradationRatio,
      onProgress: options.onProgress,
    });

    const accepted = optimization.accepted;
    if (accepted && optimization.outOfSample) {
      aggregatePnlUsd += optimization.outOfSample.netPnlUsd;
      aggregateTrades += optimization.outOfSample.trades;
      acceptedWindows += 1;
    }

    results.push({
      index: index + 1,
      trainFromMs: windowFrom,
      trainToMs: trainTo,
      testFromMs: trainTo,
      testToMs: windowTo,
      chosen: optimization.best?.label ?? null,
      outOfSample: optimization.outOfSample,
      optimization,
      accepted,
      reason: optimization.reason,
    });
  }

  // ── Stabilité des paramètres ────────────────────────────────────────
  const chosen = results
    .map((window) => window.chosen)
    .filter((label): label is string => label !== null);
  const distinct = new Set(chosen);
  const stable = distinct.size <= Math.max(1, Math.ceil(windows / 2));

  let conclusive = false;
  let reason: string | null = null;

  const minAcceptedWindowRatio = options.minAcceptedWindowRatio ?? 0.5;
  const minOutOfSampleTrades = options.minOutOfSampleTrades ?? 10;

  if (chosen.length === 0) {
    reason = "aucune fenêtre n'a pu être optimisée";
  } else if (!stable) {
    reason = `les paramètres retenus changent d'une fenêtre à l'autre (${distinct.size} jeux différents sur ${windows} fenêtres) : il n'y a pas de structure stable dans les données`;
  } else if (acceptedWindows === 0) {
    reason = "aucune fenêtre n'a passé la validation hors échantillon";
  } else if (acceptedWindows / windows < minAcceptedWindowRatio) {
    reason = `seulement ${acceptedWindows}/${windows} fenêtres ont été validées (minimum ${Math.ceil(windows * minAcceptedWindowRatio)}) : une fenêtre fortunate ne valide pas une configuration`;
  } else if (aggregateTrades < minOutOfSampleTrades) {
    reason = `seulement ${aggregateTrades} trade(s) hors échantillon (minimum ${minOutOfSampleTrades}) : l'échantillon est trop mince pour conclure`;
  } else if (aggregatePnlUsd <= 0) {
    reason = `le PnL hors échantillon agrégé est négatif (${aggregatePnlUsd.toFixed(2)} $)`;
  } else {
    conclusive = true;
  }

  return {
    windows: results,
    aggregatePnlUsd,
    aggregateTrades,
    acceptedWindows,
    stable,
    conclusive,
    reason,
  };
}
