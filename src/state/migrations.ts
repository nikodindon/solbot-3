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
  {
    version: 3,
    name: "imported-candles",
    sql: `
      -- Historique importé depuis GeckoTerminal.
      -- Table **distincte** de candles : l'import ne doit jamais contaminer
      -- les bougies construites en direct. La fusion se fait à la lecture.
      CREATE TABLE IF NOT EXISTS candles_imported (
        mint        TEXT NOT NULL,
        tf          TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        open        REAL NOT NULL,
        high        REAL NOT NULL,
        low         REAL NOT NULL,
        close       REAL NOT NULL,
        volume_usd  REAL,
        source      TEXT NOT NULL,
        imported_ms INTEGER NOT NULL,
        PRIMARY KEY (mint, tf, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_candles_imported_mint_tf_ts
        ON candles_imported (mint, tf, ts);
    `,
  },
  {
    version: 4,
    name: "trading-ledger",
    sql: `
      -- Positions agrégées (le détail est dans position_lots).
      CREATE TABLE IF NOT EXISTS positions (
        mint             TEXT PRIMARY KEY,
        symbol           TEXT NOT NULL,
        qty              REAL NOT NULL,
        invested_usd     REAL NOT NULL,
        avg_entry_usd    REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        peak_price_usd   REAL,
        stop_loss_usd    REAL,
        take_profit_usd  REAL,
        opened_ms        INTEGER NOT NULL,
        updated_ms       INTEGER NOT NULL
      );

      -- Lots FIFO : la base de custo de chaque position.
      CREATE TABLE IF NOT EXISTS position_lots (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        mint      TEXT NOT NULL,
        ts_ms     INTEGER NOT NULL,
        qty       REAL NOT NULL,
        remaining REAL NOT NULL,
        price_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_position_lots_mint ON position_lots (mint, seq);

      -- Journal des exécutions.
      CREATE TABLE IF NOT EXISTS trades (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms           INTEGER NOT NULL,
        mode            TEXT NOT NULL,
        strategy        TEXT NOT NULL,
        mint            TEXT NOT NULL,
        symbol          TEXT NOT NULL,
        side            TEXT NOT NULL,
        price_usd       REAL NOT NULL,
        qty             REAL NOT NULL,
        notional_usd    REAL NOT NULL,
        fee_usd         REAL NOT NULL DEFAULT 0,
        realized_pnl_usd REAL,
        reason          TEXT,
        signature       TEXT,
        status          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades (ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_mint_ts ON trades (mint, ts_ms DESC);

      -- Signaux émis par les stratégies.
      CREATE TABLE IF NOT EXISTS signals (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms             INTEGER NOT NULL,
        strategy          TEXT NOT NULL,
        mint              TEXT NOT NULL,
        symbol            TEXT NOT NULL,
        side              TEXT NOT NULL,
        confidence        REAL NOT NULL,
        expected_move_bps REAL NOT NULL,
        reason            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals (ts_ms DESC);

      -- Journal de décisions : la trace explicable du moteur.
      CREATE TABLE IF NOT EXISTS decisions (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms    INTEGER NOT NULL,
        tick_id  INTEGER NOT NULL,
        kind     TEXT NOT NULL,
        strategy TEXT,
        mint     TEXT,
        line     TEXT NOT NULL,
        data     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions (ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_decisions_kind ON decisions (kind, ts_ms DESC);

      -- Un point d'équité par tick.
      CREATE TABLE IF NOT EXISTS equity_curve (
        mode            TEXT NOT NULL,
        ts_ms           INTEGER NOT NULL,
        tick_id         INTEGER NOT NULL,
        nav_usd         REAL NOT NULL,
        cash_usd        REAL NOT NULL,
        positions_usd   REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL,
        drawdown_pct    REAL NOT NULL,
        PRIMARY KEY (mode, ts_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_equity_mode_ts ON equity_curve (mode, ts_ms);

      -- Runs de backtest, avec l'empreinte de la configuration testée.
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        created_ms     INTEGER NOT NULL,
        label          TEXT NOT NULL,
        config_hash    TEXT NOT NULL,
        config_json    TEXT NOT NULL,
        timeframe      TEXT NOT NULL,
        from_ms        INTEGER NOT NULL,
        to_ms          INTEGER NOT NULL,
        days           REAL NOT NULL,
        initial_usdc   REAL NOT NULL,
        mints_count    INTEGER NOT NULL,
        candles_count  INTEGER NOT NULL,
        trades_count   INTEGER NOT NULL,
        conclusive     INTEGER NOT NULL,
        metrics_json   TEXT NOT NULL,
        rejections_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_runs_hash ON backtest_runs (config_hash, conclusive);

      CREATE TABLE IF NOT EXISTS backtest_equity (
        run_id        INTEGER NOT NULL,
        ts_ms         INTEGER NOT NULL,
        nav_usd       REAL NOT NULL,
        cash_usd      REAL NOT NULL,
        positions_usd REAL NOT NULL,
        PRIMARY KEY (run_id, ts_ms)
      );
    `,
  },
  {
    version: 5,
    name: "backtest-trades",
    sql: `
      -- Trades clôturés d'un run de backtest.
      -- Le backtest s'exécute en base mémoire : sans cette table, le
      -- rapport ne pourrait pas afficher le win rate ni le profit factor.
      CREATE TABLE IF NOT EXISTS backtest_trades (
        run_id      INTEGER NOT NULL,
        ts_ms       INTEGER NOT NULL,
        mint        TEXT NOT NULL,
        side        TEXT NOT NULL,
        pnl_usd     REAL,
        notional_usd REAL NOT NULL,
        fee_usd     REAL NOT NULL DEFAULT 0,
        price_usd   REAL NOT NULL,
        qty         REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades (run_id, ts_ms);
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
