import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT } from "../../src/constants.js";
import type { AppConfig } from "../../src/config/schema.js";
import {
  Engine,
  MemoryStopSwitch,
  type MarketQuote,
  type MarketSource,
} from "../../src/engine/engine.js";
import { KvCash } from "../../src/execution/cash.js";
import { MemoryCandleSource } from "../../src/market/candles.js";
import { DEFAULT_COST_CONFIG } from "../../src/execution/costs.js";
import { PaperExecutor } from "../../src/execution/executor.js";
import { RiskManager } from "../../src/risk/risk-manager.js";
import { enabledStrategies } from "../../src/strategies/registry.js";
import { closeDb, openDb, type DB } from "../../src/state/db.js";
import { listDecisions } from "../../src/state/decisions.js";
import { listEquity } from "../../src/state/equity.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";
import { migrate } from "../../src/state/migrations.js";
import { listTrades } from "../../src/state/trades.js";

const CONFIG: AppConfig = {
  mode: "paper",
  confirm_live: false,
  base_currency: "USDC",
  loop_interval_s: 30,
  universe: {
    source: "toptraded",
    interval: "24h",
    candidate_limit: 100,
    verified_only: true,
    min_liquidity_usd: 250_000,
    min_organic_score: 60,
    min_age_hours: 24,
    blacklist_mints: [],
    whitelist_mints: [],
    max_watchlist: 40,
  },
  data: {
    timeframes: ["15m"],
    stale_price_max_s: 300,
    require_price_source: ["discovery", "candle"],
    regime: { timeframe: "15m", window: 48, trend_threshold_pct: 4, range_max_pct: 2.5 },
  },
  strategies: {
    trend_breakout: {
      enabled: true,
      timeframe: "15m",
      params: {
        ema_fast: 12,
        ema_slow: 26,
        breakout_lookback: 20,
        rsi_period: 14,
        rsi_max: 100,
        volume_mult: 0,
        atr_stop_mult: 2,
      },
    },
    mean_reversion: {
      enabled: false,
      timeframe: "15m",
      params: { window: 96, z_entry: 2, z_exit: 0.5 },
    },
    grid: { enabled: false, timeframe: "15m", params: { step_pct: 1, levels: 5 } },
    dca_rotation: {
      enabled: false,
      params: { target_alloc: { SOL: 0.4, USDC: 0.6 }, drift_trigger_pct: 5, topup_usdc: 25 },
    },
    relative_strength: {
      enabled: false,
      timeframe: "1h",
      params: { lookback_h: 24, top_n: 3, rebalance_h: 6 },
    },
    regime_switch: { enabled: false, params: {} },
  },
  allocator: {
    score_window_days: 7,
    min_trades_to_score: 10,
    hysteresis_pct: 15,
    min_edge_over_costs: 3,
    pilot_allocation_pct: 100,
  },
  risk: {
    max_position_pct: 5,
    max_positions: 6,
    max_asset_exposure_pct: 15,
    daily_loss_limit_pct: 3,
    max_drawdown_pct: 15,
    stop_loss_pct: 8,
    take_profit_pct: 15,
    trailing_stop: { activation_pct: 6, retrace_pct: 3 },
    max_price_impact_pct: 1,
    max_slippage_bps: 100,
    max_expected_move_bps: 5_000,
    min_time_between_trades_s: 0,
    sol_gas_reserve: 0.05,
  },
  paper: { initial_usdc: 1000, fill_slippage_bps: 20, impact_k: 0.5, priority_fee_sol: 0.00005 },
  backtest: { default_liquidity_usd: 250_000, initial_usdc: 1000 },
  execution: {
    path: "meta_aggregator",
    slippage: "rtse",
    slippage_adaptive: {
      timeframe: "15m",
      period: 14,
      multiplier: 1,
      min_bps: 10,
      max_bps: 100,
    },
    retries: 3,
    retry_backoff_ms: 750,
    confirm_timeout_s: 60,
    router: {
      landing: "rpc",
      tip_lamports: 0,
      cu_limit_buffer: 1.2,
      cu_price_cap_microlamports: 0,
    },
  },
  trigger: { enabled: false, take_profit_orders: true, stop_loss_orders: false },
  guard: {
    min_backtest_days: 60,
    min_windows: 3,
    require_positive_oos_pnl: true,
    max_cost_sensitivity_drop_pct: 40,
  },
  lab: {
    allow_no_stop: false,
    initial_usdc: 100,
    max_bet_usd: 1,
    database_path: "./data/lab.sqlite",
  },
  notifications: {
    telegram: {
      enabled: false,
      notify_on: ["trade", "error", "daily_report", "alert"],
      commands_enabled: true,
      daily_report_utc_hour: 8,
    },
  },
  monitoring: { enabled: true, host: "127.0.0.1", port: 9464 },
  dashboard: { enabled: true, host: "127.0.0.1", port: 4200 },
  backups: { enabled: true, dir: "./data/backups", keep: 14, daily_utc_hour: 3 },
  database: { path: "./data/solbot3.sqlite" },
};

