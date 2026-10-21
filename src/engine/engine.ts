import fs from "node:fs";
import { SOL_MINT, USDC_MINT } from "../constants.js";
import type { AppConfig, Mode, Timeframe } from "../config/schema.js";

/** Modes d'exécution : les trois modes de config, plus le backtest. */
export type RunMode = Mode | "backtest";
import { buildPortfolioView, timeframeMs } from "../portfolio/portfolio.js";
import type { RiskFlags, RiskManager } from "../risk/risk-manager.js";
import type { MarketSnapshot, Signal, Strategy } from "../strategies/types.js";
import { runShadows } from "../allocator/shadow-runner.js";
import type { CandleSource } from "../market/candles.js";
import { classifyRegime, type RegimeConfig, type RegimeResult } from "../market/regime.js";
import type { ImportedCandle } from "../state/imported-candles.js";
import type { DB } from "../state/db.js";
import { insertDecisions, type Decision, type DecisionKind } from "../state/decisions.js";
import { insertEquityPoint } from "../state/equity.js";
import { kvGet, kvGetNumber, kvSet, kvSetNumber, STATE_KEYS } from "../state/kv.js";
import { listWatchlistMints } from "../state/market-data.js";
import { listPositions } from "../state/portfolio-repo.js";
import type { CashLedger, Executor } from "../execution/executor.js";
import type { CostConfig } from "../execution/costs.js";

/**
 * Le moteur.
 *
 * **Un seul moteur** pour le paper, le dry-run, le live et le backtest :
 * seules les couches d'accès aux données et d'exécution changent. C'est le
 * principe directeur du projet — un backtest qui rejoue un moteur
 * *différent* ne prouve rien.
 *
 * Ordre d'un tick (les sorties passent **toujours** avant les entrées) :
 * 1. marché → 2. valorisation & garde-fous → 3. sorties → 4. entrées → 5. journal
 */

export interface MarketQuote {
  priceUsd: number;
  liquidityUsd: number | null;
}

/** Le *seam* d'accès au marché : le backtest injecte l'historique. */
export interface MarketSource {
  pollOnce(tsMs: number): Promise<Map<string, MarketQuote>>;
}

/** Le *seam* du kill-switch : un fichier en live, un drapeau en backtest. */
export interface StopSwitch {
  exists(): boolean;
  create(): void;
}

export interface EngineDeps {
  db: DB;
  cfg: AppConfig;
  mode: RunMode;
  strategies: Strategy[];
  market: MarketSource;
  /** Source des bougies (seam) : base en live, mémoire en backtest. */
  candles: CandleSource;
  /** Détection de régime (seam) — injectable pour les tests. */
  regime?: (candles: ImportedCandle[], cfg: RegimeConfig) => RegimeResult;
  /**
   * Allocateur (seam). Quand il est présent, le capital réel n'est confié
   * qu'à la **stratégie pilote** choisie parmi les portefeuilles fantômes.
   * Quand il est absent, toutes les stratégies sont candidates.
   */
  allocator?: {
    db: DB;
    allocator: AppConfig["allocator"];
    risk: AppConfig["risk"];
    costs: CostConfig;
    initialCashUsd: number;
  };
  executor: Executor;
  risk: RiskManager;
  cash: CashLedger;
  stop: StopSwitch;
  /** Horloge (seam) — le backtest rejoue le temps. */
  clock: () => number;
  /** Journalisation externe (dashboard, SSE). */
  onDecision?: (decision: Decision) => void;
}

export interface TickReport {
  tsMs: number;
  tickId: number;
  ok: boolean;
  error?: string;
  navUsd: number;
  cashUsd: number;
  positionsUsd: number;
  /** Nombre de positions ouvertes. */
  positionsOpen: number;
  realizedPnlUsd: number;
  drawdownPct: number;
  executed: { buys: number; sells: number };
  decisions: Decision[];
  /** Règle de risque qui a bloqué la dernière entrée (null sinon). */
  blockedBy: string | null;
}

/** Erreurs de tick consécutives au-delà desquelles le moteur s'arrête. */
export const MAX_CONSECUTIVE_ERRORS = 5;

interface ExitDecision {
  kind: "stop_loss" | "take_profit" | "trailing_stop";
  reason: string;
}

export class Engine {
  private tickId = 0;
  private busy = false;
  private consecutiveErrors = 0;

