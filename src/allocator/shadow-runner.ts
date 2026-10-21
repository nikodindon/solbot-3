import type { AllocatorConfig, RiskConfig } from "../config/schema.js";
import type { CostConfig } from "../execution/costs.js";
import { fillCosts, simulateBuy, simulateSell } from "../execution/paper-broker.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import type { Signal, Strategy, StrategyEval } from "../strategies/types.js";
import type { DB } from "../state/db.js";
import { kvGet, kvSet, STATE_KEYS } from "../state/kv.js";
import {
  choosePilot,
  scoreShadow,
  type AllocationDecision,
  type ShadowScore,
} from "./allocator.js";
import type { ShadowBookSpec } from "./shadow.js";
import {
  insertShadowNav,
  insertShadowTrade,
  loadShadowBook,
  shadowNav,
  shadowNavSeries,
  shadowTradeCount,
  type ShadowBook,
} from "./shadow.js";

/**
 * Le runner de portefeuilles fantômes.
 *
 * À chaque tick :
 * 1. chaque stratégie active est évaluée **contre son propre livre** (jamais
 *    contre le livre réel : sinon les sorties ne cibleraient jamais les
 *    positions du shadow, et le livre resterait figé) ;
 * 2. ses signaux sont appliqués à son livre, avec les **mêmes coûts** que le
 *    capital réel ;
 * 3. sa NAV est enregistrée ;
 * 4. l'allocateur classe les stratégies et choisit la pilote.
 *
 * Les shadows sont donc une **mesure** de la performance relative des
 * stratégies, pas une simulation approximative.
 */

export interface ShadowRunnerDeps {
  db: DB;
  strategies: Strategy[];
  allocator: AllocatorConfig;
  risk: RiskConfig;
  costs: CostConfig;
  /** Capital virtuel de départ de chaque shadow. */
  initialCashUsd: number;
}

export interface ShadowRunResult {
  decision: AllocationDecision;
  scores: ShadowScore[];
  /** Signaux produits par la stratégie pilote, **relativement au livre réel**. */
  pilotSignals: Signal[];
  pilot: string | null;
  /** Notes explicatives des stratégies, pour le journal. */
  notes: { strategy: string; note: string }[];
}

/** Vue de portefeuille d'un shadow, telle que la stratégie la voit. */
export function shadowPortfolioView(book: ShadowBook, prices: Map<string, number>): PortfolioView {
  const positions = [...book.positions.values()].map((position) => {
    const price = prices.get(position.mint) ?? position.avgEntryUsd;
    const value = position.qty * price;
    return {
      mint: position.mint,
      symbol: position.mint.slice(0, 4),
      qty: position.qty,
      avgEntryUsd: position.avgEntryUsd,
      valueUsd: value,
      unrealizedPnlUsd: (price - position.avgEntryUsd) * position.qty,
      unrealizedPnlPct:
        position.avgEntryUsd > 0
          ? ((price - position.avgEntryUsd) / position.avgEntryUsd) * 100
          : 0,
      stopLossUsd: null,
      takeProfitUsd: null,
      peakPriceUsd: null,
      ageMs: 0,
    };
  });

  const positionsUsd = positions.reduce((sum, p) => sum + p.valueUsd, 0);
  const unrealized = positions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);

  return {
    navUsd: book.cashUsd + positionsUsd,
    cashUsd: book.cashUsd,
    positions,
    unrealizedPnlUsd: unrealized,
  };
}

/**
 * Fait tourner tous les shadows et choisit la stratégie pilote.
 *
 * `evaluatePilot` est injecté : c'est l'appel qui évalue la stratégie
 * pilote **contre le portefeuille réel** (les shadows servent à *choisir*,
 * pas à décider).
 */
