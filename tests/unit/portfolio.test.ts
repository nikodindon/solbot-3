import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "../../src/state/db.js";
import {
  addLot,
  listLots,
  listPositions,
  reducePositionFifo,
  realizedPnlTotal,
  setStops,
  updatePeak,
} from "../../src/state/portfolio-repo.js";
import { migrate } from "../../src/state/migrations.js";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

describe("portefeuille FIFO", () => {
  it("ouvre une position et un lot", () => {
    const db = makeDb();
    try {
      const position = addLot(db, "Aa", "AAA", 100, 2, 1000);
      expect(position.qty).toBe(100);
      expect(position.investedUsd).toBe(200);
      expect(position.avgEntryUsd).toBe(2);
      expect(listPositions(db)).toHaveLength(1);
      expect(listLots(db, "Aa")).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });

  it("agrège les ajouts et recalcule le prix moyen", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000);
      const position = addLot(db, "Aa", "AAA", 100, 4, 2000);
      expect(position.qty).toBe(200);
      expect(position.investedUsd).toBe(600);
      expect(position.avgEntryUsd).toBe(3);
    } finally {
      closeDb(db);
    }
  });

  it("vend les plus anciens lots d'abord", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000); // lot ancien à 2 $
      addLot(db, "Aa", "AAA", 100, 4, 2000); // lot récent à 4 $
      const result = reducePositionFifo(db, "Aa", 100, 5, 3000);

      // Les 100 premières unités consommées sont celles à 2 $ → PnL de 300 $.
      expect(result.realizedPnlUsd).toBeCloseTo(300, 6);
      expect(result.soldQty).toBeCloseTo(100, 6);
      expect(result.position?.avgEntryUsd).toBeCloseTo(4, 6);
      expect(result.position?.qty).toBeCloseTo(100, 6);
    } finally {
      closeDb(db);
    }
  });

  it("clôture la position quand tout est vendu", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000);
      const result = reducePositionFifo(db, "Aa", 100, 3, 2000);
      expect(result.realizedPnlUsd).toBeCloseTo(100, 6);
      expect(result.position).toBeNull();
      expect(listPositions(db)).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("refuse de vendre plus que la position", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000);
      expect(() => reducePositionFifo(db, "Aa", 150, 3, 2000)).toThrow(/supérieure/);
    } finally {
      closeDb(db);
    }
  });

  it("ne dérive pas le coût de revient après de ventes partielles", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000);
      addLot(db, "Aa", "AAA", 100, 4, 2000);

      // On vend la moitié du lot ancien : il reste 50 à 2 $ et 100 à 4 $.
      // Le coût de revient consommé est celui du lot vendu (50 × 2 = 100 $),
      // pas une moyenne au prorata.
      reducePositionFifo(db, "Aa", 50, 3, 3000);
      const after1 = listPositions(db)[0];
      expect(after1?.avgEntryUsd).toBeCloseTo(500 / 150, 6);

      // Puis tout le lot ancien : il ne reste que le lot à 4 $.
      reducePositionFifo(db, "Aa", 50, 3, 4000);
      const after = listPositions(db)[0];
      expect(after?.avgEntryUsd).toBeCloseTo(4, 6);
      expect(after?.investedUsd).toBeCloseTo(400, 6);
      expect(after?.qty).toBeCloseTo(100, 6);
    } finally {
      closeDb(db);
    }
  });

  it("pose les stops et suit le plus haut historique", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000);
      setStops(db, "Aa", 1.8, 2.4, 1000);
      updatePeak(db, "Aa", 2.5, 1100);
      updatePeak(db, "Aa", 2.2, 1200);

      const position = listPositions(db)[0];
      expect(position?.stopLossUsd).toBe(1.8);
      expect(position?.takeProfitUsd).toBe(2.4);
      // Le pic ne redescend pas.
      expect(position?.peakPriceUsd).toBe(2.5);
    } finally {
      closeDb(db);
    }
  });

  it("cumule le PnL réalisé", () => {
    const db = makeDb();
    try {
      addLot(db, "Aa", "AAA", 100, 2, 1000);
      reducePositionFifo(db, "Aa", 50, 3, 2000);
      expect(realizedPnlTotal(db)).toBeCloseTo(50, 6);
    } finally {
      closeDb(db);
    }
  });
});
