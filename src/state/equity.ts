import type { DB } from "./db.js";
import { kvGetNumber, STATE_KEYS } from "./kv.js";
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

/**
 * Premier point d'équité d'un mode : le **départ du run**.
 *
 * `listEquity` est limité aux N derniers points (fenêtre d'affichage) :
 * son premier élément n'est donc pas le début du run. Pour un chiffre
 * « depuis le départ » — PnL cumulé, référence buy & hold — il faut ce
 * point-ci, qui ne dépend d'aucun limit.
 */
export function firstEquityPoint(db: DB, mode: string): EquityPoint | null {
  const row = queryGet<{
    mode: string;
    ts_ms: number;
    tick_id: number;
    nav_usd: number;
    cash_usd: number;
    positions_usd: number;
    realized_pnl_usd: number;
    drawdown_pct: number;
  }>(db, `SELECT * FROM equity_curve WHERE mode = ? ORDER BY ts_ms ASC LIMIT 1`, mode);
  if (row === undefined || row === null) return null;
  return {
    mode: row.mode,
    tsMs: row.ts_ms,
    tickId: row.tick_id,
    navUsd: row.nav_usd,
    cashUsd: row.cash_usd,
    positionsUsd: row.positions_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    drawdownPct: row.drawdown_pct,
  };
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

/**
 * Tolérance entre le pic stocké et le maximum réellement observé.
 *
 * Le pic est écrit en début de tick, le point d'équité en fin de tick : un
 * écart d'un tick est normal. Au-delà de cette marge, aucun point de la
 * courbe ne vient du pic allégué — il n'existe pas.
 */
const NAV_PEAK_TOLERANCE = 0.05;

export interface NavPeakAttestation {
  /** Le pic à utiliser pour le drawdown. */
  peakUsd: number;
  /** Le pic stocké que la courbe ne justifie pas (null sinon). */
  discardedPeakUsd: number | null;
}

/**
 * Pic d'équité **attesté** par la courbe.
 *
 * `bot_state.nav_peak_usd` n'est qu'un cache : la seule preuve qu'un pic a
 * existé est un point de `equity_curve`. Un cache orphelin — reliquat d'un
 * compte réinitialisé, écriture interrompue, reprise depuis un dump —
 * produirait un drawdown fantôme et déclencherait le kill-switch à tort.
 *
 * On réaligne donc le cache sur ce que la courbe prouve, et on signale le
 * pic écarté pour que le correctif soit visible dans le journal.
 */
export function attestNavPeak(db: DB, mode: string, navUsd: number): NavPeakAttestation {
  const row = queryGet<{ max_nav: number | null }>(
    db,
    "SELECT MAX(nav_usd) AS max_nav FROM equity_curve WHERE mode = ?",
    mode,
  );
  const curveMaxUsd = row?.max_nav ?? 0;
  // Le NAV courant compte aussi : son point n'est écrit qu'en fin de tick.
  const attestedUsd = Math.max(curveMaxUsd, navUsd);
  const storedUsd = kvGetNumber(db, STATE_KEYS.navPeakUsd);

  if (storedUsd === null) return { peakUsd: attestedUsd, discardedPeakUsd: null };
  if (curveMaxUsd > 0 && storedUsd > attestedUsd * (1 + NAV_PEAK_TOLERANCE)) {
    return { peakUsd: attestedUsd, discardedPeakUsd: storedUsd };
  }
  return { peakUsd: Math.max(storedUsd, attestedUsd), discardedPeakUsd: null };
}
