import type { AppConfig } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { insertEvent, listEvents } from "../state/events.js";
import { kvGetNumber, kvSet, STATE_KEYS } from "../state/kv.js";
import { shouldEmitAlert, type AlertKind, type AlertRule } from "./alerts.js";
import type { MetricsRegistry } from "./metrics.js";
import { METRICS } from "./metrics.js";

/**
 * Le superviseur.
 *
 * Il observe le moteur et produit tout ce qui doit arriver **en dehors** de
 * la boucle de trading : métriques, alertes, notifications, rapport
 * quotidien, sauvegarde quotidienne.
 *
 * Règle absolue : **une défaillance de supervision ne doit jamais arrêter le
 * moteur**. Tout est best-effort, et chaque erreur est journalisée sans
 * faire remonter l'exception.
 */

export interface Notifier {
  /** Envoie une notification (Telegram, ou un no-op en test). */
  send(kind: string, text: string): Promise<boolean>;
  configured: boolean;
}

export interface SupervisorDeps {
  db: DB;
  cfg: AppConfig;
  metrics: MetricsRegistry;
  notifier: Notifier;
  /** Répertoire des sauvegardes. */
  backupDir: string;
  /** Crée une sauvegarde ; injecté pour les tests. */
  backup?: () => void;
  /** Version du bot. */
  version: string;
}

export interface TickSummary {
  tsMs: number;
  ok: boolean;
  navUsd: number;
  cashUsd: number;
  positionsOpen: number;
  drawdownPct: number;
  executed: { buys: number; sells: number };
  blockedBy: string | null;
  /** Score de la stratégie pilote, en % (null si pas d'allocateur). */
  pilotScorePct: number | null;
}

export class Supervisor {
  private readonly startedAtMs = Date.now();
  private ticks = 0;
  private lastTickAtMs: number | null = null;
  private lastNavUsd: number | null = null;
  private lastPositionsOpen: number | null = null;
  private lastPaused = false;
  private lastKillSwitch = false;
  private dbError: string | null = null;
  private consecutiveTickErrors = 0;

  constructor(private readonly deps: SupervisorDeps) {}

  /** Traite la fin d'un tick. */
  onTick(summary: TickSummary): void {
    const { metrics } = this.deps;

    this.ticks += 1;
    this.lastTickAtMs = summary.tsMs;
    this.lastNavUsd = summary.navUsd;
    this.lastPositionsOpen = summary.positionsOpen;

    metrics.inc(METRICS.ticksTotal);
    metrics.set(METRICS.navUsd, summary.navUsd);
    metrics.set(METRICS.cashUsd, summary.cashUsd);
    metrics.set(METRICS.positionsOpen, summary.positionsOpen);
    metrics.set(METRICS.drawdownPct, summary.drawdownPct);
    metrics.set(METRICS.uptimeSeconds, (Date.now() - this.startedAtMs) / 1000);
    metrics.set(METRICS.lastTickTimestamp, summary.tsMs / 1000);
    metrics.inc(METRICS.tradesTotal, summary.executed.buys + summary.executed.sells);

    if (summary.pilotScorePct !== null) {
      metrics.set(METRICS.pilotScorePct, summary.pilotScorePct);
    }

    if (summary.ok) {
      this.consecutiveTickErrors = 0;
    } else {
      this.consecutiveTickErrors += 1;
      metrics.inc(METRICS.tickErrorsTotal);
      this.raise("market_failure", {
        message: `tick en échec (${this.consecutiveTickErrors} consécutif(s))`,
        severity: this.consecutiveTickErrors >= 3 ? "critical" : "warning",
        cooldownMin: 15,
      });
    }

    this.maybeDailyReport();
    this.maybeBackup();
  }

  /** Le kill-switch a été déclenché (par le moteur ou par une commande). */
  onKillSwitch(reason: string): void {
    this.lastKillSwitch = true;
    this.raise("kill_switch", {
      message: `kill-switch déclenché : ${reason}`,
      severity: "critical",
      cooldownMin: 60,
    });
  }

  /** Une divergence de réconciliation a été détectée. */
  onReconciliation(action: string, detail: string): void {
    this.raise("reconciliation", {
      message: `réconciliation : ${action} — ${detail}`,
      severity: "warning",
      cooldownMin: 60,
    });
  }

