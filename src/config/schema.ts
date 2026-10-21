import { z } from "zod";

/**
 * Schéma de configuration de solbot3.
 *
 * Principes :
 * - `strict` partout : une clé inconnue dans le YAML est une **erreur**, jamais
 *   un silence (un paramètre mal orthographié est un paramètre ignoré).
 * - Chaque feuille a une valeur par défaut : un `config.yaml` minimal reste valide.
 * - Les règles transverses (mode live, cohérence des paramètres) sont validées
 *   ici et nulle part ailleurs.
 */

// ── Types élémentaires ──────────────────────────────────────────────────────

export const MODES = ["paper", "dry_run", "live"] as const;
export type Mode = (typeof MODES)[number];

export const TIMEFRAMES = ["1m", "5m", "15m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const UNIVERSE_SOURCES = [
  "toptraded",
  "toporganicscore",
  "toptrending",
  "whitelist",
] as const;
export type UniverseSource = (typeof UNIVERSE_SOURCES)[number];

export const UNIVERSE_INTERVALS = ["5m", "1h", "6h", "24h"] as const;
export type UniverseInterval = (typeof UNIVERSE_INTERVALS)[number];

/**
 * Origines de prix acceptées pour une décision de trade.
 * `discovery` : liquidité récente remontée par Price v3.
 * `candle`    : bougie OHLCV.
 * `import`    : historique importé (GeckoTerminal) — reserved aux backtests.
 */
