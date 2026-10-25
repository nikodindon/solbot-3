import { describe, expect, it } from "vitest";
import {
  attestNavPeak,
  firstEquityPoint,
  insertEquityPoint,
  listEquity,
} from "../../src/state/equity.js";
import { closeDb, openDb, type DB } from "../../src/state/db.js";
import { kvSetNumber, STATE_KEYS } from "../../src/state/kv.js";
import { migrate } from "../../src/state/migrations.js";

function makeDb(): DB {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

/** Écrit une suite de points d'équité pour un mode. */
function seedCurve(db: DB, mode: string, navs: number[], fromMs = 1_000): void {
  navs.forEach((navUsd, index) => {
    insertEquityPoint(db, {
      mode,
      tsMs: fromMs + index * 30_000,
      tickId: index + 1,
      navUsd,
      cashUsd: navUsd,
      positionsUsd: 0,
      realizedPnlUsd: 0,
      drawdownPct: 0,
    });
  });
}

describe("pic d'équité attesté par la courbe", () => {
  it("retient un pic que la courbe confirme", () => {
    const db = makeDb();
    try {
      seedCurve(db, "paper", [1000, 1005, 1003]);
      kvSetNumber(db, STATE_KEYS.navPeakUsd, 1005, 3_000);

      const result = attestNavPeak(db, "paper", 1002);
      expect(result.peakUsd).toBeCloseTo(1005, 6);
      expect(result.discardedPeakUsd).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("écarte un pic que la courbe n'a jamais atteint", () => {
    const db = makeDb();
    try {
      // Le compte a été réinitialisé : la courbe repart à 1000 $, mais le
      // cache `nav_peak_usd` garde le pic de l'ancien compte. Le bot
      // affichait alors 15,9 % de drawdown au lieu de 3,7 %.
      seedCurve(db, "paper", [1000, 1003.46, 998]);
      kvSetNumber(db, STATE_KEYS.navPeakUsd, 1149.17, 3_000);

      const result = attestNavPeak(db, "paper", 966.28);
      expect(result.discardedPeakUsd).toBeCloseTo(1149.17, 6);
      expect(result.peakUsd).toBeCloseTo(1003.46, 6);
    } finally {
      closeDb(db);
    }
  });

  it("garde le NAV courant quand c'est le nouveau plus haut", () => {
    const db = makeDb();
    try {
      // Le point du tick en cours n'est écrit qu'à la fin du tick : le NAV
      // courant fait foi, même s'il dépasse déjà le maximum de la courbe.
      seedCurve(db, "paper", [1000, 1002]);
      kvSetNumber(db, STATE_KEYS.navPeakUsd, 1002, 3_000);

      const result = attestNavPeak(db, "paper", 1010);
      expect(result.peakUsd).toBeCloseTo(1010, 6);
      expect(result.discardedPeakUsd).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("ne juge pas un pic sans courbe — rien pour l'attester", () => {
    const db = makeDb();
    try {
      // Courbe vide : on ne peut rien prouver, on conserve le cache.
      kvSetNumber(db, STATE_KEYS.navPeakUsd, 1149.17, 3_000);

      const result = attestNavPeak(db, "paper", 966.28);
      expect(result.peakUsd).toBeCloseTo(1149.17, 6);
      expect(result.discardedPeakUsd).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("n'oublie pas les pics d'un autre mode", () => {
    const db = makeDb();
    try {
      seedCurve(db, "backtest", [5000]);
      seedCurve(db, "paper", [1000, 1004]);
      kvSetNumber(db, STATE_KEYS.navPeakUsd, 1004, 3_000);

      const result = attestNavPeak(db, "paper", 1000);
      expect(result.peakUsd).toBeCloseTo(1004, 6);
      expect(result.discardedPeakUsd).toBeNull();
      // La courbe du backtest n'entre pas en ligne de compte.
      expect(listEquity(db, { mode: "paper" })).toHaveLength(2);
    } finally {
      closeDb(db);
    }
  });
});

describe("départ du run", () => {
  it("retient le premier point de la courbe, pas celui de la fenêtre affichée", () => {
    const db = makeDb();
    try {
      seedCurve(db, "paper", [1000, 1005, 1003]);

      const first = firstEquityPoint(db, "paper");
      expect(first?.navUsd).toBe(1000);
      expect(first?.tsMs).toBe(1_000);

      // La fenêtre d'affichage est tronquée : son premier point est le
      // début de la fenêtre, pas le début du run.
      expect(listEquity(db, { mode: "paper", limit: 2 })[0]?.navUsd).toBe(1005);

      // Une autre courbe (ou un mode sans données) n'a pas de départ.
      expect(firstEquityPoint(db, "backtest")).toBeNull();
    } finally {
      closeDb(db);
    }
  });
});
