import { USDC_MINT } from "../constants.js";
import { importHistory } from "../backtest/import-history.js";
import type { PerformanceMetrics } from "../backtest/metrics.js";
import { runBacktest } from "../backtest/runner.js";
import {
  configFingerprint,
  insertBacktestEquity,
  insertBacktestRun,
  insertBacktestTrades,
} from "../backtest/store.js";
import { runSensitivity } from "../backtest/sensitivity.js";
import { runWalkForward } from "../backtest/walk-forward.js";
import { getMergedCandles, importedCoverage } from "../state/imported-candles.js";
import { listWatchlistMints } from "../state/market-data.js";
import { blank, fail, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface BacktestOptions {
  root?: string;
}

/** `backtest import --days N` — récupère l'historique OHLCV. */
export async function runBacktestImport(
  days: number,
  options: BacktestOptions & { timeframe?: "5m" | "15m" | "1h" } = {},
): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  const timeframe = options.timeframe ?? "15m";
  try {
    const mints = listWatchlistMints(runtime.db).filter((m) => m !== USDC_MINT);
    if (mints.length === 0) {
      fail("watchlist vide", "lancez d'abord `scan`");
      return;
    }

    heading(`solbot3 backtest import — ${days} jours sur ${mints.length} actifs`);
    info("source", "GeckoTerminal — pool de plus grande réserve USD");
    info("timeframe", timeframe);
    blank();

    const result = await importHistory({
      db: runtime.db,
      mints,
      tf: timeframe,
      days,
      onProgress: (done, total, mint, candles) => {
        // En dehors d'un terminal, un retour chariot à la ligne rendrait le
        // journal illisible : on écrit une ligne par actif.
        const line = `  ${String(done).padStart(3)}/${total}  ${mint.slice(0, 8)}…  ${candles} bougies`;
        if (process.stdout.isTTY) process.stdout.write(`${line}\r`);
        else if (done === total || candles > 0) console.log(line);
      },
    });
    process.stdout.write("\n");
    blank();

    ok(
      `${result.mintsImported}/${result.mintsTotal} actifs importés`,
      `${result.candlesTotal} bougies`,
    );
    if (result.mintsSkipped > 0) {
      info(
        `${result.mintsSkipped} actif(s) déjà couverts`,
        "import idempotent : rien n'a été refait",
      );
    }
    if (result.skipped.length > 0) {
      warn(`${result.skipped.length} actif(s) sans historique`, "voir le détail ci-dessous");
      for (const skip of result.skipped.slice(0, 10)) {
        note(`${skip.mint.slice(0, 8)}… : ${skip.reason}`);
      }
    }

    blank();
    const coverage = importedCoverage(runtime.db);
    for (const row of coverage) {
      note(
        `${row.tf} — ${row.candles} bougies sur ${row.mints} actif(s), du ${new Date(row.oldest ?? 0).toISOString().slice(0, 10)} au ${new Date(row.newest ?? 0).toISOString().slice(0, 10)}`,
      );
    }
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

/** `backtest run --days N --label X` — rejoue le moteur sur l'historique. */
export async function runBacktestRun(
  days: number,
  label: string,
  options: BacktestOptions & { timeframe?: "5m" | "15m" | "1h"; configPath?: string } = {},
): Promise<void> {
  const runtime = createRuntime({ root: options.root, configPath: options.configPath });
  try {
    const timeframe = options.timeframe ?? "15m";
    heading(`solbot3 backtest run — ${label} (${days} j, ${timeframe})`);
    if (options.configPath) info("configuration", options.configPath);

    const mints = listWatchlistMints(runtime.db);
    const coverage = getMergedCandles(runtime.db, mints[0] ?? "", timeframe, {
      fromMs: Date.now() - days * 86_400_000,
    });
    if (coverage.length === 0) {
      fail("aucune bougie disponible", "lancez d'abord `backtest import --days N`");
      return;
    }

    const result = await runBacktest({
      sourceDb: runtime.db,
      cfg: runtime.config,
      days,
      timeframe,
      label,
    });

    if (!result.ok) {
      fail("backtest impossible", result.error ?? "raison inconnue");
      return;
    }

    printMetrics(result.metrics, result.days);
    blank();

    // ── Verdict ────────────────────────────────────────────────────────
    if (result.conclusive) {
      ok("concluant", "les garde-fous de la phase 4 pourraient s'appuyer sur ce run");
    } else {
      warn("non concluant", result.conclusiveReason ?? "critères non remplis");
    }

    // ── Rejets par règle ───────────────────────────────────────────────
    const rejections = Object.entries(result.rejections).sort((a, b) => b[1] - a[1]);
    if (rejections.length > 0) {
      blank();
      info("rejets par règle");
      for (const [rule, count] of rejections) {
        note(`${rule.padEnd(22)} ${count}`);
      }
    }

    // ── Sensibilité aux coûts ───────────────────────────────────────────
    blank();
    info("sensibilité aux coûts");
    const sensitivity = await runSensitivity({
      sourceDb: runtime.db,
      cfg: runtime.config,
      days,
      timeframe,
    });
    for (const point of sensitivity.points) {
      const pnl = point.netPnlUsd.toFixed(2);
      note(
        `coûts ×${point.multiplier} → PnL ${pnl} $ · ${point.trades} trades · frais ${point.feesUsd.toFixed(2)} $`,
      );
    }
    if (sensitivity.reason) {
      warn("sensibilité", sensitivity.reason);
    } else {
      ok("sensibilité acceptable", "le résultat ne s'effondre pas quand les coûts montent");
    }

    // ── Stockage ───────────────────────────────────────────────────────
    const hash = configFingerprint(runtime.config);
    const runId = insertBacktestRun(runtime.db, {
      label,
      configHash: hash,
      configJson: JSON.stringify(runtime.config.strategies),
      timeframe,
      fromMs: result.fromMs,
      toMs: result.toMs,
      days: result.days,
      initialUsdc: runtime.config.paper.initial_usdc,
      mintsCount: result.mintsCount,
      candlesCount: result.candlesCount,
      tradesCount: result.tradesCount,
      conclusive: result.conclusive,
      metrics: result.metrics,
      rejections: result.rejections,
    });
    insertBacktestEquity(runtime.db, runId, result.equity);
    insertBacktestTrades(
      runtime.db,
      runId,
      result.trades.map((trade) => ({
        tsMs: trade.tsMs,
        mint: trade.mint,
        side: trade.side,
        pnlUsd: trade.realizedPnlUsd,
        notionalUsd: trade.notionalUsd,
        feeUsd: trade.feeUsd,
        priceUsd: trade.priceUsd,
        qty: trade.qty,
      })),
    );
    result.close();

    blank();
    ok("run enregistré", `#${runId} — empreinte ${hash}`);
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

/** `backtest walk-forward --windows N` — validation par fenêtres glissantes. */
export async function runBacktestWalkForward(
  windows: number,
  days: number,
  options: BacktestOptions & { configPath?: string } = {},
): Promise<void> {
  const runtime = createRuntime({ root: options.root, configPath: options.configPath });
  try {
    heading(`solbot3 backtest walk-forward — ${windows} fenêtres sur ${days} j`);
    if (options.configPath) info("configuration", options.configPath);

    const result = await runWalkForward({
      sourceDb: runtime.db,
      cfg: runtime.config,
      days,
      windows,
      timeframe: "15m",
    });

    if (result.windows.length === 0) {
      fail("aucune fenêtre exploitable", "lancez d'abord `backtest import`");
      return;
    }

    blank();
    info("fenêtres");
    for (const window of result.windows) {
      const pnl = window.metrics.netPnlUsd.toFixed(2);
      const dd = window.metrics.maxDrawdownPct?.toFixed(1) ?? "n/d";
      note(
        `#${window.index}  ${new Date(window.fromMs).toISOString().slice(0, 10)} → ${new Date(window.toMs).toISOString().slice(0, 10)}  PnL ${pnl} $  DD ${dd} %  ${window.metrics.trades} trades`,
      );
    }

    blank();
    const aggregate = result.aggregate;
    ok(
      `PnL hors échantillon agrégé : ${aggregate.netPnlUsd.toFixed(2)} $`,
      `${result.profitableWindows}/${result.windows.length} fenêtres profitables`,
    );
    if (aggregate.netPnlUsd <= 0) {
      warn("agrégat non positif", "aucune fenêtre ne produit de résultat exploitable");
    }
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

/** Affiche les métriques d'un run. */
export function printMetrics(metrics: PerformanceMetrics, days: number): void {
  const pct = (value: number | null): string => (value === null ? "n/d" : `${value.toFixed(2)} %`);

  info("capital initial", `${metrics.initialNavUsd.toFixed(2)} $`);
  info("capital final", `${metrics.finalNavUsd.toFixed(2)} $`);
  info("PnL net", `${metrics.netPnlUsd.toFixed(2)} $ (${pct(metrics.netPnlPct)})`);
  info("trades", `${metrics.trades} (${metrics.wins} gagnants / ${metrics.losses} perdants)`);
  info("win rate", pct(metrics.winRatePct));
  info("profit factor", metrics.profitFactor === null ? "n/d" : metrics.profitFactor.toFixed(2));
  info("drawdown max", pct(metrics.maxDrawdownPct));
  info("Sharpe", metrics.sharpe === null ? "n/d" : metrics.sharpe.toFixed(2));
  info("turnover", metrics.turnover.toFixed(2));
  info("frais", `${metrics.feesUsd.toFixed(2)} $`);
  info("durée", `${days.toFixed(1)} j`);
}
