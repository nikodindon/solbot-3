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
import { appConfigSchema } from "../../src/config/schema.js";
import { listEvents } from "../../src/state/events.js";
import { kvSetNumber, STATE_KEYS } from "../../src/state/kv.js";
import { Supervisor, type Notifier, type TickSummary } from "../../src/monitoring/supervisor.js";

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

describe("superviseur", () => {
  const notStub: Notifier = { send: () => Promise.resolve(true), configured: false };

  function makeSupervisor(options: { killSwitchExists?: () => boolean } = {}) {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    const registry = createRegistry();
    const supervisor = new Supervisor({
      db,
      cfg: appConfigSchema.parse({}),
      metrics: registry,
      notifier: notStub,
      backupDir: path.join(os.tmpdir(), "solbot3-superviseur"),
      backup: () => undefined,
      version: "test",
      ...options,
    });
    return { db, registry, supervisor };
  }

  const tick = (over: Partial<TickSummary> = {}): TickSummary => ({
    tsMs: Date.now(),
    ok: true,
    navUsd: 1000,
    cashUsd: 500,
    positionsOpen: 1,
    drawdownPct: 0,
    executed: { buys: 0, sells: 0 },
    blockedBy: null,
    pilotScorePct: null,
    ...over,
  });

  it("relit le kill-switch depuis sa source, sans attendre de tick", () => {
    let stopFile = false;
    const { supervisor, db } = makeSupervisor({ killSwitchExists: () => stopFile });
    try {
      expect(supervisor.health().killSwitch).toBe(false);

      // Le fichier STOP apparaît entre deux ticks : /healthz doit le voir
      // immédiatement, pas au prochain tick.
      stopFile = true;
      expect(supervisor.health().killSwitch).toBe(true);

      stopFile = false;
      expect(supervisor.health().killSwitch).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("relit la pause journalière depuis le kv", () => {
    const { db, supervisor } = makeSupervisor();
    try {
      expect(supervisor.health().paused).toBe(false);

      kvSetNumber(db, STATE_KEYS.pausedUntilMs, Date.now() + 3_600_000, Date.now());
      expect(supervisor.health().paused).toBe(true);

      // Une pause expirée n'est plus une pause.
      kvSetNumber(db, STATE_KEYS.pausedUntilMs, 0, Date.now());
      expect(supervisor.health().paused).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  it("émet l'alerte critique quand le kill-switch se lève", () => {
    let stopFile = false;
    const { db, supervisor } = makeSupervisor({ killSwitchExists: () => stopFile });
    try {
      supervisor.onTick(tick());
      expect(listEvents(db, { kind: "alert_kill_switch" })).toHaveLength(0);

      stopFile = true;
      supervisor.onTick(tick());

      const alerts = listEvents(db, { kind: "alert_kill_switch" });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.level).toBe("error");

      // Un tick suivant ne répète pas l'alerte (cooldown, pas de transition).
      supervisor.onTick(tick());
      expect(listEvents(db, { kind: "alert_kill_switch" })).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });

  it("conserve la dernière NAV valide quand un tick échoue", () => {
    const { db, supervisor } = makeSupervisor();
    try {
      supervisor.onTick(tick({ navUsd: 966.28, positionsOpen: 2 }));

      // Un tick sans prix ne valorise rien : il ne doit pas écrire 0 $.
      supervisor.onTick(tick({ ok: false, navUsd: 0, positionsOpen: 0 }));

      const health = supervisor.health();
      expect(health.navUsd).toBeCloseTo(966.28, 6);
      expect(health.positionsOpen).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  it("pose les jauges de NAV seulement sur un tick valide", () => {
    const { db, registry, supervisor } = makeSupervisor();
    try {
      supervisor.onTick(tick({ navUsd: 966.28 }));
      expect(registry.get(METRICS.navUsd)).toBeCloseTo(966.28, 6);

      supervisor.onTick(tick({ ok: false, navUsd: 0 }));
      expect(registry.get(METRICS.navUsd)).toBeCloseTo(966.28, 6);
      // Le compteur d'erreurs, lui, progresse bien.
      expect(registry.get(METRICS.tickErrorsTotal)).toBe(1);
    } finally {
      closeDb(db);
    }
  });
});
