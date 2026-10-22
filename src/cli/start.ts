import { Connection } from "@solana/web3.js";
import { Engine, FileStopSwitch, type MarketQuote, type MarketSource } from "../engine/engine.js";
import { BuildApi } from "../jupiter/build.js";
import { SwapApi } from "../jupiter/swap.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";
import { createRegistry } from "../monitoring/metrics.js";
import { MonitoringServer } from "../monitoring/server.js";
import { Supervisor } from "../monitoring/supervisor.js";
import { TelegramController } from "../notify/controller.js";
import { TelegramPoller } from "../notify/poller.js";
import { TelegramNotifier, noopNotifier } from "../notify/telegram.js";
import { createBackup } from "../state/backup.js";
import { evaluateGuard } from "../risk/guard.js";
import { createLandingTarget } from "../solana/landing.js";
import { fetchChainBalances, reconcileBalances } from "../solana/reconcile.js";
import { EnvSigner } from "../wallet/signer.js";
import { KvCash } from "../execution/cash.js";
import { DEFAULT_COST_CONFIG, type CostConfig } from "../execution/costs.js";
import { PaperExecutor } from "../execution/executor.js";
import type { CashLedger, Executor } from "../execution/executor.js";
import { JupiterExecutor } from "../execution/jupiter-executor.js";
import { RouterExecutor } from "../execution/router-executor.js";
import { DbCandleSource } from "../market/candles.js";
import { Poller, type PollResult } from "../market/poller.js";
import { RiskManager } from "../risk/risk-manager.js";
import { enabledStrategies } from "../strategies/registry.js";
import { closeDb } from "../state/db.js";
import { listWatchlistMints } from "../state/market-data.js";
import { getStopFilePath } from "../utils/paths.js";
import { kvSetNumber, STATE_KEYS } from "../state/kv.js";
import { getVersionInfo } from "./version.js";
import { sleep } from "../utils/time.js";
import { blank, fail, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

/**
 * Le moteur en temps réel — mode **paper** par défaut.
 *
 * En paper, le moteur tourne avec les **vrais prix** (Price v3) et les
 * **vrais coûts modélisés**, mais **aucun ordre n'est envoyé**. Le
 * portefeuille est virtuel.
 *
 * C'est le mode qui doit tourner des semaines avant qu'on parle de live.
 */

export interface StartOptions {
  root?: string;
  /** Mode forcé (CLI). */
  mode?: "paper" | "dry_run" | "live";
  /** Valide les confirmations interactives (automatisation). */
  yes?: boolean;
  /** Intervalle entre deux ticks (secondes). */
  intervalS?: number;
  /** Durée totale (secondes). 0 = jusqu'à l'interruption. */
  durationS?: number;
  /** Un seul tick puis sortie. */
  once?: boolean;
}

/** Adaptateur : le `Poller` devient une `MarketSource` pour le moteur. */
class PollerMarketSource implements MarketSource {
  constructor(
    private readonly poller: Poller,
    private readonly onResult: (result: PollResult) => void,
  ) {}

  async pollOnce(tsMs: number): Promise<Map<string, MarketQuote>> {
    const result = await this.poller.pollOnce(tsMs);
    this.onResult(result);

    const quotes = new Map<string, MarketQuote>();
    for (const [mint, price] of result.prices) {
      quotes.set(mint, { priceUsd: price.priceUsd, liquidityUsd: price.liquidityUsd });
    }
    return quotes;
  }
}

/** Invite de confirmation en ligne de commande. */
async function confirmLive(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export async function runStart(options: StartOptions = {}): Promise<void> {
  const runtime = createRuntime({ root: options.root, mode: options.mode });
  const mode = runtime.mode;

  // ── Garde-fous du mode live ──────────────────────────────────────────
  if (mode === "live") {
    if (!runtime.config.confirm_live) {
      fail("live refusé", "confirm_live n'est pas activé dans la configuration");
      closeRuntime(runtime);
      process.exitCode = 1;
      return;
    }

    const guard = evaluateGuard({ db: runtime.db, cfg: runtime.config });
    if (!guard.ok) {
      fail("live refusé par le garde-fou", guard.reasons.join(" ; "));
      closeRuntime(runtime);
      process.exitCode = 1;
      return;
    }
    ok("garde-fou", "tous les critères bloquants sont remplis");

    if (options.yes !== true) {
      const answer = await confirmLive("⚠️  MODE LIVE — fonds réels.\nConfirmer ? (oui/non) : ");
      if (answer !== "oui") {
        fail("live annulé", "aucun ordre n'a été envoyé");
        closeRuntime(runtime);
        process.exitCode = 1;
        return;
      }
    }
  }

  const intervalS = options.intervalS ?? runtime.config.loop_interval_s;
  const durationS = options.durationS ?? 0;
  const deadline = durationS > 0 ? Date.now() + durationS * 1000 : null;

  const poller = new Poller({
    db: runtime.db,
    priceApi: runtime.priceApi,
    tokensApi: runtime.tokensApi,
    timeframes: runtime.config.data.timeframes,
  });

  const costs: CostConfig = {
    ...DEFAULT_COST_CONFIG,
    fillSlippageBps: runtime.config.paper.fill_slippage_bps,
    impactK: runtime.config.paper.impact_k,
    priorityFeeSol: runtime.config.paper.priority_fee_sol,
  };

  // ── Cash et exécution, selon le mode ─────────────────────────────────
  let cash: CashLedger;
  let executor: Executor;

  if (mode === "live" || mode === "dry_run") {
    const connection = new Connection(
      runtime.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const signer = await EnvSigner.fromEnv(process.env);

    // En dry-run, le portefeuille reste virtuel : on ne simule que
    // l'**exécution** des ordres, pas leur effet sur la chaîne.
    const virtualCash = new KvCash(runtime.db, runtime.config.paper.initial_usdc);
    virtualCash.seed(runtime.config.paper.initial_usdc);
    cash = virtualCash;

    const confirmFn =
      mode === "live"
        ? async (summary: string) => {
            note(summary);
            if (options.yes === true) return true;
            return (await confirmLive("Confirmer cet ordre ? (oui/non) : ")) === "oui";
          }
        : undefined;

    // Le chemin par défaut est le **Meta-Aggregator** : le Router n'est
    // retenu qu'après une comparaison A/B sur 200 swaps réels.
    executor =
      runtime.config.execution.path === "router"
        ? new RouterExecutor({
            db: runtime.db,
            buildApi: new BuildApi(runtime.jupiter),
            connection,
            signer,
            landing: createLandingTarget({
              choice: runtime.config.execution.router.landing,
              connection,
              apiKey: runtime.env.JUPITER_API_KEY ?? "",
            }),
            mode: mode === "live" ? "live" : "dry_run",
            cuLimitBuffer: runtime.config.execution.router.cu_limit_buffer,
            cuPriceCapMicrolamports: runtime.config.execution.router.cu_price_cap_microlamports,
            tipLamports: runtime.config.execution.router.tip_lamports,
            retries: runtime.config.execution.retries,
            confirm: confirmFn,
          })
        : new JupiterExecutor({
            db: runtime.db,
            swapApi: new SwapApi(runtime.jupiter),
            connection,
            signer,
            mode: mode === "live" ? "live" : "dry_run",
            retries: runtime.config.execution.retries,
            slippageBumpFactor: 2,
            maxSlippageBps: runtime.config.risk.max_slippage_bps,
            slippageMode: runtime.config.execution.slippage,
            adaptive: {
              timeframe: "15m",
              period: 14,
              multiplier: 1,
              minBps: 10,
              maxBps: runtime.config.risk.max_slippage_bps,
            },
            confirm: confirmFn,
          });
  } else {
    const virtualCash = new KvCash(runtime.db, runtime.config.paper.initial_usdc);
    virtualCash.seed(runtime.config.paper.initial_usdc);
    cash = virtualCash;
    executor = new PaperExecutor({ db: runtime.db, mode: "paper", cash, costs });
  }

  const risk = new RiskManager(runtime.config.risk, runtime.config.allocator, costs);
  const strategies = enabledStrategies(runtime.config.strategies);

  // ── Réconciliation on-chain (live) ───────────────────────────────────
  // Au démarrage en live, **la chaîne fait foi** : les soldes réels sont
  // comparés au portefeuille local, et chaque divergence est journalisée.
  if (mode === "live") {
    const connection = new Connection(
      runtime.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const signer = await EnvSigner.fromEnv(process.env);
    const prices = await runtime.priceApi.refresh(
      listWatchlistMints(runtime.db).concat([SOL_MINT, USDC_MINT]),
      { fresh: true },
    );
    const priceMap = new Map<string, number>();
    for (const [mint, row] of prices) priceMap.set(mint, row.usdPrice);

    const balances = await fetchChainBalances(connection, signer.address, USDC_MINT);
    const reconciliation = reconcileBalances({
      db: runtime.db,
      connection,
      owner: signer.address,
      balances,
      baseMint: USDC_MINT,
      defaultStopLossPct: runtime.config.risk.stop_loss_pct,
      defaultTakeProfitPct: runtime.config.risk.take_profit_pct,
      prices: priceMap,
    });

    if (reconciliation.entries.length > 0) {
      warn(
        "réconciliation",
        `${reconciliation.adopted} adoptée(s), ${reconciliation.adjusted} ajustée(s), ${reconciliation.closed} clôturée(s), ${reconciliation.skipped} ignorée(s)`,
      );
      for (const entry of reconciliation.entries) {
        note(`${entry.action} — ${entry.symbol} : ${entry.note}`);
      }
    } else {
      ok("réconciliation", "portefeuille local aligné sur la chaîne");
    }
  }

  const market = new PollerMarketSource(poller, (result) => {
    if (!result.ok) {
      warn("collecte", result.error ?? "échec inconnu");
    }
  });

  const stopPath = getStopFilePath(runtime.root);
  const engine = new Engine({
    db: runtime.db,
    cfg: runtime.config,
    mode,
    strategies,
    // Les **shadows tournent toujours**, même avec une seule stratégie :
    // c'est ce qui donne la vue « Stratégies » du dashboard (performance
    // isolée de chaque stratégie), et ce qui permet de comparer plus tard.
    // Avec une seule stratégie, l'allocateur la désigne pilote d'emblée.
    allocator: {
      db: runtime.db,
      allocator: runtime.config.allocator,
      risk: runtime.config.risk,
      costs,
      initialCashUsd: runtime.config.paper.initial_usdc,
    },
    market,
    candles: new DbCandleSource(runtime.db),
    executor,
    risk,
    cash,
    stop: new FileStopSwitch(stopPath),
    clock: () => Date.now(),
  });

  // ── Supervision ──────────────────────────────────────────────────────
  const metrics = createRegistry();
  const telegramEnabled = runtime.config.notifications.telegram.enabled;
  const notifier = telegramEnabled
    ? new TelegramNotifier({
        token: runtime.env.TELEGRAM_BOT_TOKEN ?? "",
        chatId: runtime.env.TELEGRAM_CHAT_ID ?? "",
      })
    : noopNotifier();

  const supervisor = new Supervisor({
    db: runtime.db,
    cfg: runtime.config,
    metrics,
    notifier,
    backupDir: runtime.config.backups.dir,
    backup: () => {
      const info = createBackup({
        db: runtime.db,
        dir: runtime.config.backups.dir,
        keep: runtime.config.backups.keep,
      });
      kvSetNumber(runtime.db, STATE_KEYS.lastBackupAtMs, info.createdMs);
    },
    version: getVersionInfo().version,
  });

  let monitoring: MonitoringServer | undefined;
  if (runtime.config.monitoring.enabled) {
    monitoring = new MonitoringServer({
      host: runtime.config.monitoring.host,
      port: runtime.config.monitoring.port,
      metrics,
      health: () => supervisor.health(),
    });
    const address = await monitoring.start();
    info("supervision", `${address}/healthz · ${address}/metrics`);
  }

  // ── Telegram ─────────────────────────────────────────────────────────
  let telegramPoller: TelegramPoller | undefined;
  if (telegramEnabled && notifier.configured) {
    const controller = new TelegramController({
      db: runtime.db,
      cfg: runtime.config,
      root: runtime.root,
    });
    telegramPoller = new TelegramPoller({
      token: runtime.env.TELEGRAM_BOT_TOKEN ?? "",
      chatId: runtime.env.TELEGRAM_CHAT_ID ?? "",
      controller,
      reply: async (text) => {
        await notifier.send("command", text);
      },
    });
    void telegramPoller.run();
    info("telegram", "commandes actives (/status /positions /pnl /pause /resume /kill)");
  }

  heading("solbot3 start — moteur en mode paper");
  info(
    "mode",
    mode === "live"
      ? "LIVE — ordres réels sur la chaîne"
      : mode === "dry_run"
        ? "dry-run (vrais devis, transaction simulée, aucun ordre envoyé)"
        : "paper (aucun ordre envoyé, portefeuille virtuel)",
  );
  info("intervalle", `${intervalS} s`);
  info("stratégies", strategies.map((s) => s.name).join(", ") || "aucune");
  info(
    "allocateur",
    `actif (hystérésis ${runtime.config.allocator.hysteresis_pct} %, seuil ${runtime.config.allocator.min_trades_to_score} trades)${
      strategies.length === 1 ? " — stratégie unique, elle pilote d'emblée" : ""
    }`,
  );
  info("watchlist", `${listWatchlistMints(runtime.db).length} actifs`);
  info("capital virtuel", `${runtime.config.paper.initial_usdc} $`);
  info("kill-switch", stopPath);
  if (deadline) info("durée", `${durationS} s`);
  blank();

  let stopping = false;
  const onSignal = (): void => {
    if (!stopping) {
      stopping = true;
      note("arrêt demandé — le tick en cours se termine");
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let ticks = 0;
  const startedAt = Date.now();

  try {
    for (;;) {
      const report = await engine.runTick();
      ticks += 1;

      supervisor.onTick({
        tsMs: report.tsMs,
        ok: report.ok,
        navUsd: report.navUsd,
        cashUsd: report.cashUsd,
        positionsOpen: report.positionsOpen ?? 0,
        drawdownPct: report.drawdownPct,
        executed: report.executed,
        blockedBy: report.blockedBy,
        pilotScorePct: null,
      });

      if (report.ok) {
        const blocked = report.blockedBy ? ` · bloqué: ${report.blockedBy}` : "";
        ok(
          `tick ${ticks}`,
          `NAV ${report.navUsd.toFixed(2)} $ · ${report.executed.buys} achat(s), ${report.executed.sells} vente(s)${blocked}`,
        );
        for (const decision of report.decisions) {
          if (decision.kind === "trade" || decision.kind === "exit" || decision.kind === "guard") {
            note(decision.line);
          }
        }
      } else {
        warn(`tick ${ticks}`, report.error ?? "échec inconnu");
      }

      if (options.once) break;
      if (engine.shouldStop()) {
        fail("moteur arrêté", "trop d'erreurs de tick consécutives");
        break;
      }
      if (stopping) break;
      if (deadline !== null && Date.now() >= deadline) {
        note("durée atteinte — arrêt du moteur");
        break;
      }

      await sleep(intervalS * 1000);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    telegramPoller?.stop();
    if (monitoring) await monitoring.stop();

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    blank();
    ok("moteur arrêté", `${ticks} tick(s) en ${elapsed} s`);

    closeRuntime(runtime);
    closeDb(runtime.db);
  }
}
