import { computeMetrics, type ClosedTrade } from "../backtest/metrics.js";
import { getBacktestEquity, getBacktestTrades, listBacktestRuns } from "../backtest/store.js";
import { listEquity } from "../state/equity.js";
import { costBreakdown, listTrades } from "../state/trades.js";
import { blank, heading, info, note, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface ReportOptions {
  days?: number;
  mode?: string;
  root?: string;
}

/**
 * Rapport de performance du bot.
 *
 * Le rapport compare la période demandée au **dernier backtest** enregistré :
 * c'est le contexte qui donne un sens au PnL. Un PnL de -5 % n'a pas le même
 * sens selon qu'il vient du live, du paper, ou d'un backtest dont la
 * parité est mesurée.
 */
export function runReport(options: ReportOptions = {}): void {
  const runtime = createRuntime({ root: options.root });
  try {
    const days = options.days ?? 30;
    const mode = options.mode ?? "paper";
    const sinceMs = Date.now() - days * 86_400_000;

    heading(`solbot3 report — ${mode} sur ${days} j`);

    // Le backtest tourne en base mémoire : sa courbe d'équité est stockée à
    // part (`backtest_equity`), pas dans `equity_curve`.
    const runs = listBacktestRuns(runtime.db, 5);
    const isBacktest = mode === "backtest";

    let equity: { tsMs: number; navUsd: number }[];
    let trades = listTrades(runtime.db, { mode, limit: 10_000 }).filter((t) => t.tsMs >= sinceMs);

    if (isBacktest) {
      const last = runs[0];
      if (!last) {
        warn("aucun backtest enregistré", "lancez `backtest run`");
        blank();
        return;
      }
      equity = getBacktestEquity(runtime.db, last.id)
        .filter((point) => point.tsMs >= sinceMs)
        .map((point) => ({ tsMs: point.tsMs, navUsd: point.navUsd }));
      trades = getBacktestTrades(runtime.db, last.id)
        .filter((t) => t.tsMs >= sinceMs)
        .map((t) => ({
          tsMs: t.tsMs,
          mode,
          strategy: "backtest",
          mint: t.mint,
          symbol: t.mint,
          side: t.side as "buy" | "sell",
          priceUsd: t.priceUsd,
          qty: t.qty,
          notionalUsd: t.notionalUsd,
          feeUsd: t.feeUsd,
          realizedPnlUsd: t.pnlUsd,
          reason: null,
          signature: null,
          status: "simulated" as const,
        }));
    } else {
      equity = listEquity(runtime.db, { mode, fromMs: sinceMs }).map((p) => ({
        tsMs: p.tsMs,
        navUsd: p.navUsd,
      }));
    }

    if (equity.length === 0) {
      warn("aucun point d'équité", `mode « ${mode} » — rien à mesurer sur ${days} j`);
      blank();
      return;
    }

    const closed: ClosedTrade[] = trades
      .filter((t) => t.side === "sell" && t.realizedPnlUsd !== null)
      .map((t) => ({
        tsMs: t.tsMs,
        pnlUsd: t.realizedPnlUsd ?? 0,
        notionalUsd: t.notionalUsd,
        feeUsd: t.feeUsd,
      }));

    const initialUsd = equity[0]?.navUsd ?? 0;
    const metrics = computeMetrics({
      equity: equity.map((e) => ({ tsMs: e.tsMs, navUsd: e.navUsd })),
      trades: closed,
      initialUsd,
      days,
    });

    const costs = costBreakdown(runtime.db, sinceMs);
    const pct = (value: number | null): string =>
      value === null ? "n/d" : `${value.toFixed(2)} %`;

    blank();
    info("capital initial", `${metrics.initialNavUsd.toFixed(2)} $`);
    info("capital final", `${metrics.finalNavUsd.toFixed(2)} $`);
    info("PnL net", `${metrics.netPnlUsd.toFixed(2)} $ (${pct(metrics.netPnlPct)})`);
    info("trades clôturés", `${metrics.trades}`);
    info("win rate", pct(metrics.winRatePct));
    info("profit factor", metrics.profitFactor === null ? "n/d" : metrics.profitFactor.toFixed(2));
    info("drawdown max", pct(metrics.maxDrawdownPct));
    info("Sharpe", metrics.sharpe === null ? "n/d" : metrics.sharpe.toFixed(2));
    info("frais payés", `${costs.feesUsd.toFixed(2)} $ sur ${costs.trades} exécutions`);
    info("turnover", metrics.turnover.toFixed(2));

    // ── Comparaison au dernier backtest ────────────────────────────────
    if (runs.length > 0) {
      const last = runs[0];
      blank();
      info(
        `dernier backtest — « ${last.label} »`,
        `${last.days.toFixed(1)} j · ${last.tradesCount} trades`,
      );
      note(
        `PnL ${last.metrics.netPnlUsd.toFixed(2)} $ (${pct(last.metrics.netPnlPct)}) · win rate ${pct(last.metrics.winRatePct)} · PF ${last.metrics.profitFactor?.toFixed(2) ?? "n/d"} · DD ${pct(last.metrics.maxDrawdownPct)}`,
      );
      note(`empreinte de configuration : ${last.configHash}`);
    } else {
      blank();
      warn(
        "aucun backtest enregistré",
        "lancez `backtest run` pour disposer d'un point de comparaison",
      );
    }

    blank();
  } finally {
    closeRuntime(runtime);
  }
}
