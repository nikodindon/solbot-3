import type { DB } from "./db.js";
import { queryAll, queryGet } from "./sql.js";

/** Journal d'événements : alertes, erreurs, actions de supervision. */

export type EventLevel = "info" | "warn" | "error";

export interface EventRecord {
  tsMs: number;
  level: EventLevel;
  kind: string;
  message: string;
  details: string | null;
}

export function insertEvent(
  db: DB,
  event: {
    tsMs: number;
    level: EventLevel;
    kind: string;
    message: string;
    details?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO events (ts_ms, level, kind, message, details) VALUES (?, ?, ?, ?, ?)",
  ).run(event.tsMs, event.level, event.kind, event.message, event.details ?? null);
}

export function listEvents(
  db: DB,
  options: { limit?: number; level?: EventLevel; kind?: string } = {},
): EventRecord[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.level) {
    where.push("level = ?");
    params.push(options.level);
  }
  if (options.kind) {
    where.push("kind = ?");
    params.push(options.kind);
  }

  const rows = queryAll<{
    ts_ms: number;
    level: string;
    kind: string;
    message: string;
    details: string | null;
  }>(
    db,
    `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ...params,
    options.limit ?? 100,
  );

  return rows.map((row) => ({
    tsMs: row.ts_ms,
    level: row.level as EventLevel,
    kind: row.kind,
    message: row.message,
    details: row.details,
  }));
}

/** Compteur d'événements par niveau depuis un instant. */
export function countEventsByLevel(db: DB, sinceMs: number): Record<string, number> {
  const rows = queryAll<{ level: string; n: number }>(
    db,
    "SELECT level, COUNT(*) AS n FROM events WHERE ts_ms >= ? GROUP BY level",
    sinceMs,
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.level] = row.n;
  return out;
}

/** Dernier événement d'un niveau donné. */
export function lastEvent(db: DB, level?: EventLevel): EventRecord | null {
  const row = level
    ? queryGet<{
        ts_ms: number;
        level: string;
        kind: string;
        message: string;
        details: string | null;
      }>(db, "SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT 1", level)
    : queryGet<{
        ts_ms: number;
        level: string;
        kind: string;
        message: string;
        details: string | null;
      }>(db, "SELECT * FROM events ORDER BY id DESC LIMIT 1");
  if (!row) return null;
  return {
    tsMs: row.ts_ms,
    level: row.level as EventLevel,
    kind: row.kind,
    message: row.message,
    details: row.details,
  };
}
