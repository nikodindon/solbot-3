import type { DB } from "./db.js";
import { queryAll, queryGet } from "./sql.js";

/** Journal des exécutions. */

export type TradeSide = "buy" | "sell";
export type TradeStatus = "simulated" | "validated_order" | "filled" | "failed" | "reconciled";

export interface TradeRecord {
  tsMs: number;
  mode: string;
  strategy: string;
  mint: string;
  symbol: string;
  side: TradeSide;
  priceUsd: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnlUsd: number | null;
  reason: string | null;
  signature: string | null;
  status: TradeStatus;
}

export function insertTrade(db: DB, trade: TradeRecord): void {
  db.prepare(
    `INSERT INTO trades
       (ts_ms, mode, strategy, mint, symbol, side, price_usd, qty, notional_usd,
        fee_usd, realized_pnl_usd, reason, signature, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trade.tsMs,
    trade.mode,
    trade.strategy,
    trade.mint,
    trade.symbol,
    trade.side,
    trade.priceUsd,
    trade.qty,
    trade.notionalUsd,
    trade.feeUsd,
    trade.realizedPnlUsd,
    trade.reason,
    trade.signature,
    trade.status,
  );
}

export function listTrades(
  db: DB,
  options: { limit?: number; mode?: string; mint?: string } = {},
): TradeRecord[] {
  const limit = options.limit ?? 200;
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.mode) {
    where.push("mode = ?");
    params.push(options.mode);
  }
  if (options.mint) {
    where.push("mint = ?");
    params.push(options.mint);
  }

  const rows = queryAll<{
    ts_ms: number;
    mode: string;
    strategy: string;
    mint: string;
    symbol: string;
    side: string;
    price_usd: number;
    qty: number;
    notional_usd: number;
    fee_usd: number;
    realized_pnl_usd: number | null;
    reason: string | null;
    signature: string | null;
    status: string;
  }>(
    db,
    `SELECT * FROM trades ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    limit,
  );

  return rows.map((row) => ({
    tsMs: row.ts_ms,
    mode: row.mode,
    strategy: row.strategy,
    mint: row.mint,
    symbol: row.symbol,
    side: row.side as TradeSide,
    priceUsd: row.price_usd,
    qty: row.qty,
    notionalUsd: row.notional_usd,
    feeUsd: row.fee_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    reason: row.reason,
    signature: row.signature,
    status: row.status as TradeStatus,
  }));
}

export function countTrades(db: DB, mode?: string): number {
  const row = mode
    ? queryGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM trades WHERE mode = ?", mode)
    : queryGet<{ n: number }>(db, "SELECT COUNT(*) AS n FROM trades");
  return row?.n ?? 0;
}

/** Décomposition des coûts payés sur une période. */
export function costBreakdown(
  db: DB,
  sinceMs?: number,
): { feesUsd: number; trades: number; notionalUsd: number } {
  const row = queryGet<{ fees: number | null; n: number; notional: number | null }>(
    db,
    `SELECT SUM(fee_usd) AS fees, COUNT(*) AS n, SUM(notional_usd) AS notional
       FROM trades ${sinceMs !== undefined ? "WHERE ts_ms >= ?" : ""}`,
    ...(sinceMs !== undefined ? [sinceMs] : []),
  );
  return {
    feesUsd: row?.fees ?? 0,
    trades: row?.n ?? 0,
    notionalUsd: row?.notional ?? 0,
  };
}
