import type { AllocatorConfig, RiskConfig } from "../config/schema.js";
import type { CostBreakdown, CostConfig } from "../execution/costs.js";
import { roundTripCostBps } from "../execution/costs.js";
import type { Signal } from "../strategies/types.js";
import { clamp } from "../strategies/indicators.js";

/**
 * Le RiskManager — **autorité finale**.
 *
 * Un signal, même excellent, peut être rejeté. Les règles s'appliquent dans
 * un **ordre fixe** (README §12.1) : les garde-fous globaux d'abord, les
 * contraintes de portefeuille ensuite, le dimensionnement en dernier.
 *
 * Chaque rejet est **chiffré** : le journal indique la règle, les chiffres
 * qui ont conduit au rejet, et le seuil qui aurait permis de passer. C'est
 * l'outil de réglage principal du projet.
 */

export type RiskRule =
  | "kill_switch"
  | "daily_loss_pause"
  | "data_guard"
  | "max_positions"
  | "asset_exposure"
  | "edge_net"
  | "price_impact"
  | "cooldown"
  | "gas_reserve"
  | "size_too_small"
  | "insufficient_cash";

export interface RiskFlags {
  /** Kill-switch global : fichier `STOP`, drawdown max, ou commande reçue. */
  killSwitch: boolean;
  /** Timestamp jusqu'auquel les entrées sont en pause (perte journalière). */
  pausedUntilMs: number | null;
  /** Solde SOL disponible (null en paper/dry-run). */
  solBalanceSol: number | null;
  /** Solde USDC disponible. */
  cashUsd: number;
  /** NAV courant. */
  navUsd: number;
  /** Exposition déjà engagée sur l'actif concerné, en USD. */
  assetExposureUsd: number;
  /** Exposition totale déjà engagée, en USD. */
  totalExposureUsd: number;
  /** Nombre de positions ouvertes. */
  openPositions: number;
  /** Dernier trade sur cet actif (ts), pour le cooldown. */
  lastTradeTsByMint: number | null;
  /** Prix de l'actif, et son origine. */
  priceUsd: number;
  /** Liquidité connue de l'actif (null = inconnue). */
  liquidityUsd: number | null;
  /** Le prix est-il assez frais et d'une source acceptée ? */
  priceUsable: boolean;
  /** Motif du refus de données, si prix inutilisable. */
  priceGuardReason: string | null;
}

export interface RiskEntryRequest {
  signal: Signal;
  inputMint: string;
  outputMint: string;
  solPriceUsd: number;
  /** Le trade ouvre-t-il un ATA qui n'existe pas ? */
  needsAta: boolean;
  nowMs: number;
}

export interface RiskDecision {
  allowed: boolean;
  /** Taille maximale autorisée, en USD (0 si refus). */
  sizeUsd: number;
  /** Stop-loss retenu, en %. */
  stopLossPct: number;
  /** Take-profit retenu, en %. */
  takeProfitPct: number;
  /** Règle de refus (null si autorisé). */
  rule: RiskRule | null;
  /** Message lisible du refus. */
  message: string | null;
  /** Chiffres du refus, pour le journal. */
  metrics: Record<string, number | string | boolean | null>;
  /** Coût aller-retour estimé. */
  cost: CostBreakdown;
}

export class RiskManager {
  constructor(
    private readonly risk: RiskConfig,
    private readonly allocator: AllocatorConfig,
    private readonly costs: CostConfig,
  ) {}

