import type { DB } from "./db.js";

/**
 * Migrations versionnées.
 *
 * Règles :
 * - une migration écrite n'est **jamais** modifiée (append-only) ;
 * - chaque migration s'applique dans une transaction (tout ou rien) ;
 * - le contenu est idempotent (`IF NOT EXISTS`) pour tolerate un run interrompu.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "core-market-data",
    sql: `
      -- État clé/valeur générique (ancres de journée, allocation, kill-switch…).
      CREATE TABLE IF NOT EXISTS bot_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_ms INTEGER NOT NULL
      );

      -- Métadonnées d'un token de l'univers.
      CREATE TABLE IF NOT EXISTS tokens (
        mint             TEXT PRIMARY KEY,
        symbol           TEXT NOT NULL,
        name             TEXT,
        decimals         INTEGER NOT NULL,
        is_verified      INTEGER,
        organic_score    REAL,
        liquidity_usd    REAL,
        usd_price        REAL,
        price_change_24h REAL,
        pool_created_ms  INTEGER,
        first_seen_ms    INTEGER NOT NULL,
        updated_ms       INTEGER NOT NULL
      );

      -- Ticks de prix. La colonne src trace l'origine : discovery | candle | import.
      CREATE TABLE IF NOT EXISTS price_ticks (
        ts_ms           INTEGER NOT NULL,
        mint            TEXT NOT NULL,
        price_usd       REAL NOT NULL,
        liquidity_usd   REAL,
        volume_delta_usd REAL,
        src             TEXT NOT NULL DEFAULT 'discovery',
        PRIMARY KEY (ts_ms, mint)
      );
      CREATE INDEX IF NOT EXISTS idx_price_ticks_mint_ts ON price_ticks (mint, ts_ms DESC);

      -- Bougies OHLCV construites en interne (agrégation des ticks).
      CREATE TABLE IF NOT EXISTS candles (
        mint       TEXT NOT NULL,
        tf         TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        open       REAL NOT NULL,
        high       REAL NOT NULL,
        low        REAL NOT NULL,
        close      REAL NOT NULL,
        volume_usd REAL,
        ticks      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (mint, tf, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_candles_mint_tf_ts ON candles (mint, tf, ts);

      -- Watchlist persistée (univers filtré, tri déterministe).
      CREATE TABLE IF NOT EXISTS watchlist (
        mint     TEXT PRIMARY KEY,
        symbol   TEXT NOT NULL,
        rank     INTEGER NOT NULL,
        added_ms INTEGER NOT NULL,
        active   INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_watchlist_rank ON watchlist (active, rank);
    `,
  },
  {
    version: 2,
    name: "token-volume-24h",
    sql: `
      -- Volume 24 h (achats + ventes) observé au dernier passage.
      -- Sa différence entre deux ticks donne le volume *écoulé* du seau,
      -- qui sert de proxy de volume par bougie.
      ALTER TABLE tokens ADD COLUMN volume_24h_usd REAL;
    `,
  },
];

/** Version du schéma actuellement appliquée (0 si base vierge). */
export function currentVersion(db: DB): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name?: string } | undefined;
  if (!exists?.name) return 0;

  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
}

/** Applique les migrations manquantes. Retourne le nombre de migrations appliquées. */
export function migrate(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_ms INTEGER NOT NULL
  )`);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_ms) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec("COMMIT");
      count += 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration ${migration.version} (${migration.name}) échouée : ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  return count;
}

/** Tables présentes dans la base (diagnostic `doctor`). */
export function tablesOf(db: DB): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
