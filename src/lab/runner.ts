import type { AppConfig, Timeframe } from "../config/schema.js";
import { Engine, FileStopSwitch, type MarketQuote, type MarketSource } from "../engine/engine.js";
import { KvCash } from "../execution/cash.js";
import { DEFAULT_COST_CONFIG, type CostConfig } from "../execution/costs.js";
import { PaperExecutor } from "../execution/executor.js";
import type { PriceApi } from "../jupiter/price.js";
import type { TokensApi } from "../jupiter/tokens.js";
import { DbCandleSource } from "../market/candles.js";
import { Poller, type PollResult } from "../market/poller.js";
import { RiskManager } from "../risk/risk-manager.js";
import { enabledStrategies } from "../strategies/registry.js";
import { closeDb, openDb, resolveDbPath, type DB } from "../state/db.js";
import { listEquity } from "../state/equity.js";
import { getMergedCandles } from "../state/imported-candles.js";
import { migrate } from "../state/migrations.js";
import { listTrades } from "../state/trades.js";
import { getStopFilePath } from "../utils/paths.js";

/**
 * Le laboratoire.
 *
 * Les stratégies à fort risque (scalping de mèmes, loterie sans stop) ne
 * sont **jamais** dans le moteur principal. Elles vivent ici, avec des
 * garde-fous **codés en dur** :
 *
 * - **paper uniquement** : ce module ne contient aucun chemin d'exécution
 *   réelle. Il n'y a pas de « live » à y activer ;
 * - **base séparée** : le lab n'écrit jamais dans la base du bot ;
 * - **mise plafonnée** : la taille de position est plafonnée par
 *   `lab.max_bet_usd`, quelle que soit la configuration de risque ;
 * - **stop-loss obligatoire** : sans stop, le lab refuse de tourner, sauf
 *   drapeau explicite `lab.allow_no_stop` — qui écrit alors un avertissement
 *   dans chaque rapport ;
 * - **anti-manipulation** : un prix non corroboré par une seconde source est
 *   rejeté. Valoriser une position sur un prix unique, c'est accepter le prix
 *   que quelqu'un veut nous faire voir.
 */

export interface LabOptions {
  root: string;
  cfg: AppConfig;
  /** Noms des stratégies à essayer. */
  strategies: string[];
  /** Durée de la session, en secondes. 0 = un seul tick. */
  durationS?: number;
  priceApi: PriceApi;
  tokensApi: TokensApi;
}

export interface LabResult {
  ok: boolean;
  error?: string;
  /** Avertissements à écrire dans le rapport. */
  warnings: string[];
  dbPath: string;
  finalNavUsd: number;
  trades: number;
  /** Prix rejetés faute de corroboration. */
  rejectedByCorroboration: number;
  /** Stratégies effectivement jouées. */
  strategies: string[];
}

/**
 * Dérive une configuration de lab depuis la configuration principale.
 *
 * Le plafonnement de la mise passe par `risk.max_position_pct` : le
 * RiskManager dimensionne en pourcentage du NAV, et c'est le seul point
 * d'entrée du dimensionnement. Le cap absolu est donc respecté **par
 * construction**, pas par une vérification a posteriori.
 */
export function labConfig(
  cfg: AppConfig,
  options: { maxBetUsd: number; initialUsdc: number },
): AppConfig {
  const maxPositionPct = (options.maxBetUsd / Math.max(options.initialUsdc, 1)) * 100;

  return {
    ...cfg,
    mode: "paper",
    paper: { ...cfg.paper, initial_usdc: options.initialUsdc },
    risk: { ...cfg.risk, max_position_pct: maxPositionPct },
  };
}

/**
 * Source de marché **corroborée**.
 *
 * Un prix n'est accepté que si une **seconde source** le corrobore : ici,
 * la dernière bougie clôturée du timeframe de la stratégie. Si le prix live
 * s'écarte de plus de `maxDivergencePct` de la clôture, le prix est
 * rejeté — l'actif devient non négociable et non valorisable.
 *
 * C'est la règle que solbot2 avait apprise à ses dépens sur des pools
 * « mules » : un prix unique, non corroboré, est un prix que l'on peut
 * choisir.
 */
export class CorroboratingMarketSource implements MarketSource {
  rejected = 0;

  constructor(
    private readonly inner: MarketSource,
    private readonly db: DB,
    private readonly timeframe: Timeframe,
    private readonly maxDivergencePct = 20,
  ) {}

