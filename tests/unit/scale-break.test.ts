import { describe, expect, it } from "vitest";
import {
  dropScaleBreaks,
  getMergedCandles,
  SCALE_BREAK_FACTOR,
} from "../../src/state/imported-candles.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";
import { upsertCandles } from "../../src/state/market-data.js";
import { resolveSymbol } from "../../src/state/market-data.js";

const MINT = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

function candle(
  ts: number,
  close: number,
): {
  mint: string;
  tf: "1h";
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
  source: string;
} {
  return {
    mint: MINT,
    tf: "1h",
    ts,
    open: close,
    high: close,
    low: close,
    close,
    volumeUsd: 100,
    source: "import",
  };
}

describe("changement d'échelle (migration de pool)", () => {
  it("détecte une rupture et conserve la partie récente", () => {
    const base = Date.UTC(2026, 0, 1);
    const series = [
      ...Array.from({ length: 10 }, (_, i) => candle(base + i * 3_600_000, 1300)),
      ...Array.from({ length: 5 }, (_, i) => candle(base + (10 + i) * 3_600_000, 0.05)),
    ];

    const cleaned = dropScaleBreaks(series);

    // Seule la partie postérieure à la rupture est conservée.
    expect(cleaned).toHaveLength(5);
    expect(cleaned[0]?.close).toBeCloseTo(0.05, 6);
  });

  it("laisse passer une variation ordinaire", () => {
    const base = Date.UTC(2026, 0, 1);
    const series = [
      candle(base, 1),
      candle(base + 3_600_000, 1.1),
      candle(base + 7_200_000, 0.95),
      candle(base + 10_800_000, 1.2),
    ];
    expect(dropScaleBreaks(series)).toHaveLength(4);
  });

  it("ne coupe pas une hausse légitime", () => {
    const base = Date.UTC(2026, 0, 1);
    // ×30 en une heure : sous le seuil de 50.
    const series = [candle(base, 1), candle(base + 3_600_000, 30)];
    expect(dropScaleBreaks(series)).toHaveLength(2);
  });

  it("utilise un seuil élevé", () => {
    expect(SCALE_BREAK_FACTOR).toBeGreaterThanOrEqual(50);
  });

  it("protège la fusion complète : le z-score redevient plausible", () => {
    const db = makeDb();
    try {
      const base = Date.UTC(2026, 0, 1);
      // 100 bougies importées à 1 300 $ (ancienne unité)…
      upsertImportedCandles(
        db,
        Array.from({ length: 100 }, (_, i) => candle(base + i * 3_600_000, 1300)),
      );
      // …puis 20 bougies collectées à 0,05 $ (unité courante).
      upsertCandles(
        db,
        Array.from({ length: 20 }, (_, i) => ({
          mint: MINT,
          tf: "1h" as const,
          ts: base + (100 + i) * 3_600_000,
          open: 0.05,
          high: 0.05,
          low: 0.05,
          close: 0.05,
          volumeUsd: 100,
          ticks: 1,
        })),
      );

      const rows = getMergedCandles(db, MINT, "1h", {});
      const closes = rows.map((r) => r.close);
      const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
      const sigma = Math.sqrt(closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length);
      const z = sigma > 0 ? ((closes[closes.length - 1] ?? 0) - mean) / sigma : null;

      // Avant le correctif, z était de -8,5 (un « écart » de -99,99 %).
      expect(Math.abs(z ?? 99)).toBeLessThan(3);
    } finally {
      closeDb(db);
    }
  });
});

describe("symboles lisibles", () => {
  it("retourne le vrai symbole du token", () => {
    const db = makeDb();
    try {
      db.prepare(
        `INSERT INTO tokens
           (mint, symbol, name, decimals, is_verified, first_seen_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(MINT, "ANSEM", "Ansem", 6, 1, 0, 0);

      expect(resolveSymbol(db, MINT)).toBe("ANSEM");
    } finally {
      closeDb(db);
    }
  });

  it("retombe sur le symbole mémorisé si le token est inconnu", () => {
    const db = makeDb();
    try {
      expect(resolveSymbol(db, MINT, "MEMO")).toBe("MEMO");
      expect(resolveSymbol(db, MINT)).toBe("AaAa…");
    } finally {
      closeDb(db);
    }
  });
});
