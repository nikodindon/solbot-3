import { VersionedTransaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { USDC_MINT } from "../constants.js";
import type { SwapApi } from "../jupiter/swap.js";
import { describeExecuteError, describeOrderFailure } from "../jupiter/swap.js";
import type { DB } from "../state/db.js";
import { addLot, reducePositionFifo, setStops } from "../state/portfolio-repo.js";
import { insertTrade } from "../state/trades.js";
import type { Signer } from "../wallet/signer.js";
import type { Executor, ExecuteResult, TradeIntent } from "./executor.js";
import { adaptiveSlippageBps, bumpSlippageBps, describeSlippage } from "./slippage.js";

/**
 * Exécuteur Jupiter — dry-run et live.
 *
 * Le **dry-run** et le **live** partagent le même code : la seule différence
 * est que le dry-run **simule** la transaction au lieu de la signer et de
 * l'envoyer. C'est ce qui rend le dry-run utile : il teste exactement le
 * chemin d'exécution, avec les mêmes devis, les mêmes codes d'erreur et
 * les mêmes blocages qu'en live — sans risque.
 *
 * Le chemin par défaut est le **Meta-Aggregator** (`/order` → signature →
 * `/execute`) : la protection MEV et l'atterrissage sont gérés par Jupiter,
 * et aucun RPC n'est nécessaire pour exécuter.
 */

export interface JupiterExecutorDeps {
  db: DB;
  swapApi: SwapApi;
  connection: Connection;
  signer: Signer;
  /** `dry_run` simule, `live` signe et envoie. */
  mode: "dry_run" | "live";
  /** Nombre de tentatives (re-cotation) après un échec rejouable. */
  retries: number;
  /** Facteur d'élargissement de la borne de slippage après un échec. */
  slippageBumpFactor: number;
  /** Plafond absolu de slippage (jamais dépassé). */
  maxSlippageBps: number;
  /** Mode de slippage demandé. */
  slippageMode: "rtse" | "adaptive" | number;
  /** Paramètres du slippage adaptatif. */
  adaptive: {
    timeframe: "5m" | "15m" | "1h";
    period: number;
    multiplier: number;
    minBps: number;
    maxBps: number;
  };
  /** Confirmation interactive avant un envoi réel. */
  confirm?: (summary: string) => Promise<boolean>;
}

export class JupiterExecutor implements Executor {
  constructor(private readonly deps: JupiterExecutorDeps) {}

  async execute(intent: TradeIntent): Promise<ExecuteResult> {
    const { swapApi, signer, mode } = this.deps;

    const inputAmount =
      intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd;
    if (inputAmount <= 0) {
      return this.failure(intent, "montant nul");
    }

    // Montant en unités de base du token d'entrée.
    const amount = String(Math.floor(inputAmount * 10 ** 6)); // USDC : 6 décimales
    const inputMint = intent.side === "buy" ? USDC_MINT : intent.mint;
    const outputMint = intent.side === "buy" ? intent.mint : USDC_MINT;

    // ── Borne de slippage ──────────────────────────────────────────────
    let slippageBps: number | undefined;
    if (this.deps.slippageMode !== "rtse") {
      if (this.deps.slippageMode === "adaptive") {
        slippageBps =
          adaptiveSlippageBps(this.deps.db, intent.mint, Date.now(), this.deps.adaptive) ??
          undefined;
        // Historique insuffisant → on laisse Jupiter gérer (RTSE).
        if (slippageBps === undefined) slippageBps = undefined;
      } else {
        slippageBps = this.deps.slippageMode;
      }
    }

    // ── Boucle d'exécution, avec re-cotation bornée ───────────────────
    let lastNote: string | null = null;

    for (let attempt = 1; attempt <= this.deps.retries + 1; attempt++) {
      const order = await swapApi.order({
        inputMint,
        outputMint,
        amount,
        taker: signer.address,
        slippageBps,
        maxSupportedTransactionVersion: "0",
      });

      if (!order.transaction) {
        const reason = describeOrderFailure(order.router, order.errorCode);
        // Un échec de devis n'est pas rejouable en aveugle : la cause
        // (fonds insuffisants, ATA manquant) ne changera pas.
        return this.failure(intent, reason);
      }
      if (!order.requestId) {
        return this.failure(intent, "Jupiter n'a pas retourné de requestId");
      }

      let transaction: VersionedTransaction;
      try {
        transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
      } catch (error) {
        return this.failure(
          intent,
          `transaction illisible : ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // ── Dry-run : on simule, on ne signe pas ────────────────────────
      if (mode === "dry_run") {
        return this.simulate(intent, order, transaction);
      }

      // ── Live : confirmation, signature, exécution ─────────────────────
      const summary = [
        `Vente ${intent.side === "buy" ? "achat" : "vente"} ${intent.symbol}`,
        `Montant : ${inputAmount.toFixed(4)} $`,
        `Routeur : ${order.router ?? "inconnu"}`,
        `Slippage : ${describeSlippage(this.deps.slippageMode, slippageBps)}`,
        `Prix attendu : ${order.outAmount} unités de ${outputMint.slice(0, 6)}…`,
      ].join("\n");

      if (this.deps.confirm) {
        const allowed = await this.deps.confirm(summary);
        if (!allowed) {
          return this.failure(intent, "confirmations refusée par l'opérateur");
        }
      }

      const signed = await signer.signVersionedTransaction(transaction);
      const signedTransaction = Buffer.from(signed.serialize()).toString("base64");

      const execution = await swapApi.execute({
        signedTransaction,
        requestId: order.requestId,
        lastValidBlockHeight: order.lastValidBlockHeight,
      });

      if (execution.status === "Success" && execution.code === 0) {
        return this.settle(intent, order, execution);
      }

      // ── Échec : ardoise selon la taxonomie ──────────────────────────
      const info = describeExecuteError(execution.code);
      lastNote = `${info.label}${execution.error ? ` — ${execution.error}` : ""}`;

      if (info.strategy === "abort") {
        return this.failure(intent, lastNote);
      }

      // Rejouable : on élargit la borne de slippage (calculée seulement) et
      // on retente. Une borne fournie explicitement n'est jamais élargie.
      if (slippageBps !== undefined) {
        const bumped = bumpSlippageBps(
          slippageBps,
          this.deps.slippageBumpFactor,
          this.deps.maxSlippageBps,
        );
        if (bumped !== slippageBps) slippageBps = bumped;
      }
    }

    return this.failure(intent, lastNote ?? "échec d'exécution");
  }

  /** Dry-run : la transaction est **simulée**, jamais signée. */
  private async simulate(
    intent: TradeIntent,
    order: { requestId?: string; outAmount: string },
    transaction: VersionedTransaction,
  ): Promise<ExecuteResult> {
    const simulation = await this.deps.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (simulation.value.err) {
      return this.failure(intent, `simulation refusée : ${JSON.stringify(simulation.value.err)}`);
    }

    insertTrade(this.deps.db, {
      tsMs: Date.now(),
      mode: "dry_run",
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: intent.side,
      priceUsd: intent.priceUsd,
      qty: intent.side === "buy" ? 0 : (intent.qty ?? 0),
      notionalUsd: intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd,
      feeUsd: 0,
      realizedPnlUsd: null,
      reason: `dry-run validé (requestId ${order.requestId ?? "?"})`,
      signature: null,
      status: "validated_order",
    });

    return {
      ok: true,
      status: "validated_order",
      qty: intent.side === "buy" ? 0 : (intent.qty ?? 0),
      spendUsd: intent.side === "buy" ? intent.spendUsd : 0,
      proceedsUsd: intent.side === "sell" ? (intent.qty ?? 0) * intent.priceUsd : 0,
      feeUsd: 0,
      realizedPnlUsd: null,
      note: `transaction simulée avec succès (${order.outAmount} unités attendues)`,
      signature: null,
    };
  }

  /** Live : la transaction est passée, on met à jour le portefeuille. */
  private settle(
    intent: TradeIntent,
    order: { outAmount: string; router?: string; feeBps?: number },
    execution: {
      signature?: string | null;
      totalInputAmount?: string | null;
      totalOutputAmount?: string | null;
    },
  ): ExecuteResult {
    const { db } = this.deps;

    // Le PnL se calcule sur les **montants réels** reflétés par Jupiter
    // (`totalInputAmount` / `totalOutputAmount`), pas sur le devis.
    const outputAmount = Number(execution.totalOutputAmount ?? order.outAmount ?? 0);
    const inputAmount = Number(execution.totalInputAmount ?? 0);

    const decimals = intent.decimals;
    const qty = intent.side === "buy" ? outputAmount / 10 ** decimals : (intent.qty ?? 0);
    const priceUsd = intent.side === "buy" && qty > 0 ? inputAmount / qty : intent.priceUsd;
    const notionalUsd = intent.side === "buy" ? inputAmount : qty * priceUsd;

    insertTrade(db, {
      tsMs: Date.now(),
      mode: "live",
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: intent.side,
      priceUsd,
      qty,
      notionalUsd,
      feeUsd: 0,
      realizedPnlUsd: null,
      reason: intent.reason,
      signature: execution.signature ?? null,
      status: "filled",
    });

    if (intent.side === "buy") {
      addLot(db, intent.mint, intent.symbol, qty, priceUsd, Date.now());
      setStops(
        db,
        intent.mint,
        priceUsd * (1 - intent.stopLossPct / 100),
        priceUsd * (1 + intent.takeProfitPct / 100),
        Date.now(),
      );
      return {
        ok: true,
        status: "filled",
        qty,
        spendUsd: notionalUsd,
        proceedsUsd: 0,
        feeUsd: 0,
        realizedPnlUsd: null,
        note: null,
        signature: execution.signature ?? null,
      };
    }

    const reduce = reducePositionFifo(db, intent.mint, qty, priceUsd, Date.now());
    return {
      ok: true,
      status: "filled",
      qty,
      spendUsd: 0,
      proceedsUsd: notionalUsd,
      feeUsd: 0,
      realizedPnlUsd: reduce.realizedPnlUsd,
      note: null,
      signature: execution.signature ?? null,
    };
  }

  private failure(intent: TradeIntent, note: string): ExecuteResult {
    insertTrade(this.deps.db, {
      tsMs: Date.now(),
      mode: this.deps.mode,
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: intent.side,
      priceUsd: intent.priceUsd,
      qty: 0,
      notionalUsd: 0,
      feeUsd: 0,
      realizedPnlUsd: null,
      reason: note,
      signature: null,
      status: "failed",
    });

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