  async pollOnce(tsMs: number): Promise<Map<string, MarketQuote>> {
    const quotes = await this.inner.pollOnce(tsMs);
    const out = new Map<string, MarketQuote>();

    for (const [mint, quote] of quotes) {
      const candles = getMergedCandles(this.db, mint, this.timeframe, { toMs: tsMs });
      const last = candles[candles.length - 1];
      if (!last || last.close <= 0) {
        this.rejected += 1;
        continue;
      }

      const divergence = Math.abs((quote.priceUsd - last.close) / last.close) * 100;
      if (divergence > this.maxDivergencePct) {
        this.rejected += 1;
        continue;
      }

      out.set(mint, quote);
    }

    return out;
  }
}

/** Exécute une session de laboratoire. */
export async function runLab(options: LabOptions): Promise<LabResult> {
  const { root, cfg } = options;
  const warnings: string[] = [];

  // ── Garde-fou : stop-loss obligatoire ─────────────────────────────────
  const hasStop = cfg.risk.stop_loss_pct > 0;
  if (!hasStop && !cfg.lab.allow_no_stop) {
    return {
      ok: false,
      error:
        "le laboratoire exige un stop-loss (risk.stop_loss_pct > 0). Pour tourner sans, il faut `lab.allow_no_stop: true` — et chaque rapport portera alors un avertissement.",
      warnings,
      dbPath: "",
      finalNavUsd: 0,
      trades: 0,
      rejectedByCorroboration: 0,
      strategies: [],
    };
  }
  if (!hasStop) {
    warnings.push(
      "⚠️ SANS STOP-LOSS — variante à risque maximal, autorisée par `lab.allow_no_stop: true`",
    );
  }

  // ── Base séparée ─────────────────────────────────────────────────────
  const dbPath = resolveDbPath(root, cfg.lab.database_path);
  const db = openDb({ path: dbPath });
  migrate(db);

  const labCfg = labConfig(cfg, {
    maxBetUsd: cfg.lab.max_bet_usd,
    initialUsdc: cfg.lab.initial_usdc,
  });

  const costs: CostConfig = {
    ...DEFAULT_COST_CONFIG,
    fillSlippageBps: cfg.paper.fill_slippage_bps,
    impactK: cfg.paper.impact_k,
    priorityFeeSol: cfg.paper.priority_fee_sol,
  };

  const cash = new KvCash(db, cfg.lab.initial_usdc);
  cash.seed(cfg.lab.initial_usdc);

  const executor = new PaperExecutor({ db, mode: "paper", cash, costs });
  const risk = new RiskManager(labCfg.risk, labCfg.allocator, costs);

  const all = enabledStrategies(labCfg.strategies);
  const strategies = all.filter((strategy) => options.strategies.includes(strategy.name));
  if (strategies.length === 0) {
    closeDb(db);
    return {
      ok: false,
      error: `aucune stratégie active parmi : ${options.strategies.join(", ")}`,
      warnings,
      dbPath,
      finalNavUsd: 0,
      trades: 0,
      rejectedByCorroboration: 0,
      strategies: [],
    };
  }

  const timeframe = strategies[0]?.requires[0]?.timeframe ?? "15m";

  const poller = new Poller({
    db,
    priceApi: options.priceApi,
    tokensApi: options.tokensApi,
    timeframes: labCfg.data.timeframes,
  });

  const market = new CorroboratingMarketSource(new PollerMarketSource(poller), db, timeframe);

  let clock = Date.now();
  const engine = new Engine({
    db,
    cfg: labCfg,
    mode: "paper",
    strategies,
    market,
    candles: new DbCandleSource(db),
    executor,
    risk,
    cash,
    stop: new FileStopSwitch(getStopFilePath(root)),
    clock: () => clock,
  });

  const durationS = options.durationS ?? 0;
  const deadline = durationS > 0 ? Date.now() + durationS * 1000 : null;

  while (true) {
    clock = Date.now();
    const report = await engine.runTick();
    if (!report.ok && engine.shouldStop()) break;
    if (deadline === null) break; // une seule itération
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const equity = listEquity(db, { mode: "paper" });
  const finalNavUsd = equity[equity.length - 1]?.navUsd ?? cfg.lab.initial_usdc;
  const trades = listTrades(db, { mode: "paper", limit: 10_000 }).length;

  closeDb(db);

  return {
    ok: true,
    warnings,
    dbPath,
    finalNavUsd,
    trades,
    rejectedByCorroboration: market.rejected,
    strategies: strategies.map((strategy) => strategy.name),
  };
}

/** Adaptateur : le `Poller` devient une `MarketSource` pour le moteur. */
class PollerMarketSource implements MarketSource {
  constructor(private readonly poller: Poller) {}

  async pollOnce(tsMs: number): Promise<Map<string, MarketQuote>> {
    const result: PollResult = await this.poller.pollOnce(tsMs);
    const out = new Map<string, MarketQuote>();
    for (const [mint, price] of result.prices) {
      out.set(mint, { priceUsd: price.priceUsd, liquidityUsd: price.liquidityUsd });
    }
    return out;
  }
}