  /**
   * Évalue une entrée. Les règles sont appliquées **dans l'ordre** ; la
   * première qui échoue arrête l'évaluation.
   */
  checkEntry(request: RiskEntryRequest, flags: RiskFlags): RiskDecision {
    const { signal } = request;
    const cost = this.roundTripCost(request, flags);

    // ── 1. Kill-switch global ────────────────────────────────────────────
    if (flags.killSwitch) {
      return this.reject("kill_switch", "kill-switch actif : plus d'entrées", flags, cost, {
        pausedUntilMs: flags.pausedUntilMs,
      });
    }

    // ── 2. Perte journalière ─────────────────────────────────────────────
    if (flags.pausedUntilMs !== null && flags.pausedUntilMs > request.nowMs) {
      const minutes = Math.ceil((flags.pausedUntilMs - request.nowMs) / 60_000);
      return this.reject(
        "daily_loss_pause",
        `entrées en pause pendant ${minutes} min (limite de perte journalière)`,
        flags,
        cost,
        { pausedUntilMs: flags.pausedUntilMs },
      );
    }

    // ── 3. Garde de données (prix périmé ou sans source acceptée) ───────
    if (!flags.priceUsable) {
      return this.reject(
        "data_guard",
        `prix inutilisable — ${flags.priceGuardReason ?? "source ou fraîcheur insuffisante"}`,
        flags,
        cost,
        {},
      );
    }

    // ── 4. Plafond de positions ──────────────────────────────────────────
    const alreadyHeld = flags.assetExposureUsd > 0;
    if (!alreadyHeld && flags.openPositions >= this.risk.max_positions) {
      return this.reject(
        "max_positions",
        `${flags.openPositions} positions ouvertes ≥ ${this.risk.max_positions}`,
        flags,
        cost,
        { openPositions: flags.openPositions },
      );
    }

    // ── 5. Edge net ──────────────────────────────────────────────────────
    // Un signal de rééquilibrage en est exempt : son gain n'est pas un
    // mouvement de prix, c'est une réduction de dérive.
    const edgeExempt = signal.edgeExempt === true;
    const threshold = this.allocator.min_edge_over_costs * cost.amortizedBps;
    if (!edgeExempt && signal.expectedMoveBps < threshold) {
      return this.reject(
        "edge_net",
        `edge ${signal.expectedMoveBps.toFixed(0)} bps < seuil ${this.allocator.min_edge_over_costs}×coûts ${threshold.toFixed(0)} bps`,
        flags,
        cost,
        { edgeBps: signal.expectedMoveBps, thresholdBps: threshold },
      );
    }

    // ── 6. Dimensionnement ───────────────────────────────────────────────
    const sizeUsd = this.computeSize(request, flags);

    if (sizeUsd <= 0) {
      return this.reject(
        "insufficient_cash",
        `cash ${flags.cashUsd.toFixed(2)} $ insuffisant`,
        flags,
        cost,
        { cashUsd: flags.cashUsd },
      );
    }

    // ── 7. Impact de prix ────────────────────────────────────────────────
    const impact = this.impactBps(sizeUsd, flags.liquidityUsd);
    if (impact > this.risk.max_price_impact_pct * 100) {
      return this.reject(
        "price_impact",
        `impact ${impact.toFixed(0)} bps > max ${(this.risk.max_price_impact_pct * 100).toFixed(0)} bps`,
        flags,
        cost,
        { impactBps: impact, sizeUsd },
      );
    }

    // ── 8. Cooldown ───────────────────────────────────────────────────────
    if (flags.lastTradeTsByMint !== null) {
      const elapsed = (request.nowMs - flags.lastTradeTsByMint) / 1000;
      if (elapsed < this.risk.min_time_between_trades_s) {
        const remaining = Math.ceil(this.risk.min_time_between_trades_s - elapsed);
        return this.reject(
          "cooldown",
          `cooldown actif : ${remaining} s restantes sur cet actif`,
          flags,
          cost,
          { elapsedS: elapsed, cooldownS: this.risk.min_time_between_trades_s },
        );
      }
    }

    // ── 9. Réserve de gaz ────────────────────────────────────────────────
    if (flags.solBalanceSol !== null) {
      const needed = this.costs.priorityFeeSol * 2 + 0.001;
      if (flags.solBalanceSol - needed < this.risk.sol_gas_reserve) {
        return this.reject(
          "gas_reserve",
          `SOL ${flags.solBalanceSol.toFixed(5)} < réserve ${this.risk.sol_gas_reserve} + frais`,
          flags,
          cost,
          { solBalanceSol: flags.solBalanceSol, neededSol: needed },
        );
      }
    }

    // ── 10. Taille minimale ──────────────────────────────────────────────
    // Une position doit valoir au moins 10 % de la taille maximale autorisée
    // (et au moins 1 $) : en dessous, c'est de la poussière de trade.
    const maxPositionUsd = (this.risk.max_position_pct / 100) * flags.navUsd;
    const minSize = Math.max(1, maxPositionUsd * 0.1);
    if (sizeUsd < minSize && !edgeExempt) {
      return this.reject(
        "size_too_small",
        `taille calculée ${sizeUsd.toFixed(2)} $ < minimum ${minSize.toFixed(2)} $`,
        flags,
        cost,
        { sizeUsd, minSize },
      );
    }

    const stopLossPct = clamp(signal.stopLossPct ?? this.risk.stop_loss_pct, 0.5, 50);

    return {
      allowed: true,
      sizeUsd,
      stopLossPct,
      takeProfitPct: this.risk.take_profit_pct,
      rule: null,
      message: null,
      metrics: {
        sizeUsd,
        edgeBps: signal.expectedMoveBps,
        thresholdBps: threshold,
        costBps: cost.amortizedBps,
        impactBps: impact,
      },
      cost,
    };
  }