export const PRICE_SOURCES = ["discovery", "candle", "import"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const EXECUTION_PATHS = ["meta_aggregator", "router"] as const;
export type ExecutionPath = (typeof EXECUTION_PATHS)[number];

export const LANDING_TARGETS = ["rpc", "tx_jup", "jito"] as const;
export type LandingTarget = (typeof LANDING_TARGETS)[number];

export const NOTIFY_KINDS = ["trade", "error", "daily_report", "alert", "backup"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Un mint Solana fait 32 à 44 caractères en base58. */
const mintSchema = z
  .string()
  .min(32, "un mint doit faire au moins 32 caractères")
  .max(64, "un mint ne peut pas faire plus de 64 caractères")
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "un mint doit être encodé en base58");

const positiveInt = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.number().int().min(min).max(max);

const pct = (min: number, max: number) => z.number().min(min).max(max);

// ── Univers ─────────────────────────────────────────────────────────────────

export const universeSchema = z.strictObject({
  source: z.enum(UNIVERSE_SOURCES).default("toptraded"),
  interval: z.enum(UNIVERSE_INTERVALS).default("24h"),
  candidate_limit: positiveInt(1, 500).default(100),
  verified_only: z.boolean().default(true),
  min_liquidity_usd: z.number().min(0).default(250_000),
  min_organic_score: z.number().min(0).max(100).default(60),
  min_age_hours: z.number().min(0).default(24),
  blacklist_mints: z.array(mintSchema).default([]),
  whitelist_mints: z.array(mintSchema).default([]),
  max_watchlist: positiveInt(1, 500).default(40),
});

// ── Données de marché ───────────────────────────────────────────────────────

export const regimeSchema = z.strictObject({
  timeframe: z.enum(TIMEFRAMES).default("15m"),
  window: positiveInt(10, 5_000).default(48),
  trend_threshold_pct: z.number().min(0).default(4),
  range_max_pct: z.number().min(0).default(2.5),
});

export const dataSchema = z.strictObject({
  timeframes: z.array(z.enum(TIMEFRAMES)).min(1).default(["5m", "15m", "1h"]),
  stale_price_max_s: positiveInt(10).default(300),
  require_price_source: z.array(z.enum(PRICE_SOURCES)).min(1).default(["discovery", "candle"]),
  regime: regimeSchema.prefault({}),
});

// ── Stratégies ──────────────────────────────────────────────────────────────

export const trendBreakoutParamsSchema = z
  .strictObject({
    ema_fast: positiveInt(2).default(12),
    ema_slow: positiveInt(3).default(26),
    breakout_lookback: positiveInt(2).default(20),
    rsi_period: positiveInt(2).default(14),
    rsi_max: z.number().min(0).max(100).default(68),
    volume_mult: z.number().min(0).default(1.5),
    atr_stop_mult: z.number().min(0).default(2.0),
  })
  .refine((p) => p.ema_slow > p.ema_fast, {
    message: "ema_slow doit être strictement supérieur à ema_fast",
    path: ["ema_slow"],
  });

export const meanReversionParamsSchema = z
  .strictObject({
    window: positiveInt(5).default(96),
    z_entry: z.number().min(0).default(2.0),
    z_exit: z.number().min(0).default(0.5),
  })
  .refine((p) => p.z_exit < p.z_entry, {
    message: "z_exit doit être inférieur à z_entry",
    path: ["z_exit"],
  });

export const gridParamsSchema = z.strictObject({
  step_pct: z.number().min(0.01).default(1.0),
  levels: positiveInt(1, 50).default(5),
});

export const dcaRotationParamsSchema = z.strictObject({
  target_alloc: z.record(z.string(), z.number().min(0).max(1)).default({ SOL: 0.4, USDC: 0.6 }),
  drift_trigger_pct: z.number().min(0).default(5),
  topup_usdc: z.number().min(0).default(25),
});

export const relativeStrengthParamsSchema = z.strictObject({
  lookback_h: positiveInt(1).default(24),
  top_n: positiveInt(1, 50).default(3),
  rebalance_h: positiveInt(1).default(6),
});

export const strategyNames = [
  "trend_breakout",
  "mean_reversion",
  "grid",
  "dca_rotation",
  "relative_strength",
  "regime_switch",
] as const;
export type StrategyName = (typeof strategyNames)[number];

export const strategiesSchema = z.strictObject({
  trend_breakout: z
    .strictObject({
      enabled: z.boolean().default(false),
      timeframe: z.enum(TIMEFRAMES).default("1h"),
      params: trendBreakoutParamsSchema.prefault({}),
    })
    .prefault({}),
  mean_reversion: z
    .strictObject({
      enabled: z.boolean().default(true),
      timeframe: z.enum(TIMEFRAMES).default("1h"),
      params: meanReversionParamsSchema.prefault({}),
    })
    .prefault({}),
  grid: z
    .strictObject({
      enabled: z.boolean().default(false),
      timeframe: z.enum(TIMEFRAMES).default("15m"),
      params: gridParamsSchema.prefault({}),
    })
    .prefault({}),
  dca_rotation: z
    .strictObject({
      enabled: z.boolean().default(false),
      params: dcaRotationParamsSchema.prefault({}),
    })
    .prefault({}),
  relative_strength: z
    .strictObject({
      enabled: z.boolean().default(false),
      timeframe: z.enum(TIMEFRAMES).default("1h"),
      params: relativeStrengthParamsSchema.prefault({}),
    })
    .prefault({}),
  regime_switch: z
    .strictObject({
      enabled: z.boolean().default(false),
      params: z.strictObject({}).prefault({}),
    })
    .prefault({}),
});

// ── Allocateur (portefeuilles fantômes) ─────────────────────────────────────

export const allocatorSchema = z.strictObject({
  score_window_days: positiveInt(1).default(7),
  min_trades_to_score: positiveInt(1).default(10),
  hysteresis_pct: z.number().min(0).default(15),
  min_edge_over_costs: z.number().min(0).default(8.0),
  pilot_allocation_pct: pct(0, 100).default(100),
});

// ── Risque ──────────────────────────────────────────────────────────────────

export const trailingStopSchema = z.strictObject({
  activation_pct: z.number().min(0).default(8),
  retrace_pct: z.number().min(0).default(4),
});

export const riskSchema = z.strictObject({
  max_position_pct: pct(0, 100).default(5),
  max_positions: positiveInt(0, 100).default(6),
  max_asset_exposure_pct: pct(0, 100).default(15),
  daily_loss_limit_pct: pct(0, 100).default(3),
  max_drawdown_pct: pct(0, 100).default(15),
  stop_loss_pct: pct(0, 100).default(12),
  take_profit_pct: z.number().min(0).default(20),
  trailing_stop: trailingStopSchema.prefault({}),
  max_price_impact_pct: z.number().min(0).default(1.0),
  max_slippage_bps: positiveInt(1, 10_000).default(100),
  min_time_between_trades_s: positiveInt(0).default(300),
  sol_gas_reserve: z.number().min(0).default(0.05),
});

// ── Simulation (paper / dry-run) ───────────────────────────────────────────

export const paperSchema = z.strictObject({
  initial_usdc: z.number().min(0).default(1000),
  fill_slippage_bps: z.number().min(0).default(20),
  impact_k: z.number().min(0).default(0.5),
  priority_fee_sol: z.number().min(0).default(0.00005),
});

// ── Exécution (live) ────────────────────────────────────────────────────────

/** `rtse` (automatique Jupiter) | `adaptive` (borné par l'ATR) | une borne fixe en bps. */
export const slippageSchema = z.union([
  z.literal("rtse"),
  z.literal("adaptive"),
  positiveInt(1, 10_000),
]);

export const routerSchema = z.strictObject({
  landing: z.enum(LANDING_TARGETS).default("rpc"),
  tip_lamports: positiveInt(0).default(0),
  cu_limit_buffer: z.number().min(1).max(2).default(1.2),
  cu_price_cap_microlamports: positiveInt(0).default(0),
});

export const executionSchema = z.strictObject({
  path: z.enum(EXECUTION_PATHS).default("meta_aggregator"),
  slippage: slippageSchema.default("rtse"),
  retries: positiveInt(0, 10).default(3),
  retry_backoff_ms: positiveInt(0).default(750),
  confirm_timeout_s: positiveInt(1, 3_600).default(60),
  router: routerSchema.prefault({}),
});

// ── Backtest ────────────────────────────────────────────────────────────────

export const backtestSchema = z.strictObject({
  /**
   * Liquidité de repli, en USD, pour les actifs dont la liquidité n'est pas
   * connue.
   *
   * En backtest, la liquidité est **supposée statique** (README §9.5) : c'est
   * une des limites documentées du rejeu. On utilise la liquidité relevée au
   * scan quand elle existe, et ce repli sinon.
   */
  default_liquidity_usd: z.number().min(0).default(250_000),
  /** Capital de départ du run (indépendant du paper). */
  initial_usdc: z.number().min(0).default(1000),
});

// ── Protections on-chain (phase 7) ──────────────────────────────────────────

export const triggerSchema = z.strictObject({
  enabled: z.boolean().default(false),
  take_profit_orders: z.boolean().default(true),
  stop_loss_orders: z.boolean().default(false),
});

// ── Garde-fou live ──────────────────────────────────────────────────────────

export const guardSchema = z.strictObject({
  min_backtest_days: positiveInt(1).default(60),
  min_windows: positiveInt(1, 100).default(3),
  require_positive_oos_pnl: z.boolean().default(true),
  max_cost_sensitivity_drop_pct: pct(0, 100).default(40),
});

// ── Laboratoire (expériences isolées, paper uniquement) ─────────────────────

export const labSchema = z.strictObject({
  allow_no_stop: z.boolean().default(false),
  initial_usdc: z.number().min(0).default(100),
  max_bet_usd: z.number().min(0).default(1),
  database_path: z.string().default("./data/lab.sqlite"),
});

// ── Supervision ─────────────────────────────────────────────────────────────

export const telegramSchema = z.strictObject({
  enabled: z.boolean().default(false),
  notify_on: z.array(z.enum(NOTIFY_KINDS)).default(["trade", "error", "daily_report", "alert"]),
  commands_enabled: z.boolean().default(true),
  daily_report_utc_hour: positiveInt(0, 23).default(8),
});

export const notificationsSchema = z.strictObject({
  telegram: telegramSchema.prefault({}),
});

export const monitoringSchema = z.strictObject({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: positiveInt(1, 65_535).default(9464),
});

export const dashboardSchema = z.strictObject({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: positiveInt(1, 65_535).default(4200),
});

export const backupsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  dir: z.string().default("./data/backups"),
  keep: positiveInt(1, 365).default(14),
  daily_utc_hour: positiveInt(0, 23).default(3),
});

