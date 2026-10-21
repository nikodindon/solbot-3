import { SOL_MINT, USDC_MINT } from "../constants.js";
import type { AppConfig, Timeframe } from "../config/schema.js";
import { Engine, MemoryStopSwitch, type MarketQuote, type MarketSource } from "../engine/engine.js";
import { KvCash } from "../execution/cash.js";
import { DEFAULT_COST_CONFIG, type CostConfig } from "../execution/costs.js";
import { PaperExecutor } from "../execution/executor.js";
import { RiskManager } from "../risk/risk-manager.js";
import { enabledStrategies } from "../strategies/registry.js";
import { closeDb, openDb, type DB } from "../state/db.js";
import { countRejectionsByRule } from "../state/decisions.js";
import { listEquity } from "../state/equity.js";
import { MemoryCandleSource } from "../market/candles.js";
import { getMergedCandles } from "../state/imported-candles.js";
import { kvSetNumber, STATE_KEYS } from "../state/kv.js";
import { getTokenMeta, listWatchlist, listWatchlistMints } from "../state/market-data.js";
import { listTrades } from "../state/trades.js";
import { computeMetrics, type ClosedTrade, type PerformanceMetrics } from "./metrics.js";

/**
 * Le backtest.
 *
 * Il rejoue **le moteur réel** — mêmes stratégies, même RiskManager, même
 * portefeuille FIFO, même modèle de coûts, même exécuteur de fill. Seules
 * trois choses changent :
 * - la source de marché rejoue l'historique au lieu de l'interroger ;
 * - l'horloge rejoue le temps au lieu de le laisser couler ;
 * - la base est en mémoire, pour ne pas polluer l'état réel.
 *
 * C'est le cœur de la méthode : un backtest qui rejoue un moteur *différent*
 * ne prouve rien.
 */

/** Un échantillon de marché : les prix de tous les actifs à un instant. */
export interface MarketSample {
  tsMs: number;
  quotes: Map<string, MarketQuote>;
}

export interface BacktestOptions {
  /** Base de référence (contient l'historique importé et la watchlist). */
  sourceDb: DB;
  cfg: AppConfig;
  /** Fenêtre historique, en jours. */
  days: number;
  /** Timeframe des bougies rejouées. */
  timeframe: Timeframe;
  /** Capital de départ. */
  initialUsdc?: number;
  /** Mints à rejouer (défaut : la watchlist). */
  mints?: string[];
  /** Multiplicateur de coûts (sensibilité). */
  costMultiplier?: number;
  /** Libellé (pour le stockage). */
  label?: string;
  /** Force la fenêtre historique (utilisé par le walk-forward). */
  fromMs?: number;
  toMs?: number;
  /** Progression. */
  onProgress?: (done: number, total: number) => void;
}

export interface BacktestResult {
  ok: boolean;
  /** Toutes les exécutions du run, pour le rapport. */
  trades: {
    tsMs: number;
    mint: string;
    side: string;
    priceUsd: number;
    qty: number;
    notionalUsd: number;
    feeUsd: number;
    realizedPnlUsd: number | null;
  }[];
  error?: string;
  metrics: PerformanceMetrics;
  equity: { tsMs: number; navUsd: number; cashUsd: number; positionsUsd: number }[];
  rejections: Record<string, number>;
  mintsCount: number;
  candlesCount: number;
  tradesCount: number;
  fromMs: number;
  toMs: number;
  days: number;
  /** Le run a-t-il été jugé concluant ? */
  conclusive: boolean;
  /** Motif du refus de conclure. */
  conclusiveReason: string | null;
  db: DB;
  close(): void;
}

/**
 * Construit les échantillons de marché à partir de l'historique.
 *
 * Pour chaque horodatage de bougie, le prix d'un actif est la **clôture de
 * sa dernière bougie** à cet instant. Les actifs sans bougie à ce moment
 * n'ont pas de prix : ils sont absents de l'échantillon.
 */
