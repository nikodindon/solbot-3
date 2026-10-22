import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../../src/config/schema.js";
import {
  gridFor,
  meanReversionGrid,
  optimizeParameters,
  type ParameterPoint,
} from "../../src/backtest/optimizer.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";

const CONFIG = appConfigSchema.parse({});

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

/** Un historique synthétique : tendance puis range, pour avoir de quoi trader. */
function seedHistory(db: ReturnType<typeof openDb>, count: number): void {
  const start = Date.UTC(2026, 0, 1);
  const candles = [];
  for (let i = 0; i < count; i++) {
    const phase = i < count / 2 ? i / count : (count - i) / count;
    const close = 100 * (1 + phase * 0.1 + Math.sin(i / 5) * 0.002);
    candles.push({
      mint: "Aa",
      tf: "1h" as const,
      ts: start + i * 3_600_000,
      open: close,
      high: close * 1.002,
      low: close * 0.998,
      close,
      volumeUsd: 1_000_000,
      source: "import" as const,
    });
  }
  upsertImportedCandles(db, candles);
}

describe("grille de paramètres", () => {
  it("propose une grille bornée pour mean_reversion", () => {
    const grid = meanReversionGrid(CONFIG);
    expect(grid.length).toBe(9);
    // Chaque point a un libellé lisible et un effet distinct.
    const labels = new Set(grid.map((point) => point.label));
    expect(labels.size).toBe(grid.length);
  });

  it("applique effectivement les paramètres au configuration", () => {
    const grid = meanReversionGrid(CONFIG);
    const point = grid.find((entry) => entry.label.includes("z=1.5"));
    const applied = point?.apply(CONFIG);
    expect(applied?.strategies.mean_reversion.params.z_entry).toBe(1.5);
  });

  it("choisit la grille selon la stratégie activée", () => {
    expect(gridFor(CONFIG)[0]?.label).toMatch(/mean_reversion/);
  });
});

describe("optimisation avec garde anti-surapprentissage", () => {
  it("refuse de valider quand le score d'entraînement est négatif", async () => {
    const db = makeDb();
    try {
      // Un historique plat : aucun jeu de paramètres ne gagne.
      const start = Date.UTC(2026, 0, 1);
      upsertImportedCandles(
        db,
        Array.from({ length: 200 }, (_, i) => ({
          mint: "Aa",
          tf: "1h" as const,
          ts: start + i * 3_600_000,
          open: 100,
          high: 100.01,
          low: 99.99,
          close: 100,
          volumeUsd: 1000,
          source: "import" as const,
        })),
      );

      const grid: ParameterPoint[] = meanReversionGrid(CONFIG).slice(0, 2);
      const result = await optimizeParameters({
        sourceDb: db,
        cfg: CONFIG,
        grid,
        trainFromMs: start,
        trainToMs: start + 100 * 3_600_000,
        testFromMs: start + 100 * 3_600_000,
        testToMs: start + 200 * 3_600_000,
        timeframe: "1h",
        mints: ["Aa"],
        minTrades: 1,
        maxDegradationRatio: 0.5,
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toBeTruthy();
    } finally {
      closeDb(db);
    }
  });

  it("écarte les candidats qui n'ont pas assez de trades", async () => {
    const db = makeDb();
    try {
      seedHistory(db, 100);
      const start = Date.UTC(2026, 0, 1);

      const result = await optimizeParameters({
        sourceDb: db,
        cfg: CONFIG,
        grid: meanReversionGrid(CONFIG).slice(0, 2),
        trainFromMs: start,
        trainToMs: start + 50 * 3_600_000,
        testFromMs: start + 50 * 3_600_000,
        testToMs: start + 100 * 3_600_000,
        timeframe: "1h",
        mints: ["Aa"],
        minTrades: 10_000, // seuil absurde : aucun candidat ne passe
        maxDegradationRatio: 0.5,
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toMatch(/trade/);
      expect(result.best).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("classe tous les candidats explorés", async () => {
    const db = makeDb();
    try {
      seedHistory(db, 200);
      const start = Date.UTC(2026, 0, 1);
      const grid = meanReversionGrid(CONFIG).slice(0, 3);

      const result = await optimizeParameters({
        sourceDb: db,
        cfg: CONFIG,
        grid,
        trainFromMs: start,
        trainToMs: start + 100 * 3_600_000,
        testFromMs: start + 100 * 3_600_000,
        testToMs: start + 200 * 3_600_000,
        timeframe: "1h",
        mints: ["Aa"],
        minTrades: 1,
        maxDegradationRatio: 0.5,
      });

      expect(result.candidates).toHaveLength(3);
      // Les candidats sont triés par score d'entraînement, décroissant.
      const pnl = result.candidates.map((c) => c.metrics.netPnlUsd);
      expect([...pnl].sort((a, b) => b - a)).toEqual(pnl);
    } finally {
      closeDb(db);
    }
  });
});
