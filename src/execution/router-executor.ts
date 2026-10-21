import type { Connection, TransactionInstruction } from "@solana/web3.js";
import type { BuildApi } from "../jupiter/build.js";
import type { LandingTarget } from "../solana/landing.js";
import { LandingSendError } from "../solana/landing.js";
import type { Signer } from "../wallet/signer.js";
import type { DB } from "../state/db.js";
import { addLot, reducePositionFifo, setStops } from "../state/portfolio-repo.js";
import { insertTrade } from "../state/trades.js";
import { USDC_MINT } from "../constants.js";
import type { Executor, ExecuteResult, TradeIntent } from "./executor.js";
import { buildRouterTransaction, computeUnitLimitFromSimulation, ROUTER_CODES } from "./router.js";

/**
 * Exécuteur du chemin Router (`/build`).
 *
 * Contrairement au Meta-Aggregator, Jupiter ne renvoie **pas** de
 * transaction : il renvoie des instructions brutes, et l'assemblage est
 * notre charge. Cela donne le contrôle de la transaction (et des frais), au
 * prix de la responsabilité de l'atterrissage.
 *
 * ⚠ Ce chemin est **optionnel et non validé**. Le README n'autorise un
 * changement de chemin par défaut qu'après une comparaison A/B sur au moins
 * 200 swaps réels (`solbot3 paths`).
 */
export interface RouterExecutorDeps {
  db: DB;
  buildApi: BuildApi;
  connection: Connection;
  signer: Signer;
  landing: LandingTarget;
  mode: "dry_run" | "live";
  /** Multiplicateur de la limite de compute units. */
  cuLimitBuffer: number;
  /** Plafond du prix des CU (0 = pas de plafond). */
  cuPriceCapMicrolamports: number;
  /** Tip vers la cible d'atterrissage (lamports). */
  tipLamports: number;
  retries: number;
  confirm?: (summary: string) => Promise<boolean>;
}

export class RouterExecutor implements Executor {
  constructor(private readonly deps: RouterExecutorDeps) {}

