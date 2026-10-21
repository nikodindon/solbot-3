import { evaluateGuard } from "../risk/guard.js";
import { blank, fail, heading, info, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface GuardOptions {
  root?: string;
}

/**
 * Affiche l'état du garde-fou live.
 *
 * Le live n'est accessible que si cette commande ne signale **aucun**
 * critère bloquant. C'est la même évaluation que celle qui sera appliquée
 * au démarrage du mode live — pas une version « pour l'affichage ».
 */
export function runGuard(options: GuardOptions = {}): boolean {
  const runtime = createRuntime({ root: options.root });
  try {
    const report = evaluateGuard({ db: runtime.db, cfg: runtime.config });

    heading("solbot3 guard — le live est-il accessible ?");
    info("empreinte de configuration", report.configHash);

    blank();
    for (const criterion of report.criteria) {
      if (criterion.ok) ok(criterion.name, criterion.detail);
      else if (criterion.blocking) fail(criterion.name, criterion.detail);
      else warn(criterion.name, criterion.detail);
    }

    blank();
    if (report.ok) {
      ok("LIVE AUTORISÉ", "tous les critères bloquants sont remplis");
    } else {
      fail("LIVE REFUSÉ", report.reasons.join(" ; "));
    }
    blank();

    return report.ok;
  } finally {
    closeRuntime(runtime);
  }
}