  constructor(private readonly deps: EngineDeps) {}

  /** Un tick complet. Un tick concurrent est ignoré (verrou de trade). */
  async runTick(): Promise<TickReport> {
    if (this.busy) {
      return this.emptyReport("tick concurrent ignoré");
    }
    this.busy = true;

    const decisions: Decision[] = [];
    const tsMs = this.deps.clock();
    this.tickId += 1;
    const tickId = this.tickId;

    const record = (
      kind: DecisionKind,
      line: string,
      options: { strategy?: string; mint?: string; data?: Record<string, unknown> } = {},
    ): void => {
      const decision: Decision = {
        tsMs,
        tickId,
        kind,
        strategy: options.strategy ?? null,
        mint: options.mint ?? null,
        line,
        data: options.data,
      };
      decisions.push(decision);
      this.deps.onDecision?.(decision);
    };

    try {
      // ── 1. Marché ─────────────────────────────────────────────────────
      const quotes = await this.deps.market.pollOnce(tsMs);
      if (quotes.size === 0) {
        this.consecutiveErrors += 1;
        record("error", "aucun prix disponible — tick abandonné");
        return this.report(tsMs, tickId, false, "aucun prix disponible", decisions);
      }

      // ── 2. Valorisation et garde-fous globaux ─────────────────────────
      const prices = new Map<string, number>();
      for (const [mint, quote] of quotes) prices.set(mint, quote.priceUsd);

      const cashUsd = this.deps.cash.cashUsd();
      const positions = listPositions(this.deps.db);
      const view = buildPortfolioView(positions, prices, cashUsd, tsMs);

      const peak = Math.max(
        kvGetNumber(this.deps.db, STATE_KEYS.navPeakUsd) ?? view.navUsd,
        view.navUsd,
      );
      kvSetNumber(this.deps.db, STATE_KEYS.navPeakUsd, peak, tsMs);
      const drawdownPct = peak > 0 ? Math.max(0, ((peak - view.navUsd) / peak) * 100) : 0;

      // ── Ancre journalière (UTC) ───────────────────────────────────────
      const dayKey = new Date(tsMs).toISOString().slice(0, 10);
      const storedDayKey = kvGet(this.deps.db, STATE_KEYS.dayKey);
      if (storedDayKey !== dayKey) {
        kvSet(this.deps.db, STATE_KEYS.dayKey, dayKey, tsMs);
        kvSetNumber(this.deps.db, STATE_KEYS.dayStartNavUsd, view.navUsd, tsMs);
      }
      const dayStartNav = kvGetNumber(this.deps.db, STATE_KEYS.dayStartNavUsd) ?? view.navUsd;
      const dailyLossPct =
        dayStartNav > 0 ? Math.max(0, ((dayStartNav - view.navUsd) / dayStartNav) * 100) : 0;

      let pausedUntilMs = kvGetNumber(this.deps.db, STATE_KEYS.pausedUntilMs);
      if (dailyLossPct >= this.deps.cfg.risk.daily_loss_limit_pct) {
        pausedUntilMs = nextUtcMidnight(tsMs);
        kvSetNumber(this.deps.db, STATE_KEYS.pausedUntilMs, pausedUntilMs, tsMs);
        record(
          "guard",
          `perte journalière ${dailyLossPct.toFixed(2)} % ≥ ${this.deps.cfg.risk.daily_loss_limit_pct} % — entrées en pause jusqu'à minuit UTC`,
        );
      } else if (pausedUntilMs !== null && pausedUntilMs <= tsMs) {
        pausedUntilMs = null;
        kvSetNumber(this.deps.db, STATE_KEYS.pausedUntilMs, 0, tsMs);
      }

      // ── Kill-switch : drawdown max ou fichier STOP ────────────────────
      let killSwitch = this.deps.stop.exists();
      if (drawdownPct >= this.deps.cfg.risk.max_drawdown_pct && !killSwitch) {
        this.deps.stop.create();
        killSwitch = true;
        record(
          "guard",
          `drawdown ${drawdownPct.toFixed(2)} % ≥ ${this.deps.cfg.risk.max_drawdown_pct} % — kill-switch déclenché`,
        );
      }

      // ── 3. Sorties (priorité absolue) ─────────────────────────────────
      const executed = { buys: 0, sells: 0 };
      const snapshot = this.buildSnapshot(tsMs, quotes);
      const portfolio = buildPortfolioView(positions, prices, cashUsd, tsMs);

      for (const position of portfolio.positions) {
        const quote = quotes.get(position.mint);
        if (!quote) continue;

        const exit = this.decideExit(position, quote.priceUsd);
        if (!exit) continue;

        const flags = this.buildFlags({
          mint: position.mint,
          quote,
          navUsd: view.navUsd,
          positions: portfolio.positions,
          pausedUntilMs,
          killSwitch,
          lastTradeTsByMint: null,
        });
        const gate = this.deps.risk.checkExit(flags);
        if (!gate.allowed) {
          record("reject", `sortie ${position.symbol} bloquée — ${gate.message}`, {
            mint: position.mint,
            data: { rule: "exit_data_guard" },
          });
          continue;
        }

        const result = await this.deps.executor.execute({
          mint: position.mint,
          symbol: position.symbol,
          side: "sell",
          strategy: "risk",
          priceUsd: quote.priceUsd,
          liquidityUsd: quote.liquidityUsd,
          spendUsd: 0,
          qty: position.qty,
          reason: exit.reason,
          stopLossPct: 0,
          takeProfitPct: 0,
          decimals: 6,
          needsAta: false,
        });

        if (result.ok) {
          executed.sells += 1;
          record(
            "exit",
            `${exit.kind} — ${position.symbol} vendu (PnL ${(result.realizedPnlUsd ?? 0).toFixed(2)} $)`,
            { mint: position.mint, data: { kind: exit.kind, pnlUsd: result.realizedPnlUsd } },
          );
        } else {
          record(
            "error",
            `sortie ${position.symbol} échouée — ${result.note ?? "raison inconnue"}`,
            {
              mint: position.mint,
            },
          );
        }
      }

      // ── 4. Signaux et entrées ─────────────────────────────────────────
      let blockedBy: string | null = null;

      if (killSwitch) {
        record("guard", "kill-switch actif — aucune entrée");
        blockedBy = "kill_switch";
      } else if (pausedUntilMs !== null && pausedUntilMs > tsMs) {
        record("guard", "entrées en pause (limite de perte journalière)");
        blockedBy = "daily_loss_pause";
      } else {
        const candidates: { signal: Signal; strategy: string }[] = [];

        for (const asset of snapshot.assets) {
          if (!asset.regime) continue;
          record("regime", `${asset.symbol} — ${asset.regime.regime} : ${asset.regime.reason}`, {
            mint: asset.mint,
            data: { regime: asset.regime.regime },
          });
        }

        // ── Phase 4 : portefeuilles fantômes et allocation ────────────
        //
        // Chaque stratégie joue son propre portefeuille en parallèle, avec
        // les mêmes coûts. L'une d'elles est choisie comme **pilote** : c'est
        // la seule qui décide du capital réel.
        let pilot: string | null = null;

        if (this.deps.allocator) {
          const shadow = runShadows(
            {
              db: this.deps.allocator.db,
              strategies: this.deps.strategies,
              allocator: this.deps.allocator.allocator,
              risk: this.deps.allocator.risk,
              costs: this.deps.allocator.costs,
              initialCashUsd: this.deps.allocator.initialCashUsd,
            },
            {
              tsMs,
              prices,
              evaluate: (strategy, shadowPortfolio) => strategy.evaluate(snapshot, shadowPortfolio),
            },
          );

          pilot = shadow.pilot;
          record("alloc", shadow.decision.reason, {
            data: {
              pilot: shadow.pilot,
              previousPilot: shadow.decision.previousPilot,
              changed: shadow.decision.changed,
              scores: shadow.scores.map((score) => ({
                name: score.name,
                scorePct: score.scorePct,
                trades: score.trades,
                eligible: score.eligible,
                reason: score.reason,
              })),
            },
          });
          for (const note of shadow.notes) {
            record("note", note.note, { strategy: note.strategy });
          }
        }

        // ── Phase 5 : la stratégie pilote décide, sur le livre réel ────
        for (const strategy of this.deps.strategies) {
          if (pilot !== null && strategy.name !== pilot) continue;

          const evaluated = strategy.evaluate(snapshot, portfolio);
          for (const note of evaluated.notes) {
            record("note", note, { strategy: strategy.name });
          }
          for (const signal of evaluated.signals) {
            record("signal", `${signal.symbol} ${signal.side} — ${signal.reason}`, {
              strategy: strategy.name,
              mint: signal.assetMint,
              data: {
                confidence: signal.confidence,
                expectedMoveBps: signal.expectedMoveBps,
              },
            });
            candidates.push({ signal, strategy: strategy.name });
          }
        }

        if (pilot === null && this.deps.allocator) {
          record("guard", "aucune stratégie pilote — aucune entrée");
          blockedBy = "no_pilot";
        }

        // Une seule entrée par tick : la meilleure confiance.
        const best = candidates
          .filter((c) => c.signal.side === "buy")
          .sort((a, b) => b.signal.confidence - a.signal.confidence)[0];

        if (best) {
          const quote = quotes.get(best.signal.assetMint);
          if (!quote) {
            record("reject", `prix absent pour ${best.signal.symbol}`, {
              strategy: best.strategy,
              mint: best.signal.assetMint,
              data: { rule: "data_guard" },
            });
          } else {
            const held = portfolio.positions.find((p) => p.mint === best.signal.assetMint);
            const flags = this.buildFlags({
              mint: best.signal.assetMint,
              quote,
              navUsd: view.navUsd,
              positions: portfolio.positions,
              pausedUntilMs,
              killSwitch,
              lastTradeTsByMint: kvGetNumber(
                this.deps.db,
                `${STATE_KEYS.lastTradeTsByMint}:${best.signal.assetMint}`,
              ),
            });

            const decision = this.deps.risk.checkEntry(
              {
                signal: best.signal,
                inputMint: USDC_MINT,
                outputMint: best.signal.assetMint,
                solPriceUsd: prices.get(SOL_MINT) ?? 0,
                needsAta: held === undefined,
                nowMs: tsMs,
              },
              flags,
            );

            if (!decision.allowed) {
              blockedBy = decision.rule ?? null;
              record("reject", `${best.signal.symbol} — ${decision.message}`, {
                strategy: best.strategy,
                mint: best.signal.assetMint,
                data: { rule: decision.rule, ...decision.metrics },
              });
            } else {
              const result = await this.deps.executor.execute({
                mint: best.signal.assetMint,
                symbol: best.signal.symbol,
                side: "buy",
                strategy: best.strategy,
                priceUsd: quote.priceUsd,
                liquidityUsd: quote.liquidityUsd,
                spendUsd: decision.sizeUsd,
                reason: best.signal.reason,
                stopLossPct: decision.stopLossPct,
                takeProfitPct: decision.takeProfitPct,
                decimals: 6,
                needsAta: held === undefined,
              });

              if (result.ok) {
                executed.buys += 1;
                kvSetNumber(
                  this.deps.db,
                  `${STATE_KEYS.lastTradeTsByMint}:${best.signal.assetMint}`,
                  tsMs,
                  tsMs,
                );
                record(
                  "trade",
                  `achat ${best.signal.symbol} — ${result.spendUsd.toFixed(2)} $ pour ${result.qty}`,
                  {
                    strategy: best.strategy,
                    mint: best.signal.assetMint,
                    data: { sizeUsd: decision.sizeUsd, costBps: decision.cost.amortizedBps },
                  },
                );
              } else {
                record(
                  "error",
                  `achat ${best.signal.symbol} échoué — ${result.note ?? "raison inconnue"}`,
                  { strategy: best.strategy, mint: best.signal.assetMint },
                );
              }
            }
          }
        }
      }

      // ── 5. Journal ────────────────────────────────────────────────────
      insertDecisions(this.deps.db, decisions);

      const finalPositions = listPositions(this.deps.db);
      const finalView = buildPortfolioView(finalPositions, prices, this.deps.cash.cashUsd(), tsMs);
      const realized = finalPositions.reduce((sum, p) => sum + p.realizedPnlUsd, 0);
      const positionsUsd = finalView.positions.reduce((sum, p) => sum + p.valueUsd, 0);
      const finalPeak = Math.max(peak, finalView.navUsd);
      const finalDrawdown =
        finalPeak > 0 ? Math.max(0, ((finalPeak - finalView.navUsd) / finalPeak) * 100) : 0;

      insertEquityPoint(this.deps.db, {
        mode: this.deps.mode,
        tsMs,
        tickId,
        navUsd: finalView.navUsd,
        cashUsd: finalView.cashUsd,
        positionsUsd,
        realizedPnlUsd: realized,
        drawdownPct: finalDrawdown,
      });

      this.consecutiveErrors = 0;
      return {
        tsMs,
        tickId,
        ok: true,
        navUsd: finalView.navUsd,
        cashUsd: finalView.cashUsd,
        positionsUsd,
        positionsOpen: finalPositions.length,
        realizedPnlUsd: realized,
        drawdownPct: finalDrawdown,
        executed,
        decisions,
        blockedBy,
      };
    } catch (error) {
      this.consecutiveErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      record("error", `erreur de tick : ${message}`);
      insertDecisions(this.deps.db, decisions);
      return this.report(tsMs, tickId, false, message, decisions);
    } finally {
      this.busy = false;
    }
  }