  /** État de santé courant. */
  health(nowMs: number = Date.now()): {
    status: "ok" | "stale" | "degraded";
    mode: string;
    version: string;
    uptimeS: number;
    ticks: number;
    lastTickAt: number | null;
    lastTickAgeS: number | null;
    navUsd: number | null;
    positionsOpen: number | null;
    paused: boolean;
    killSwitch: boolean;
    lastBackupAt: number | null;
    db: string;
  } {
    const staleAfterS = Math.max(120, this.deps.cfg.loop_interval_s * 3);
    const ageS = this.lastTickAtMs === null ? null : Math.floor((nowMs - this.lastTickAtMs) / 1000);

    let status: "ok" | "stale" | "degraded" = "ok";
    if (this.dbError !== null) status = "degraded";
    else if (ageS === null || ageS > staleAfterS) status = "stale";

    return {
      status,
      mode: this.deps.cfg.mode,
      version: this.deps.version,
      uptimeS: Math.floor((nowMs - this.startedAtMs) / 1000),
      ticks: this.ticks,
      lastTickAt: this.lastTickAtMs,
      lastTickAgeS: ageS,
      navUsd: this.lastNavUsd,
      positionsOpen: this.lastPositionsOpen,
      paused: this.lastPaused,
      killSwitch: this.lastKillSwitch,
      lastBackupAt: kvGetNumber(this.deps.db, STATE_KEYS.lastBackupAtMs),
      db: this.dbError === null ? "ok" : this.dbError,
    };
  }

  /** Signale une erreur d'accès à la base. */
  setDbError(error: string | null): void {
    this.dbError = error;
  }

  /** Le kill-switch est-il actif ? (lu depuis la base) */
  refreshGuards(paused: boolean, killSwitch: boolean): void {
    this.lastPaused = paused;
    this.lastKillSwitch = killSwitch;
  }

  // ── Interne ────────────────────────────────────────────────────────────

  /** Émet une alerte si le cooldown le permet. */
  private raise(kind: AlertKind, rule: Omit<AlertRule, "kind">): void {
    const { db, metrics, notifier } = this.deps;

    const decision = shouldEmitAlert({ db }, { kind, ...rule });
    if (!decision.emit) return;

    metrics.inc(METRICS.alertsTotal, 1, { kind });
    insertEvent(db, {
      tsMs: Date.now(),
      level: rule.severity === "critical" ? "error" : "warn",
      kind: `alert_${kind}`,
      message: rule.message,
      details: JSON.stringify({ cooldownMin: rule.cooldownMin }),
    });

    void notifier
      .send("alert", `⚠️ *${kind}*\n${rule.message}`)
      .then((sent) => {
        if (sent) metrics.inc(METRICS.notificationsTotal, 1, { kind: "alert" });
      })
      .catch(() => {
        // une notification ratée ne doit jamais faire tomber le bot
      });
  }

  /** Rapport quotidien, une fois par jour UTC. */
  private maybeDailyReport(): void {
    const { db, cfg, notifier, metrics } = this.deps;
    if (!cfg.notifications.telegram.enabled) return;

    const today = new Date().toISOString().slice(0, 10);
    if (kvGetNumber(db, STATE_KEYS.lastDailyReportDay) === dayNumber(today)) return;

    const hour = new Date().getUTCHours();
    if (hour < cfg.notifications.telegram.daily_report_utc_hour) return;

    kvSet(db, STATE_KEYS.lastDailyReportDay, String(dayNumber(today)), Date.now());

    const nav = this.lastNavUsd ?? 0;
    const text = [
      `📊 *Rapport solbot3 — ${today}*`,
      `NAV : ${nav.toFixed(2)} $`,
      `Positions : ${this.lastPositionsOpen ?? 0}`,
      `Drawdown : ${(this.deps.metrics.get(METRICS.drawdownPct) ?? 0).toFixed(2)} %`,
    ].join("\n");

    void notifier
      .send("daily_report", text)
      .then((sent) => {
        if (sent) metrics.inc(METRICS.notificationsTotal, 1, { kind: "daily_report" });
      })
      .catch(() => undefined);
  }

  /** Sauvegarde quotidienne, une fois par jour UTC. */
  private maybeBackup(): void {
    const { db, cfg, metrics } = this.deps;
    if (!cfg.backups.enabled) return;

    const today = new Date().toISOString().slice(0, 10);
    if (kvGetNumber(db, STATE_KEYS.lastBackupDay) === dayNumber(today)) return;

    const hour = new Date().getUTCHours();
    if (hour < cfg.backups.daily_utc_hour) return;

    kvSet(db, STATE_KEYS.lastBackupDay, String(dayNumber(today)), Date.now());

    try {
      this.deps.backup?.();
      metrics.inc(METRICS.backupsTotal);
    } catch (error) {
      insertEvent(db, {
        tsMs: Date.now(),
        level: "error",
        kind: "backup_failed",
        message: error instanceof Error ? error.message : String(error),
        details: null,
      });
    }
  }
}

/** Numéro de jour UTC, pour les clés « une fois par jour ». */
function dayNumber(dayKey: string): number {
  return Number(dayKey.replace(/-/g, ""));
}

/** Journal d'événements (alertes, backup, erreurs). */
export { listEvents };