const MINT = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const START = Date.UTC(2026, 0, 1);

/** Série de bougies : une hausse, puis une cassure. */
function buildCandles(count: number): { ts: number; close: number }[] {
  const out: { ts: number; close: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ ts: START + i * 900_000, close: 1 + i * 0.005 });
  }
  return out;
}

function makeDb(): DB {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

function seedCandles(db: DB, candles: { ts: number; close: number }[]): void {
  upsertImportedCandles(
    db,
    candles.map((c) => ({
      mint: MINT,
      tf: "15m" as const,
      ts: c.ts,
      open: c.close,
      high: c.close,
      low: c.close,
      close: c.close,
      volumeUsd: 1_000,
      source: "import",
    })),
  );
}

/**
 * Source de marché qui rejoue une série de prix.
 *
 * Elle porte sa propre horloge : chaque `pollOnce` avance d'un cran. C'est
 * ainsi que le moteur rejoue le temps en backtest.
 */
class ScriptedMarket implements MarketSource {
  index = 0;
  currentTs = START;

  constructor(private readonly quotes: Map<string, MarketQuote>[]) {}

  pollOnce(): Promise<Map<string, MarketQuote>> {
    const quote = this.quotes[this.index] ?? new Map();
    this.index = Math.min(this.index + 1, this.quotes.length - 1);
    // L'horloge pointe vers le **prochain** tick : le moteur la lit avant
    // d'interroger le marché, les deux restent donc alignés.
    this.currentTs = START + this.index * 900_000;
    return Promise.resolve(quote);
  }
}

function buildEngine(
  db: DB,
  market: ScriptedMarket,
  mode: "paper" | "backtest",
  candles: { ts: number; close: number }[],
): Engine {
  const cash = new KvCash(db, 1000);
  cash.seed(1000);
  const costs = DEFAULT_COST_CONFIG;
  const executor = new PaperExecutor({ db, mode, cash, costs });
  const risk = new RiskManager(CONFIG.risk, CONFIG.allocator, costs);

  return new Engine({
    db,
    cfg: CONFIG,
    mode,
    strategies: enabledStrategies(CONFIG.strategies),
    market,
    candles: new MemoryCandleSource(
      candles.map((c) => ({
        mint: MINT,
        tf: "15m" as const,
        ts: c.ts,
        open: c.close,
        high: c.close,
        low: c.close,
        close: c.close,
        volumeUsd: 1_000,
        source: "import",
      })),
    ),
    executor,
    risk,
    cash,
    stop: new MemoryStopSwitch(),
    clock: () => market.currentTs,
  });
}

describe("moteur", () => {
  it("journalise un point d'équité par tick", async () => {
    const db = makeDb();
    try {
      const candles = buildCandles(5);
      seedCandles(db, candles);
      const quotes = candles.map(
        (c) =>
          new Map([
            [MINT, { priceUsd: c.close, liquidityUsd: 10_000_000 }],
            [SOL_MINT, { priceUsd: 100, liquidityUsd: 100_000_000 }],
            [USDC_MINT, { priceUsd: 1, liquidityUsd: 100_000_000 }],
          ]),
      );

      const engine = buildEngine(db, new ScriptedMarket(quotes), "paper", candles);
      for (const _candle of candles) {
        await engine.runTick();
      }

      const equity = listEquity(db, { mode: "paper" });
      expect(equity.length).toBe(candles.length);
      expect(equity[0]?.navUsd).toBeCloseTo(1000, 6);
    } finally {
      closeDb(db);
    }
  });

  it("produit les mêmes décisions en backtest et en paper", async () => {
    // C'est LA propriété centrale du projet : le backtest rejoue le moteur
    // réel. Même scénario, mêmes décisions.
    const candles = buildCandles(30);
    const quotes = candles.map(
      (c) =>
        new Map([
          [MINT, { priceUsd: c.close * 1.02, liquidityUsd: 10_000_000 }],
          [SOL_MINT, { priceUsd: 100, liquidityUsd: 100_000_000 }],
          [USDC_MINT, { priceUsd: 1, liquidityUsd: 100_000_000 }],
        ]),
    );

    const run = async (mode: "paper" | "backtest") => {
      const db = makeDb();
      try {
        seedCandles(db, candles);
        const engine = buildEngine(db, new ScriptedMarket(quotes), mode, candles);
        for (let i = 0; i < candles.length; i++) {
          await engine.runTick();
        }
        const decisions = listDecisions(db, { limit: 1000 })
          .filter((d) => d.kind === "signal" || d.kind === "trade" || d.kind === "reject")
          .map((d) => `${d.kind}|${d.mint ?? ""}|${d.line}`)
          .sort();
        const trades = listTrades(db, { mode, limit: 1000 }).map(
          (t) => `${t.side}|${t.mint}|${t.qty}|${t.priceUsd.toFixed(8)}`,
        );
        const equity = listEquity(db, { mode }).map((e) => e.navUsd.toFixed(8));
        return { decisions, trades, equity };
      } finally {
        closeDb(db);
      }
    };

    const paper = await run("paper");
    const backtest = await run("backtest");

    expect(backtest.decisions).toEqual(paper.decisions);
    expect(backtest.trades).toEqual(paper.trades);
    expect(backtest.equity).toEqual(paper.equity);
  });

  it("coupe les entrées mais laisse sortir quand le kill-switch est actif", async () => {
    const db = makeDb();
    try {
      const candles = buildCandles(10);
      seedCandles(db, candles);
      const quotes = candles.map(
        (c) =>
          new Map([
            [MINT, { priceUsd: c.close, liquidityUsd: 10_000_000 }],
            [SOL_MINT, { priceUsd: 100, liquidityUsd: 100_000_000 }],
          ]),
      );

      const engine = buildEngine(db, new ScriptedMarket(quotes), "paper", candles);
      // Le kill-switch est levé avant le premier tick.
      engine.triggerKillSwitch();
      await engine.runTick();

      const decisions = listDecisions(db, { limit: 100 });
      expect(decisions.some((d) => d.kind === "guard")).toBe(true);
      expect(listTrades(db, { mode: "paper" })).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("ignore un tick concurrent", async () => {
    const db = makeDb();
    try {
      const candles = buildCandles(3);
      seedCandles(db, candles);
      const quotes = candles.map(
        (c) => new Map([[MINT, { priceUsd: c.close, liquidityUsd: 10_000_000 }]]),
      );

      const engine = buildEngine(db, new ScriptedMarket(quotes), "paper", candles);
      const [a, b] = await Promise.all([engine.runTick(), engine.runTick()]);
      const skipped = [a, b].filter((r) => r.error?.includes("concurrent"));
      expect(skipped).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });
});
