import { describe, expect, it } from "vitest";
import { runBacktest, buildSamples } from "../../src/backtest/runner.js";
import { configFingerprint } from "../../src/backtest/store.js";
import { closeDb, openDb, type DB } from "../../src/state/db.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";
import { migrate } from "../../src/state/migrations.js";
import { appConfigSchema, type AppConfig } from "../../src/config/schema.js";

const CONFIG: AppConfig = appConfigSchema.parse({
  mode: "paper",
  strategies: {
    trend_breakout: {
      enabled: true,
      params: { ema_fast: 12, ema_slow: 26, rsi_max: 100, volume_mult: 0 },
    },
    mean_reversion: { enabled: false },
    grid: { enabled: false },
    dca_rotation: { enabled: false },
    relative_strength: { enabled: false },
    regime_switch: { enabled: false },
  },
  risk: { min_time_between_trades_s: 0, max_position_pct: 5 },
  paper: { initial_usdc: 1000, fill_slippage_bps: 20, impact_k: 0.5, priority_fee_sol: 0.00005 },
  allocator: { min_edge_over_costs: 0.5 },
});

const MINT = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const STEP = 900_000; // 15 min

function makeDb(): DB {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

/** Historique synthétique : hausse puis repli. */
function seedHistory(db: DB, count: number): void {
  const start = Date.now() - count * STEP;
  const candles = [];
  for (let i = 0; i < count; i++) {
    const close =
      i < count * 0.7 ? 1 + i * 0.002 : 1 + count * 0.7 * 0.002 - (i - count * 0.7) * 0.004;
    candles.push({
      mint: MINT,
      tf: "15m" as const,
      ts: start + i * STEP,
      open: close,
      high: close * 1.002,
      low: close * 0.998,
      close,
      volumeUsd: 1_000,
      source: "import",
    });
  }
  upsertImportedCandles(db, candles);
}

describe("backtest", () => {
  it("rejoue le moteur sur l'historique et produit une courbe d'équité", async () => {
    const db = makeDb();
    try {
      seedHistory(db, 200);

      const result = await runBacktest({
        sourceDb: db,
        cfg: CONFIG,
        days: 2,
        timeframe: "15m",
        initialUsdc: 1000,
        mints: [MINT],
      });

      expect(result.ok).toBe(true);
      expect(result.equity.length).toBeGreaterThan(100);
      expect(result.metrics.initialNavUsd).toBeCloseTo(1000, 6);
      // La courbe d'équité est continue : pas de trou.
      for (let i = 1; i < result.equity.length; i++) {
        expect(result.equity[i].tsMs).toBeGreaterThan(result.equity[i - 1].tsMs);
      }
      result.close();
    } finally {
      closeDb(db);
    }
  });

  it("n'altère jamais la base source", async () => {
    const db = makeDb();
    try {
      seedHistory(db, 50);
      const before = db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number };

      const result = await runBacktest({
        sourceDb: db,
        cfg: CONFIG,
        days: 1,
        timeframe: "15m",
        mints: [MINT],
      });
      result.close();

      const after = db.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number };
      expect(after.n).toBe(before.n);
      expect(after.n).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("échoue proprement quand il n'y a aucune bougie", async () => {
    const db = makeDb();
    try {
      const result = await runBacktest({
        sourceDb: db,
        cfg: CONFIG,
        days: 30,
        timeframe: "15m",
        mints: [MINT],
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/backtest import/);
      result.close();
    } finally {
      closeDb(db);
    }
  });

  it("construit des échantillons de marché à partir des bougies", () => {
    const db = makeDb();
    try {
      seedHistory(db, 10);
      const samples = buildSamples(db, [MINT], "15m", Date.now() - 10 * STEP, Date.now(), 250_000);
      expect(samples.length).toBe(10);
      // La liquidité de repli est appliquée quand elle est inconnue.
      expect(samples[0]?.quotes.get(MINT)?.liquidityUsd).toBe(250_000);
    } finally {
      closeDb(db);
    }
  });

  it("donne une empreinte stable à une configuration, et différente sinon", () => {
    const a = configFingerprint(CONFIG);
    const b = configFingerprint(CONFIG);
    expect(a).toBe(b);
    expect(a).toHaveLength(16);

    const changed = configFingerprint({
      ...CONFIG,
      strategies: {
        ...CONFIG.strategies,
        trend_breakout: {
          ...CONFIG.strategies.trend_breakout,
          params: { ...CONFIG.strategies.trend_breakout.params, ema_slow: 40 },
        },
      },
    });
    expect(changed).not.toBe(a);
  });
});
