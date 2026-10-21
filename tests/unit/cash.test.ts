import { describe, expect, it } from "vitest";
import { KvCash } from "../../src/execution/cash.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { kvGetNumber, STATE_KEYS } from "../../src/state/kv.js";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

describe("cash virtuel", () => {
  it("s'initialise une seule fois", () => {
    const db = makeDb();
    try {
      const cash = new KvCash(db, 1000);
      cash.seed();
      expect(cash.cashUsd()).toBe(1000);

      cash.debit(200);
      expect(cash.cashUsd()).toBe(800);

      // Un redémarrage ne doit PAS réinitialiser le cash : le portefeuille
      // paper est persistant (cash **et** positions).
      cash.seed();
      expect(cash.cashUsd()).toBe(800);
    } finally {
      closeDb(db);
    }
  });

  it("crédite et débite", () => {
    const db = makeDb();
    try {
      const cash = new KvCash(db, 1000);
      cash.seed();
      cash.debit(100);
      cash.credit(50);
      expect(cash.cashUsd()).toBe(950);
      expect(kvGetNumber(db, STATE_KEYS.paperCashUsdc)).toBe(950);
    } finally {
      closeDb(db);
    }
  });

  it("ignore les opérations nulles ou négatives", () => {
    const db = makeDb();
    try {
      const cash = new KvCash(db, 1000);
      cash.seed();
      cash.debit(0);
      cash.debit(-10);
      cash.credit(0);
      expect(cash.cashUsd()).toBe(1000);
    } finally {
      closeDb(db);
    }
  });

  it("ne connaît pas le solde SOL en paper", () => {
    const db = makeDb();
    try {
      const cash = new KvCash(db, 1000);
      expect(cash.solBalance()).toBeNull();
    } finally {
      closeDb(db);
    }
  });
});
