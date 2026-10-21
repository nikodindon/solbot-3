import type { Timeframe } from "../config/schema.js";
import type { TokenInfo } from "../jupiter/tokens.js";
import type { DB } from "./db.js";
import { queryAll } from "./sql.js";

/**
 * Accès aux données de marché persistées.
 *
 * Deux tables portent les prix, et la distinction est **structurante** :
 * - `price_ticks` : observation ponctuelle, avec son origine (`src`) ;
 * - `candles`     : agrégation temporelle de ces observations.
 *
 * L'origine d'un prix (`discovery` / `candle` / `import`) est ce qui permet,
 * plus tard, de refuser une décision fondée sur un prix peu fiable.
 */

export type PriceSource = "discovery" | "candle" | "import";

export interface PriceTick {
  tsMs: number;
  mint: string;
  priceUsd: number;
  liquidityUsd: number | null;
  /** Volume 24 h *écoulé* depuis le tick précédent (approximation, cf. README). */
  volumeDeltaUsd: number | null;
  src: PriceSource;
}

export interface Candle {
  mint: string;
  tf: Timeframe;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number | null;
  ticks: number;
}

export interface WatchlistItem {
  mint: string;
  symbol: string;
  rank: number;
  active: boolean;
}

// ── Ticks ───────────────────────────────────────────────────────────────────

/** Insère des ticks (upsert sur la clé primaire `ts_ms, mint`). */
export function insertTicks(db: DB, ticks: PriceTick[]): number {
  if (ticks.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO price_ticks (ts_ms, mint, price_usd, liquidity_usd, volume_delta_usd, src)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ts_ms, mint) DO UPDATE SET
      price_usd = excluded.price_usd,
      liquidity_usd = excluded.liquidity_usd,
      volume_delta_usd = excluded.volume_delta_usd,
      src = excluded.src
  `);
  db.exec("BEGIN");
  try {
    for (const tick of ticks) {
      stmt.run(
        tick.tsMs,
        tick.mint,
        tick.priceUsd,
        tick.liquidityUsd,
        tick.volumeDeltaUsd,
        tick.src,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ticks.length;
}

/** Dernier tick d'un mint, quelle que soit son origine. */
export function latestTick(db: DB, mint: string): PriceTick | null {
  const row = db
    .prepare(
      "SELECT ts_ms, mint, price_usd, liquidity_usd, volume_delta_usd, src FROM price_ticks WHERE mint = ? ORDER BY ts_ms DESC LIMIT 1",
    )
    .get(mint) as PriceTickRow | undefined;
  return row ? rowToTick(row) : null;
}

/**
 * Dernier tick d'origine `discovery` (donc issu de Price v3, avec liquidité).
 * C'est le prix de référence pour valoriser une position.
 */
export function latestDiscoveryTick(db: DB, mint: string, maxAgeMs?: number): PriceTick | null {
  const row = db
    .prepare(
      "SELECT ts_ms, mint, price_usd, liquidity_usd, volume_delta_usd, src FROM price_ticks WHERE mint = ? AND src = 'discovery' ORDER BY ts_ms DESC LIMIT 1",
    )
    .get(mint) as PriceTickRow | undefined;
  if (!row) return null;
  if (maxAgeMs !== undefined && Date.now() - row.ts_ms > maxAgeMs) return null;
  return rowToTick(row);
}

/** Dernier tick de chaque mint dans une fenêtre, pour un tick donné. */
export function latestTicksInWindow(
  db: DB,
  sinceMs: number,
  untilMs: number,
): Map<string, PriceTick> {
  const rows = queryAll<PriceTickRow>(
    db,
    "SELECT ts_ms, mint, price_usd, liquidity_usd, volume_delta_usd, src FROM price_ticks WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC",
    sinceMs,
    untilMs,
  );
  const out = new Map<string, PriceTick>();
  for (const row of rows) out.set(row.mint, rowToTick(row));
  return out;
}

export function countTicks(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM price_ticks").get() as { n: number };
  return row.n;
}

interface PriceTickRow {
  ts_ms: number;
  mint: string;
  price_usd: number;
  liquidity_usd: number | null;
  volume_delta_usd: number | null;
  src: string;
}

function rowToTick(row: PriceTickRow): PriceTick {
  return {
    tsMs: row.ts_ms,
    mint: row.mint,
    priceUsd: row.price_usd,
    liquidityUsd: row.liquidity_usd,
    volumeDeltaUsd: row.volume_delta_usd,
    src: row.src as PriceSource,
  };
}

// ── Bougies ─────────────────────────────────────────────────────────────────

/**
 * Agrège des bougies (upsert).
 *
 * `open` est conservé (premier tick du seau), `high`/`low` sont élargis,
 * `close` est le dernier tick, le volume est cumulé.
 */
export function upsertCandles(db: DB, candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO candles (mint, tf, ts, open, high, low, close, volume_usd, ticks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, tf, ts) DO UPDATE SET
      high = MAX(candles.high, excluded.high),
      low = MIN(candles.low, excluded.low),
      close = excluded.close,
      volume_usd = COALESCE(candles.volume_usd, 0) + COALESCE(excluded.volume_usd, 0),
      ticks = candles.ticks + excluded.ticks
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
        candle.ticks,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return candles.length;
}

/** Bougies d'un mint, de la plus récente à la plus ancienne. */
export function listCandles(db: DB, mint: string, tf: Timeframe, limit = 500): Candle[] {
  const rows = queryAll<CandleRow>(
    db,
    "SELECT mint, tf, ts, open, high, low, close, volume_usd, ticks FROM candles WHERE mint = ? AND tf = ? ORDER BY ts DESC LIMIT ?",
    mint,
    tf,
    limit,
  );
  return rows.map(rowToCandle);
}

export function countCandles(db: DB, mint: string, tf: Timeframe): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM candles WHERE mint = ? AND tf = ?")
    .get(mint, tf) as { n: number };
  return row.n;
}

/** Nombre de bougies distinctes par timeframe (couverture du jeu de données). */
export function candleCoverage(db: DB): { tf: string; mints: number; candles: number }[] {
  const rows = queryAll<{ tf: string; mints: number; candles: number }>(
    db,
    "SELECT tf, COUNT(DISTINCT mint) AS mints, COUNT(*) AS candles FROM candles GROUP BY tf ORDER BY tf",
  );
  return rows;
}

interface CandleRow {
  mint: string;
  tf: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_usd: number | null;
  ticks: number;
}

function rowToCandle(row: CandleRow): Candle {
  return {
    mint: row.mint,
    tf: row.tf as Timeframe,
    ts: row.ts,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volumeUsd: row.volume_usd,
    ticks: row.ticks,
  };
}

// ── Métadonnées de tokens ───────────────────────────────────────────────────

/**
 * Enregistre (ou met à jour) les métadonnées d'un token.
 *
 * Le volume 24 h est conservé : c'est ce qui permet de calculer le volume
 * *écoulé* entre deux ticks (le proxy de volume du moteur).
 */
export function upsertTokenMeta(db: DB, tokens: TokenInfo[], nowMs: number = Date.now()): number {
  if (tokens.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO tokens (
      mint, symbol, name, decimals, is_verified, organic_score, liquidity_usd,
      usd_price, price_change_24h, pool_created_ms, first_seen_ms, updated_ms, volume_24h_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      symbol = excluded.symbol,
      name = COALESCE(NULLIF(excluded.name, ''), tokens.name),
      decimals = COALESCE(excluded.decimals, tokens.decimals),
      is_verified = COALESCE(excluded.is_verified, tokens.is_verified),
      organic_score = COALESCE(excluded.organic_score, tokens.organic_score),
      liquidity_usd = COALESCE(excluded.liquidity_usd, tokens.liquidity_usd),
      usd_price = COALESCE(excluded.usd_price, tokens.usd_price),
      pool_created_ms = COALESCE(excluded.pool_created_ms, tokens.pool_created_ms),
      volume_24h_usd = COALESCE(excluded.volume_24h_usd, tokens.volume_24h_usd),
      updated_ms = excluded.updated_ms
  `);
  db.exec("BEGIN");
  try {
    for (const token of tokens) {
      stmt.run(
        token.mint,
        token.symbol,
        token.name,
        token.decimals,
        token.isVerified ? 1 : 0,
        token.organicScore,
        token.liquidityUsd,
        token.usdPrice,
        null,
        token.poolCreatedMs,
        nowMs,
        nowMs,
        token.volume24hUsd,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return tokens.length;
}

export function getTokenMeta(db: DB, mint: string): TokenMeta | null {
  const row = db.prepare("SELECT * FROM tokens WHERE mint = ?").get(mint) as
    TokenMetaRow | undefined;
  return row ? rowToTokenMeta(row) : null;
}

/** Volume 24 h connu pour chaque mint — sert au calcul du volume écoulé. */
export function knownVolumes24h(db: DB, mints: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;
  const stmt = db.prepare("SELECT mint, volume_24h_usd FROM tokens WHERE mint = ?");
  for (const mint of mints) {
    const row = stmt.get(mint) as { volume_24h_usd: number | null } | undefined;
    const volume = row?.volume_24h_usd;
    if (volume !== null && volume !== undefined) out.set(mint, volume);
  }
  return out;
}

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string | null;
  decimals: number | null;
  isVerified: boolean | null;
  organicScore: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  poolCreatedMs: number | null;
  volume24hUsd: number | null;
}

interface TokenMetaRow {
  mint: string;
  symbol: string;
  name: string | null;
  decimals: number | null;
  is_verified: number | null;
  organic_score: number | null;
  liquidity_usd: number | null;
  usd_price: number | null;
  pool_created_ms: number | null;
  volume_24h_usd: number | null;
}

function rowToTokenMeta(row: TokenMetaRow): TokenMeta {
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    isVerified: row.is_verified === null ? null : row.is_verified === 1,
    organicScore: row.organic_score,
    liquidityUsd: row.liquidity_usd,
    usdPrice: row.usd_price,
    poolCreatedMs: row.pool_created_ms,
    volume24hUsd: row.volume_24h_usd,
  };
}

