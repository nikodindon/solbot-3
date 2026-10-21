import { describe, expect, it } from "vitest";
import { choosePilot, maxDrawdown, scoreShadow } from "../../src/allocator/allocator.js";
import {
  insertShadowNav,
  insertShadowTrade,
  loadShadowBook,
  shadowNav,
  shadowNavSeries,
  shadowTradeCount,
} from "../../src/allocator/shadow.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

function navSeries(values: number[]): { tsMs: number; navUsd: number }[] {
  return values.map((nav, index) => ({ tsMs: index * 1000, navUsd: nav }));
}

describe("score d'un shadow", () => {
  it("calcule la performance sur la fenêtre", () => {
    const score = scoreShadow("s", navSeries([100, 110, 120]), 12, 10);
    expect(score.scorePct).toBeCloseTo(20, 6);
    expect(score.trades).toBe(12);
    expect(score.eligible).toBe(true);
  });

  it("est ineligible sous le seuil d'échantillon", () => {
    const score = scoreShadow("s", navSeries([100, 110]), 3, 10);
    expect(score.eligible).toBe(false);
    expect(score.reason).toMatch(/3 trade/);
  });

  it("est ineligible sans point de NAV", () => {
    const score = scoreShadow("s", [], 0, 10);
    expect(score.eligible).toBe(false);
    expect(score.reason).toMatch(/aucun point/);
  });

  it("mesure le drawdown maximal", () => {
    expect(maxDrawdown(navSeries([100, 120, 90, 110]))).toBeCloseTo(25, 6);
  });
});

describe("choix de la stratégie pilote", () => {
  const eligible = (name: string, scorePct: number) => ({
    name,
    scorePct,
    trades: 20,
    startNav: 1000,
    endNav: 1000 * (1 + scorePct / 100),
    maxDrawdownPct: 5,
    eligible: true,
    reason: null,
  });

  it("prend la meilleure stratégie quand il n'y a pas de pilote en place", () => {
    const decision = choosePilot([eligible("a", 5), eligible("b", 12)], null, 15);
    expect(decision.pilot).toBe("b");
    expect(decision.changed).toBe(true);
  });

  it("respecte l'hystérésis : un challenger insuffisant ne prend pas le relais", () => {
    // b est 20 % au-dessus de a : 12 % > 5 % × 1,15 = 5,75 %… le
    // challenger devrait passer. Prenons un cas où il ne passe pas.
    const decision = choosePilot([eligible("a", 10), eligible("b", 11)], "a", 15);
    expect(decision.pilot).toBe("a");
    expect(decision.changed).toBe(false);
  });

  it("change de pilote quand le challenger dépasse l'hystérésis", () => {
    const decision = choosePilot([eligible("a", 5), eligible("b", 25)], "a", 15);
    expect(decision.pilot).toBe("b");
    expect(decision.changed).toBe(true);
    expect(decision.previousPilot).toBe("a");
  });

  it("change de pilote même avec un score négatif si l'écart relatif le justifie", () => {
    // a = -10 %, b = -2 % : -2 > -10 × 1,15 = -11,5 → b prend le relais.
    const decision = choosePilot([eligible("a", -10), eligible("b", -2)], "a", 15);
    expect(decision.pilot).toBe("b");
    expect(decision.changed).toBe(true);
  });

  it("ignore les stratégies inéligibles", () => {
    const ineligible = { ...eligible("a", 50), eligible: false, reason: "trop peu de trades" };
    const decision = choosePilot([ineligible, eligible("b", 1)], null, 15);
    expect(decision.pilot).toBe("b");
  });

  it("remplace une pilote devenue ineligible, sans condition d'hystérésis", () => {
    const scores = [
      { ...eligible("a", 50), eligible: false, reason: "trop peu de trades" },
      eligible("b", 1),
    ];
    const decision = choosePilot(scores, "a", 15);
    expect(decision.pilot).toBe("b");
    expect(decision.changed).toBe(true);
  });

  it("ne bloque pas le trading quand il n'y a qu'une seule stratégie", () => {
    // Le seuil d'échantillon sert à arbitrer entre candidats, pas à
    // interdire de trader.
    const decision = choosePilot([eligible("seule", 0)], null, 15);
    expect(decision.pilot).toBe("seule");
  });

  it("donne aucune pilote si aucune n'est éligible", () => {
    const scores = [
      { ...eligible("a", 5), eligible: false, reason: "trop peu" },
      { ...eligible("b", 5), eligible: false, reason: "trop peu" },
    ];
    const decision = choosePilot(scores, null, 15);
    expect(decision.pilot).toBeNull();
    expect(decision.reason).toMatch(/éligible/);
  });
});

