import type { SQLInputValue } from "node:sqlite";
import type { DB } from "./db.js";

/**
 * Helpers SQL typés.
 *
 * `node:sqlite` renvoie des lignes `Record<string, SQLOutputValue>` : le cast
 * vers une interface de ligne doit passer par `unknown`. Ces fonctions
 * centralisent ce cast une seule fois.
 */

export function queryAll<T>(db: DB, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function queryGet<T>(db: DB, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/** Exécute une transaction : tout ou rien. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
