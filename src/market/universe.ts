import type { UniverseConfig } from "../config/schema.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";

/**
 * Construction de l'univers de trading.
 *
 * Deux propriétés sont exigentes :
 * 1. **Stabilité** — le résultat doit être identique d'un run à l'autre
 *    (à univers source égal). Le tri est donc totally déterministe, avec un
 *    tie-break sur le mint.
 * 2. **Explicabilité** — chaque exclusion est comptée par motif, pour que le
 *    rapport de scan dise *pourquoi* l'univers est ce qu'il est.
 */

export interface UniverseCandidate {
  mint: string;
  symbol: string;
  name: string;
  decimals: number | null;
  isVerified: boolean;
  organicScore: number | null;
  liquidityUsd: number | null;
  poolCreatedMs: number | null;
  usdPrice: number | null;
}

export interface UniverseExclusions {
  duplicate: number;
  blacklist: number;
  whitelist: number;
  unverified: number;
  liquidity: number;
  organicScore: number;
  age: number;
}

export interface UniverseResult {
  selected: UniverseCandidate[];
  exclusions: UniverseExclusions;
  /** Candidats retenus avant troncature (la watchlist finale est plus courte). */
  eligible: number;
}

/** Les deux actifs de base sont toujours disponibles : base et gaze. */
export const BASE_ASSETS: { mint: string; symbol: string }[] = [
  { mint: SOL_MINT, symbol: "SOL" },
  { mint: USDC_MINT, symbol: "USDC" },
];

export function emptyExclusions(): UniverseExclusions {
  return {
    duplicate: 0,
    blacklist: 0,
    whitelist: 0,
    unverified: 0,
    liquidity: 0,
    organicScore: 0,
    age: 0,
  };
}

/**
 * Filtre, classe et tronque une liste de candidats.
 *
 * Ordre des filtres (inchangé depuis solbot v1, pour comparer les universality) :
 * doublons → blacklist → whitelist → vérifié → liquidité → organic score → âge.
 */
export function buildUniverse(
  candidates: UniverseCandidate[],
  cfg: UniverseConfig,
  nowMs: number = Date.now(),
): UniverseResult {
  const exclusions = emptyExclusions();
  const seen = new Set<string>();
  const blacklist = new Set(cfg.blacklist_mints);
  const whitelist = new Set(cfg.whitelist_mints);
  const minAgeMs = cfg.min_age_hours * 3_600_000;

  const kept: UniverseCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.mint)) {
      exclusions.duplicate += 1;
      continue;
    }
    seen.add(candidate.mint);

    if (blacklist.has(candidate.mint)) {
      exclusions.blacklist += 1;
      continue;
    }

    // Une whitelist non vide restreint l'univers à elle.
    if (whitelist.size > 0 && !whitelist.has(candidate.mint)) {
      exclusions.whitelist += 1;
      continue;
    }

    if (cfg.verified_only && !candidate.isVerified) {
      exclusions.unverified += 1;
      continue;
    }

    if ((candidate.liquidityUsd ?? 0) < cfg.min_liquidity_usd) {
      exclusions.liquidity += 1;
      continue;
    }

    if ((candidate.organicScore ?? 0) < cfg.min_organic_score) {
      exclusions.organicScore += 1;
      continue;
    }

    // Âge du premier pool. Si l'âge est inconnu, on **ne bloque pas** :
    // une information manquante n'est pas une disqualification.
    if (candidate.poolCreatedMs !== null && nowMs - candidate.poolCreatedMs < minAgeMs) {
      exclusions.age += 1;
      continue;
    }

    kept.push(candidate);
  }

  kept.sort(compareCandidates);

  const selected = kept.slice(0, cfg.max_watchlist);
  return { selected, exclusions, eligible: kept.length };
}

/**
 * Tri déterministe : score organique décroissant, puis liquidité décroissante,
 * puis symbole croissant, puis mint (tie-break final).
 *
 * Le score organique passe avant la liquidité : c'est le filtre anti-volume
 * artificiel, celui qui distingue un actif réellement échangé d'un actif
 * gonflé par un seul acteur.
 */
export function compareCandidates(a: UniverseCandidate, b: UniverseCandidate): number {
  const organic = (b.organicScore ?? 0) - (a.organicScore ?? 0);
  if (organic !== 0) return organic;

  const liquidity = (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0);
  if (liquidity !== 0) return liquidity;

  const symbol = a.symbol.localeCompare(b.symbol, "en");
  if (symbol !== 0) return symbol;

  return a.mint.localeCompare(b.mint, "en");
}
