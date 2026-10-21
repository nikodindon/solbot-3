import { ATA_RENT_SOL, BASE_FEE_LAMPORTS, jupiterPairFeeBps } from "../constants.js";

/**
 * Modèle de coûts.
 *
 * **Un seul modèle pour le paper et le backtest.** C'est la correction
 * directe du défaut de solbot2, où le backtest tournait avec
 * `fill_slippage_bps: 0` pendant que le paper en modélisait 20 : la parité
 * backtest/paper était alors cassée à la source, et le rapport de parité
 * ne pouvait rien mesurer.
 *
 * Le coût aller-retour se décompose en :
 * - frais de plateforme Jupiter (barème par paire) ;
 * - frais réseau (base fee + priority fee), convertis en bps du notionnel ;
 * - slippage de fill, payé **dans les deux sens** ;
 * - loyer d'ATA, amorti sur un horizon de trades (le rent est one-shot).
 */

export interface CostConfig {
  /** Slippage de fill par exécution, en bps (un sens). */
  fillSlippageBps: number;
  /** Coefficient d'impact : impact ≈ impact_k × notionnel / liquidité. */
  impactK: number;
  /** Priority fee par swap, en SOL. */
  priorityFeeSol: number;
  /** Barème de frais forcé (bps) — sinon le barème Jupiter est utilisé. */
  feeBpsOverride: number | null;
  /** Nombre de trades sur lesquels le loyer d'ATA est amorti. */
  ataAmortizationTrades: number;
}

export const DEFAULT_COST_CONFIG: CostConfig = {
  fillSlippageBps: 20,
  impactK: 0.5,
  priorityFeeSol: 0.00005,
  feeBpsOverride: null,
  ataAmortizationTrades: 10,
};

export interface CostBreakdown {
  /** Frais de plateforme Jupiter, aller-retour, en bps. */
  feeBps: number;
  /** Frais réseau (base fee + priority fee), aller-retour, en bps. */
  solFeeBps: number;
  /** Slippage de fill aller-retour, en bps. */
  slippageBps: number;
  /** Loyer d'ATA par exécution, en bps (one-shot, non amorti). */
  rentBps: number;
  /** Total aller-retour, en bps. */
  totalBps: number;
  /** Total **récurrent** (hors rent), en bps — c'est le seuil du filtre d'edge. */
  recurringBps: number;
  /** Total amorti (rent réparti), en bps. */
  amortizedBps: number;
}

export interface CostQuery {
  inputMint: string;
  outputMint: string;
  /** Notionnel de la transaction, en USD. */
  notionalUsd: number;
  /** Prix du SOL en USD (pour convertir les frais réseau). */
  solPriceUsd: number;
  /** Le trade ouvre-t-il un ATA qui n'existait pas ? */
  needsAta: boolean;
}

/** Frais de plateforme Jupiter modélisés pour une paire (un sens). */
export function pairFeeBps(inputMint: string, outputMint: string, override: number | null): number {
  if (override !== null) return override;
  return jupiterPairFeeBps(inputMint, outputMint);
}

/**
 * Impact de prix estimé, en bps.
 *
 * Modèle simplifié `x·y = k` : un achat de `notional` dans un pool de
 * `liquidity` déplace le prix d'environ `2 × notional / liquidité`.
 */
export function impactBps(notionalUsd: number, liquidityUsd: number | null): number {
  if (!liquidityUsd || liquidityUsd <= 0) return 0;
  const raw = (2 * notionalUsd * 10_000) / liquidityUsd;
  return Math.min(5_000, Math.max(0, raw));
}

/** Coût réseau d'une exécution, en lamports. */
export function networkFeeLamports(priorityFeeSol: number): number {
  return BASE_FEE_LAMPORTS + Math.round(priorityFeeSol * 1e9);
}

/**
 * Coût aller-retour d'une position, décomposé.
 *
 * Le résultat est la **base du filtre d'edge** : une entrée n'est justifiée
 * que si le mouvement attendu dépasse `k ×` ce coût.
 */
export function roundTripCostBps(query: CostQuery, cfg: CostConfig): CostBreakdown {
  const feeBps = 2 * pairFeeBps(query.inputMint, query.outputMint, cfg.feeBpsOverride);

  // Les lamports doivent être convertis en SOL avant d'être valorisés :
  // 55 000 lamports = 0,000055 SOL, pas 55 000 SOL.
  const solFeeUsd = ((2 * networkFeeLamports(cfg.priorityFeeSol)) / 1e9) * query.solPriceUsd;
  const solFeeBps = query.notionalUsd > 0 ? (solFeeUsd * 10_000) / query.notionalUsd : 0;

  const slippageBps = 2 * cfg.fillSlippageBps;

  const rentBps =
    query.needsAta && query.solPriceUsd > 0
      ? (ATA_RENT_SOL * query.solPriceUsd * 10_000) / Math.max(query.notionalUsd, 1)
      : 0;

  const recurringBps = feeBps + solFeeBps + slippageBps;
  const totalBps = recurringBps + rentBps;

  return {
    feeBps,
    solFeeBps,
    slippageBps,
    rentBps,
    totalBps,
    recurringBps,
    amortizedBps: recurringBps + rentBps / Math.max(1, cfg.ataAmortizationTrades),
  };
}
