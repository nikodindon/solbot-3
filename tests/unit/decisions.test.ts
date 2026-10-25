import { describe, expect, it } from "vitest";
import { closeDb, openDb, type DB } from "../../src/state/db.js";
import {
  decisionsJournalStats,
  dedupeDecisions,
  insertDecisions,
  listDecisions,
  type Decision,
} from "../../src/state/decisions.js";
import { migrate } from "../../src/state/migrations.js";

function makeDb(): DB {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

/** La même note écrite deux fois : c'est exactement le doublon observé. */
function note(mint: string, line: string): Decision {
  return { tsMs: 1_000, tickId: 1, kind: "note", strategy: "mean_reversion", mint, line };
}

describe("journal de décisions — dédoublonnage", () => {
  it("compte les copies strictes puis les supprime sans perte", () => {
    const db = makeDb();
    try {
      insertDecisions(db, [
        note("Aa", "écart de −8 % à la moyenne"),
        note("Aa", "écart de −8 % à la moyenne"),
        note("Aa", "écart de −8 % à la moyenne"),
        note("Bb", "écart de −8 % à la moyenne"),
      ]);

      const stats = decisionsJournalStats(db);
      expect(stats.total).toBe(4);
      // Un seul groupe (même tick, même texte, même actif) : `Bb` diffère.
      expect(stats.duplicateGroups).toBe(1);
      expect(stats.duplicateRows).toBe(2);

      expect(dedupeDecisions(db)).toBe(2);

      const after = decisionsJournalStats(db);
      expect(after.total).toBe(2);
      expect(after.duplicateGroups).toBe(0);
      expect(after.duplicateRows).toBe(0);
      // Les deux actifs distincts sont conservés.
      expect(
        listDecisions(db)
          .map((d) => d.mint)
          .sort(),
      ).toEqual(["Aa", "Bb"]);
    } finally {
      closeDb(db);
    }
  });

  it("ne confond pas deux ticks qui écrivent la même phrase", () => {
    const db = makeDb();
    try {
      const first = note("Aa", "écart de −8 % à la moyenne");
      const second: Decision = { ...first, tsMs: 2_000, tickId: 2 };

      insertDecisions(db, [first, second]);

      const stats = decisionsJournalStats(db);
      expect(stats.total).toBe(2);
      expect(stats.duplicateRows).toBe(0);
      expect(dedupeDecisions(db)).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("n'écrit pas deux fois un journal vide", () => {
    const db = makeDb();
    try {
      expect(decisionsJournalStats(db)).toEqual({ total: 0, duplicateGroups: 0, duplicateRows: 0 });
      expect(dedupeDecisions(db)).toBe(0);
    } finally {
      closeDb(db);
    }
  });
});