export function buildSamples(
  sourceDb: DB,
  mints: string[],
  timeframe: Timeframe,
  fromMs: number,
  toMs: number,
  defaultLiquidityUsd: number,
): MarketSample[] {
  const histories = new Map<string, { ts: number; close: number; liquidity: number }[]>();

  for (const mint of mints) {
    const candles = getMergedCandles(sourceDb, mint, timeframe, { fromMs, toMs });
    // Liquidité supposée **statique** : celle relevée au scan, ou le repli
    // configuré. C'est une limite documentée du backtest (README §9.5).
    const liquidity = getTokenMeta(sourceDb, mint)?.liquidityUsd ?? defaultLiquidityUsd;
    histories.set(
      mint,
      candles.map((c) => ({ ts: c.ts, close: c.close, liquidity })),
    );
  }

  // Tous les horodatages possibles, triés.
  const timestamps = new Set<number>();
  for (const series of histories.values()) {
    for (const point of series) timestamps.add(point.ts);
  }
  const sorted = [...timestamps].sort((a, b) => a - b);

  const samples: MarketSample[] = [];
  const cursors = new Map<string, number>();

  for (const tsMs of sorted) {
    const quotes = new Map<string, MarketQuote>();
    for (const [mint, series] of histories) {
      let index = cursors.get(mint) ?? 0;
      while (index < series.length && (series[index]?.ts ?? 0) <= tsMs) index += 1;
      cursors.set(mint, index);
      const point = series[index - 1];
      if (point) quotes.set(mint, { priceUsd: point.close, liquidityUsd: point.liquidity });
    }
    samples.push({ tsMs, quotes });
  }

  return samples;
}

/** Source de marché qui rejoue les échantillons. */
export class ReplayMarketSource implements MarketSource {
  private index = 0;

  constructor(private readonly samples: MarketSample[]) {}

  pollOnce(tsMs: number): Promise<Map<string, MarketQuote>> {
    while (
      this.index + 1 < this.samples.length &&
      (this.samples[this.index + 1]?.tsMs ?? 0) <= tsMs
    ) {
      this.index += 1;
    }
    return Promise.resolve(this.samples[this.index]?.quotes ?? new Map());
  }

  /** Nombre d'échantillons restants. */
  get remaining(): number {
    return Math.max(0, this.samples.length - this.index);
  }
}

/**
 * Exécute un backtest.
 *
 * La base de travail est **en mémoire** : l'état réel n'est jamais touché.
 */
