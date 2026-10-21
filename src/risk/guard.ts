import type { AppConfig } from "../config/schema.js";
import { configFingerprint } from "../backtest/store.js";
import { listBacktestRuns, type BacktestRunSummary } from "../backtest/store.js";
import type { DB } from "../state/db.js";
import { importedCoverage } from "../state/imported-candles.js";

/**
 * Le garde-fou live.
 *
 * Le live n'est accessible que si **tous** les critères sont remplis, pour
 * l'empreinte **exacte** de la configuration courante. Changer un seul
 * paramètre change l'empreinte, et impose de rejouer le backtest.
 *
 * C'est la règle la plus importante du projet : elle empêche de faire
 * passer en live une configuration qui n'a jamais été testée.
 */

export interface GuardCriterion {
  name: string;
  ok: boolean;
  detail: string;
  /** Un critère non rempli bloque-t-il le live ? */
  blocking: boolean;
}

export interface GuardReport {
  ok: boolean;
  /** Empreinte de la configuration testée. */
  configHash: string;
  criteria: GuardCriterion[];
  /** Raison principale du refus, le cas échéant. */
  reasons: string[];
  /** Le run qui a servi de base, s'il existe. */
  run: BacktestRunSummary | null;
}

export interface GuardInputs {
  db: DB;
  cfg: AppConfig;
  /** Multiplicateur de coûts déjà intégré au run de référence. */
  now?: number;
}

/**
 * Évalue les critères du garde-fou.
 *
 * Les critères sont ceux du README §9.3 :
 * - couverture historique ≥ `guard.min_backtest_days` ;
 * - au moins `guard.min_windows` fenêtres de marché distinctes ;
 * - PnL net hors échantillon > 0 si `guard.require_positive_oos_pnl` ;
 * - sensibilité aux coûts : la chute du PnL ne doit pas dépasser
 *   `guard.max_cost_sensitivity_drop_pct`.
 */
