import type { DB } from "./db.js";
import { queryGet } from "./sql.js";

/**
 * État clé/valeur.
 *
 * Réservé aux valeurs **singleton** de l'exécution (cash virtuel, ancre de
 * journée, pic d'équité). Tout ce qui est un journal ou un historique
 * vit dans une table dédiée.
 */

export function kvGet(db: DB, key: string): string | null {
  const row = queryGet<{ value: string }>(db, "SELECT value FROM bot_state WHERE key = ?", key);
  return row?.value ?? null;
}

export function kvSet(db: DB, key: string, value: string, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO bot_state (key, value, updated_ms) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ms = excluded.updated_ms`,
  ).run(key, value, nowMs);
}

export function kvGetJson<T>(db: DB, key: string, fallback: T): T {
  const raw = kvGet(db, key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function kvSetJson(db: DB, key: string, value: unknown, nowMs: number = Date.now()): void {
  kvSet(db, key, JSON.stringify(value), nowMs);
}

export function kvGetNumber(db: DB, key: string): number | null {
  const raw = kvGet(db, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function kvSetNumber(db: DB, key: string, value: number, nowMs: number = Date.now()): void {
  kvSet(db, key, String(value), nowMs);
}

export function kvDelete(db: DB, key: string): void {
  db.prepare("DELETE FROM bot_state WHERE key = ?").run(key);
}

/** Clés d'état connues, centralisées pour éviter les fautes de frappe. */
export const STATE_KEYS = {
  paperCashUsdc: "paper_cash_usdc",
  paperSolBalance: "paper_sol_balance",
  navPeakUsd: "nav_peak_usd",
  dayKey: "day_key",
  dayStartNavUsd: "day_start_nav_usd",
  pausedUntilMs: "paused_until_ms",
  killSwitchAtMs: "kill_switch_at_ms",
  lastTradeTsByMint: "last_trade_ts_by_mint",
  tickCount: "tick_count",
  solPrice0: "sol_price_0",
  allocatedStrategy: "allocated_strategy",
  manualPaused: "manual_paused",
  lastBackupDay: "last_backup_day",
  lastBackupAtMs: "last_backup_at_ms",
  lastDailyReportDay: "last_daily_report_day",
} as const;