  async execute(intent: TradeIntent): Promise<ExecuteResult> {
    const { db, buildApi, connection, signer, landing, mode } = this.deps;

    const inputAmount =
      intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd;
    if (inputAmount <= 0) return this.failure(intent, "montant nul");

    const amount = String(Math.floor(inputAmount * 10 ** 6));
    const inputMint = intent.side === "buy" ? USDC_MINT : intent.mint;
    const outputMint = intent.side === "buy" ? intent.mint : USDC_MINT;

    let lastNote: string | null = null;

    for (let attempt = 1; attempt <= this.deps.retries + 1; attempt++) {
      // ── 1. Build ───────────────────────────────────────────────────
      let build;
      try {
        build = await buildApi.build({
          inputMint,
          outputMint,
          amount,
          taker: signer.address,
        });
      } catch (error) {
        return this.failure(
          intent,
          `build échoué (${ROUTER_CODES.build}) : ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // ── 2. Sonde de simulation pour dimensionner les CU ────────────
      let unitsConsumed: number | undefined;
      try {
        const probe = buildRouterTransaction({
          build,
          payerKey: signer.publicKey,
          cuLimit: 1_400_000,
          cuPriceCapMicrolamports: this.deps.cuPriceCapMicrolamports,
        });
        const simulation = await connection.simulateTransaction(probe.transaction, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
        if (simulation.value.err) {
          return this.failure(
            intent,
            `simulation échouée (${ROUTER_CODES.simulation}) : ${JSON.stringify(simulation.value.err)}`,
          );
        }
        const consumed = simulation.value.unitsConsumed;
        unitsConsumed = typeof consumed === "bigint" ? Number(consumed) : consumed;
      } catch (error) {
        lastNote = `sonde de simulation impossible (${ROUTER_CODES.simulation}) : ${error instanceof Error ? error.message : String(error)}`;
        break;
      }

      const cuLimit = computeUnitLimitFromSimulation(unitsConsumed, this.deps.cuLimitBuffer);

      // ── 3. Assemblage final ────────────────────────────────────────
      let additionalInstructions: TransactionInstruction[] = [];
      try {
        await landing.warmup?.();
        if (landing.prepare && this.deps.tipLamports > 0) {
          additionalInstructions = await landing.prepare({
            taker: signer.publicKey,
            lamports: this.deps.tipLamports,
          });
        }
      } catch {
        additionalInstructions = [];
      }

      let router;
      try {
        router = buildRouterTransaction({
          build,
          payerKey: signer.publicKey,
          cuLimit,
          cuPriceCapMicrolamports: this.deps.cuPriceCapMicrolamports,
          additionalInstructions,
        });
      } catch (error) {
        return this.failure(
          intent,
          `assemblage impossible (${ROUTER_CODES.build}) : ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // ── 4. Dry-run : on s'arrête à la signature ────────────────────
      if (mode === "dry_run") {
        const simulation = await connection.simulateTransaction(router.transaction, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
        if (simulation.value.err) {
          return this.failure(
            intent,
            `simulation finale échouée (${ROUTER_CODES.simulation}) : ${JSON.stringify(simulation.value.err)}`,
          );
        }

        insertTrade(db, {
          tsMs: Date.now(),
          mode: "dry_run",
          strategy: intent.strategy,
          mint: intent.mint,
          symbol: intent.symbol,
          side: intent.side,
          priceUsd: intent.priceUsd,
          qty: intent.side === "buy" ? 0 : (intent.qty ?? 0),
          notionalUsd:
            intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd,
          feeUsd: 0,
          realizedPnlUsd: null,
          reason: `dry-run router validé (${router.cuLimit} CU, ${router.instructionCount} instructions)`,
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
          note: `transaction simulée (${router.cuLimit} CU, bloc ${router.lastValidBlockHeight})`,
          signature: null,
        };
      }

      // ── 5. Live : signature, envoi, confirmation ────────────────────
      const summary = [
        `Swap ${intent.symbol} (chemin router)`,
        `Montant : ${inputAmount.toFixed(4)} $`,
        `CU : ${router.cuLimit}`,
        `Atterrissage : ${landing.name}`,
      ].join("\n");

      if (this.deps.confirm) {
        const allowed = await this.deps.confirm(summary);
        if (!allowed) return this.failure(intent, "confirmation refusée");
      }

      const signed = await signer.signVersionedTransaction(router.transaction);
      const signedBase64 = Buffer.from(signed.serialize()).toString("base64");

      let sendResult;
      try {
        sendResult = await landing.send({
          signedBase64,
          taker: signer.publicKey,
          tipLamports: this.deps.tipLamports,
        });
      } catch (error) {
        if (error instanceof LandingSendError) {
          // L'envoi a été **refusé** : la transaction n'a jamais été soumise.
          // On peut réessayer sans risque de double exécution.
          lastNote = `envoi refusé (${ROUTER_CODES.send}) : ${error.message}`;
          continue;
        }
        lastNote = `envoi incertain (${ROUTER_CODES.confirmUnknown}) : ${error instanceof Error ? error.message : String(error)}`;
        break;
      }

      if (!sendResult.signature) {
        lastNote = `envoi sans signature (${ROUTER_CODES.confirmUnknown}) — ${sendResult.detail}`;
        break;
      }

      const confirmation = await landing.confirm(sendResult.signature, {
        signedBase64,
        taker: signer.publicKey,
        tipLamports: this.deps.tipLamports,
      });

      if (!confirmation.confirmed) {
        return this.failure(
          intent,
          `confirmation ${confirmation.unknown ? "incertaine" : "en échec"} (${ROUTER_CODES.confirmUnknown}) — ${confirmation.detail}`,
        );
      }

      return this.settle(intent, sendResult.signature, inputAmount);
    }

    return this.failure(intent, lastNote ?? "échec d'exécution (router)");
  }

  /** Mise à jour du portefeuille après un swap réussi. */
  private settle(intent: TradeIntent, signature: string, inputAmount: number): ExecuteResult {
    const { db } = this.deps;
    const priceUsd = intent.priceUsd;

    insertTrade(db, {
      tsMs: Date.now(),
      mode: "live",
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: intent.side,
      priceUsd,
      qty: intent.side === "buy" ? intent.spendUsd / priceUsd : (intent.qty ?? 0),
      notionalUsd: inputAmount,
      feeUsd: 0,
      realizedPnlUsd: null,
      reason: intent.reason,
      signature,
      status: "filled",
    });

    if (intent.side === "buy") {
      const qty = intent.spendUsd / priceUsd;
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
        spendUsd: inputAmount,
        proceedsUsd: 0,
        feeUsd: 0,
        realizedPnlUsd: null,
        note: null,
        signature,
      };
    }

    const qty = intent.qty ?? 0;
    const reduce = reducePositionFifo(db, intent.mint, qty, priceUsd, Date.now());
    return {
      ok: true,
      status: "filled",
      qty,
      spendUsd: 0,
      proceedsUsd: inputAmount,
      feeUsd: 0,
      realizedPnlUsd: reduce.realizedPnlUsd,
      note: null,
      signature,
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
