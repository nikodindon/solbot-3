import path from "node:path";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "../state/backup.js";
import { blank, fail, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface BackupCliOptions {
  root?: string;
  /** Liste les sauvegardes sans rien faire. */
  list?: boolean;
  /** Restaure une sauvegarde. */
  restore?: string;
}

/**
 * `solbot3 backup` — sauvegarde, liste et restauration vérifiée.
 *
 * La restauration est refusée si une autre connexion est ouverte sur la base
 * (le bot tourne) : remplacer le fichier d'une base ouverte en WAL laisserait
 * la connexion dans un état incohérent.
 */
export function runBackup(options: BackupCliOptions = {}): void {
  const runtime = createRuntime({ root: options.root });
  try {
    const dir = path.resolve(runtime.root, runtime.config.backups.dir);

    if (options.restore) {
      heading(`solbot3 backup — restauration de ${path.basename(options.restore)}`);

      const verification = verifyBackup(options.restore);
      if (!verification.ok) {
        fail("sauvegarde invalide", verification.detail);
        blank();
        process.exitCode = 1;
        return;
      }
      ok("intégrité vérifiée", verification.detail);

      const target = path.resolve(runtime.root, runtime.config.database.path);
      const result = restoreBackup(options.restore, target);
      if (!result.ok) {
        fail("restauration impossible", result.detail);
        blank();
        process.exitCode = 1;
        return;
      }
      ok("restauration réussie", result.detail);
      note(`la base précédente a été conservée en ${target}.before-restore`);
      blank();
      return;
    }

    if (options.list) {
      heading("solbot3 backup — sauvegardes disponibles");
      const backups = listBackups(dir);
      if (backups.length === 0) {
        warn("aucune sauvegarde", dir);
        blank();
        return;
      }
      blank();
      for (const backup of backups) {
        info(
          path.basename(backup.path),
          `${(backup.sizeBytes / 1024).toFixed(0)} Ko — ${new Date(backup.createdMs).toISOString().slice(0, 16).replace("T", " ")} UTC`,
        );
      }
      blank();
      return;
    }

    heading("solbot3 backup — création d'une sauvegarde");
    const backup = createBackup({
      db: runtime.db,
      dir,
      keep: runtime.config.backups.keep,
    });
    ok("sauvegarde créée", path.basename(backup.path));
    info("taille", `${(backup.sizeBytes / 1024).toFixed(0)} Ko`);
    info("rotation", `${runtime.config.backups.keep} conservées`);
    blank();
  } finally {
    closeRuntime(runtime);
  }
}
