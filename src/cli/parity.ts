import { listBacktestRuns } from "../backtest/store.js";
import { listEquity } from "../state/equity.js";
import { listTrades } from "../state/trades.js";
import { blank, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface ParityOptions {
  root?: string;
  days?: number;
  mode?: string;
}

/**
 * Rapport de **parité** entre le paper et le backtest.
 *
 * C'est le document le plus important du projet, et le plus inconfortable :
 * il compare, sur la même période, ce que le backtest annonçait et ce que
 * le paper a réellement fait. Un écart unexplained est un signal d'alerte
 * — soit le backtest est trop optimiste, soit le paper est mal branché.
 *
 * L'écart est décomposé en quatre postes, pour qu'il soit actionnable :
 * - **coûts** : le paper a-t-il payé plus que le modèle ne prévoyait ?
 * - **timing** : les trades ont-ils eu lieu aux mêmes moments ?
 * - **liquidité** : les fills ont-ils été aussi bons que modélisés ?
 * - **décisions** : les bots ont-ils pris les mêmes décisions ?
 */
export function runParity(options: ParityOptions = {}): void {
  const runtime = createRuntime({ root: options.root });
  try {
    const days = options.days ?? 30;
    const mode = options.mode ?? "paper";
    const sinceMs = Date.now() - days * 86_400_000;

    heading(`solbot3 parity — paper vs backtest sur ${days} j`);

    const paperTrades = listTrades(runtime.db, { mode, limit: 10_000 }).filter(
      (t) => t.tsMs >= sinceMs,
    );
    const paperEquity = listEquity(runtime.db, { mode, fromMs: sinceMs });

    const runs = listBacktestRuns(runtime.db, 10);
    const lastRun = runs[0];

    blank();

    if (paperTrades.length === 0 && paperEquity.length === 0) {
      warn(
        `aucune activité en mode « ${mode} » sur ${days} j`,
        "lancez `start --paper` pour produire des données de comparaison",
      );
      blank();
      return;
    }

    // ── Côté paper ──────────────────────────────────────────────────────
    const paperPnl = paperEquity.length
      ? (paperEquity[paperEquity.length - 1]?.navUsd ?? 0) - (paperEquity[0]?.navUsd ?? 0)
      : 0;
    const paperFees = paperTrades.reduce((sum, t) => sum + t.feeUsd, 0);
    const paperNotional = paperTrades.reduce((sum, t) => sum + t.notionalUsd, 0);

    info("paper — trades", `${paperTrades.length}`);
    info("paper — PnL", `${paperPnl.toFixed(2)} $`);
    info("paper — frais", `${paperFees.toFixed(2)} $`);
    info("paper — notionnel", `${paperNotional.toFixed(2)} $`);

    // ── Côté backtest ───────────────────────────────────────────────────
    if (!lastRun) {
      blank();
      warn(
        "aucun backtest enregistré",
        "lancez `backtest run` pour disposer d'un point de comparaison",
      );
      blank();
      return;
    }

    blank();
    info(
      `backtest « ${lastRun.label} »`,
      `${lastRun.days.toFixed(1)} j · ${lastRun.tradesCount} trades`,
    );
    info("backtest — PnL", `${lastRun.metrics.netPnlUsd.toFixed(2)} $`);
    info("backtest — frais", `${lastRun.metrics.feesUsd.toFixed(2)} $`);
    info(
      "backtest — notionnel",
      `${(lastRun.metrics.turnover * 1000).toFixed(0)} $ (turnover ${lastRun.metrics.turnover.toFixed(2)})`,
    );

    // ── Décomposition de l'écart ────────────────────────────────────────
    blank();
    info("écart");

    const tradeRatio =
      lastRun.metrics.trades > 0 ? paperTrades.length / lastRun.metrics.trades : null;
    note(
      tradeRatio === null
        ? "timing — impossible à comparer (aucun trade de référence)"
        : `timing — ${paperTrades.length} trades paper pour ${lastRun.metrics.trades} backtest (ratio ${tradeRatio.toFixed(2)})`,
    );

    const paperCostBps = paperNotional > 0 ? (paperFees / paperNotional) * 10_000 : null;
    const backtestCostBps =
      lastRun.metrics.turnover > 0
        ? (lastRun.metrics.feesUsd / (lastRun.metrics.turnover * 1000)) * 10_000
        : null;
    note(
      paperCostBps === null || backtestCostBps === null
        ? "coûts — incomparables (notionnel nul d'un côté)"
        : `coûts — paper ${paperCostBps.toFixed(1)} bps contre backtest ${backtestCostBps.toFixed(1)} bps`,
    );

    const pnlGap = paperPnl - lastRun.metrics.netPnlUsd;
    note(
      `PnL — écart de ${pnlGap >= 0 ? "+" : ""}${pnlGap.toFixed(2)} $ entre le paper et le backtest`,
    );

    // ── Verdict ─────────────────────────────────────────────────────────
    blank();
    const tolerancePct = 50;
    const relativeGap =
      Math.abs(lastRun.metrics.netPnlUsd) > 0
        ? Math.abs(pnlGap / lastRun.metrics.netPnlUsd) * 100
        : null;

    if (relativeGap === null) {
      warn("parité indéterminée", "le backtest de référence n'a produit aucun PnL");
    } else if (relativeGap <= tolerancePct) {
      ok("parité acceptable", `écart de ${relativeGap.toFixed(1)} % (tolérance ${tolerancePct} %)`);
    } else {
      warn(
        "parité rompue",
        `écart de ${relativeGap.toFixed(1)} % (tolérance ${tolerancePct} %) — le backtest est peut-être trop optimiste, ou le paper mal branché`,
      );
    }

    blank();
  } finally {
    closeRuntime(runtime);
  }
}
