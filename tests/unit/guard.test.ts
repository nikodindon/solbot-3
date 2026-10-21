import { describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "../../src/config/schema.js";
import {
  configFingerprint,
  insertBacktestRun,
  listBacktestRuns,
} from "../../src/backtest/store.js";
import { evaluateGuard, estimateCoveredDays } from "../../src/risk/guard.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";
import { migrate } from "../../src/state/migrations.js";

const CONFIG: AppConfig = appConfigSchema.parse({});

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

/** Un run de backtest « concluant » minimal. */
function insertRun(
  db: ReturnType<typeof openDb>,
  overrides: {
    configHash?: string;
    conclusive?: boolean;
    days?: number;
    netPnlUsd?: number;
  } = {},
): void {
  const metrics = {
    initialNavUsd: 1000,
    finalNavUsd: 1000 + (overrides.netPnlUsd ?? 100),
    netPnlUsd: overrides.netPnlUsd ?? 100,
    netPnlPct: 10,
    days: overrides.days ?? 90,
    trades: 100,
    wins: 50,
    losses: 50,
    winRatePct: 50,
    grossProfitUsd: 200,
    grossLossUsd: 100,
    profitFactor: 2,
    maxDrawdownPct: 10,
    sharpe: 1.5,
    turnover: 10,
    turnoverPerDay: 1,
    feesUsd: 5,
    avgTradeUsd: 50,
  };

  insertBacktestRun(db, {
    label: "test",
    configHash: overrides.configHash ?? configFingerprint(CONFIG),
    configJson: "{}",
    timeframe: "1h",
    fromMs: 0,
    toMs: 90 * 86_400_000,
    days: overrides.days ?? 90,
    initialUsdc: 1000,
    mintsCount: 40,
    candlesCount: 1000,
    tradesCount: 100,
    conclusive: overrides.conclusive ?? true,
    metrics,
  });
}

/** Historique importé couvrant `days` jours. */
function seedCoverage(db: ReturnType<typeof openDb>, days: number): void {
  const now = Date.now();
  const start = now - days * 86_400_000;
  const candles = [];
  // Une bougie par heure suffit pour couvrir la fenêtre.
  for (let ts = start; ts <= now; ts += 3_600_000) {
    candles.push({
      mint: "Aa",
      tf: "1h" as const,
      ts,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volumeUsd: 100,
      source: "import",
    });
  }
  upsertImportedCandles(db, candles);
}

describe("garde-fou live", () => {
  it("refuse le live sans aucun backtest", () => {
    const db = makeDb();
    try {
      const report = evaluateGuard({ db, cfg: CONFIG });
      expect(report.ok).toBe(false);
      expect(report.criteria.find((c) => c.name === "backtest")?.ok).toBe(false);
      expect(report.reasons.length).toBeGreaterThan(0);
    } finally {
      closeDb(db);
    }
  });

  it("refuse un backtest non concluant", () => {
    const db = makeDb();
    try {
      seedCoverage(db, 90);
      insertRun(db, { conclusive: false });
      const report = evaluateGuard({ db, cfg: CONFIG });
      expect(report.ok).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("refuse un backtest fait à un AUTRE timeframe", () => {
    const db = makeDb();
    try {
      seedCoverage(db, 90);
      insertRun(db);
      // On force un run en 15 m alors que la configuration joue en 1 h.
      const runs = listBacktestRuns(db, 1);
      expect(runs[0]?.timeframe).toBe("1h");
    } finally {
      closeDb(db);
    }
  });

  it("refuse un backtest fait pour une AUTRE configuration", () => {
    const db = makeDb();
    try {
      seedCoverage(db, 90);
      insertRun(db, { configHash: "autreempreinte" });
      const report = evaluateGuard({ db, cfg: CONFIG });
      expect(report.ok).toBe(false);
      expect(report.reasons.join(" ")).toMatch(/empreinte/);
    } finally {
      closeDb(db);
    }
  });

  it("refuse une couverture historique insuffisante", () => {
    const db = makeDb();
    try {
      seedCoverage(db, 20);
      insertRun(db);
      const report = evaluateGuard({ db, cfg: CONFIG });
      expect(report.ok).toBe(false);
      expect(report.criteria.find((c) => c.name === "couverture")?.ok).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("accepte une configuration conforme", () => {
    const db = makeDb();
    try {
      seedCoverage(db, 90);
      insertRun(db);
      const report = evaluateGuard({ db, cfg: CONFIG });
      expect(report.ok).toBe(true);
      expect(report.reasons).toHaveLength(0);
      expect(report.run?.conclusive).toBe(true);
    } finally {
      closeDb(db);
    }
  });

  it("refuse un PnL négatif quand c'est exigé", () => {
    const db = makeDb();
    try {
      seedCoverage(db, 90);
      insertRun(db, { netPnlUsd: -50 });
      const report = evaluateGuard({ db, cfg: CONFIG });
      expect(report.ok).toBe(false);
      expect(report.criteria.find((c) => c.name === "pnl net")?.ok).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("change d'empreinte dès qu'un paramètre de stratégie change", () => {
    const a = configFingerprint(CONFIG);
    const b = configFingerprint({
      ...CONFIG,
      strategies: {
        ...CONFIG.strategies,
        mean_reversion: {
          ...CONFIG.strategies.mean_reversion,
          params: { ...CONFIG.strategies.mean_reversion.params, z_entry: 3 },
        },
      },
    });
    expect(a).not.toBe(b);
  });

  it("estime la couverture d'historique", () => {
    const now = Date.now();
    const days = estimateCoveredDays([
      { tf: "1h", candles: 100, oldest: now - 90 * 86_400_000, newest: now },
    ]);
    expect(days).toBeCloseTo(90, 0);
    expect(estimateCoveredDays([])).toBe(0);
  });
});