export const databaseSchema = z.strictObject({
  path: z.string().default("./data/solbot3.sqlite"),
});

// ── Configuration applicative ───────────────────────────────────────────────

export const appConfigSchema = z
  .strictObject({
    mode: z.enum(MODES).default("paper"),
    confirm_live: z.boolean().default(false),
    base_currency: z.string().min(1).default("USDC"),
    loop_interval_s: positiveInt(5, 3_600).default(30),

    universe: universeSchema.prefault({}),
    data: dataSchema.prefault({}),
    strategies: strategiesSchema.default(strategiesSchema.parse({})),
    allocator: allocatorSchema.prefault({}),
    risk: riskSchema.prefault({}),
    paper: paperSchema.prefault({}),
    execution: executionSchema.prefault({}),
    backtest: backtestSchema.prefault({}),
    trigger: triggerSchema.prefault({}),
    guard: guardSchema.prefault({}),
    lab: labSchema.prefault({}),
    notifications: notificationsSchema.prefault({}),
    monitoring: monitoringSchema.prefault({}),
    dashboard: dashboardSchema.prefault({}),
    backups: backupsSchema.prefault({}),
    database: databaseSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    // Le mode live est un double filet : `confirm_live` doit être posé à la main.
    if (cfg.mode === "live" && !cfg.confirm_live) {
      ctx.addIssue({
        code: "custom",
        path: ["confirm_live"],
        message: "le mode `live` exige `confirm_live: true` dans la configuration",
      });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
export type UniverseConfig = z.infer<typeof universeSchema>;
export type DataConfig = z.infer<typeof dataSchema>;
export type StrategiesConfig = z.infer<typeof strategiesSchema>;
export type AllocatorConfig = z.infer<typeof allocatorSchema>;
export type RiskConfig = z.infer<typeof riskSchema>;
export type PaperConfig = z.infer<typeof paperSchema>;
export type ExecutionConfig = z.infer<typeof executionSchema>;
export type BacktestConfig = z.infer<typeof backtestSchema>;
export type GuardConfig = z.infer<typeof guardSchema>;
export type LabConfig = z.infer<typeof labSchema>;
export type DashboardConfig = z.infer<typeof dashboardSchema>;
export type MonitoringConfig = z.infer<typeof monitoringSchema>;
export type BackupsConfig = z.infer<typeof backupsSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type NotificationsConfig = z.infer<typeof notificationsSchema>;

// ── Variables d'environnement ───────────────────────────────────────────────

const BS58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().min(1, "la variable ne doit pas être vide").optional(),
);

export const envSchema = z.looseObject({
  BS58_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(BS58_PATTERN, "clé privée invalide : attendu 64 octets en base58 (87 à 90 caractères)")
      .optional(),
  ),
  JUPITER_API_KEY: optionalString,
  JUPITER_RPS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive("JUPITER_RPS doit être > 0").optional(),
  ),
  SOLANA_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  SOLANA_RPC_FALLBACK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  GECKO_API_KEY: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  DASHBOARD_TOKEN: optionalString,
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  ),
});

export type AppEnv = z.infer<typeof envSchema>;

/** Valeur par défaut du débit Jupiter : 0,5 req/s sans clé, 1 req/s avec clé. */
export function defaultJupiterRps(apiKey: string | undefined): number {
  return apiKey ? 1 : 0.5;
}