  /** Le moteur doit-il s'arrêter ? (erreurs de tick consécutives) */
  shouldStop(): boolean {
    return this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
  }

  /** Déclenche le kill-switch (commande externe, Telegram, test). */
  triggerKillSwitch(): void {
    this.deps.stop.create();
  }

  /** Le kill-switch est-il actif ? */
  killSwitchActive(): boolean {
    return this.deps.stop.exists();
  }

  // ── Interne ────────────────────────────────────────────────────────────

  /**
   * Construit l'instantané de marché : prix + bougies **clôturées** lues en
   * base (import prioritaire, live en complément).
   */
  private buildSnapshot(tsMs: number, quotes: Map<string, MarketQuote>): MarketSnapshot {
    const mints = new Set<string>(listWatchlistMints(this.deps.db));
    for (const mint of quotes.keys()) mints.add(mint);
    for (const position of listPositions(this.deps.db)) mints.add(position.mint);
    mints.add(SOL_MINT);
    mints.add(USDC_MINT);

    // Les stratégies n'ont besoin que d'une fenêtre : leur passer tout
    // l'historique rendrait le backtest quadratiquement lent.
    //
    // Chaque stratégie lit **son** timeframe : une stratégie en 1 h et une
    // stratégie en 15 m ne doivent pas voir la même fenêtre. On ne charge
    // donc que les timeframes réellement demandés.
    const barsByTimeframe = new Map<Timeframe, number>();
    for (const strategy of this.deps.strategies) {
      for (const requirement of strategy.requires) {
        const current = barsByTimeframe.get(requirement.timeframe) ?? 0;
        barsByTimeframe.set(requirement.timeframe, Math.max(current, requirement.bars));
      }
    }
    if (barsByTimeframe.size === 0) {
      barsByTimeframe.set(this.deps.cfg.data.regime.timeframe, 48);
    }

    const regimeCfg: RegimeConfig = {
      timeframe: this.deps.cfg.data.regime.timeframe,
      window: this.deps.cfg.data.regime.window,
      trendThresholdPct: this.deps.cfg.data.regime.trend_threshold_pct,
      rangeMaxPct: this.deps.cfg.data.regime.range_max_pct,
    };
    const classify = this.deps.regime ?? classifyRegime;

    const assets = [];
    for (const mint of mints) {
      const quote = quotes.get(mint);
      if (!quote) continue;
      const candles: Partial<Record<Timeframe, ImportedCandle[]>> = {};
      for (const [tf, bars] of barsByTimeframe) {
        candles[tf] = this.deps.candles.candles(mint, tf, tsMs, bars);
      }
      assets.push({
        mint,
        symbol: this.symbolOf(mint),
        priceUsd: quote.priceUsd,
        liquidityUsd: quote.liquidityUsd,
        candles,
        regime: classify(candles[regimeCfg.timeframe] ?? [], regimeCfg),
      });
    }

    return { tsMs, assets };
  }

