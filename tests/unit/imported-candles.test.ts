import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "../../src/state/db.js";
import {
  closeAtOrBefore,
  getMergedCandles,
  importedCoverage,
  upsertImportedCandles,
} from "../../src/state/imported-candles.js";
import { migrate } from "../../src/state/migrations.js";
import { upsertCandles } from "../../src/state/market-data.js";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

function imported(ts: number, close: number, volumeUsd: number | null = 100) {
  return {
    mint: "Aa",
    tf: "15m" as const,
    ts,
    open: close,
    high: close,
    low: close,
    close,
    volumeUsd,
    source: "geckoterminal",
  };
}

describe("bougies importées", () => {
  it("stocke et relit l'historique importé", () => {
    const db = makeDb();
    try {
      upsertImportedCandles(db, [imported(0, 1), imported(900_000, 2)]);
      const rows = getMergedCandles(db, "Aa", "15m");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.close).toBe(1);
      expect(rows[1]?.close).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  it("donne la priorité à l'import sur le live", () => {
    const db = makeDb();
    try {
      upsertImportedCandles(db, [imported(0, 10, 500)]);
      upsertCandles(db, [
        {
          mint: "Aa",
          tf: "15m",
          ts: 0,
          open: 9,
          high: 9,
          low: 9,
          close: 9,
          volumeUsd: 42,
          ticks: 1,
        },
      ]);

      const rows = getMergedCandles(db, "Aa", "15m");
      expect(rows).toHaveLength(1);
      // L'OHLC vient de l'import…
      expect(rows[0]?.close).toBe(10);
      // …mais le volume importé est prioritaire quand il existe.
      expect(rows[0]?.volumeUsd).toBe(500);
      expect(rows[0]?.source).toBe("import");
    } finally {
      closeDb(db);
    }
  });

  it("complète avec le live pour les bougies absentes de l'import", () => {
    const db = makeDb();
    try {
      upsertImportedCandles(db, [imported(0, 10)]);
      upsertCandles(db, [
        {
          mint: "Aa",
          tf: "15m",
          ts: 900_000,
          open: 9,
          high: 9,
          low: 9,
          close: 9,
          volumeUsd: 7,
          ticks: 1,
        },
      ]);

      const rows = getMergedCandles(db, "Aa", "15m");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.source).toBe("import");
      expect(rows[1]?.source).toBe("live");
      expect(rows[1]?.close).toBe(9);
    } finally {
      closeDb(db);
    }
  });

  it("respecte la fenêtre temporelle demandée", () => {
    const db = makeDb();
    try {
      upsertImportedCandles(db, [imported(0, 1), imported(900_000, 2), imported(1_800_000, 3)]);
      const rows = getMergedCandles(db, "Aa", "15m", { fromMs: 900_000, toMs: 1_800_000 });
      expect(rows.map((r) => r.close)).toEqual([2, 3]);
    } finally {
      closeDb(db);
    }
  });

  it("expose la couverture par timeframe", () => {
    const db = makeDb();
    try {
      upsertImportedCandles(db, [imported(0, 1), imported(900_000, 2)]);
      const coverage = importedCoverage(db);
      expect(coverage).toHaveLength(1);
      expect(coverage[0]).toMatchObject({ tf: "15m", mints: 1, candles: 2 });
    } finally {
      closeDb(db);
    }
  });

  it("trouve le dernier close connu au plus tard à une date", () => {
    const rows = [imported(0, 1), imported(900_000, 2), imported(1_800_000, 3)];

    expect(closeAtOrBefore(rows, 0)).toBe(1);
    expect(closeAtOrBefore(rows, 1_799_999)).toBe(2);
    expect(closeAtOrBefore(rows, 1_800_000)).toBe(3);
    // Avant toute donnée, ou sur une série vide : rien à dire.
    expect(closeAtOrBefore(rows, -1)).toBeNull();
    expect(closeAtOrBefore([], 0)).toBeNull();
  });
});