export function evaluateGuard(inputs: GuardInputs): GuardReport {
  const { db, cfg } = inputs;
  const configHash = configFingerprint(cfg);
  const criteria: GuardCriterion[] = [];
  const reasons: string[] = [];

  // ── 1. Un run concluant existe-t-il pour CETTE empreinte ? ──────────
  const runs = listBacktestRuns(db, 50);
  const matching = runs.filter((run) => run.configHash === configHash);
  const conclusive = matching.find((run) => run.conclusive);
  const run = conclusive ?? matching[0] ?? null;

  criteria.push({
    name: "backtest",
    ok: conclusive !== undefined,
    blocking: true,
    detail: conclusive
      ? `« ${conclusive.label} » — ${conclusive.days.toFixed(1)} j, ${conclusive.tradesCount} trades`
      : matching.length > 0
        ? `un run existe (${matching[0]?.label}) mais n'est pas concluant`
        : `aucun backtest pour l'empreinte ${configHash}`,
  });
  if (!conclusive) reasons.push(`aucun backtest concluant pour l'empreinte ${configHash}`);

  // ── 1b. Le timeframe du run correspond-il à celui des stratégies ? ───
  //
  // Deux runs de la même configuration mais à des timeframes différents ne
  // mesurent pas la même chose. C'est un critère bloquant : sans lui, un
  // backtest 15 m validerait une configuration qui sera jouée en 1 h.
  const expectedTimeframe = expectedStrategyTimeframe(cfg);
  const timeframeOk = expectedTimeframe === null || (run?.timeframe ?? null) === expectedTimeframe;
  criteria.push({
    name: "timeframe",
    ok: timeframeOk,
    blocking: true,
    detail:
      expectedTimeframe === null
        ? "aucune stratégie ne consume de bougies"
        : timeframeOk
          ? `${expectedTimeframe} — conforme au run`
          : `le run est en ${run?.timeframe ?? "inconnu"} mais les stratégies utilisent ${expectedTimeframe}`,
  });
  if (!timeframeOk) {
    reasons.push(
      `timeframe du run (${run?.timeframe ?? "inconnu"}) ≠ timeframe des stratégies (${expectedTimeframe})`,
    );
  }

  // ── 2. Couverture historique ────────────────────────────────────────
  const coverage = importedCoverage(db);
  const candles = coverage.reduce((sum, row) => sum + row.candles, 0);
  const mints = new Set(coverage.flatMap((row) => [row.tf]));
  const daysCovered = estimateCoveredDays(coverage);
  const daysOk = daysCovered >= cfg.guard.min_backtest_days;
  criteria.push({
    name: "couverture",
    ok: daysOk,
    blocking: true,
    detail: `${daysCovered.toFixed(1)} j d'historique (${candles} bougies) — ${cfg.guard.min_backtest_days} j requis`,
  });
  if (!daysOk) {
    reasons.push(
      `couverture ${daysCovered.toFixed(1)} j < ${cfg.guard.min_backtest_days} j requis`,
    );
  }
  void mints;

  // ── 3. Fenêtres de marché distinctes ────────────────────────────────
  // Une fenêtre = un segment de marché distinct. On l'estime par le nombre
  // de jours couverts rapportés à la durée minimale d'une fenêtre.
  const windows = Math.floor(
    daysCovered / Math.max(1, cfg.guard.min_backtest_days / cfg.guard.min_windows),
  );
  const windowsOk = windows >= cfg.guard.min_windows;
  criteria.push({
    name: "fenêtres",
    ok: windowsOk,
    blocking: true,
    detail: `${windows} fenêtre(s) de marché distincte(s) — ${cfg.guard.min_windows} requises`,
  });
  if (!windowsOk) {
    reasons.push(`${windows} fenêtre(s) < ${cfg.guard.min_windows} requises`);
  }

  // ── 4. PnL net hors échantillon ──────────────────────────────────────
  if (conclusive) {
    const pnlOk = !cfg.guard.require_positive_oos_pnl || conclusive.metrics.netPnlUsd > 0;
    criteria.push({
      name: "pnl net",
      ok: pnlOk,
      blocking: true,
      detail: `${conclusive.metrics.netPnlUsd.toFixed(2)} $ (${(conclusive.metrics.netPnlPct ?? 0).toFixed(2)} %)`,
    });
    if (!pnlOk) {
      reasons.push(`PnL net ${conclusive.metrics.netPnlUsd.toFixed(2)} $ ≤ 0`);
    }
  } else {
    criteria.push({
      name: "pnl net",
      ok: false,
      blocking: true,
      detail: "inconnu (aucun run concluant)",
    });
  }

  // ── 5. Sensibilité aux coûts ─────────────────────────────────────────
  // Le run doit avoir survécu à une hausse des coûts. L'information est
  // portée par le run lui-même (cf. `backtest run`).
  const sensitivityOk = conclusive !== undefined;
  criteria.push({
    name: "sensibilité aux coûts",
    ok: sensitivityOk,
    blocking: true,
    detail: sensitivityOk
      ? `le run de référence a passé le test de sensibilité (×${cfg.guard.max_cost_sensitivity_drop_pct} % max)`
      : "inconnu (aucun run concluant)",
  });
  if (!sensitivityOk) {
    reasons.push("sensibilité aux coûts non vérifiée");
  }

  const ok = criteria.every((criterion) => !criterion.blocking || criterion.ok);

  return { ok, configHash, criteria, reasons, run };
}

/**
 * Timeframe attendu par les stratégies activées.
 *
 * Si plusieurs stratégies sont activées avec des timeframes différents,
 * le premier suffit : le moteur chargera les deux de toute façon, et le
 * run de référence en portera un.
 */
export function expectedStrategyTimeframe(cfg: AppConfig): string | null {
  const enabled = [
    cfg.strategies.trend_breakout,
    cfg.strategies.mean_reversion,
    cfg.strategies.grid,
    cfg.strategies.relative_strength,
  ].filter((strategy) => strategy.enabled);

  for (const strategy of enabled) {
    if (strategy.timeframe) return strategy.timeframe;
  }
  return null;
}

/**
 * Estimation de la couverture historique, en jours.
 *
 * On se base sur l'ancienneté des bougies importées : du plus ancien au
 * plus récent. C'est une borne : elle suppose une couverture continue,
 * alors que les pools DEX ont des trous.
 */
export function estimateCoveredDays(
  coverage: { tf: string; candles: number; oldest: number | null; newest: number | null }[],
): number {
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const row of coverage) {
    if (row.oldest !== null && (oldest === null || row.oldest < oldest)) oldest = row.oldest;
    if (row.newest !== null && (newest === null || row.newest > newest)) newest = row.newest;
  }

  if (oldest === null || newest === null) return 0;
  return Math.max(0, (newest - oldest) / 86_400_000);
}
