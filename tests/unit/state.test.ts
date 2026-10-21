import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "../../src/state/db.js";
import { currentVersion, migrate, MIGRATIONS, tablesOf } from "../../src/state/migrations.js";

describe("migrations", () => {
  it("crée le schéma et les tables core", () => {
    const db = openDb({ path: ":memory:" });
    try {
      expect(currentVersion(db)).toBe(0);
      const applied = migrate(db);
      expect(applied).toBe(MIGRATIONS.length);
      expect(currentVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);

      const tables = tablesOf(db);
      expect(tables).toContain("bot_state");
      expect(tables).toContain("tokens");
      expect(tables).toContain("price_ticks");
      expect(tables).toContain("candles");
      expect(tables).toContain("watchlist");
      expect(tables).toContain("schema_migrations");
    } finally {
      closeDb(db);
    }
  });

  it("est idempotente", () => {
    const db = openDb({ path: ":memory:" });
    try {
      migrate(db);
      expect(migrate(db)).toBe(0);
      expect(currentVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    } finally {
      closeDb(db);
    }
  });

  it("trace l'origine des prix", () => {
    const db = openDb({ path: ":memory:" });
    try {
      migrate(db);
      const columns = db.prepare("PRAGMA table_info(price_ticks)").all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain("src");
    } finally {
      closeDb(db);
    }
  });
});