  /**
   * Vérifie qu'une **sortie** est exécutable.
   *
   * Une sortie n'est **jamais** bloquée par le risque : ni kill-switch, ni
   * pause, ni plafonds. Seule une garde de données peut l'empêcher (un
   * prix périmé rendrait la sortie fantaisiste).
   */
  checkExit(flags: RiskFlags): { allowed: boolean; message: string | null } {
    if (!flags.priceUsable) {
      return {
        allowed: false,
        message: `prix inutilisable — ${flags.priceGuardReason ?? "source ou fraîcheur insuffisante"}`,
      };
    }
    return { allowed: true, message: null };
  }

  /**
   * Taille maximale autorisée.
   *
   * Le minimum de quatre contraintes : plafond par position, exposition
   * restante sur l'actif, cash disponible, et impact de prix.
   */
  private computeSize(request: RiskEntryRequest, flags: RiskFlags): number {
    const maxByPosition = (this.risk.max_position_pct / 100) * flags.navUsd;
    const maxByAsset =
      (this.risk.max_asset_exposure_pct / 100) * flags.navUsd - flags.assetExposureUsd;
    const maxByCash = flags.cashUsd;
    const maxByImpact = (this.risk.max_price_impact_pct / 100) * (flags.liquidityUsd ?? 0);

    const suggested = request.signal.suggestedSizeUsd;
    const sizes = [maxByPosition, maxByAsset, maxByCash, maxByImpact];
    if (suggested !== undefined) sizes.push(suggested);

    return Math.max(0, Math.min(...sizes));
  }

  private roundTripCost(request: RiskEntryRequest, flags: RiskFlags): CostBreakdown {
    const notional = Math.max(
      1,
      Math.min(
        (this.risk.max_position_pct / 100) * flags.navUsd,
        request.signal.suggestedSizeUsd ?? Number.POSITIVE_INFINITY,
        flags.cashUsd,
      ),
    );
    return roundTripCostBps(
      {
        inputMint: request.outputMint,
        outputMint: request.inputMint,
        notionalUsd: notional,
        solPriceUsd: request.solPriceUsd,
        needsAta: request.needsAta,
      },
      this.costs,
    );
  }

  private impactBps(sizeUsd: number, liquidityUsd: number | null): number {
    if (!liquidityUsd || liquidityUsd <= 0) return 0;
    return Math.min(5_000, (2 * sizeUsd * 10_000) / liquidityUsd);
  }

  private reject(
    rule: RiskRule,
    message: string,
    flags: RiskFlags,
    cost: CostBreakdown,
    extra: Record<string, number | string | boolean | null>,
  ): RiskDecision {
    return {
      allowed: false,
      sizeUsd: 0,
      stopLossPct: 0,
      takeProfitPct: 0,
      rule,
      message,
      metrics: {
        navUsd: flags.navUsd,
        cashUsd: flags.cashUsd,
        assetExposureUsd: flags.assetExposureUsd,
        totalExposureUsd: flags.totalExposureUsd,
        openPositions: flags.openPositions,
        costBps: cost.amortizedBps,
        ...extra,
      },
      cost,
    };
  }
}
