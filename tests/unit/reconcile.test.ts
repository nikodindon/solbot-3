import { describe, expect, it } from "vitest";
import { reconcileBalances } from "../../src/solana/reconcile.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { listPositions } from "../../src/state/portfolio-repo.js";
import { listEvents } from "../../src/state/events.js";

const BASE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

describe("réconciliation on-chain", () => {
  it("n'adopte rien quand la chaîne est vide", () => {
    const db = makeDb();
    try {
      const result = reconcileBalances({
        db,
        connection: {} as never,
        owner: "Owner",
        balances: [],
        baseMint: BASE_MINT,
        defaultStopLossPct: 8,
        defaultTakeProfitPct: 15,
        prices: new Map(),
      });
      expect(result.entries).toHaveLength(0);
      expect(result.adopted).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("adopte un actif présent on-chain et inconnu du local", () => {
    const db = makeDb();
    try {
      const result = reconcileBalances({
        db,
        connection: {} as never,
        owner: "Owner",
        balances: [{ mint: "Aa", amount: 1_000_000, decimals: 6 }],
        baseMint: BASE_MINT,
        defaultStopLossPct: 8,
        defaultTakeProfitPct: 15,
        prices: new Map([["Aa", 2]]),
      });

      expect(result.adopted).toBe(1);
      const position = listPositions(db)[0];
      expect(position?.mint).toBe("Aa");
      expect(position?.qty).toBeCloseTo(1, 6);
      expect(position?.stopLossUsd).toBeCloseTo(1.84, 6);
      expect(position?.takeProfitUsd).toBeCloseTo(2.3, 6);
    } finally {
      closeDb(db);
    }
  });

  it("n'adopte pas un actif sans prix de référence", () => {
    const db = makeDb();
    try {
      const result = reconcileBalances({
        db,
        connection: {} as never,
        owner: "Owner",
        balances: [{ mint: "Aa", amount: 1_000_000, decimals: 6 }],
        baseMint: BASE_MINT,
        defaultStopLossPct: 8,
        defaultTakeProfitPct: 15,
        prices: new Map(),
      });

      expect(result.adopted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(listPositions(db)).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("n'adopte jamais la devise de base", () => {
    const db = makeDb();
    try {
      const result = reconcileBalances({
        db,
        connection: {} as never,
        owner: "Owner",
        balances: [{ mint: BASE_MINT, amount: 5_000_000, decimals: 6 }],
        baseMint: BASE_MINT,
        defaultStopLossPct: 8,
        defaultTakeProfitPct: 15,
        prices: new Map([[BASE_MINT, 1]]),
      });
      expect(result.adopted).toBe(0);
      expect(listPositions(db)).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("clôture une position locale absente de la chaîne", () => {
    const db = makeDb();
    try {
      // Une position locale, créée par un achat antérieur.
      db.prepare(
        `INSERT INTO positions (mint, symbol, qty, invested_usd, avg_entry_usd, realized_pnl_usd, opened_ms, updated_ms)
         VALUES ('Aa', 'AAA', 100, 200, 2, 0, 1000, 1000)`,
      ).run();

      const result = reconcileBalances({
        db,
        connection: {} as never,
        owner: "Owner",
        balances: [],
        baseMint: BASE_MINT,
        defaultStopLossPct: 8,
        defaultTakeProfitPct: 15,
        prices: new Map(),
      });

      expect(result.closed).toBe(1);
      expect(listPositions(db)).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("journalise chaque action", () => {
    const db = makeDb();
    try {
      reconcileBalances({
        db,
        connection: {} as never,
        owner: "Owner",
        balances: [{ mint: "Aa", amount: 1_000_000, decimals: 6 }],
        baseMint: BASE_MINT,
        defaultStopLossPct: 8,
        defaultTakeProfitPct: 15,
        prices: new Map([["Aa", 2]]),
      });

      const events = listEvents(db, { kind: "reconcile_adopted" });
      expect(events).toHaveLength(1);
      expect(events[0]?.message).toMatch(/adoptée/);
    } finally {
      closeDb(db);
    }
  });
});
