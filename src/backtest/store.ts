import { createHash } from "node:crypto";
import type { AppConfig } from "../config/schema.js";
import { strategySetDescriptor } from "../strategies/registry.js";
import type { DB } from "../state/db.js";
import { queryAll, queryGet } from "../state/sql.js";
import type { PerformanceMetrics } from "./metrics.js";

/**
 * Stockage des runs de backtest et **empreinte de configuration**.
 *
 * L'empreinte est le lien entre un run et la configuration qui l'a produit.
 * Le garde-fou live (phase 4) n'ouvrira la porte que si un run *concluant*
 * existe pour l'empreinte **exacte** de la configuration courante : changer
 * un seul paramètre change l'empreinte et impose de rejouer le backtest.
 */

export interface BacktestRunSummary {
  id: number;
  createdMs: number;
  label: string;
  configHash: string;
  timeframe: string;
  fromMs: number;
  toMs: number;
  days: number;
  tradesCount: number;
  conclusive: boolean;
  metrics: PerformanceMetrics;
}

/**
 * Empreinte de la configuration testée.
 *
 * Le descripteur du jeu de stratégies (noms, paramètres, ordre) entre dans le
 * hash : c'est ce qui lie un backtest à *ceux* qu'il a validés.
 */
export function configFingerprint(cfg: AppConfig): string {
  const descriptor = JSON.stringify({
    base: cfg.base_currency,
    strategies: strategySetDescriptor(cfg.strategies),
  });
  return createHash("sha256").update(descriptor).digest("hex").slice(0, 16);
}

export function insertBacktestRun(
  db: DB,
  run: {
    label: string;
    configHash: string;
    configJson: string;
    timeframe: string;
    fromMs: number;
    toMs: number;
    days: number;
    initialUsdc: number;
    mintsCount: number;
    candlesCount: number;
    tradesCount: number;
    conclusive: boolean;
    metrics: PerformanceMetrics;
    rejections?: Record<string, number>;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO backtest_runs
         (created_ms, label, config_hash, config_json, timeframe, from_ms, to_ms, days,
          initial_usdc, mints_count, candles_count, trades_count, conclusive, metrics_json, rejections_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      run.label,
      run.configHash,
      run.configJson,
      run.timeframe,
      run.fromMs,
      run.toMs,
      run.days,
      run.initialUsdc,
      run.mintsCount,
      run.candlesCount,
      run.tradesCount,
      run.conclusive ? 1 : 0,
      JSON.stringify(run.metrics),
      run.rejections ? JSON.stringify(run.rejections) : null,
    );
  return Number(result.lastInsertRowid);
}

export function insertBacktestEquity(
  db: DB,
  runId: number,
  points: { tsMs: number; navUsd: number; cashUsd: number; positionsUsd: number }[],
): void {
  if (points.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO backtest_equity (run_id, ts_ms, nav_usd, cash_usd, positions_usd) VALUES (?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const point of points) {
      stmt.run(runId, point.tsMs, point.navUsd, point.cashUsd, point.positionsUsd);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listBacktestRuns(db: DB, limit = 20): BacktestRunSummary[] {
  return queryAll<{
    id: number;
    created_ms: number;
    label: string;
    config_hash: string;
    timeframe: string;
    from_ms: number;
    to_ms: number;
    days: number;
    trades_count: number;
    conclusive: number;
    metrics_json: string;
  }>(db, "SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?", limit).map((row) => ({
    id: row.id,
    createdMs: row.created_ms,
    label: row.label,
    configHash: row.config_hash,
    timeframe: row.timeframe,
    fromMs: row.from_ms,
    toMs: row.to_ms,
    days: row.days,
    tradesCount: row.trades_count,
    conclusive: row.conclusive === 1,
    metrics: JSON.parse(row.metrics_json) as PerformanceMetrics,
  }));
}

/** Courbe d'équité d'un run de backtest. */
export function getBacktestEquity(
  db: DB,
  runId: number,
): { tsMs: number; navUsd: number; cashUsd: number; positionsUsd: number }[] {
  return queryAll<{
    ts_ms: number;
    nav_usd: number;
    cash_usd: number;
    positions_usd: number;
  }>(
    db,
    "SELECT ts_ms, nav_usd, cash_usd, positions_usd FROM backtest_equity WHERE run_id = ? ORDER BY ts_ms ASC",
    runId,
  ).map((row) => ({
    tsMs: row.ts_ms,
    navUsd: row.nav_usd,
    cashUsd: row.cash_usd,
    positionsUsd: row.positions_usd,
  }));
}

/** Trades clôturés d'un run de backtest. */
export function insertBacktestTrades(
  db: DB,
  runId: number,
  trades: {
    tsMs: number;
    mint: string;
    side: string;
    pnlUsd: number | null;
    notionalUsd: number;
    feeUsd: number;
    priceUsd: number;
    qty: number;
  }[],
): void {
  if (trades.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO backtest_trades (run_id, ts_ms, mint, side, pnl_usd, notional_usd, fee_usd, price_usd, qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const trade of trades) {
      stmt.run(
        runId,
        trade.tsMs,
        trade.mint,
        trade.side,
        trade.pnlUsd,
        trade.notionalUsd,
        trade.feeUsd,
        trade.priceUsd,
        trade.qty,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getBacktestTrades(
  db: DB,
  runId: number,
): {
  tsMs: number;
  mint: string;
  side: string;
  pnlUsd: number | null;
  notionalUsd: number;
  feeUsd: number;
  priceUsd: number;
  qty: number;
}[] {
  return queryAll<{
    ts_ms: number;
    mint: string;
    side: string;
    pnl_usd: number | null;
    notional_usd: number;
    fee_usd: number;
    price_usd: number;
    qty: number;
  }>(db, "SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY ts_ms ASC", runId).map((row) => ({
    tsMs: row.ts_ms,
    mint: row.mint,
    side: row.side,
    pnlUsd: row.pnl_usd,
    notionalUsd: row.notional_usd,
    feeUsd: row.fee_usd,
    priceUsd: row.price_usd,
    qty: row.qty,
  }));
}

/** Dernier run **concluant** pour une empreinte donnée.
 *
 * C'est la porte du garde-fou live : sans ce run, pas de live.
 */
export function findConclusiveRun(
  db: DB,
  configHash: string,
  minDays: number,
): BacktestRunSummary | null {
  const row = queryGet<{
    id: number;
    created_ms: number;
    label: string;
    config_hash: string;
    timeframe: string;
    from_ms: number;
    to_ms: number;
    days: number;
    trades_count: number;
    conclusive: number;
    metrics_json: string;
  }>(
    db,
    `SELECT * FROM backtest_runs
      WHERE config_hash = ? AND conclusive = 1 AND days >= ?
      ORDER BY id DESC LIMIT 1`,
    configHash,
    minDays,
  );
  if (!row) return null;
  return {
    id: row.id,
    createdMs: row.created_ms,
    label: row.label,
    configHash: row.config_hash,
    timeframe: row.timeframe,
    fromMs: row.from_ms,
    toMs: row.to_ms,
    days: row.days,
    tradesCount: row.trades_count,
    conclusive: true,
    metrics: JSON.parse(row.metrics_json) as PerformanceMetrics,
  };
}
