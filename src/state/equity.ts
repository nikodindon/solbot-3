import type { DB } from "./db.js";
import { queryAll, queryGet } from "./sql.js";

/** Courbe d'équité : un point par tick. */

export interface EquityPoint {
  mode: string;
  tsMs: number;
  tickId: number;
  navUsd: number;
  cashUsd: number;
  positionsUsd: number;
  realizedPnlUsd: number;
  drawdownPct: number;
}

export function insertEquityPoint(db: DB, point: EquityPoint): void {
  db.prepare(
    `INSERT INTO equity_curve
       (mode, ts_ms, tick_id, nav_usd, cash_usd, positions_usd, realized_pnl_usd, drawdown_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mode, ts_ms) DO UPDATE SET
       tick_id = excluded.tick_id,
       nav_usd = excluded.nav_usd,
       cash_usd = excluded.cash_usd,
       positions_usd = excluded.positions_usd,
       realized_pnl_usd = excluded.realized_pnl_usd,
       drawdown_pct = excluded.drawdown_pct`,
  ).run(
    point.mode,
    point.tsMs,
    point.tickId,
    point.navUsd,
    point.cashUsd,
    point.positionsUsd,
    point.realizedPnlUsd,
    point.drawdownPct,
  );
}

export function listEquity(
  db: DB,
  options: { mode?: string; fromMs?: number; toMs?: number; limit?: number } = {},
): EquityPoint[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.mode) {
    where.push("mode = ?");
    params.push(options.mode);
  }
  if (options.fromMs !== undefined) {
    where.push("ts_ms >= ?");
    params.push(options.fromMs);
  }
  if (options.toMs !== undefined) {
    where.push("ts_ms <= ?");
    params.push(options.toMs);
  }

  const rows = queryAll<{
    mode: string;
    ts_ms: number;
    tick_id: number;
    nav_usd: number;
    cash_usd: number;
    positions_usd: number;
    realized_pnl_usd: number;
    drawdown_pct: number;
  }>(
    db,
    `SELECT * FROM equity_curve ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts_ms ASC`,
    ...params,
  );

  const limited =
    options.limit !== undefined && rows.length > options.limit
      ? rows.slice(rows.length - options.limit)
      : rows;

  return limited.map((row) => ({
    mode: row.mode,
    tsMs: row.ts_ms,
    tickId: row.tick_id,
    navUsd: row.nav_usd,
    cashUsd: row.cash_usd,
    positionsUsd: row.positions_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    drawdownPct: row.drawdown_pct,
  }));
}

/** Nombre de points d'équité pour un mode. */
export function equityCount(db: DB, mode: string): number {
  const row = queryGet<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM equity_curve WHERE mode = ?",
    mode,
  );
  return row?.n ?? 0;
}