export function runShadows(
  deps: ShadowRunnerDeps,
  input: {
    tsMs: number;
    prices: Map<string, number>;
    evaluate: (strategy: Strategy, portfolio: PortfolioView) => StrategyEval;
  },
): ShadowRunResult {
  const { db, strategies, allocator, risk, costs, initialCashUsd } = deps;
  const windowMs = allocator.score_window_days * 86_400_000;
  const sinceMs = input.tsMs - windowMs;

  const spec = {
    initialCashUsd,
    positionPct: risk.max_position_pct,
  };

  const scores: ShadowScore[] = [];
  const notes: { strategy: string; note: string }[] = [];

  for (const strategy of strategies) {
    const book = loadShadowBook(db, strategy.name, spec, sinceMs);

    // La stratégie est évaluée contre **son** livre.
    const shadowView = shadowPortfolioView(book, input.prices);
    const shadowEval = input.evaluate(strategy, shadowView);
    for (const note of shadowEval.notes) notes.push({ strategy: strategy.name, note });

    for (const signal of shadowEval.signals) {
      applyShadowSignal(db, strategy.name, book, signal, input, costs, spec, risk);
    }

    const nav = shadowNav(book, input.prices);
    insertShadowNav(db, strategy.name, input.tsMs, nav);

    const navSeries = shadowNavSeries(db, strategy.name, sinceMs);
    const trades = shadowTradeCount(db, strategy.name, sinceMs);
    scores.push(scoreShadow(strategy.name, navSeries, trades, allocator.min_trades_to_score));
  }

  const currentPilot = kvGet(db, STATE_KEYS.allocatedStrategy);
  const decision = choosePilot(scores, currentPilot, allocator.hysteresis_pct);
  if (decision.pilot !== null) {
    kvSet(db, STATE_KEYS.allocatedStrategy, decision.pilot, input.tsMs);
  } else if (currentPilot !== null) {
    kvSet(db, STATE_KEYS.allocatedStrategy, "", input.tsMs);
  }

  return {
    decision,
    scores,
    pilot: decision.pilot,
    pilotSignals: [],
    notes,
  };
}

/**
 * Applique un signal au livre d'un shadow.
 *
 * Les fills sont **modélisés exactement comme ceux du capital réel** : même
 * barème de frais, même slippage, même impact. Un shadow qui triche sur
 * les coûts ne vaut rien comme instrument de comparaison.
 */
function applyShadowSignal(
  db: DB,
  shadow: string,
  book: ShadowBook,
  signal: Signal,
  input: { tsMs: number; prices: Map<string, number> },
  costs: CostConfig,
  spec: ShadowBookSpec,
  risk: RiskConfig,
): void {
  const price = input.prices.get(signal.assetMint);
  if (price === undefined || price <= 0) return;

  const position = book.positions.get(signal.assetMint);

  if (signal.side === "sell") {
    if (!position || position.qty <= 0) return;
    const fill = simulateSell(
      position.qty,
      price,
      fillCosts(signal.assetMint, "USDC", position.qty * price, null, costs),
    );
    const pnl = (fill.priceUsd - position.avgEntryUsd) * fill.qty;
    book.cashUsd += fill.proceedsUsd;
    book.positions.delete(signal.assetMint);

    insertShadowTrade(db, shadow, {
      tsMs: input.tsMs,
      mint: signal.assetMint,
      side: "sell",
      qty: fill.qty,
      priceUsd: fill.priceUsd,
      notionalUsd: fill.qty * fill.priceUsd,
      feeUsd: fill.feeUsd,
      pnlUsd: pnl,
    });
    return;
  }

  // Achat : on n'enlève pas plus que ce qu'on a, et on ne dépasse pas la
  // fraction du NAV autorisée (miroir du RiskManager réel).
  const nav = shadowNav(book, input.prices);
  const maxByPosition = (risk.max_position_pct / 100) * nav;
  const maxByCash = book.cashUsd;
  const sizeUsd = Math.min(maxByPosition, maxByCash, signal.suggestedSizeUsd ?? maxByPosition);
  if (sizeUsd <= 0) return;

  const fill = simulateBuy(
    sizeUsd,
    price,
    fillCosts(signal.assetMint, "USDC", sizeUsd, null, costs),
  );
  if (fill.qty <= 0) return;

  book.cashUsd -= fill.spendUsd;
  const existing = book.positions.get(signal.assetMint);
  if (existing) {
    const qty = existing.qty + fill.qty;
    existing.avgEntryUsd =
      qty > 0
        ? (existing.avgEntryUsd * existing.qty + fill.priceUsd * fill.qty) / qty
        : fill.priceUsd;
    existing.qty = qty;
  } else {
    book.positions.set(signal.assetMint, {
      mint: signal.assetMint,
      qty: fill.qty,
      avgEntryUsd: fill.priceUsd,
      valueUsd: fill.qty * fill.priceUsd,
    });
  }

  insertShadowTrade(db, shadow, {
    tsMs: input.tsMs,
    mint: signal.assetMint,
    side: "buy",
    qty: fill.qty,
    priceUsd: fill.priceUsd,
    notionalUsd: fill.qty * fill.priceUsd,
    feeUsd: fill.feeUsd,
    pnlUsd: null,
  });
  void spec;
}
