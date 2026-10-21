import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "../../src/state/db.js";
import {
  candleCoverage,
  countCandles,
  countTicks,
  insertTicks,
  latestDiscoveryTick,
  listCandles,
  listWatchlist,
  listWatchlistMints,
  replaceWatchlist,
  upsertCandles,
  upsertTokenMeta,
  knownVolumes24h,
  type Candle,
  type PriceTick,
} from "../../src/state/market-data.js";
import { migrate } from "../../src/state/migrations.js";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

function tick(
  partial: Partial<PriceTick> & { mint: string; tsMs: number; priceUsd: number },
): PriceTick {
  return {
    liquidityUsd: 1_000_000,
    volumeDeltaUsd: null,
    src: "discovery",
    ...partial,
  };
}

describe("données de marché", () => {
  it("insère les ticks et les relit", () => {
    const db = makeDb();
    try {
      insertTicks(db, [tick({ mint: "Aa", tsMs: 1000, priceUsd: 2 })]);
      expect(countTicks(db)).toBe(1);

      const latest = latestDiscoveryTick(db, "Aa");
      expect(latest?.priceUsd).toBe(2);
      expect(latest?.src).toBe("discovery");
    } finally {
      closeDb(db);
    }
  });

  it("est idempotent sur (ts, mint)", () => {
    const db = makeDb();
    try {
      insertTicks(db, [tick({ mint: "Aa", tsMs: 1000, priceUsd: 2 })]);
      insertTicks(db, [tick({ mint: "Aa", tsMs: 1000, priceUsd: 3 })]);
      expect(countTicks(db)).toBe(1);
      expect(latestDiscoveryTick(db, "Aa")?.priceUsd).toBe(3);
    } finally {
      closeDb(db);
    }
  });

  it("agrège les bougies : open figé, high/low élargis, close mis à jour, volume cumulé", () => {
    const db = makeDb();
    try {
      const base: Omit<Candle, "open" | "high" | "low" | "close" | "volumeUsd" | "ticks"> = {
        mint: "Aa",
        tf: "5m",
        ts: 0,
      };

      upsertCandles(db, [
        { ...base, open: 10, high: 10, low: 10, close: 10, volumeUsd: 100, ticks: 1 },
      ]);
      upsertCandles(db, [
        { ...base, open: 12, high: 12, low: 12, close: 12, volumeUsd: 50, ticks: 1 },
      ]);
      upsertCandles(db, [{ ...base, open: 8, high: 8, low: 8, close: 8, volumeUsd: 25, ticks: 1 }]);

      const [candle] = listCandles(db, "Aa", "5m");
      expect(candle.open).toBe(10); // premier tick conservé
      expect(candle.high).toBe(12); // maximum
      expect(candle.low).toBe(8); // minimum
      expect(candle.close).toBe(8); // dernier tick
      expect(candle.volumeUsd).toBe(175); // somme
      expect(candle.ticks).toBe(3);
      expect(countCandles(db, "Aa", "5m")).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  it("remplace la watchlist sans reliquat", () => {
    const db = makeDb();
    try {
      replaceWatchlist(db, [
        { mint: "Aa", symbol: "AAA", rank: 0, active: true },
        { mint: "Bb", symbol: "BBB", rank: 1, active: true },
      ]);
      expect(listWatchlistMints(db)).toEqual(["Aa", "Bb"]);

      replaceWatchlist(db, [{ mint: "Cc", symbol: "CCC", rank: 0, active: true }]);
      expect(listWatchlist(db)).toHaveLength(1);
      expect(listWatchlistMints(db)).toEqual(["Cc"]);
    } finally {
      closeDb(db);
    }
  });

  it("conserve le volume 24 h pour le calcul du volume écoulé", () => {
    const db = makeDb();
    try {
      upsertTokenMeta(
        db,
        [
          {
            mint: "Aa",
            symbol: "AAA",
            name: "A",
            decimals: 6,
            isVerified: true,
            organicScore: 90,
            usdPrice: 1,
            liquidityUsd: 1_000_000,
            poolCreatedMs: null,
            createdAtMs: null,
            volume24hUsd: 1_000,
            tags: [],
            topHoldersPct: null,
          },
        ],
        1000,
      );

      expect(knownVolumes24h(db, ["Aa"]).get("Aa")).toBe(1_000);
    } finally {
      closeDb(db);
    }
  });

  it("expose la couverture des bougies par timeframe", () => {
    const db = makeDb();
    try {
      upsertCandles(db, [
        { mint: "Aa", tf: "5m", ts: 0, open: 1, high: 1, low: 1, close: 1, volumeUsd: 0, ticks: 1 },
        { mint: "Bb", tf: "5m", ts: 0, open: 1, high: 1, low: 1, close: 1, volumeUsd: 0, ticks: 1 },
      ]);
      const coverage = candleCoverage(db);
      expect(coverage).toHaveLength(1);
      expect(coverage[0]).toMatchObject({ tf: "5m", mints: 2, candles: 2 });
    } finally {
      closeDb(db);
    }
  });
});
