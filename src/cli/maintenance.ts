import fs from "node:fs";
import { resolveDbPath } from "../state/db.js";
import { decisionsJournalStats, dedupeDecisions } from "../state/decisions.js";
import { blank, fail, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface MaintenanceCliOptions {
  root?: string;
  /** Ne fait que compter : rien n'est supprimé, rien n'est compacté. */
  plan?: boolean;
  /** Saute le `VACUUM` (utile si la base est ouverte ailleurs). */
  noVacuum?: boolean;
}

function sizeOf(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function mo(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} Mo`;
}

/**
 * `solbot3 maintenance` — dédoublonnage du journal et compaction.
 *
 * Deux opérations distinctes, toutes deux **sans perte d'information** :
 *
 * 1. Les décisions strictement redondantes (le portefeuille fantôme et le
 *    livre réel écrivent la même phrase) sont supprimées. Ce sont des
 *    copies exactes : rien n'est perdu, la table perd simplement la moitié
 *    de son poids.
 * 2. `VACUUM` réécrit la base sans les pages libérées. Il faut un accès
 *    exclusif : si le moteur ou le dashboard tient la base ouverte, il échoue
 *    et on le dit — on ne tue pas un bot pour compacter.
 *
 * À passer une fois par semaine ou quand la base grossit visiblement.
 */
export function runMaintenance(options: MaintenanceCliOptions = {}): void {
  const runtime = createRuntime({ root: options.root });
  try {
    const dbPath = resolveDbPath(runtime.root, runtime.config.database.path);
    const before = sizeOf(dbPath);

    heading("solbot3 maintenance — état du journal");

    const stats = decisionsJournalStats(runtime.db);
    info("décisions", `${stats.total} lignes`);
    info(
      "doublons",
      stats.duplicateRows > 0
        ? `${stats.duplicateRows} lignes redondantes dans ${stats.duplicateGroups} groupes`
        : "aucun",
    );
    info("poids de la base", mo(before));

    if (options.plan === true) {
      blank();
      note("--plan : aucune modification effectuée");
      blank();
      return;
    }

    if (stats.duplicateRows > 0) {
      const removed = dedupeDecisions(runtime.db);
      ok("doublons supprimés", `${removed} lignes`);
    } else {
      note("le journal est déjà propre");
    }

    if (options.noVacuum === true) {
      blank();
      return;
    }

    heading("solbot3 maintenance — compaction (VACUUM)");
    try {
      runtime.db.exec("VACUUM");
    } catch (error) {
      warn(
        "VACUUM impossible",
        `${error instanceof Error ? error.message : String(error)} — arrêtez le bot et le dashboard, puis relancez`,
      );
      blank();
      return;
    }

    const after = sizeOf(dbPath);
    ok("base compactée", `${mo(before)} → ${mo(after)} (−${mo(Math.max(0, before - after))})`);
    blank();
  } catch (error) {
    fail("maintenance impossible", error instanceof Error ? error.message : String(error));
    blank();
    process.exitCode = 1;
  } finally {
    closeRuntime(runtime);
  }
}
