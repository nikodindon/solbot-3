import { describe, expect, it } from "vitest";
import { classifyRegime, MIN_REGIME_BARS, type RegimeConfig } from "../../src/market/regime.js";
import type { ImportedCandle } from "../../src/state/imported-candles.js";

const CONFIG: RegimeConfig = {
  timeframe: "15m",
  window: 48,
  trendThresholdPct: 4,
  rangeMaxPct: 2.5,
};

/** Fabrique une série de bougies clôturées. */
function series(closes: number[], spread = 0): ImportedCandle[] {
  const start = Date.UTC(2026, 0, 1);
  return closes.map((close, index) => ({
    mint: "Aa",
    tf: "15m" as const,
    ts: start + index * 900_000,
    open: close,
    high: close * (1 + spread),
    low: close * (1 - spread),
    close,
    volumeUsd: 1_000,
    source: "import",
  }));
}

describe("détection de régime", () => {
  it("classe en idle quand l'historique est insuffisant", () => {
    const result = classifyRegime(series([1, 2, 3]), CONFIG);
    expect(result.regime).toBe("idle");
    expect(result.reason).toMatch(/historique insuffisant/);
  });

  it("classe en trending sur une hausse franche", () => {
    const closes = Array.from({ length: 48 }, (_, i) => 1 + i * 0.02); // +94 % sur la fenêtre
    const result = classifyRegime(series(closes), CONFIG);
    expect(result.regime).toBe("trending");
    expect(result.direction).toBe("up");
    expect(result.variationPct).toBeGreaterThan(4);
  });

  it("classe en trending sur une baisse franche", () => {
    const closes = Array.from({ length: 48 }, (_, i) => 2 - i * 0.02);
    const result = classifyRegime(series(closes), CONFIG);
    expect(result.regime).toBe("trending");
    expect(result.direction).toBe("down");
  });

  it("classe en ranging quand l'amplitude est faible", () => {
    const closes = Array.from({ length: 48 }, (_, i) => 1 + Math.sin(i / 3) * 0.002);
    const result = classifyRegime(series(closes, 0.003), CONFIG);
    expect(result.regime).toBe("ranging");
    expect(result.amplitudePct).toBeLessThanOrEqual(2.5);
  });

  it("classe en idle quand ça bouge sans direction et hors fourchette", () => {
    // Variation faible mais amplitude large : du bruit, pas de setup.
    const closes = Array.from({ length: 48 }, (_, i) => 1 + (i % 2 === 0 ? 0.02 : -0.02));
    const result = classifyRegime(series(closes, 0.03), CONFIG);
    expect(result.regime).toBe("idle");
    expect(result.reason).toMatch(/aucun setup/);
  });

  it("est déterministe", () => {
    const closes = Array.from({ length: 48 }, (_, i) => 1 + i * 0.02);
    const a = classifyRegime(series(closes), CONFIG);
    const b = classifyRegime(series(closes), CONFIG);
    expect(a).toEqual(b);
  });

  it("n'utilise que la fenêtre configurée", () => {
    const closes = Array.from({ length: 48 }, (_, i) => 1 + i * 0.02);
    const withOlder = classifyRegime(series([10, ...closes]), CONFIG);
    const withoutOlder = classifyRegime(series(closes), CONFIG);
    expect(withOlder.variationPct).toBeCloseTo(withoutOlder.variationPct, 6);
  });

  it("exige un minimum de bougies", () => {
    expect(MIN_REGIME_BARS).toBe(12);
    const tooShort = classifyRegime(series(Array.from({ length: 11 }, () => 1)), CONFIG);
    expect(tooShort.regime).toBe("idle");
  });
});
