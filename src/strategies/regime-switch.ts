import type { PortfolioView } from "../portfolio/portfolio.js";
import {
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
  type StrategyEval,
} from "./types.js";

/**
 * `regime_switch` — chaque régime demande une stratégie différente.
 *
 * C'est une **méta-stratégie** : elle ne produit pas de signal propre, elle
 * **délègue** aux stratégies adaptées au régime de chaque actif, puis
 * **filtre** leurs signaux.
 *
 * - en `trending`, on veut de la cassure (suivre le mouvement) ;
 * - en `ranging`, on veut du retour à la moyenne ;
 * - en `idle`, on ne veut **rien** — et c'est une décision, pas une
 *   absence de décision.
 *
 * Le filtrage n'est pas cosmétique : un signal de cassure émis en régime
 * `ranging` n'est pas une cassure, c'est du bruit. C'est exactement ce que
 * la méta-stratégie doit empêcher.
 */
export interface RegimeDelegate {
  strategy: Strategy;
  /** Régimes dans lesquels ce délégué est autorisé à parler. */
  regimes: string[];
}

export class RegimeSwitchStrategy implements Strategy {
  readonly name = "regime_switch";

  /** Les données requises sont celles des délégués (l'union). */
  readonly requires: DataRequirement[];

  constructor(private readonly delegates: RegimeDelegate[]) {
    const seen = new Set<string>();
    const requires: DataRequirement[] = [];
    for (const delegate of delegates) {
      for (const requirement of delegate.strategy.requires) {
        const key = `${requirement.timeframe}:${requirement.bars}`;
        if (seen.has(key)) continue;
        seen.add(key);
        requires.push(requirement);
      }
    }
    this.requires = requires;
  }

  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval {
    const signals: Signal[] = [];
    const notes: string[] = [];

    for (const delegate of this.delegates) {
      const evaluated = delegate.strategy.evaluate(snapshot, portfolio);
      notes.push(...evaluated.notes);

      for (const signal of evaluated.signals) {
        const asset = snapshot.assets.find((a) => a.mint === signal.assetMint);
        const regime = asset?.regime?.regime ?? null;

        if (regime !== null && delegate.regimes.includes(regime)) {
          signals.push({
            ...signal,
            tags: [...(signal.tags ?? []), "regime_switch"],
          });
          continue;
        }

        notes.push(
          `${signal.symbol} : signal ${signal.side} de ${delegate.strategy.name} écarté — régime « ${regime ?? "inconnu"} » hors de ${delegate.regimes.join("/")}`,
        );
      }
    }

    return { signals, notes };
  }
}
