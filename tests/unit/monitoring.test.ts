import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRegistry, METRICS } from "../../src/monitoring/metrics.js";
import { shouldEmitAlert } from "../../src/monitoring/alerts.js";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "../../src/state/backup.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { parseCommand } from "../../src/notify/controller.js";

describe("registre de métriques", () => {
  it("incrémente les compteurs et pose les jauges", () => {
    const registry = createRegistry();
    registry.inc(METRICS.ticksTotal);
    registry.inc(METRICS.ticksTotal, 2);
    registry.set(METRICS.navUsd, 1234.5);

    expect(registry.get(METRICS.ticksTotal)).toBe(3);
    expect(registry.get(METRICS.navUsd)).toBe(1234.5);
  });

  it("rend un format Prometheus exploitable", () => {
    const registry = createRegistry();
    registry.inc(METRICS.ticksTotal, 5);
    registry.set(METRICS.navUsd, 1000);

    const rendered = registry.render();
    expect(rendered).toContain(`# TYPE ${METRICS.ticksTotal} counter`);
    expect(rendered).toContain(`${METRICS.ticksTotal} 5`);
    expect(rendered).toContain(`${METRICS.navUsd} 1000`);
  });

  it(" trie les étiquettes de façon déterministe", () => {
    const registry = createRegistry();
    registry.inc(METRICS.rejectionsTotal, 1, { rule: "edge_net", kind: "risk" });
    registry.inc(METRICS.rejectionsTotal, 1, { kind: "risk", rule: "edge_net" });

    const rendered = registry.render();
    expect(rendered).toContain('kind="risk",rule="edge_net"');
    // Le rendu est stable : deux appels donnent le même texte.
    expect(registry.render()).toBe(rendered);
  });
});

describe("alertes et cooldown", () => {
  it("n'émet qu'une fois par fenêtre de cooldown", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      const rule = {
        kind: "gas_reserve" as const,
        cooldownMin: 30,
        message: "réserve",
        severity: "warning" as const,
      };

      const first = shouldEmitAlert({ db }, rule);
      expect(first.emit).toBe(true);

      const second = shouldEmitAlert({ db }, rule);
      expect(second.emit).toBe(false);
      expect(second.reason).toMatch(/cooldown/);
    } finally {
      closeDb(db);
    }
  });

  it("persiste le cooldown : un redémarrage ne relance pas l'alerte", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-alert-")), "a.sqlite");
    try {
      const db = openDb({ path: dbPath });
      migrate(db);
      const rule = {
        kind: "kill_switch" as const,
        cooldownMin: 60,
        message: "x",
        severity: "critical" as const,
      };
      expect(shouldEmitAlert({ db }, rule).emit).toBe(true);
      closeDb(db);

      // Nouvelle base, même fichier : le cooldown est toujours là.
      const reopened = openDb({ path: dbPath });
      expect(shouldEmitAlert({ db: reopened }, rule).emit).toBe(false);
      closeDb(reopened);
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});

describe("sauvegardes", () => {
  it("crée, vérifie et restaure une sauvegarde", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-backup-"));
    try {
      const db = openDb({ path: path.join(dir, "main.sqlite") });
      migrate(db);
      db.prepare("INSERT INTO bot_state (key, value, updated_ms) VALUES ('k', 'v', 1)").run();

      const backup = createBackup({ db, dir: path.join(dir, "backups"), keep: 3 });
      expect(fs.existsSync(backup.path)).toBe(true);
      expect(backup.sizeBytes).toBeGreaterThan(0);

      expect(verifyBackup(backup.path).ok).toBe(true);
      expect(listBackups(path.join(dir, "backups"))).toHaveLength(1);

      // On modifie la base, puis on restaure.
      db.prepare("UPDATE bot_state SET value = 'modifié' WHERE key = 'k'").run();
      // La restauration remplace le fichier : le bot doit être arrêté, on
      // ferme donc la connexion avant.
      closeDb(db);
      const restore = restoreBackup(backup.path, path.join(dir, "main.sqlite"));
      expect(restore.ok).toBe(true);

      const restored = openDb({ path: path.join(dir, "main.sqlite") });
      const row = restored.prepare("SELECT value FROM bot_state WHERE key = 'k'").get() as {
        value: string;
      };
      expect(row.value).toBe("v");
      closeDb(restored);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuse de restaurer une sauvegarde corrompue", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-backup-"));
    try {
      const broken = path.join(dir, "broken.sqlite");
      fs.writeFileSync(broken, "ceci n'est pas une base SQLite");

      expect(verifyBackup(broken).ok).toBe(false);
      const restore = restoreBackup(broken, path.join(dir, "main.sqlite"));
      expect(restore.ok).toBe(false);
      expect(restore.detail).toMatch(/invalide/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applique la rotation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-backup-"));
    try {
      const db = openDb({ path: path.join(dir, "main.sqlite") });
      migrate(db);
      for (let i = 0; i < 5; i++) {
        createBackup({ db, dir: path.join(dir, "backups"), keep: 2 });
      }
      expect(listBackups(path.join(dir, "backups")).length).toBeLessThanOrEqual(2);
      closeDb(db);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("commandes Telegram", () => {
  it("analyse les commandes", () => {
    expect(parseCommand("/status")).toEqual({ name: "status", args: [] });
    expect(parseCommand("/pnl 7")).toEqual({ name: "pnl", args: ["7"] });
    expect(parseCommand("/pnl@monbot 30")).toEqual({ name: "pnl", args: ["30"] });
    expect(parseCommand("bonjour")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});
