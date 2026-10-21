import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { closeDb, openDb } from "./db.js";
import { queryGet } from "./sql.js";

/**
 * Sauvegardes SQLite.
 *
 * La sauvegarde se fait via `VACUUM INTO` : c'est la seule méthode qui produit une
 * copie **cohérente** d'une base ouverte en mode WAL, sans l'arrêter.
 *
 * Une sauvegarde n'est jamais écrite à la place de la base vivante : elle
 * vit dans son propre répertoire, avec rotation.
 */

export interface BackupInfo {
  path: string;
  sizeBytes: number;
  createdMs: number;
}

export interface BackupOptions {
  /** Base à sauvegarder. */
  db: DB;
  /** Répertoire de destination. */
  dir: string;
  /** Nombre de sauvegardes conservées. */
  keep: number;
}

/** Crée une sauvegarde horodatée et renvoie son chemin. */
export function createBackup(options: BackupOptions): BackupInfo {
  const { db, dir, keep } = options;
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `solbot3-${stamp}.sqlite`);

  // `VACUUM INTO` écrit une copie compacte et cohérente de la base.
  db.prepare("VACUUM INTO ?").run(target);

  pruneBackups(dir, keep);

  const stat = fs.statSync(target);
  return { path: target, sizeBytes: stat.size, createdMs: Date.now() };
}

/** Supprime les sauvegardes les plus anciennes, au-delà de `keep`. */
export function pruneBackups(dir: string, keep: number): number {
  const backups = listBackups(dir);
  if (backups.length <= keep) return 0;

  // Les noms sont horodatés : le tri lexicographique est le tri chronologique.
  const toRemove = backups.slice(0, backups.length - keep);
  for (const backup of toRemove) {
    try {
      fs.unlinkSync(backup.path);
    } catch {
      // un fichier déjà supprimé n'est pas une erreur
    }
  }
  return toRemove.length;
}

/** Sauvegardes présentes, de la plus ancienne à la plus récente. */
export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite"))
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { path: full, sizeBytes: stat.size, createdMs: stat.mtimeMs };
    });
}

/**
 * Vérifie l'intégrité d'une sauvegarde.
 *
 * `PRAGMA integrity_check` est le seul contrôle qui vaille : un fichier
 * copié à la main peut être tronqué, et une base tronquée ne se voit pas à
 * l'ouverture.
 */
export function verifyBackup(file: string): { ok: boolean; detail: string } {
  if (!fs.existsSync(file)) return { ok: false, detail: "fichier introuvable" };

  let db: DB | undefined;
  try {
    db = openDb({ path: file, readonly: true });
    const row = queryGet<{ integrity_check: string }>(db, "PRAGMA integrity_check");
    const result = row?.integrity_check ?? "unknown";
    if (result !== "ok") return { ok: false, detail: result };
    return { ok: true, detail: "intégrité vérifiée" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

/**
 * Restaure une sauvegarde à la place de la base courante.
 *
 * La restauration est **vérifiée avant** d'écraser : une sauvegarde corrompue
 * ne doit jamais remplacer une base saine. Le fichier courant est
 * sauvegardé à côté avant l'opération, pour pouvoir revenir en arrière.
 *
 * ⚠ Le bot doit être **arrêté** pendant l'opération : remplacer le fichier
 * d'une base ouverte en mode WAL laisserait la connexion active dans un
 * état incohérent. La commande `backup --restore` le vérifie.
 */
export function restoreBackup(file: string, targetPath: string): { ok: boolean; detail: string } {
  const verification = verifyBackup(file);
  if (!verification.ok) {
    return { ok: false, detail: `sauvegarde invalide : ${verification.detail}` };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // Filet de sécurité : la base courante est mise de côté.
  if (fs.existsSync(targetPath)) {
    const backupCopy = `${targetPath}.before-restore`;
    fs.copyFileSync(targetPath, backupCopy);
  }

  // Les fichiers annexes de WAL doivent disparaître : sinon SQLite les
  // rejouerait par-dessus la base restaurée.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${targetPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }

  fs.copyFileSync(file, targetPath);
  return { ok: true, detail: `restauré depuis ${path.basename(file)}` };
}