// ── Watchlist ───────────────────────────────────────────────────────────────

/**
 * Remplace la watchlist (remplacement complet dans une transaction).
 *
 * Le remplacement total est volontaire : la watchlist est un **état**, pas un
 * journal. Un scan produit la liste exacte, sans reliquat du scan précédent.
 */
export function replaceWatchlist(
  db: DB,
  items: WatchlistItem[],
  nowMs: number = Date.now(),
): number {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM watchlist");
    const stmt = db.prepare(
      "INSERT INTO watchlist (mint, symbol, rank, added_ms, active) VALUES (?, ?, ?, ?, ?)",
    );
    for (const item of items) {
      stmt.run(item.mint, item.symbol, item.rank, nowMs, item.active ? 1 : 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return items.length;
}

export function listWatchlist(db: DB): WatchlistItem[] {
  const rows = db
    .prepare("SELECT mint, symbol, rank, active FROM watchlist ORDER BY rank ASC")
    .all() as { mint: string; symbol: string; rank: number; active: number }[];
  return rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol,
    rank: row.rank,
    active: row.active === 1,
  }));
}

/** Mints de la watchlist, dans l'ordre du classement. */
export function listWatchlistMints(db: DB): string[] {
  return listWatchlist(db)
    .filter((item) => item.active)
    .map((item) => item.mint);
}
