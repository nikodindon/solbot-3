import { describe, expect, it } from "vitest";
import { bucketStart, isClosed, tfMs, ticksToCandleUpdates } from "../../src/market/ohlcv.js";
import type { PriceTick } from "../../src/state/market-data.js";

function tick(tsMs: number, priceUsd: number, volumeDeltaUsd: number | null = null): PriceTick {
  return {
    tsMs,
    mint: "Mint",
    priceUsd,
    liquidityUsd: 1_000_000,
    volumeDeltaUsd,
    src: "discovery",
  };
}

describe("OHLCV", () => {
  it("convertit les timeframes en millisecondes", () => {
    expect(tfMs("1m")).toBe(60_000);
    expect(tfMs("5m")).toBe(300_000);
    expect(tfMs("15m")).toBe(900_000);
    expect(tfMs("1h")).toBe(3_600_000);
  });

  it("aligne un timestamp sur le début de son seau", () => {
    const ts = Date.UTC(2026, 0, 15, 12, 7, 33);
    expect(bucketStart(ts, "5m")).toBe(Date.UTC(2026, 0, 15, 12, 5, 0));
    expect(bucketStart(ts, "15m")).toBe(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(bucketStart(ts, "1h")).toBe(Date.UTC(2026, 0, 15, 12, 0, 0));
  });

  it("produit une bougie dégénérée par tick et par timeframe", () => {
    const updates = ticksToCandleUpdates([tick(1_700_000_000_000, 2.5, 100)], ["5m", "15m"]);
    expect(updates).toHaveLength(2);

    for (const candle of updates) {
      expect(candle.open).toBe(2.5);
      expect(candle.high).toBe(2.5);
      expect(candle.low).toBe(2.5);
      expect(candle.close).toBe(2.5);
      expect(candle.volumeUsd).toBe(100);
      expect(candle.ticks).toBe(1);
    }
  });

  it("range les ticks dans le bon seau", () => {
    const ts = Date.UTC(2026, 0, 15, 12, 7, 33);
    const [candle] = ticksToCandleUpdates([tick(ts, 1)], ["5m"]);
    expect(candle.ts).toBe(Date.UTC(2026, 0, 15, 12, 5, 0));
  });

  it("traite un volume inconnu comme nul", () => {
    const [candle] = ticksToCandleUpdates([tick(1, 1, null)], ["5m"]);
    expect(candle.volumeUsd).toBe(0);
  });

  it("ne considère une bougie comme clôturée qu'après la fin du seau", () => {
    const ts = Date.UTC(2026, 0, 15, 12, 5, 0);
    expect(isClosed(ts, "5m", ts + 299_999)).toBe(false);
    expect(isClosed(ts, "5m", ts + 300_000)).toBe(true);
  });
});
