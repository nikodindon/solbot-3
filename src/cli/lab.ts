import fs from "node:fs";
import path from "node:path";
import { runLab } from "../lab/runner.js";
import { blank, fail, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface LabCliOptions {
  root?: string;
  /** Stratégies à jouer (défaut : celles activées dans la configuration). */
  strategies?: string[];
  /** Durée de la session, en secondes. */
  durationS?: number;
}

/**
 * `solbot3 lab` — le laboratoire.
 *
 * Le lab est **paper uniquement** : il n'existe aucun moyen de transformer
 * une session de lab en ordre réel. Chaque run est consigné dans
 * `results/experiments.md`, y compris quand il échoue.
 */
export async function runLabCommand(options: LabCliOptions = {}): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  try {
    const cfg = runtime.config;

    const strategies =
      options.strategies && options.strategies.length > 0
        ? options.strategies
        : [
            ...(cfg.strategies.trend_breakout.enabled ? ["trend_breakout"] : []),
            ...(cfg.strategies.mean_reversion.enabled ? ["mean_reversion"] : []),
            ...(cfg.strategies.grid.enabled ? ["grid"] : []),
            ...(cfg.strategies.dca_rotation.enabled ? ["dca_rotation"] : []),
            ...(cfg.strategies.relative_strength.enabled ? ["relative_strength"] : []),
            ...(cfg.strategies.regime_switch.enabled ? ["regime_switch"] : []),
          ];

    heading("solbot3 lab — laboratoire (paper uniquement)");
    info("stratégies", strategies.join(", ") || "aucune");
    info("capital initial", `${cfg.lab.initial_usdc} $`);
    info("mise maximale", `${cfg.lab.max_bet_usd} $`);
    info(
      "stop-loss obligatoire",
      cfg.risk.stop_loss_pct > 0 ? `oui (${cfg.risk.stop_loss_pct} %)` : "NON",
    );
    blank();

    const result = await runLab({
      root: runtime.root,
      cfg,
      strategies,
      durationS: options.durationS ?? 0,
      priceApi: runtime.priceApi,
      tokensApi: runtime.tokensApi,
    });

    if (!result.ok) {
      fail("laboratoire refusé", result.error ?? "raison inconnue");
      blank();
      return;
    }

    for (const warning of result.warnings) warn(warning);

    ok("session terminée", `NAV ${result.finalNavUsd.toFixed(2)} $ · ${result.trades} trade(s)`);
    info("base du lab", result.dbPath);
    info("prix rejetés (non corroborés)", String(result.rejectedByCorroboration));

    appendExperiment(runtime.root, result);
    blank();
    note("run consigné dans results/experiments.md");
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

/**
 * Consigne le run dans `results/experiments.md`.
 *
 * Le journal est **versionné** : c'est la mémoire du projet. Les échecs
 * y sont écrit comme les succès — c'est ce qui évite de repeating les
 * mêmes erreurs.
 */
function appendExperiment(
  root: string,
  result: {
    finalNavUsd: number;
    trades: number;
    rejectedByCorroboration: number;
    strategies: string[];
    warnings: string[];
  },
): void {
  const file = path.join(root, "results", "experiments.md");
  if (!fs.existsSync(path.dirname(file))) return;

  const today = new Date().toISOString().slice(0, 10);
  const block = [
    "",
    `### ${today} — laboratoire : ${result.strategies.join(" + ")}`,
    "",
    `- **Mise maximale** : plafonnée par \`lab.max_bet_usd\` (base séparée, paper uniquement).`,
    `- **NAV final** : ${result.finalNavUsd.toFixed(2)} $`,
    `- **Trades** : ${result.trades}`,
    `- **Prix rejetés faute de corroboration** : ${result.rejectedByCorroboration}`,
    ...(result.warnings.length > 0 ? result.warnings.map((w) => `- ${w}`) : []),
    "",
  ].join("\n");

  try {
    const content = fs.readFileSync(file, "utf8");
    const marker = "\n## Expériences\n";
    const index = content.indexOf(marker);
    if (index === -1) {
      fs.appendFileSync(file, block, "utf8");
    } else {
      const head = content.slice(0, index + marker.length);
      const tail = content.slice(index + marker.length);
      fs.writeFileSync(file, `${head}${block}${tail}`, "utf8");
    }
  } catch {
    // Le journal est un confort : son échec ne doit pas faire échouer le lab.
  }
}
