import { fillCosts, simulateBuy, simulateSell } from "./paper-broker.js";
import type { CostConfig } from "./costs.js";
import type { DB } from "../state/db.js";
import { addLot, reducePositionFifo, setStops, updatePeak } from "../state/portfolio-repo.js";
import { insertTrade } from "../state/trades.js";

/**
 * Exécution — le *seam* entre le moteur et le monde extérieur.
 *
 * Un seul `Executor` pour les trois modes ; seul l'implémentation change :
 * - `PaperExecutor` : fill simulé, portefeuille et cash mis à jour ;
 * - `JupiterExecutor` (phase 5) : `/order` → signature → `/execute`.
 *
 * Le moteur ne sait jamais lequel est branché : c'est ce qui garantit que
 * le backtest et le live prennent **exactement** les mêmes décisions.
 */

export interface TradeIntent {
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  strategy: string;
  /** Prix de référence observé. */
  priceUsd: number;
  liquidityUsd: number | null;
  /** Montant dépensé (achat). */
  spendUsd: number;
  /** Quantité vendue (vente) — calculée si absente. */
  qty?: number;
  /** Part de la position à vendre, 0..1. */
  sellPortion?: number;
  reason: string;
  stopLossPct: number;
  takeProfitPct: number;
  decimals: number;
  /** L'entrée ouvre-t-elle un ATA inexistant ? */
  needsAta: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  status: "filled" | "simulated" | "failed" | "rejected";
  qty: number;
  spendUsd: number;
  proceedsUsd: number;
  feeUsd: number;
  realizedPnlUsd: number | null;
  note: string | null;
  signature: string | null;
}

export interface Executor {
  execute(intent: TradeIntent): Promise<ExecuteResult>;
}

/** Cash : abstraction du cash disponible (virtuel en paper, on-chain en live). */
export interface CashLedger {
  cashUsd(): number;
  /** Solde SOL (null quand inconnu, ex. paper). */
  solBalance(): number | null;
  debit(usd: number): void;
  credit(usd: number): void;
}

/**
 * Exécuteur de simulation : il modelledise le fill, met à jour le
 * portefeuille (lots FIFO) et le cash, et journalise le trade.
 *
 * C'est **le même** exécuteur en paper et en backtest : la parité entre les
 * deux modes est donc structurelle, pas une coïncidence.
 */
export class PaperExecutor implements Executor {
  constructor(
    private readonly deps: {
      db: DB;
      mode: string;
      cash: CashLedger;
      costs: CostConfig;
    },
  ) {}

  execute(intent: TradeIntent): Promise<ExecuteResult> {
    return Promise.resolve(this.executeSync(intent));
  }

  /** Le fill simulé est synchrone : rien n'attend quoi que ce soit. */
  private executeSync(intent: TradeIntent): ExecuteResult {
    const { db, cash, costs: cfg } = this.deps;
    const notional = intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd;

    const costs = fillCosts(intent.mint, "USDC", notional, intent.liquidityUsd, cfg);

    if (intent.side === "buy") {
      const fill = simulateBuy(intent.spendUsd, intent.priceUsd, costs, intent.decimals);
      if (fill.qty <= 0) {
        return this.fail("quantité nulle après application des frais");
      }

      cash.debit(fill.spendUsd);
      addLot(db, intent.mint, intent.symbol, fill.qty, fill.priceUsd, Date.now());

      const stopLoss = intent.priceUsd * (1 - intent.stopLossPct / 100);
      const takeProfit = intent.priceUsd * (1 + intent.takeProfitPct / 100);
      setStops(db, intent.mint, stopLoss, takeProfit, Date.now());
      updatePeak(db, intent.mint, intent.priceUsd, Date.now());

      insertTrade(db, {
        tsMs: Date.now(),
        mode: this.deps.mode,
        strategy: intent.strategy,
        mint: intent.mint,
        symbol: intent.symbol,
        side: "buy",
        priceUsd: fill.priceUsd,
        qty: fill.qty,
        notionalUsd: fill.qty * fill.priceUsd,
        feeUsd: fill.feeUsd,
        realizedPnlUsd: null,
        reason: intent.reason,
        signature: null,
        status: "simulated",
      });

      return {
        ok: true,
        status: "simulated",
        qty: fill.qty,
        spendUsd: fill.spendUsd,
        proceedsUsd: 0,
        feeUsd: fill.feeUsd,
        realizedPnlUsd: null,
        note: null,
        signature: null,
      };
    }

    // ── Vente ────────────────────────────────────────────────────────────
    const qty = intent.qty ?? 0;
    if (qty <= 0) {
      return this.fail("quantité de vente nulle");
    }

    const fill = simulateSell(qty, intent.priceUsd, costs);
    const reduce = reducePositionFifo(db, intent.mint, qty, fill.priceUsd, Date.now());

    cash.credit(fill.proceedsUsd);

    insertTrade(db, {
      tsMs: Date.now(),
      mode: this.deps.mode,
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: "sell",
      priceUsd: fill.priceUsd,
      qty: fill.qty,
      notionalUsd: fill.qty * fill.priceUsd,
      feeUsd: fill.feeUsd,
      realizedPnlUsd: reduce.realizedPnlUsd,
      reason: intent.reason,
      signature: null,
      status: "simulated",
    });

    return {
      ok: true,
      status: "simulated",
      qty: fill.qty,
      spendUsd: 0,
      proceedsUsd: fill.proceedsUsd,
      feeUsd: fill.feeUsd,
      realizedPnlUsd: reduce.realizedPnlUsd,
      note: null,
      signature: null,
    };
  }

  private fail(note: string): ExecuteResult {
    return {
      ok: false,
      status: "failed",
      qty: 0,
      spendUsd: 0,
      proceedsUsd: 0,
      feeUsd: 0,
      realizedPnlUsd: null,
      note,
      signature: null,
    };
  }
}
