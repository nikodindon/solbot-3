import { describe, expect, it } from "vitest";
import {
  describeExecuteError,
  describeOrderFailure,
  EXECUTE_ERRORS,
} from "../../src/jupiter/swap.js";
import { adaptiveSlippageBps, bumpSlippageBps } from "../../src/execution/slippage.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { upsertImportedCandles } from "../../src/state/imported-candles.js";
import { migrate } from "../../src/state/migrations.js";

describe("taxonomie des erreurs d'exécution", () => {
  it("classe les codes rejouables et non rejouables", () => {
    // Un code rejouable : la cause peut disparaître (expiration, last-look).
    expect(describeExecuteError(-1).strategy).toBe("requote");
    expect(describeExecuteError(-1005).strategy).toBe("requote");
    expect(describeExecuteError(-2004).strategy).toBe("requote");

    // Un code non rejouable : rejouer risquerait une double exécution.
    expect(describeExecuteError(-2).strategy).toBe("abort");
    expect(describeExecuteError(-3).strategy).toBe("abort");
    expect(describeExecuteError(-1002).strategy).toBe("abort");
  });

  it("abandonne par défaut sur un code inconnu", () => {
    const info = describeExecuteError(-9999);
    expect(info.strategy).toBe("abort");
    expect(info.label).toMatch(/inconnu/);
  });

  it("couvre tous les codes documentés", () => {
    for (const [code, info] of Object.entries(EXECUTE_ERRORS)) {
      expect(info.label.length).toBeGreaterThan(0);
      expect(["requote", "abort"]).toContain(info.strategy);
      expect(Number.isInteger(Number(code))).toBe(true);
    }
  });

  it("décrit les échecs d'ordre selon le routeur", () => {
    expect(describeOrderFailure("jupiterz", 1)).toMatch(/fonds insuffisants/);
    expect(describeOrderFailure(undefined, 1)).toMatch(/solde insuffisant/);
    expect(describeOrderFailure(undefined, 2)).toMatch(/ATA/);
    expect(describeOrderFailure(undefined, 3)).toMatch(/gasless/);
  });
});

describe("slippage adaptatif", () => {
  it("renvoie null quand l'historique est insuffisant", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      const bps = adaptiveSlippageBps(db, "Aa", Date.now(), {
        timeframe: "15m",
        period: 14,
        multiplier: 1,
        minBps: 10,
        maxBps: 100,
      });
      expect(bps).toBeNull();
    } finally {
      closeDb(db);
    }
  });

  it("calcule une borne à partir de l'ATR", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      const start = Date.UTC(2026, 0, 1);
      const candles = [];
      for (let i = 0; i < 30; i++) {
        // Bougie de 2 % d'amplitude : l'ATR vaut ~2 % du prix.
        candles.push({
          mint: "Aa",
          tf: "15m" as const,
          ts: start + i * 900_000,
          open: 100,
          high: 102,
          low: 98,
          close: 100,
          volumeUsd: 100,
          source: "import",
        });
      }
      upsertImportedCandles(db, candles);

      const bps = adaptiveSlippageBps(db, "Aa", start + 40 * 900_000, {
        timeframe: "15m",
        period: 14,
        multiplier: 1,
        minBps: 10,
        maxBps: 100,
      });
      expect(bps).not.toBeNull();
      // L'ATR est de ~4 % (400 bps) : la borne est donc **plafonnée** à 100.
      expect(bps).toBe(100);

      // Sans plafond, on retrouve bien l'ordre de grandeur de l'ATR.
      const uncapped = adaptiveSlippageBps(db, "Aa", start + 40 * 900_000, {
        timeframe: "15m",
        period: 14,
        multiplier: 1,
        minBps: 10,
        maxBps: 10_000,
      });
      expect(uncapped).toBeGreaterThan(300);
    } finally {
      closeDb(db);
    }
  });

  it("élargit la borne sans jamais dépasser le plafond", () => {
    expect(bumpSlippageBps(50, 2, 100)).toBe(100);
    expect(bumpSlippageBps(20, 2, 100)).toBe(40);
    // Une borne non calculée n'est jamais élargie.
    expect(bumpSlippageBps(undefined, 2, 100)).toBeUndefined();
  });
});
