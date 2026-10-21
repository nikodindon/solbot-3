import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

export interface OpenDbOptions {
  /** Chemin du fichier SQLite, ou `":memory:"` pour une base éphémère. */
  path: string;
  /** Mode lecture seule (dashboard). */
  readonly?: boolean;
}

/**
 * Ouvre la base SQLite.
 *
 * `node:sqlite` est intégré à Node 22 : aucune dépendance native à compiler.
 * Le mode WAL permet à un dashboard de lire pendant que le moteur écrit.
 */
export function openDb(options: OpenDbOptions): DB {
  const { path: dbPath, readonly = false } = options;

  if (dbPath !== ":memory:" && !readonly) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  if (!readonly) {
    db.exec("PRAGMA synchronous = NORMAL");
  }
  return db;
}

export function closeDb(db: DB): void {
  try {
    db.close();
  } catch {
    // une base déjà fermée ne doit jamais faire tomber l'arrêt du moteur
  }
}

/** Résout un chemin de base relatif à la racine du projet. */
export function resolveDbPath(root: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}
