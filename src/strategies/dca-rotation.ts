import { SOL_MINT } from "../constants.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import {
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
  type StrategyEval,
} from "./types.js";

/**
 * `dca_rotation` — un portefeuille cible se rééquilibre mieux qu'il ne se
 * laisse dériver.
 *
 * C'est la seule stratégie qui ne regarde **pas** le marché : elle ne
 * compares que l'allocation courante à l'allocation cible. Elle n'a donc
 * besoin d'aucune bougie.
 *
 * Un signal de rééquilibrage est marqué `edgeExempt` : le filtre d'edge net
 * ne s'y applique pas, parce que le gain attendu n'est pas un mouvement de
 * prix mais une réduction de la dérive.
 */
export interface DcaRotationParams {
  /** Allocation cible, par symbole ou par mint. Les poids somment à ≤ 1. */
  targetAlloc: Record<string, number>;
  /** Dérive déclenchant un rééquilibrage, en %. */
  driftTriggerPct: number;
  /** Montant maximal ajouté par rééquilibrage, en USD. */
  topupUsdc: number;
}

export const DCA_ROTATION_DEFAULTS: DcaRotationParams = {
  targetAlloc: { SOL: 0.4, USDC: 0.6 },
  driftTriggerPct: 5,
  topupUsdc: 25,
};

export class DcaRotationStrategy implements Strategy {
  readonly name = "dca_rotation";

  /** Aucune donnée de marché requise. */
  readonly requires: DataRequirement[] = [];

  constructor(private readonly params: DcaRotationParams = DCA_ROTATION_DEFAULTS) {}

  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval {
    const signals: Signal[] = [];
    const notes: string[] = [];

    const nav = portfolio.navUsd;
    if (nav <= 0) {
      notes.push("dca_rotation : NAV nul, rien à rééquilibrer");
      return { signals, notes };
    }

    // Valeur courante par actif cible, résolue par symbole puis par mint.
    const current = new Map<string, number>();
    for (const [key, weight] of Object.entries(this.params.targetAlloc)) {
      const mint = resolveMint(key, snapshot);
      if (!mint) {
        notes.push(`dca_rotation : actif cible inconnu (${key})`);
        continue;
      }
      const position = portfolio.positions.find((pos) => pos.mint === mint);
      const value = position?.valueUsd ?? 0;
      current.set(key, value);
      const drift = (value / nav - weight) * 100;
      if (Math.abs(drift) < this.params.driftTriggerPct) {
        notes.push(
          `dca_rotation ${key} : dérive ${drift.toFixed(2)} % sous le seuil ${this.params.driftTriggerPct} %`,
        );
      }
    }

    // Une seule action par évaluation : la plus sous-allouée.
    let bestKey: string | undefined;
    let bestDeficit = 0;
    for (const [key, weight] of Object.entries(this.params.targetAlloc)) {
      const value = current.get(key);
      if (value === undefined) continue;
      const deficit = weight * nav - value;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestKey = key;
      }
    }

    if (bestKey !== undefined && bestDeficit > 0) {
      const mint = resolveMint(bestKey, snapshot);
      if (mint) {
        const amount = Math.min(this.params.topupUsdc, bestDeficit, portfolio.cashUsd * 0.8);
        if (amount >= 0.2) {
          const weight = this.params.targetAlloc[bestKey] ?? 0;
          signals.push({
            assetMint: mint,
            symbol: bestKey,
            side: "buy",
            confidence: 0.5,
            expectedMoveBps: 0,
            ttlMs: 3_600_000,
            reason: `rééquilibrage : ${bestKey} sous-alloué de ${bestDeficit.toFixed(2)} $ (cible ${(weight * 100).toFixed(0)} %)`,
            suggestedSizeUsd: amount,
            allowAdd: true,
            tags: ["rebalance"],
            edgeExempt: true,
          });
          return { signals, notes };
        }
      }
    }

    // À défaut, la cible la plus sur-allouée est allégée.
    let overKey: string | undefined;
    let overExcess = 0;
    for (const [key, weight] of Object.entries(this.params.targetAlloc)) {
      const value = current.get(key);
      if (value === undefined) continue;
      const excess = value - weight * nav;
      if (excess > overExcess) {
        overExcess = excess;
        overKey = key;
      }
    }

    if (overKey !== undefined && overExcess > 0) {
      const mint = resolveMint(overKey, snapshot);
      const position = mint ? portfolio.positions.find((pos) => pos.mint === mint) : undefined;
      if (mint && position && position.valueUsd > 0) {
        const portion = Math.min(1, Math.max(0.1, overExcess / position.valueUsd));
        signals.push({
          assetMint: mint,
          symbol: overKey,
          side: "sell",
          confidence: 0.5,
          expectedMoveBps: 0,
          ttlMs: 3_600_000,
          reason: `rééquilibrage : ${overKey} sur-alloué de ${overExcess.toFixed(2)} $`,
          sellPortion: portion,
          tags: ["rebalance"],
          edgeExempt: true,
        });
      }
    }

    return { signals, notes };
  }
}

/** Résout un symbole cible en mint, via le snapshot de marché. */
function resolveMint(key: string, snapshot: MarketSnapshot): string | undefined {
  if (key === "SOL") return SOL_MINT;
  const upper = key.toUpperCase();
  const bySymbol = snapshot.assets.find((asset) => asset.symbol.toUpperCase() === upper);
  if (bySymbol) return bySymbol.mint;
  return snapshot.assets.find((asset) => asset.mint === key)?.mint;
}