export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const {
    sourceDb,
    cfg,
    days,
    timeframe,
    initialUsdc = cfg.paper.initial_usdc,
    costMultiplier = 1,
  } = options;

  const toMs = options.toMs ?? Date.now();
  const fromMs = options.fromMs ?? toMs - days * 24 * 3_600_000;

  const mints = options.mints ?? listWatchlistMints(sourceDb).filter((m) => m !== USDC_MINT);
  const universe = [...new Set([...mints, SOL_MINT, USDC_MINT])];

  // ── Base de travail en mémoire ────────────────────────────────────────
  const work = openDb({ path: ":memory:" });
  const { migrate } = await import("../state/migrations.js");
  migrate(work);

  // Watchlist (on garde les symboles pour le journal).
  const watchlist = listWatchlist(sourceDb);
  for (const item of watchlist) {
    work
      .prepare(
        "INSERT INTO watchlist (mint, symbol, rank, added_ms, active) VALUES (?, ?, ?, ?, 1)",
      )
      .run(item.mint, item.symbol, item.rank, Date.now());
  }

  // Historique : on le charge **en mémoire** (source de bougies) et on le
  // recopie dans la base de travail pour que le moteur lise exactement le
  // même historique.
  let candlesCount = 0;
  const allCandles = [];
  for (const mint of universe) {
    const candles = getMergedCandles(sourceDb, mint, timeframe, { fromMs, toMs });
    if (candles.length === 0) continue;
    candlesCount += candles.length;
    allCandles.push(...candles);
  }

  const samples = buildSamples(
    sourceDb,
    universe,
    timeframe,
    fromMs,
    toMs,
    cfg.backtest.default_liquidity_usd,
  );
  if (samples.length === 0) {
    closeDb(work);
    return {
      ok: false,
      error: "aucune bougie dans la fenêtre demandée — lancez d'abord `backtest import`",
      trades: [],
      metrics: computeMetrics({ equity: [], trades: [], initialUsd: initialUsdc, days }),
      equity: [],
      rejections: {},
      mintsCount: 0,
      candlesCount: 0,
      tradesCount: 0,
      fromMs,
      toMs,
      days,
      conclusive: false,
      conclusiveReason: "aucune donnée",
      db: work,
      close: () => closeDb(work),
    };
  }

  // ── Moteur ────────────────────────────────────────────────────────────
  const costs: CostConfig = {
    ...DEFAULT_COST_CONFIG,
    fillSlippageBps: cfg.paper.fill_slippage_bps * costMultiplier,
    impactK: cfg.paper.impact_k * costMultiplier,
    priorityFeeSol: cfg.paper.priority_fee_sol * costMultiplier,
  };

  const cash = new KvCash(work, initialUsdc);
  cash.seed(initialUsdc);

  const executor = new PaperExecutor({ db: work, mode: "backtest", cash, costs });
  const risk = new RiskManager(cfg.risk, cfg.allocator, costs);
  const strategies = enabledStrategies(cfg.strategies);

  let clock = samples[0]?.tsMs ?? fromMs;
  const market = new ReplayMarketSource(samples);

  const engine = new Engine({
    db: work,
    cfg,
    mode: "backtest",
    strategies,
    market,
    candles: new MemoryCandleSource(allCandles),
    executor,
    risk,
    cash,
    stop: new MemoryStopSwitch(),
    clock: () => clock,
  });

  for (const [index, sample] of samples.entries()) {
    clock = sample.tsMs;
    const report = await engine.runTick();
    if (!report.ok && engine.shouldStop()) break;
    options.onProgress?.(index + 1, samples.length);
  }

  // ── Métriques ─────────────────────────────────────────────────────────
  const equityRows = listEquity(work, { mode: "backtest" });
  const equity = equityRows.map((row) => ({
    tsMs: row.tsMs,
    navUsd: row.navUsd,
    cashUsd: row.cashUsd,
    positionsUsd: row.positionsUsd,
  }));

  const tradeRows = listTrades(work, { mode: "backtest", limit: 10_000 });
  const closedTrades: ClosedTrade[] = tradeRows
    .filter((trade) => trade.side === "sell" && trade.realizedPnlUsd !== null)
    .map((trade) => ({
      tsMs: trade.tsMs,
      pnlUsd: trade.realizedPnlUsd ?? 0,
      notionalUsd: trade.notionalUsd,
      feeUsd: trade.feeUsd,
    }));

  const metrics = computeMetrics({
    equity: equityRows.map((row) => ({ tsMs: row.tsMs, navUsd: row.navUsd })),
    trades: closedTrades,
    initialUsd: initialUsdc,
    days,
  });

  const rejections = countRejectionsByRule(work, fromMs);

  // ── Verdict ───────────────────────────────────────────────────────────
  const coverageDays = (samples[samples.length - 1]?.tsMs ?? fromMs) - fromMs;
  const coveredDays = coverageDays / 86_400_000;
  const { min_backtest_days: minDays, min_windows: minWindows } = cfg.guard;

  const reasons: string[] = [];
  if (coveredDays < minDays) {
    reasons.push(`couverture ${coveredDays.toFixed(1)} j < ${minDays} j requis`);
  }
  if (minWindows > 1) {
    // Le nombre de fenêtres distinctes est approché par le nombre de jours
    // couverts : une fenêtre = un segment de marché distinct.
    const windows = Math.floor(coveredDays / Math.max(1, minDays / minWindows));
    if (windows < minWindows) {
      reasons.push(`${windows} fenêtre(s) < ${minWindows} requises`);
    }
  }
  if (cfg.guard.require_positive_oos_pnl && metrics.netPnlUsd <= 0) {
    reasons.push(`PnL net ${metrics.netPnlUsd.toFixed(2)} $ ≤ 0`);
  }

  return {
    ok: true,
    trades: tradeRows.map((trade) => ({
      tsMs: trade.tsMs,
      mint: trade.mint,
      side: trade.side,
      priceUsd: trade.priceUsd,
      qty: trade.qty,
      notionalUsd: trade.notionalUsd,
      feeUsd: trade.feeUsd,
      realizedPnlUsd: trade.realizedPnlUsd,
    })),
    metrics,
    equity,
    rejections,
    mintsCount: universe.length,
    candlesCount,
    tradesCount: tradeRows.length,
    fromMs,
    toMs,
    days: coveredDays,
    conclusive: reasons.length === 0,
    conclusiveReason: reasons.length > 0 ? reasons.join(" ; ") : null,
    db: work,
    close: () => closeDb(work),
  };
}

/** Garde-fou : la réserve de gaz et le pic d'équité vivent dans la base. */
export { kvSetNumber, STATE_KEYS };
