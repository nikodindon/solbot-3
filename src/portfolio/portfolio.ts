import type { Timeframe } from "../config/schema.js";
import type { ImportedCandle } from "../state/imported-candles.js";
import { listPositions, type Position } from "../state/portfolio-repo.js";
import type { DB } from "../state/db.js";

/**
 * Vue du portefeuille, telle que les stratégies la voient.
 *
 * Une stratégie ne touche jamais à la base : elle reçoit un instantané
 * **en lecture seule**. C'est ce qui rend les stratégies testables sur des
 * séries synthétiques et le moteur rejouable en backtest.
 */

export interface PositionView {
  mint: string;
  symbol: string;
  qty: number;
  avgEntryUsd: number;
  valueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  peakPriceUsd: number | null;
  ageMs: number;
}

export interface PortfolioView {
  /** Valeur nette totale, en USD. */
  navUsd: number;
  /** Cash disponible, en USD. */
  cashUsd: number;
  /** Positions ouvertes. */
  positions: PositionView[];
  /** PnL latent total, en USD. */
  unrealizedPnlUsd: number;
}

export interface PortfolioSnapshot extends PortfolioView {
  /** PnL réalisé cumulé. */
  realizedPnlUsd: number;
  /** Valeur des positions, en USD. */
  positionsUsd: number;
}

/** Calcule la vue du portefeuille à partir des positions et d'une carte de prix. */
export function buildPortfolioView(
  positions: Position[],
  prices: Map<string, number>,
  cashUsd: number,
  nowMs: number,
): PortfolioView {
  const views: PositionView[] = [];
  let positionsUsd = 0;
  let unrealized = 0;

  for (const position of positions) {
    const price = prices.get(position.mint) ?? position.avgEntryUsd;
    const value = position.qty * price;
    const pnl = (price - position.avgEntryUsd) * position.qty;
    const pnlPct =
      position.avgEntryUsd > 0 ? ((price - position.avgEntryUsd) / position.avgEntryUsd) * 100 : 0;

    positionsUsd += value;
    unrealized += pnl;

    views.push({
      mint: position.mint,
      symbol: position.symbol,
      qty: position.qty,
      avgEntryUsd: position.avgEntryUsd,
      valueUsd: value,
      unrealizedPnlUsd: pnl,
      unrealizedPnlPct: pnlPct,
      stopLossUsd: position.stopLossUsd,
      takeProfitUsd: position.takeProfitUsd,
      peakPriceUsd: position.peakPriceUsd,
      ageMs: nowMs - position.openedMs,
    });
  }

  return {
    navUsd: cashUsd + positionsUsd,
    cashUsd,
    positions: views,
    unrealizedPnlUsd: unrealized,
  };
}

/** Snapshot complet (avec PnL réalisé) lu depuis la base. */
export function snapshotPortfolio(
  db: DB,
  prices: Map<string, number>,
  cashUsd: number,
  nowMs: number,
): PortfolioSnapshot {
  const positions = listPositions(db);
  const view = buildPortfolioView(positions, prices, cashUsd, nowMs);
  const realized = positions.reduce((sum, p) => sum + p.realizedPnlUsd, 0);
  const positionsUsd = view.positions.reduce((sum, p) => sum + p.valueUsd, 0);
  return { ...view, realizedPnlUsd: realized, positionsUsd };
}

/**
 * Bougies clôturées d'un actif pour un timeframe donné.
 *
 * Une bougie en cours ne doit jamais servir à une décision : elle est
 * exclue. C'est la discipline qui rend le backtest et le live comparables.
 */
export function closedCandles(
  candles: ImportedCandle[],
  tf: Timeframe,
  nowMs: number,
): ImportedCandle[] {
  const durationMs = timeframeMs(tf);
  return candles.filter((candle) => candle.ts + durationMs <= nowMs);
}

export function timeframeMs(tf: Timeframe): number {
  switch (tf) {
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
    case "15m":
      return 900_000;
    case "1h":
      return 3_600_000;
  }
}