  private symbolOf(mint: string): string {
    if (mint === SOL_MINT) return "SOL";
    if (mint === USDC_MINT) return "USDC";
    return `${mint.slice(0, 4)}…`;
  }

  /**
   * Décide d'une sortie : stop-loss, take-profit, trailing stop.
   *
   * L'ordre est fixe : le stop-loss d'abord (c'est le risque), puis le
   * take-profit, puis le trailing.
   */
  private decideExit(
    position: {
      avgEntryUsd: number;
      stopLossUsd: number | null;
      takeProfitUsd: number | null;
      peakPriceUsd: number | null;
    },
    priceUsd: number,
  ): ExitDecision | null {
    const trailing = this.deps.cfg.risk.trailing_stop;

    if (position.stopLossUsd !== null && priceUsd <= position.stopLossUsd) {
      return {
        kind: "stop_loss",
        reason: `stop-loss touché (${priceUsd.toFixed(6)} ≤ ${position.stopLossUsd.toFixed(6)})`,
      };
    }

    if (position.takeProfitUsd !== null && priceUsd >= position.takeProfitUsd) {
      return {
        kind: "take_profit",
        reason: `take-profit touché (${priceUsd.toFixed(6)} ≥ ${position.takeProfitUsd.toFixed(6)})`,
      };
    }

    if (
      position.peakPriceUsd !== null &&
      position.peakPriceUsd >= position.avgEntryUsd * (1 + trailing.activation_pct / 100)
    ) {
      const trailingStop = position.peakPriceUsd * (1 - trailing.retrace_pct / 100);
      if (priceUsd <= trailingStop) {
        return {
          kind: "trailing_stop",
          reason: `trailing stop touché (${priceUsd.toFixed(6)} ≤ ${trailingStop.toFixed(6)})`,
        };
      }
    }

    return null;
  }

