import { describe, expect, it } from "vitest";
import { Poller, type PriceFetcher, type TokenFetcher } from "../../src/market/poller.js";
import type { TokenInfo } from "../../src/jupiter/tokens.js";
import { closeDb, openDb } from "../../src/state/db.js";
import {
  countCandles,
  countTicks,
  latestTick,
  replaceWatchlist,
} from "../../src/state/market-data.js";
import { migrate } from "../../src/state/migrations.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function token(partial: Partial<TokenInfo> & { mint: string }): TokenInfo {
  return {
    symbol: partial.mint.slice(0, 4),
    name: "token",
    decimals: 6,
    isVerified: true,
    organicScore: 90,
    usdPrice: 1,
    liquidityUsd: 1_000_000,
    poolCreatedMs: null,
    createdAtMs: null,
    volume24hUsd: null,
    tags: [],
    topHoldersPct: null,
    ...partial,
  };
}

describe("poller", () => {
  it("collecte les prix, trace l'origine et agrège les bougies", async () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      replaceWatchlist(db, [{ mint: "Aa", symbol: "AAA", rank: 0, active: true }]);

      const priceApi: PriceFetcher = {
        refresh: () =>
          Promise.resolve(
            new Map([
              ["Aa", { mint: "Aa", usdPrice: 2, liquidity: 500_000 }],
              [SOL, { mint: SOL, usdPrice: 100 }],
              [USDC, { mint: USDC, usdPrice: 1 }],
            ]),
          ),
      };
      const tokensApi: TokenFetcher = {
        searchMints: () =>
          Promise.resolve(new Map([["Aa", token({ mint: "Aa", volume24hUsd: 1_000 })]])),
      };

      const poller = new Poller({ db, priceApi, tokensApi, timeframes: ["5m", "15m"] });
      const result = await poller.pollOnce(1_700_000_000_000);

      expect(result.ok).toBe(true);
      expect(result.prices.size).toBe(3);
      expect(result.volumesKnown).toBe(true);

      // 3 mints × 2 timeframes = 6 bougies
      expect(countCandles(db, "Aa", "5m")).toBe(1);
      expect(countCandles(db, "Aa", "15m")).toBe(1);
      expect(countTicks(db)).toBe(3);

      const tick = latestTick(db, "Aa");
      expect(tick?.src).toBe("discovery");
      expect(tick?.priceUsd).toBe(2);
      expect(tick?.liquidityUsd).toBe(500_000);
    } finally {
      closeDb(db);
    }
  });

  it("calcule le volume écoulé depuis le tick précédent", async () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      replaceWatchlist(db, [{ mint: "Aa", symbol: "AAA", rank: 0, active: true }]);

      let volume = 1_000;
      const tokensApi: TokenFetcher = {
        searchMints: () =>
          Promise.resolve(new Map([["Aa", token({ mint: "Aa", volume24hUsd: volume })]])),
      };
      const priceApi: PriceFetcher = {
        refresh: () => Promise.resolve(new Map([["Aa", { mint: "Aa", usdPrice: 2 }]])),
      };

      const poller = new Poller({ db, priceApi, tokensApi, timeframes: ["5m"] });

      // Premier tick : pas de référence, donc pas de delta.
      await poller.pollOnce(1_000);
      expect(latestTick(db, "Aa")?.volumeDeltaUsd).toBeNull();

      // Second tick : le volume 24 h a monté de 400.
      volume = 1_400;
      await poller.pollOnce(2_000);
      expect(latestTick(db, "Aa")?.volumeDeltaUsd).toBe(400);
    } finally {
      closeDb(db);
    }
  });

  it("ne perd pas le tick quand les métadonnées sont inaccessibles", async () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      replaceWatchlist(db, [{ mint: "Aa", symbol: "AAA", rank: 0, active: true }]);

      const priceApi: PriceFetcher = {
        refresh: () => Promise.resolve(new Map([["Aa", { mint: "Aa", usdPrice: 2 }]])),
      };
      const tokensApi: TokenFetcher = {
        searchMints: () => {
          throw new Error("tokens v2 indisponible");
        },
      };

      const poller = new Poller({ db, priceApi, tokensApi, timeframes: ["5m"] });
      const result = await poller.pollOnce(1_000);

      expect(result.ok).toBe(true);
      expect(result.volumesKnown).toBe(false);
      expect(countTicks(db)).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("échoue proprement quand Price v3 ne renvoie rien", async () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      const priceApi: PriceFetcher = { refresh: () => Promise.resolve(new Map()) };
      const tokensApi: TokenFetcher = { searchMints: () => Promise.resolve(new Map()) };

      const poller = new Poller({ db, priceApi, tokensApi, timeframes: ["5m"] });
      const result = await poller.pollOnce(1_000);

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(countTicks(db)).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  it("suit toujours SOL et USDC, même avec une watchlist vide", async () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    try {
      const requested: string[][] = [];
      const priceApi: PriceFetcher = {
        refresh: (mints) => {
          requested.push(mints);
          return Promise.resolve(new Map());
        },
      };
      const tokensApi: TokenFetcher = { searchMints: () => Promise.resolve(new Map()) };

      const poller = new Poller({ db, priceApi, tokensApi, timeframes: ["5m"] });
      await poller.pollOnce(1_000);

      expect(requested[0]).toContain(SOL);
      expect(requested[0]).toContain(USDC);
    } finally {
      closeDb(db);
    }
  });
});
