import type { TokenCategory, TokenInfo } from "../jupiter/tokens.js";
import { buildUniverse, BASE_ASSETS, type UniverseCandidate } from "../market/universe.js";
import { replaceWatchlist, type WatchlistItem } from "../state/market-data.js";
import { blank, heading, info, note, ok, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface ScanOptions {
  /** Limite le nombre d'actifs affichés (la watchlist complète est toujours écrite). */
  top?: number;
  root?: string;
}

/**
 * Construit la watchlist et l'enregistre.
 *
 * Le résultat est **stable** : à univers source égal, deux scans successifs
 * produisent la même liste. C'est la propriété qui rend le backtest
 * reproductible.
 */
export async function runScan(options: ScanOptions = {}): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  try {
    const { config } = runtime;
    const universeCfg = config.universe;

    const candidates = await fetchCandidates(runtime, universeCfg.source, universeCfg.interval);

    if (candidates.length === 0) {
      warn("aucun candidat renvoyé par l'API Tokens v2");
      return;
    }

    const result = buildUniverse(candidates, universeCfg);

    // Les actifs de base sont toujours en tête : le moteur a besoin de SOL
    // (base de valorisation, frais) et d'USDC (devise de référence).
    const base = BASE_ASSETS.map((asset) => ({
      mint: asset.mint,
      symbol: asset.symbol,
      name: asset.symbol,
      decimals: null,
      isVerified: true,
      organicScore: 100,
      liquidityUsd: Number.POSITIVE_INFINITY,
      poolCreatedMs: 0,
      usdPrice: null,
    }));

    const merged = [...base, ...result.selected];
    const items: WatchlistItem[] = merged.map((candidate, index) => ({
      mint: candidate.mint,
      symbol: candidate.symbol,
      rank: index,
      active: true,
    }));
    replaceWatchlist(runtime.db, items);

    heading(`solbot3 scan — univers (${universeCfg.source}/${universeCfg.interval})`);
    ok(
      `${items.length} actifs dans la watchlist`,
      `${result.eligible} éligibles avant troncature (max ${universeCfg.max_watchlist})`,
    );
    blank();

    const limit = Math.min(options.top ?? items.length, items.length);
    for (const item of items.slice(0, limit)) {
      const candidate = merged[item.rank];
      info(
        `#${String(item.rank).padStart(2, "0")} ${item.symbol.padEnd(12)}`,
        `liq ${fmtUsd(candidate.liquidityUsd)} · organic ${fmtScore(candidate.organicScore)} · ${item.mint.slice(0, 6)}…`,
      );
    }
    if (limit < items.length) {
      note(`… et ${items.length - limit} autres (watchlist complète en base)`);
    }

    blank();
    const ex = result.exclusions;
    note(
      `exclusions — doublons ${ex.duplicate} · blacklist ${ex.blacklist} · hors whitelist ${ex.whitelist} · non vérifiés ${ex.unverified} · liquidité ${ex.liquidity} · organic ${ex.organicScore} · âge ${ex.age}`,
    );
    blank();
  } finally {
    closeRuntime(runtime);
  }
}

async function fetchCandidates(
  runtime: ReturnType<typeof createRuntime>,
  source: string,
  interval: string,
): Promise<UniverseCandidate[]> {
  const cfg = runtime.config.universe;

  let tokens: TokenInfo[];
  if (source === "whitelist") {
    tokens = cfg.whitelist_mints.length
      ? [...(await runtime.tokensApi.searchMints(cfg.whitelist_mints)).values()]
      : [];
  } else {
    tokens = await runtime.tokensApi.byCategory(
      source as TokenCategory,
      interval as "5m" | "1h" | "6h" | "24h",
      cfg.candidate_limit,
    );
  }

  return tokens.map(toCandidate);
}

function toCandidate(token: TokenInfo): UniverseCandidate {
  return {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    isVerified: token.isVerified,
    organicScore: token.organicScore,
    liquidityUsd: token.liquidityUsd,
    poolCreatedMs: token.poolCreatedMs,
    usdPrice: token.usdPrice,
  };
}

function fmtUsd(value: number | null): string {
  if (value === null) return "n/d";
  if (!Number.isFinite(value)) return "∞";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M$`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k$`;
  return `${value.toFixed(0)}$`;
}

function fmtScore(value: number | null): string {
  return value === null ? "n/d" : value.toFixed(0);
}