  private buildFlags(input: {
    mint: string;
    quote: MarketQuote;
    navUsd: number;
    positions: { mint: string; valueUsd: number }[];
    pausedUntilMs: number | null;
    killSwitch: boolean;
    lastTradeTsByMint: number | null;
  }): RiskFlags {
    const assetExposureUsd = input.positions
      .filter((p) => p.mint === input.mint)
      .reduce((sum, p) => sum + p.valueUsd, 0);
    const totalExposureUsd = input.positions.reduce((sum, p) => sum + p.valueUsd, 0);

    return {
      killSwitch: input.killSwitch,
      pausedUntilMs: input.pausedUntilMs,
      solBalanceSol: this.deps.cash.solBalance(),
      cashUsd: this.deps.cash.cashUsd(),
      navUsd: input.navUsd,
      assetExposureUsd,
      totalExposureUsd,
      openPositions: input.positions.length,
      lastTradeTsByMint: input.lastTradeTsByMint,
      priceUsd: input.quote.priceUsd,
      liquidityUsd: input.quote.liquidityUsd,
      priceUsable: input.quote.priceUsd > 0,
      priceGuardReason: input.quote.priceUsd > 0 ? null : "prix nul ou absent",
    };
  }

  private report(
    tsMs: number,
    tickId: number,
    ok: boolean,
    error: string | undefined,
    decisions: Decision[],
  ): TickReport {
    return {
      tsMs,
      tickId,
      ok,
      error,
      navUsd: 0,
      cashUsd: 0,
      positionsUsd: 0,
      positionsOpen: 0,
      realizedPnlUsd: 0,
      drawdownPct: 0,
      executed: { buys: 0, sells: 0 },
      decisions,
      blockedBy: null,
    };
  }

  private emptyReport(error: string): TickReport {
    return {
      tsMs: this.deps.clock(),
      tickId: this.tickId,
      ok: false,
      error,
      navUsd: 0,
      cashUsd: 0,
      positionsUsd: 0,
      positionsOpen: 0,
      realizedPnlUsd: 0,
      drawdownPct: 0,
      executed: { buys: 0, sells: 0 },
      decisions: [],
      blockedBy: null,
    };
  }
}

/** Minuit UTC suivant. */
function nextUtcMidnight(tsMs: number): number {
  const date = new Date(tsMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0);
}

/** Kill-switch adossé à un fichier (live, paper). */
export class FileStopSwitch implements StopSwitch {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  create(): void {
    try {
      fs.writeFileSync(this.path, "kill-switch\n", { flag: "wx" });
    } catch {
      // déjà présent
    }
  }
}

/** Kill-switch en mémoire (backtest). */
export class MemoryStopSwitch implements StopSwitch {
  private stopped = false;

  exists(): boolean {
    return this.stopped;
  }

  create(): void {
    this.stopped = true;
  }
}

/** Durée d'un timeframe, réutilisée par le moteur. */
export { timeframeMs };
