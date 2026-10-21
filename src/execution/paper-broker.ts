import { SOL_MINT } from "../constants.js";
import { impactBps, networkFeeLamports, pairFeeBps, type CostConfig } from "./costs.js";

/**
 * Broker de simulation : modèle de fill partagé par le paper et le backtest.
 *
 * Un fill est **modélisé**, jamais observé :
 * - prix effectif = prix courant ± slippage ± impact ;
 * - frais de plateforme deducted du montant ;
 * - frais réseau (SOL) déduits séparément.
 *
 * Les quantités sont arrondies **vers le bas** à l'unité de base : un fill ne
 * peut jamais créditer plus de tokens qu'il n'y en a.
 */

export interface FillCosts {
  feeBps: number;
  slippageBps: number;
  impactBps: number;
  /** Frais réseau en SOL (base fee + priority fee). */
  networkFeeSol: number;
}

export interface BuyFill {
  /** Prix effectif payé. */
  priceUsd: number;
  /** Quantité reçue. */
  qty: number;
  /** Dépensé en USD (frais compris). */
  spendUsd: number;
  /** Frais de plateforme, en USD. */
  feeUsd: number;
  /** Frais réseau, en SOL. */
  networkFeeSol: number;
}

export interface SellFill {
  priceUsd: number;
  qty: number;
  /** Encaissé en USD (frais déduits). */
  proceedsUsd: number;
  feeUsd: number;
  networkFeeSol: number;
}

/** Coûts d'un fill pour une paire donnée. */
export function fillCosts(
  inputMint: string,
  outputMint: string,
  notionalUsd: number,
  liquidityUsd: number | null,
  cfg: CostConfig,
): FillCosts {
  return {
    feeBps: pairFeeBps(inputMint, outputMint, cfg.feeBpsOverride),
    slippageBps: cfg.fillSlippageBps,
    impactBps: impactBps(notionalUsd, liquidityUsd),
    networkFeeSol: networkFeeLamports(cfg.priorityFeeSol) / 1e9,
  };
}

/** Simule un achat : `spendUsd` est le montant total disponible. */
export function simulateBuy(
  spendUsd: number,
  priceUsd: number,
  costs: FillCosts,
  decimals = 9,
): BuyFill {
  if (priceUsd <= 0) throw new Error("simulateBuy : prix invalide");
  if (spendUsd <= 0) throw new Error("simulateBuy : montant invalide");

  const effectivePrice = priceUsd * (1 + (costs.slippageBps + costs.impactBps) / 10_000);
  const feeUsd = spendUsd * (costs.feeBps / 10_000);
  const investable = spendUsd - feeUsd;
  const qty = floorToBaseUnits(investable / effectivePrice, decimals);

  return {
    priceUsd: effectivePrice,
    qty,
    spendUsd: qty * effectivePrice + feeUsd,
    feeUsd,
    networkFeeSol: costs.networkFeeSol,
  };
}

/** Simule une vente : `qty` est la quantité détenue. */
export function simulateSell(qty: number, priceUsd: number, costs: FillCosts): SellFill {
  if (priceUsd <= 0) throw new Error("simulateSell : prix invalide");
  if (qty <= 0) throw new Error("simulateSell : quantité invalide");

  const effectivePrice = priceUsd * (1 - (costs.slippageBps + costs.impactBps) / 10_000);
  const gross = qty * effectivePrice;
  const feeUsd = gross * (costs.feeBps / 10_000);
  const proceeds = gross - feeUsd;

  return {
    priceUsd: effectivePrice,
    qty,
    proceedsUsd: proceeds,
    feeUsd,
    networkFeeSol: costs.networkFeeSol,
  };
}

/**
 * Arrondi **vers le bas** à l'unité de base.
 *
 * L'arrondi vers le bas évite le créditage de dust : on ne peut jamais
 * recevoir (ni vendre) plus que ce qu'on a.
 */
export function floorToBaseUnits(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 10 ** Math.min(decimals, 9);
  const scaled = value * factor;
  // L'epsilon compense les erreurs de représentation en virgule flottante.
  const floored = Math.floor(scaled + 1e-9);
  return floored / factor;
}

/** Le SOL est la devise de frais : il n'est jamais vendu contre un autre jeton. */
export function isFeeMint(mint: string): boolean {
  return mint === SOL_MINT;
}
