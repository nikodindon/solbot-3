import { listTrades } from "../state/trades.js";
import { blank, heading, info, note, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface PathsOptions {
  root?: string;
  days?: number;
}

/**
 * `solbot3 paths` — comparaison A/B des chemins d'exécution.
 *
 * ⚠ Seuls les swaps **live** comptent : un dry-run mesure la qualité d'un
 * devis, pas la qualité d'un atterrissage. Le dry-run ne produit donc aucune
 * ligne dans ce rapport — c'est volontaire.
 *
 * Le chemin Meta-Aggregator reste le **défaut** tant que cette comparaison
 * n'a pas porté sur au moins 200 swaps réels : c'est la règle du README
 * (§11.2), et elle n'est pas négociable.
 */
export function runPaths(options: PathsOptions = {}): void {
  const runtime = createRuntime({ root: options.root });
  try {
    const days = options.days ?? 7;
    const sinceMs = Date.now() - days * 86_400_000;

    heading(`solbot3 paths — chemins d'exécution (${days} j)`);

    const trades = listTrades(runtime.db, { mode: "live", limit: 10_000 }).filter(
      (trade) => trade.tsMs >= sinceMs,
    );

    blank();
    if (trades.length === 0) {
      warn(
        "aucun swap live sur la période",
        "seuls les swaps réellement envoyés mesurent un chemin d'atterrissage",
      );
      blank();
      return;
    }

    // Regroupement par chemin.
    const byPath = new Map<string, { count: number; ok: number; notional: number }>();
    for (const trade of trades) {
      const path = (trade.reason ?? "inconnu").includes("router") ? "router" : "meta_aggregator";
      const entry = byPath.get(path) ?? { count: 0, ok: 0, notional: 0 };
      entry.count += 1;
      if (trade.status === "filled") entry.ok += 1;
      entry.notional += trade.notionalUsd;
      byPath.set(path, entry);
    }

    info("chemin", "swaps");
    for (const [path, entry] of byPath) {
      const rate = entry.count > 0 ? (entry.ok / entry.count) * 100 : 0;
      note(
        `${path.padEnd(16)} ${String(entry.count).padStart(4)}  réussite ${rate.toFixed(1)} %  notionnel ${entry.notional.toFixed(2)} $`,
      );
    }

    blank();
    if (trades.length < 200) {
      note(
        `⚠ ${trades.length} swap(s) observé(s) — le README exige au moins 200 pour autoriser un changement de chemin par défaut.`,
      );
      note("Le Meta-Aggregator reste donc le défaut.");
    } else {
      ok("échantillon suffisant", "une recommandation de bascule peut être formulée");
    }
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

function ok(label: string, detail?: string): void {
  console.log(`  ✔ ${label}${detail ? ` ${detail}` : ""}`);
}
