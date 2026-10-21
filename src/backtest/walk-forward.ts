import type { AppConfig, Timeframe } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { runBacktest, type BacktestResult } from "./runner.js";
import type { PerformanceMetrics } from "./metrics.js";

/**
 * Walk-forward :validation par fenêtres glissantes.
 *
 * Le README est explicite (§9.4) : « le rapport présente le PnL
 * out-of-sample **agrégé**, pas le meilleur PnL in-sample ». Une stratégie
 * qui gagne sur une seule fenêtre n'est pas validée.
 *
 * En phase 2, les paramètres sont **fixes** : le walk-forward mesure donc la
 * performance hors échantillon de la configuration courante sur N segments
 * de marché distincts. L'optimisation automatique des paramètres (avec garde
 * anti-surapprentissage) arrive en phase 7.
 */

export interface WalkForwardOptions {
  sourceDb: DB;
  cfg: AppConfig;
  days: number;
  windows: number;
  timeframe: Timeframe;
  initialUsdc?: number;
  mints?: string[];
  onProgress?: (done: number, total: number) => void;
}

export interface WindowResult {
  index: number;
  fromMs: number;
  toMs: number;
  days: number;
  metrics: PerformanceMetrics;
}

export interface WalkForwardResult {
  windows: WindowResult[];
  /** Métriques agrégées sur l'ensemble des fenêtres hors échantillon. */
  aggregate: PerformanceMetrics;
  /** Nombre de fenêtres-ES profitable. */
  profitableWindows: number;
}

export async function runWalkForward(options: WalkForwardOptions): Promise<WalkForwardResult> {
  const { sourceDb, cfg, days, windows, timeframe } = options;
  if (windows < 1) throw new Error("walk-forward : il faut au moins une fenêtre");

  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 3_600_000;
  const windowMs = (toMs - fromMs) / windows;

  const results: WindowResult[] = [];
  const equities: { tsMs: number; navUsd: number }[] = [];
  let totalPnl = 0;
  let totalFees = 0;
  let totalTrades = 0;
  let initialNav = 0;
  let finalNav = 0;

  for (let index = 0; index < windows; index++) {
    const windowFrom = fromMs + index * windowMs;
    const windowTo = index === windows - 1 ? toMs : fromMs + (index + 1) * windowMs;

    const result: BacktestResult = await runBacktest({
      sourceDb,
      cfg,
      days,
      timeframe,
      initialUsdc: options.initialUsdc,
      mints: options.mints,
      fromMs: windowFrom,
      toMs: windowTo,
    });

    if (!result.ok) {
      result.close();
      continue;
    }

    const windowDays = (windowTo - windowFrom) / 86_400_000;
    results.push({
      index: index + 1,
      fromMs: windowFrom,
      toMs: windowTo,
      days: windowDays,
      metrics: result.metrics,
    });

    // Agrégation : on additionne les PnL des fenêtres disjointes.
    totalPnl += result.metrics.netPnlUsd;
    totalFees += result.metrics.feesUsd;
    totalTrades += result.metrics.trades;
    if (index === 0) initialNav = result.metrics.initialNavUsd;
    finalNav = result.metrics.finalNavUsd;

    for (const point of result.equity) {
      equities.push({ tsMs: point.tsMs, navUsd: point.navUsd });
    }

    result.close();
    options.onProgress?.(index + 1, windows);
  }

  const profitableWindows = results.filter((w) => w.metrics.netPnlUsd > 0).length;

  return {
    windows: results,
    aggregate: {
      ...(results[0]?.metrics ?? ({} as PerformanceMetrics)),
      initialNavUsd: initialNav,
      finalNavUsd: finalNav,
      netPnlUsd: totalPnl,
      netPnlPct: initialNav > 0 ? (totalPnl / initialNav) * 100 : null,
      trades: totalTrades,
      feesUsd: totalFees,
      winRatePct: null,
      profitFactor: null,
      sharpe: null,
      maxDrawdownPct: null,
      days: (toMs - fromMs) / 86_400_000,
    },
    profitableWindows,
  };
}
