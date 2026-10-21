import type { Timeframe } from "../config/schema.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import { clamp } from "./indicators.js";
import {
  type DataRequirement,
  type MarketSnapshot,
  type Signal,
  type Strategy,
  type StrategyEval,
} from "./types.js";

/**
 * `relative_strength` — les actifs les plus forts sur 24 h restent forts
 * quelques heures.
 *
 * C'est une stratégie **cross-sectionnelle** : elle ne compare pas un actif
 * à son propre passé, elle le compare à **ses pairs**. Le classement est
 * fait sur l'ensemble de l'univers, ce qui la rend complémentaire des
 * stratégies absolues (tendance, retour à la moyenne).
 *
 * Sur un univers de tokens très dispersés, cette approche peut être plus
 * robuste qu'une condition absolue : elle exploite la **dispersion** plutôt
 * que le niveau de prix.
 */
export interface RelativeStrengthParams {
  /** Fenêtre de classement, en heures. */
  lookbackH: number;
  /** Nombre d'actifs retenus en tête de classement. */
  topN: number;
  /** Période de rééquilibrage, en heures. */
  rebalanceH: number;
}

export const RELATIVE_STRENGTH_DEFAULTS: RelativeStrengthParams = {
  lookbackH: 24,
  topN: 3,
  rebalanceH: 6,
};

export class RelativeStrengthStrategy implements Strategy {
  readonly name = "relative_strength";

  readonly requires: DataRequirement[];

  constructor(
    private readonly params: RelativeStrengthParams = RELATIVE_STRENGTH_DEFAULTS,
    private readonly timeframe: Timeframe = "1h",
  ) {
    // Il faut 1 h de bougies pour une fenêtre de 24 h.
    this.requires = [{ timeframe, bars: 24 }];
  }

  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval {
    const signals: Signal[] = [];
    const notes: string[] = [];
    const p = this.params;

    // ── Classement cross-sectionnel ──────────────────────────────────────
    const ranked = snapshot.assets
      .map((asset) => {
        const closes = asset.candles[this.timeframe] ?? [];
        if (closes.length < 2) return null;
        const lookback = Math.min(closes.length, p.lookbackH);
        const slice = closes.slice(-lookback);
        const first = slice[0];
        const last = slice[slice.length - 1];
        if (!first || !last || first.close <= 0) return null;
        const changePct = ((last.close - first.close) / first.close) * 100;
        return { asset, changePct, bars: slice.length };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => b.changePct - a.changePct);

    if (ranked.length === 0) {
      notes.push("relative_strength : pas assez d'historique pour classer l'univers");
      return { signals, notes };
    }

    const leaders = ranked.slice(0, Math.min(p.topN, ranked.length));
    const median = ranked[Math.floor(ranked.length / 2)]?.changePct ?? 0;

    notes.push(
      `relative_strength : top ${leaders.length}/${ranked.length} — ${leaders
        .map(
          (leader) =>
            `${leader.asset.symbol} ${leader.changePct >= 0 ? "+" : ""}${leader.changePct.toFixed(1)} %`,
        )
        .join(", ")} (médiane ${median.toFixed(1)} %)`,
    );

    // ── Signal d'entrée sur les chefs de file ───────────────────────────
    for (const leader of leaders) {
      if (leader.changePct <= 0) continue;

      const position = portfolio.positions.find((pos) => pos.mint === leader.asset.mint);
      if (position) {
        notes.push(
          `${leader.asset.symbol} : déjà en position (${leader.changePct.toFixed(1)} % sur ${p.lookbackH} h)`,
        );
        continue;
      }

      // L'edge annoncé est la **prime** sur la médiane de l'univers : c'est
      // le gain relatif qu'on parie, pas le mouvement absolu.
      const expectedMoveBps = (leader.changePct - median) * 100;

      signals.push({
        assetMint: leader.asset.mint,
        symbol: leader.asset.symbol,
        side: "buy",
        confidence: clamp(0.4 + (leader.changePct - median) / 200, 0, 0.85),
        expectedMoveBps,
        ttlMs: 3_600_000,
        reason: `force relative : +${leader.changePct.toFixed(1)} % sur ${p.lookbackH} h, +${(leader.changePct - median).toFixed(1)} % de prime sur la médiane de l'univers`,
        stopLossPct: 8,
        tags: ["cross-sectional", "regime:trending"],
      });
    }

    return { signals, notes };
  }
}
