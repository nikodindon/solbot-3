import { Poller } from "../market/poller.js";
import { candleCoverage } from "../state/market-data.js";
import { sleep } from "../utils/time.js";
import { blank, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface WatchOptions {
  /** Intervalle entre deux collectes (secondes). Défaut : `config.loop_interval_s`. */
  intervalS?: number;
  /** Durée totale (secondes). 0 = jusqu'à l'interruption. */
  durationS?: number;
  /** Un seul tick puis sortie. */
  once?: boolean;
  root?: string;
}

/**
 * Collecte continue des prix et des bougies, sans trader.
 *
 * C'est la phase de *warm-up* du projet : plus le moteur a de bougies
 * clôturées, plus les stratégies ont de matière pour produire un signal.
 */
export async function runWatch(options: WatchOptions = {}): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  const intervalMs = (options.intervalS ?? runtime.config.loop_interval_s) * 1000;
  const deadline =
    options.durationS && options.durationS > 0 ? Date.now() + options.durationS * 1000 : null;

  const poller = new Poller({
    db: runtime.db,
    priceApi: runtime.priceApi,
    tokensApi: runtime.tokensApi,
    timeframes: runtime.config.data.timeframes,
  });

  heading("solbot3 watch — collecte des prix et des bougies");
  info("intervalle", `${intervalMs / 1000} s`);
  info("timeframes", runtime.config.data.timeframes.join(", "));
  info("watchlist", `${poller.mints().length} mints suivis`);
  if (deadline) info("durée", `${options.durationS} s`);
  blank();

  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let ticks = 0;
  let failures = 0;
  const startedAt = Date.now();

  try {
    for (;;) {
      const result = await poller.pollOnce(Date.now());
      ticks += 1;

      if (result.ok) {
        const prices = [...result.prices.values()];
        const median = medianPrice(prices.map((p) => p.priceUsd));
        ok(
          `tick ${ticks}`,
          `${prices.length} prix · médiane ${median.toFixed(6)} $ · ${result.candles} bougies${
            result.volumesKnown ? "" : " · volume indisponible"
          }`,
        );
      } else {
        failures += 1;
        warn(`tick ${ticks}`, result.error ?? "échec inconnu");
      }

      if (options.once) break;
      if (stopping) {
        note("interruption demandée — arrêt du collecteur");
        break;
      }
      if (deadline !== null && Date.now() >= deadline) {
        note("durée atteinte — arrêt du collecteur");
        break;
      }

      await sleep(intervalMs);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    blank();
    ok(
      "collecte terminée",
      `${ticks} tick(s) en ${elapsed} s${failures ? `, ${failures} échec(s)` : ""}`,
    );

    const coverage = candleCoverage(runtime.db);
    if (coverage.length > 0) {
      blank();
      info("couverture des bougies");
      for (const row of coverage) {
        note(`${row.tf} — ${row.candles} bougies sur ${row.mints} actif(s)`);
      }
    }
    blank();

    closeRuntime(runtime);
  }
}

function medianPrice(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}
