import type { AllocatorConfig } from "../config/schema.js";

/**
 * L'allocateur.
 *
 * Chaque stratégie active joue en shadow. L'allocateur les classe sur une
 * fenêtre glissante, puis choisit **la stratégie pilote** : celle dont le
 * capital réel est confié.
 *
 * Deux règles protègent contre l'instabilité :
 *
 * 1. **Seuil d'échantillon** (`min_trades_to_score`) : une stratégie qui
 *    n'a pas assez trade n'est **pas** éligible. Sans cela, le winner-take-
 *    all changerait de stratégie à chaque tick, sur du bruit.
 * 2. **Hystérésis** (`hysteresis_pct`) : la stratégie en place n'est
 *    remplacée que si une concurrente la dépasse **relativement** de
 *    `hysteresis_pct`. Sans cela, deux stratégies de performance voisine
 *    s'échangeraient le capital en boucle — le pire comportement possible
 *    pour un portefeuille réel.
 */

export interface ShadowScore {
  name: string;
  /** Performance sur la fenêtre, en % (peut être négative). */
  scorePct: number;
  /** Nombre de trades sur la fenêtre. */
  trades: number;
  /** NAV au début et à la fin de la fenêtre. */
  startNav: number;
  endNav: number;
  /** Max drawdown de la fenêtre, en % (0 si non calculable). */
  maxDrawdownPct: number;
  /** Assez de trades pour être éligible ? */
  eligible: boolean;
  /** Raison de l'inéligibilité, le cas échéant. */
  reason: string | null;
}

export interface AllocationDecision {
  /** Stratégie qui pilote le capital réel (null si aucune n'est éligible). */
  pilot: string | null;
  /** Stratégie précédente, pour le journal. */
  previousPilot: string | null;
  /** La pilot a-t-elle changé à ce tick ? */
  changed: boolean;
  /** Scores de toutes les stratégies, pour le dashboard. */
  scores: ShadowScore[];
  /** Raison du choix, journalisée telle quelle. */
  reason: string;
}

/**
 * Calcule le score d'un shadow sur la fenêtre.
 *
 * Le score est la **performance en %** sur la fenêtre. C'est une mesure
 * simple et explicable : elle se compare directement entre stratégies, et
 * elle est stable quand le nombre de points de NAV est faible.
 */
export function scoreShadow(
  name: string,
  navSeries: { tsMs: number; navUsd: number }[],
  trades: number,
  minTrades: number,
): ShadowScore {
  if (navSeries.length === 0) {
    return {
      name,
      scorePct: 0,
      trades,
      startNav: 0,
      endNav: 0,
      maxDrawdownPct: 0,
      eligible: false,
      reason: "aucun point de NAV",
    };
  }

  const startNav = navSeries[0]?.navUsd ?? 0;
  const endNav = navSeries[navSeries.length - 1]?.navUsd ?? 0;
  const scorePct = startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0;

  if (trades < minTrades) {
    return {
      name,
      scorePct,
      trades,
      startNav,
      endNav,
      maxDrawdownPct: maxDrawdown(navSeries),
      eligible: false,
      reason: `${trades} trade(s) < ${minTrades} requis`,
    };
  }

  return {
    name,
    scorePct,
    trades,
    startNav,
    endNav,
    maxDrawdownPct: maxDrawdown(navSeries),
    eligible: true,
    reason: null,
  };
}

/** Drawdown maximal de la série, en %. */
export function maxDrawdown(navSeries: { navUsd: number }[]): number {
  let peak = navSeries[0]?.navUsd ?? 0;
  let worst = 0;
  for (const point of navSeries) {
    if (point.navUsd > peak) peak = point.navUsd;
    if (peak > 0) {
      const dd = ((peak - point.navUsd) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Choisit la stratégie pilote.
 *
 * La règle d'hystérésis est **relative** : le challenger doit faire
 * `pilot × (1 + hysteresis)` — ce qui fonctionne aussi quand les scores
 * sont négatifs, là où une comparaison en points absolus bloquerait tout
 * remplacement dès que la pilote est sous zéro.
 */
export function choosePilot(
  scores: ShadowScore[],
  currentPilot: string | null,
  hysteresisPct: number,
): AllocationDecision {
  // Une seule stratégie active : il n'y a rien à comparer.
  //
  // Le seuil d'échantillon sert à **arbitrer entre plusieurs candidats**,
  // pas à interdire de trader. L'appliquer à une stratégie unique
  // condamnerait le portefeuille à l'inaction pendant des semaines, le
  // temps que le shadow accumule assez de trades.
  if (scores.length === 1) {
    const only = scores[0];
    if (!only) {
      return {
        pilot: null,
        previousPilot: currentPilot,
        changed: false,
        scores,
        reason: "aucune stratégie",
      };
    }
    return {
      pilot: only.name,
      previousPilot: currentPilot,
      changed: currentPilot !== only.name,
      scores,
      reason: `stratégie unique : ${only.name} pilote`,
    };
  }

  const eligible = scores.filter((score) => score.eligible);

  if (eligible.length === 0) {
    return {
      pilot: null,
      previousPilot: currentPilot,
      changed: false,
      scores,
      reason: "aucune stratégie éligible (échantillon insuffisant)",
    };
  }

  const sorted = [...eligible].sort((a, b) => b.scorePct - a.scorePct);
  const best = sorted[0];
  if (!best) {
    return {
      pilot: null,
      previousPilot: currentPilot,
      changed: false,
      scores,
      reason: "aucune stratégie éligible",
    };
  }

  // Pas de pilote en place : on prend la meilleure.
  if (currentPilot === null) {
    return {
      pilot: best.name,
      previousPilot: null,
      changed: true,
      scores,
      reason: `${best.name} devient pilote (${best.scorePct.toFixed(2)} %, ${best.trades} trades)`,
    };
  }

  const current = eligible.find((score) => score.name === currentPilot);

  // La pilote en place n'est plus éligible (échantillon insuffisant) : on
  // la remplace, sans condition d'hystérésis — il n'y a rien à protéger.
  if (!current) {
    return {
      pilot: best.name,
      previousPilot: currentPilot,
      changed: true,
      scores,
      reason: `${currentPilot} n'est plus éligible — ${best.name} prend le relais (${best.scorePct.toFixed(2)} %)`,
    };
  }

  // La challenger doit battre la pilote **relativement** de `hysteresisPct`.
  const threshold = current.scorePct * (1 + hysteresisPct / 100);
  if (best.scorePct > threshold) {
    return {
      pilot: best.name,
      previousPilot: currentPilot,
      changed: true,
      scores,
      reason: `${best.name} (${best.scorePct.toFixed(2)} %) dépasse ${currentPilot} (${current.scorePct.toFixed(2)} %) de plus de ${hysteresisPct} %`,
    };
  }

  return {
    pilot: currentPilot,
    previousPilot: currentPilot,
    changed: false,
    scores,
    reason: `${currentPilot} reste pilote (${current.scorePct.toFixed(2)} % — ${best.name} à ${best.scorePct.toFixed(2)} %, hystérésis ${hysteresisPct} %)`,
  };
}

/** Configuration effective de l'allocateur. */
export function allocatorDefaults(cfg: AllocatorConfig): AllocatorConfig {
  return cfg;
}
