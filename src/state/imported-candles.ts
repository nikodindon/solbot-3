import type { Timeframe } from "../config/schema.js";
import type { DB } from "./db.js";
import { queryAll, queryGet } from "./sql.js";

/**
 * Bougies importées (GeckoTerminal) et fusion avec les bougies en direct.
 *
 * Les deux sources sont **stockées à part** : l'import ne doit jamais
 * contaminer les bougies construites en direct, et le live ne doit jamais
 * réécrire l'historique. La fusion se fait **à la lecture** :
 * - l'OHLC importé est prioritaire (c'est la donnée de référence du backtest) ;
 * - le volume live est conservé quand l'import n'en fournit pas.
 */

export interface ImportedCandle {
  mint: string;
  tf: Timeframe;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number | null;
  source: string;
}

export function upsertImportedCandles(
  db: DB,
  candles: ImportedCandle[],
  nowMs = Date.now(),
): number {
  if (candles.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO candles_imported (mint, tf, ts, open, high, low, close, volume_usd, source, imported_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, tf, ts) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume_usd = COALESCE(excluded.volume_usd, candles_imported.volume_usd),
      source = excluded.source,
      imported_ms = excluded.imported_ms
  `);
  db.exec("BEGIN");
  try {
    for (const candle of candles) {
      stmt.run(
        candle.mint,
        candle.tf,
        candle.ts,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volumeUsd,
        candle.source,
        nowMs,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return candles.length;
}

export function countImportedCandles(db: DB, mint: string, tf: Timeframe): number {
  const row = queryGet<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM candles_imported WHERE mint = ? AND tf = ?",
    mint,
    tf,
  );
  return row?.n ?? 0;
}

/** Couverture de l'historique importé, par timeframe. */
export function importedCoverage(
  db: DB,
): { tf: string; mints: number; candles: number; oldest: number | null; newest: number | null }[] {
  return queryAll<{
    tf: string;
    mints: number;
    candles: number;
    oldest: number | null;
    newest: number | null;
  }>(
    db,
    `SELECT tf, COUNT(DISTINCT mint) AS mints, COUNT(*) AS candles,
            MIN(ts) AS oldest, MAX(ts) AS newest
       FROM candles_imported GROUP BY tf ORDER BY tf`,
  );
}

/**
 * Historique fusionné, du plus ancien au plus récent.
 *
 * L'import prioritaire : une bougie présente dans les deux sources prend son
 * OHLC de l'import, mais garde le volume live si l'import n'en a pas.
 */
export function getMergedCandles(
  db: DB,
  mint: string,
  tf: Timeframe,
  options: { fromMs?: number; toMs?: number; limit?: number } = {},
): ImportedCandle[] {
  const bounds: string[] = [];
  const importParams: (string | number)[] = [mint, tf];
  const liveParams: (string | number)[] = [mint, tf];

  if (options.fromMs !== undefined) {
    bounds.push("ts >= ?");
    importParams.push(options.fromMs);
    liveParams.push(options.fromMs);
  }
  if (options.toMs !== undefined) {
    bounds.push("ts <= ?");
    importParams.push(options.toMs);
    liveParams.push(options.toMs);
  }

  const importWhere = bounds.length ? `AND ${bounds.map((b) => `i.${b}`).join(" AND ")}` : "";
  const liveWhere = bounds.length ? `AND ${bounds.map((b) => `l.${b}`).join(" AND ")}` : "";

  const rows = queryAll<{
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume_usd: number | null;
    source: string;
  }>(
    db,
    `SELECT ts, open, high, low, close, volume_usd, source FROM (
       SELECT i.ts AS ts, i.open AS open, i.high AS high, i.low AS low, i.close AS close,
              COALESCE(i.volume_usd, l.volume_usd) AS volume_usd,
              CASE WHEN i.volume_usd IS NOT NULL THEN 'import' ELSE 'live' END AS source
         FROM candles_imported i
         LEFT JOIN candles l ON l.mint = i.mint AND l.tf = i.tf AND l.ts = i.ts
        WHERE i.mint = ? AND i.tf = ? ${importWhere}
       UNION ALL
       SELECT l.ts, l.open, l.high, l.low, l.close, l.volume_usd, 'live'
         FROM candles l
        WHERE l.mint = ? AND l.tf = ?
          AND NOT EXISTS (
            SELECT 1 FROM candles_imported i
             WHERE i.mint = l.mint AND i.tf = l.tf AND i.ts = l.ts
          ) ${liveWhere}
     ) ORDER BY ts ASC`,
    ...importParams,
    ...liveParams,
  );

  const limited = options.limit !== undefined ? rows.slice(0, options.limit) : rows;

  return limited.map((row) => ({
    mint,
    tf,
    ts: row.ts,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volumeUsd: row.volume_usd,
    source: row.source,
  }));
}
