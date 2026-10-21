import { Engine, FileStopSwitch, type MarketQuote, type MarketSource } from "../engine/engine.js";
import { createRegistry } from "../monitoring/metrics.js";
import { MonitoringServer } from "../monitoring/server.js";
import { Supervisor } from "../monitoring/supervisor.js";
import { TelegramController } from "../notify/controller.js";
import { TelegramPoller } from "../notify/poller.js";
import { TelegramNotifier, noopNotifier } from "../notify/telegram.js";
import { createBackup } from "../state/backup.js";
import { KvCash } from "../execution/cash.js";
import { DEFAULT_COST_CONFIG, type CostConfig } from "../execution/costs.js";
import { PaperExecutor } from "../execution/executor.js";
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

export async function runStart(options: StartOptions = {}): Promise<void> {
  const runtime = createRuntime({ root: options.root, mode: options.mode });
  const mode = runtime.mode;

  if (mode !== "paper") {
    fail(
      `le mode « ${mode} » n'est pas encore disponible`,
      "l'exécution Jupiter (dry-run et live) arrive en phase 5",
    );
    closeRuntime(runtime);
    process.exitCode = 1;
    return;
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

  const cash = new KvCash(runtime.db, runtime.config.paper.initial_usdc);
  cash.seed(runtime.config.paper.initial_usdc);

  const executor = new PaperExecutor({ db: runtime.db, mode: "paper", cash, costs });
  const risk = new RiskManager(runtime.config.risk, runtime.config.allocator, costs);
  const strategies = enabledStrategies(runtime.config.strategies);

  const market = new PollerMarketSource(poller, (result) => {
    if (!result.ok) {
      warn("collecte", result.error ?? "échec inconnu");
    }
  });

  const stopPath = getStopFilePath(runtime.root);
  const engine = new Engine({
    db: runtime.db,
    cfg: runtime.config,
    mode: "paper",
    strategies,
    // L'allocateur est actif dès qu'il y a **plusieurs** stratégies : le
    // capital réel n'est alors confié qu'à la stratégie pilote.
    allocator:
      strategies.length > 1
        ? {
            db: runtime.db,
            allocator: runtime.config.allocator,
            risk: runtime.config.risk,
            costs,
            initialCashUsd: runtime.config.paper.initial_usdc,
          }
        : undefined,
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
  info("mode", "paper (aucun ordre envoyé, portefeuille virtuel)");
  info("intervalle", `${intervalS} s`);
  info("stratégies", strategies.map((s) => s.name).join(", ") || "aucune");
  info(
    "allocateur",
    strategies.length > 1
      ? `actif (hystérésis ${runtime.config.allocator.hysteresis_pct} %, seuil ${runtime.config.allocator.min_trades_to_score} trades)`
      : "inactif (stratégie unique)",
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
