import { describe, expect, it } from "vitest";
import { buildDashboardState } from "../../src/dashboard/state.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { insertEquityPoint } from "../../src/state/equity.js";
import { insertShadowNav } from "../../src/allocator/shadow.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";
import { SOL_MINT } from "../../src/constants.js";

const CONFIG = { mode: "paper", stalePriceMaxS: 300, timeframes: ["1h"] };

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

describe("séries de graphiques", () => {
  it("produit des séries alignées pour le NAV, le cash et la référence", () => {
    const db = makeDb();
    try {
      for (let i = 0; i < 5; i++) {
        insertEquityPoint(db, {
          mode: "paper",
          tsMs: 1_700_000_000_000 + i * 3_600_000,
          tickId: i,
          navUsd: 1000 + i * 10,
          cashUsd: 900,
          positionsUsd: 100 + i * 10,
          realizedPnlUsd: 0,
          drawdownPct: 0,
        });
      }

      // Un historique SOL pour la référence buy & hold.
      const candles = [];
      for (let i = 0; i < 5; i++) {
        candles.push({
          mint: SOL_MINT,
          tf: "1h" as const,
          ts: 1_700_000_000_000 + i * 3_600_000,
          open: 100,
          high: 100,
          low: 100,
          close: 100 + i * 5,
          volumeUsd: 100,
          source: "import" as const,
        });
      }
      upsertImportedCandles(db, candles);

      const state = buildDashboardState(db, CONFIG, 1_700_000_000_000 + 5 * 3_600_000);

      expect(state.charts.time).toHaveLength(5);
      expect(state.charts.nav).toHaveLength(5);
      expect(state.charts.cash).toHaveLength(5);
      expect(state.charts.benchmark).toHaveLength(5);
      // La référence est normalisée sur le NAV initial.
      expect(state.charts.benchmark[0]).toBeCloseTo(1000, 6);
      expect(state.charts.benchmark[4]).toBeCloseTo(1200, 6);
    } finally {
      closeDb(db);
    }
  });

  it("expose une série par stratégie en shadow", () => {
    const db = makeDb();
    try {
      for (let i = 0; i < 3; i++) {
        insertShadowNav(db, "mean_reversion", 1_700_000_000_000 + i * 60_000, 1000 + i);
        insertShadowNav(db, "trend_breakout", 1_700_000_000_000 + i * 60_000, 990 - i);
      }

      const state = buildDashboardState(db, CONFIG, 1_700_000_000_000 + 300_000);

      expect(state.charts.shadows).toHaveLength(2);
      const meanRev = state.charts.shadows.find((s) => s.name === "mean_reversion");
      expect(meanRev?.nav).toHaveLength(3);
      expect(meanRev?.nav[2]).toBeCloseTo(1002, 6);
    } finally {
      closeDb(db);
    }
  });
});
