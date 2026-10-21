import { describe, expect, it } from "vitest";
import type { UniverseConfig } from "../../src/config/schema.js";
import {
  buildUniverse,
  compareCandidates,
  type UniverseCandidate,
} from "../../src/market/universe.js";

const CONFIG: UniverseConfig = {
  source: "toptraded",
  interval: "24h",
  candidate_limit: 100,
  verified_only: true,
  min_liquidity_usd: 250_000,
  min_organic_score: 60,
  min_age_hours: 24,
  blacklist_mints: [],
  whitelist_mints: [],
  max_watchlist: 40,
};

const NOW = Date.UTC(2026, 0, 15);

function candidate(partial: Partial<UniverseCandidate> & { mint: string }): UniverseCandidate {
  return {
    symbol: partial.mint.slice(0, 4),
    name: "token",
    decimals: 6,
    isVerified: true,
    organicScore: 90,
    liquidityUsd: 1_000_000,
    poolCreatedMs: NOW - 48 * 3_600_000,
    usdPrice: 1,
    ...partial,
  };
}

describe("univers", () => {
  it("retient un candidat conforme", () => {
    const result = buildUniverse([candidate({ mint: "Aa" })], CONFIG, NOW);
    expect(result.selected).toHaveLength(1);
    expect(result.eligible).toBe(1);
  });

  it("écarte les doublons", () => {
    const result = buildUniverse(
      [candidate({ mint: "Aa" }), candidate({ mint: "Aa" })],
      CONFIG,
      NOW,
    );
    expect(result.selected).toHaveLength(1);
    expect(result.exclusions.duplicate).toBe(1);
  });

  it("applique la blacklist", () => {
    const result = buildUniverse(
      [candidate({ mint: "Aa" })],
      {
        ...CONFIG,
        blacklist_mints: ["Aa"],
      },
      NOW,
    );
    expect(result.selected).toHaveLength(0);
    expect(result.exclusions.blacklist).toBe(1);
  });

  it("restreint à la whitelist quand elle est renseignée", () => {
    const result = buildUniverse(
      [candidate({ mint: "Aa" }), candidate({ mint: "Bb" })],
      { ...CONFIG, whitelist_mints: ["Aa"] },
      NOW,
    );
    expect(result.selected.map((c) => c.mint)).toEqual(["Aa"]);
    expect(result.exclusions.whitelist).toBe(1);
  });

  it("écarte les tokens non vérifiés", () => {
    const result = buildUniverse([candidate({ mint: "Aa", isVerified: false })], CONFIG, NOW);
    expect(result.selected).toHaveLength(0);
    expect(result.exclusions.unverified).toBe(1);
  });

  it("écarte les tokens trop peu liquides", () => {
    const result = buildUniverse([candidate({ mint: "Aa", liquidityUsd: 1_000 })], CONFIG, NOW);
    expect(result.exclusions.liquidity).toBe(1);
  });

  it("écarte les tokens sous le seuil de volume organique", () => {
    const result = buildUniverse([candidate({ mint: "Aa", organicScore: 10 })], CONFIG, NOW);
    expect(result.exclusions.organicScore).toBe(1);
  });

  it("écarte les tokens trop récents", () => {
    const result = buildUniverse(
      [candidate({ mint: "Aa", poolCreatedMs: NOW - 2 * 3_600_000 })],
      CONFIG,
      NOW,
    );
    expect(result.exclusions.age).toBe(1);
  });

  it("ne bloque pas sur un âge inconnu", () => {
    const result = buildUniverse([candidate({ mint: "Aa", poolCreatedMs: null })], CONFIG, NOW);
    expect(result.selected).toHaveLength(1);
    expect(result.exclusions.age).toBe(0);
  });

  it("tranche au max_watchlist", () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      candidate({ mint: `Mint${i.toString().padStart(3, "0")}` }),
    );
    const result = buildUniverse(candidates, { ...CONFIG, max_watchlist: 10 }, NOW);
    expect(result.selected).toHaveLength(10);
    expect(result.eligible).toBe(50);
  });

  it("produit une liste stable d'un run à l'autre", () => {
    const candidates = [
      candidate({ mint: "Bbb", organicScore: 90, liquidityUsd: 5_000_000 }),
      candidate({ mint: "Aaa", organicScore: 90, liquidityUsd: 5_000_000 }),
      candidate({ mint: "Ccc", organicScore: 95, liquidityUsd: 1_000_000 }),
      candidate({ mint: "Ddd", organicScore: 90, liquidityUsd: 5_000_000 }),
    ];

    const first = buildUniverse(candidates, CONFIG, NOW).selected.map((c) => c.mint);
    // Les entrées sont permutées : le résultat doit être identique.
    const second = buildUniverse([...candidates].reverse(), CONFIG, NOW).selected.map(
      (c) => c.mint,
    );

    expect(first).toEqual(second);
    expect(first[0]).toBe("Ccc"); // meilleur score organique d'abord
  });

  it("départage à score égal par liquidité, puis symbole, puis mint", () => {
    const a = candidate({ mint: "Zzz", symbol: "ZZZ", organicScore: 90, liquidityUsd: 5_000_000 });
    const b = candidate({ mint: "Aaa", symbol: "AAA", organicScore: 90, liquidityUsd: 5_000_000 });
    const c = candidate({ mint: "Mmm", symbol: "MMM", organicScore: 90, liquidityUsd: 9_000_000 });

    const sorted = [a, b, c].sort(compareCandidates);
    expect(sorted.map((x) => x.symbol)).toEqual(["MMM", "AAA", "ZZZ"]);
  });
});