describe("portefeuille fantôme", () => {
  it("reconstruit son état à partir des trades", () => {
    const db = makeDb();
    try {
      insertShadowTrade(db, "s1", {
        tsMs: 1000,
        mint: "Aa",
        side: "buy",
        qty: 100,
        priceUsd: 2,
        notionalUsd: 200,
        feeUsd: 1,
        pnlUsd: null,
      });
      insertShadowTrade(db, "s1", {
        tsMs: 2000,
        mint: "Aa",
        side: "buy",
        qty: 100,
        priceUsd: 4,
        notionalUsd: 400,
        feeUsd: 2,
        pnlUsd: null,
      });
      insertShadowTrade(db, "s1", {
        tsMs: 3000,
        mint: "Aa",
        side: "sell",
        qty: 100,
        priceUsd: 5,
        notionalUsd: 500,
        feeUsd: 2.5,
        pnlUsd: 300,
      });

      const book = loadShadowBook(db, "s1", { initialCashUsd: 1000, positionPct: 5 });
      // 1000 - 201 - 402 + 497,5
      expect(book.cashUsd).toBeCloseTo(894.5, 6);
      expect(book.positions.get("Aa")?.qty).toBeCloseTo(100, 6);
      // Le shadow utilise un **coût de revient moyen pondéré** (pas FIFO) :
      // après deux achats à 2 $ et 4 $, la moyenne est 3 $, et la vente de
      // 100 sur 200 la laisse inchangée.
      expect(book.positions.get("Aa")?.avgEntryUsd).toBeCloseTo(3, 6);
      expect(book.recentTrades).toBe(3);
    } finally {
      closeDb(db);
    }
  });

  it("calcule la NAV à partir des prix courants", () => {
    const db = makeDb();
    try {
      insertShadowTrade(db, "s1", {
        tsMs: 1000,
        mint: "Aa",
        side: "buy",
        qty: 100,
        priceUsd: 2,
        notionalUsd: 200,
        feeUsd: 0,
        pnlUsd: null,
      });
      const book = loadShadowBook(db, "s1", { initialCashUsd: 1000, positionPct: 5 });
      const nav = shadowNav(book, new Map([["Aa", 3]]));
      expect(nav).toBeCloseTo(1100, 6);
    } finally {
      closeDb(db);
    }
  });

  it("enregistre la série de NAV et compte les trades sur la fenêtre", () => {
    const db = makeDb();
    try {
      insertShadowNav(db, "s1", 1000, 1000);
      insertShadowNav(db, "s1", 2000, 1010);
      insertShadowTrade(db, "s1", {
        tsMs: 1500,
        mint: "Aa",
        side: "buy",
        qty: 1,
        priceUsd: 1,
        notionalUsd: 1,
        feeUsd: 0,
        pnlUsd: null,
      });

      expect(shadowNavSeries(db, "s1", 1000)).toHaveLength(2);
      expect(shadowTradeCount(db, "s1", 1000)).toBe(1);
      expect(shadowTradeCount(db, "s1", 5000)).toBe(0);
    } finally {
      closeDb(db);
    }
  });
});
