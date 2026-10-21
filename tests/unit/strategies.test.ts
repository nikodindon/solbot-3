import { describe, expect, it } from "vitest";
import { SOL_MINT } from "../../src/constants.js";
import type { PortfolioView } from "../../src/portfolio/portfolio.js";
import { DcaRotationStrategy } from "../../src/strategies/dca-rotation.js";
import { GridStrategy } from "../../src/strategies/grid.js";
import { MeanReversionStrategy } from "../../src/strategies/mean-reversion.js";
import { TrendBreakoutStrategy } from "../../src/strategies/trend-breakout.js";
import type { AssetSnapshot } from "../../src/strategies/types.js";

/**
 * Fabrique une série de bougies clôturées, disposées sous les timeframes
 * attendus par les stratégies testées (15 m et 1 h).
 */
function candles(
  closes: number[],
  options: { high?: number; low?: number; volume?: number } = {},
): AssetSnapshot["candles"] {
  const start = Date.UTC(2026, 0, 1);
  const list = closes.map((close, index) => ({
    mint: "Aa",
    tf: "15m" as const,
    ts: start + index * 900_000,
    open: close,
    high: options.high ?? close,
    low: options.low ?? close,
    close,
    volumeUsd: options.volume ?? 1_000,
    source: "import" as const,
  }));
  return { "15m": list, "1h": list };
}

function asset(partial: Partial<AssetSnapshot> & { mint: string }): AssetSnapshot {
  return {
    symbol: partial.mint.slice(0, 4),
    priceUsd: 1,
    liquidityUsd: 1_000_000,
    candles: {},
    ...partial,
  };
}

const EMPTY_PORTFOLIO: PortfolioView = {
  navUsd: 1000,
  cashUsd: 1000,
  positions: [],
  unrealizedPnlUsd: 0,
};

/** Portefeuille avec une position ouverte sur `Aa`. */
const WITH_POSITION: PortfolioView = {
  ...EMPTY_PORTFOLIO,
  navUsd: 1180,
  positions: [
    {
      mint: "Aa",
      symbol: "AAA",
      qty: 100,
      avgEntryUsd: 1.5,
      valueUsd: 180,
      unrealizedPnlUsd: 30,
      unrealizedPnlPct: 20,
      stopLossUsd: null,
      takeProfitUsd: null,
      peakPriceUsd: null,
      ageMs: 1000,
    },
  ],
};

describe("trend_breakout", () => {
  /** Paramètres laxistes : on isole la logique de cassure des autres filtres. */
  const LAX = {
    emaFast: 12,
    emaSlow: 26,
    breakoutLookback: 20,
    rsiPeriod: 14,
    rsiMax: 100,
    volumeMult: 0,
    atrStopMult: 2,
  };

  it("ne produit rien sans historique suffisant", () => {
    const strategy = new TrendBreakoutStrategy(LAX);
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", candles: candles([1, 2]) })] },
      EMPTY_PORTFOLIO,
    );
    expect(result.signals).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/historique insuffisant/);
  });

  it("n'achète pas sans cassure", () => {
    const strategy = new TrendBreakoutStrategy(LAX);
    const closes = Array.from({ length: 40 }, (_, i) => 1 + i * 0.005);
    // Le prix est **sous** le plus haut des 20 dernières bougies : pas de cassure.
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 1.1, candles: candles(closes) })] },
      EMPTY_PORTFOLIO,
    );
    expect(result.signals.filter((s) => s.side === "buy")).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/pas de cassure/);
  });

  it("achète sur une cassure confirmée", () => {
    const strategy = new TrendBreakoutStrategy(LAX);
    const closes = Array.from({ length: 40 }, (_, i) => 1 + i * 0.005);
    const priorHigh = Math.max(...closes.slice(-21, -1));
    const result = strategy.evaluate(
      {
        tsMs: 0,
        assets: [asset({ mint: "Aa", priceUsd: priorHigh * 1.05, candles: candles(closes) })],
      },
      EMPTY_PORTFOLIO,
    );

    const buys = result.signals.filter((s) => s.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.expectedMoveBps).toBeGreaterThan(0);
    expect(buys[0]?.stopLossPct).toBeGreaterThan(0);
    expect(buys[0]?.reason).toMatch(/cassure/);
  });

  it("bloque l'entrée quand le RSI est trop élevé", () => {
    const strategy = new TrendBreakoutStrategy({ ...LAX, rsiMax: 68 });
    const closes = Array.from({ length: 40 }, (_, i) => 1 + i * 0.005);
    const priorHigh = Math.max(...closes.slice(-21, -1));
    const result = strategy.evaluate(
      {
        tsMs: 0,
        assets: [asset({ mint: "Aa", priceUsd: priorHigh * 1.05, candles: candles(closes) })],
      },
      EMPTY_PORTFOLIO,
    );
    expect(result.signals.filter((s) => s.side === "buy")).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/RSI/);
  });

  it("bloque l'entrée quand le volume est insuffisant", () => {
    const strategy = new TrendBreakoutStrategy({ ...LAX, volumeMult: 5 });
    const closes = Array.from({ length: 40 }, (_, i) => 1 + i * 0.005);
    const priorHigh = Math.max(...closes.slice(-21, -1));
    const result = strategy.evaluate(
      {
        tsMs: 0,
        assets: [asset({ mint: "Aa", priceUsd: priorHigh * 1.05, candles: candles(closes) })],
      },
      EMPTY_PORTFOLIO,
    );
    expect(result.signals.filter((s) => s.side === "buy")).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/volume insuffisant/);
  });

  it("vend quand la tendance s'inverse", () => {
    const strategy = new TrendBreakoutStrategy(LAX);
    const falls = Array.from({ length: 40 }, (_, i) => 2 - i * 0.01);
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 1.8, candles: candles(falls) })] },
      WITH_POSITION,
    );
    expect(result.signals.filter((s) => s.side === "sell")).toHaveLength(1);
  });
});

describe("mean_reversion", () => {
  it("n'achète pas sans historique suffisant", () => {
    const strategy = new MeanReversionStrategy({ window: 96, zEntry: 2, zExit: 0.5 });
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", candles: candles([1, 2, 3]) })] },
      EMPTY_PORTFOLIO,
    );
    expect(result.signals).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/historique insuffisant/);
  });

  it("achète sur un écart extrême à la moyenne", () => {
    const strategy = new MeanReversionStrategy({ window: 20, zEntry: 2, zExit: 0.5 });
    const closes = Array.from({ length: 20 }, (_, i) => 10 + Math.sin(i) * 0.01);
    closes.push(5); // écart brutal
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 5, candles: candles(closes) })] },
      EMPTY_PORTFOLIO,
    );

    const buys = result.signals.filter((s) => s.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.expectedMoveBps).toBeGreaterThan(0);
  });

  it("vend quand le prix revient à la moyenne", () => {
    const strategy = new MeanReversionStrategy({ window: 20, zEntry: 2, zExit: 0.5 });
    const closes = Array.from({ length: 20 }, (_, i) => 10 + Math.sin(i) * 0.01);
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 10, candles: candles(closes) })] },
      WITH_POSITION,
    );
    expect(result.signals.filter((s) => s.side === "sell")).toHaveLength(1);
  });
});

describe("grid", () => {
  it("n'achète pas tant qu'aucun palier n'est franchi", () => {
    const strategy = new GridStrategy({ stepPct: 1, levels: 5 }, "15m", 20);
    const closes = Array.from({ length: 20 }, () => 10);
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 9.95, candles: candles(closes) })] },
      EMPTY_PORTFOLIO,
    );
    expect(result.signals.filter((s) => s.side === "buy")).toHaveLength(0);
  });

  it("achète par paliers sous l'ancre et autorise l'ajout", () => {
    const strategy = new GridStrategy({ stepPct: 1, levels: 5 }, "15m", 20);
    const closes = Array.from({ length: 20 }, () => 10);
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 9.5, candles: candles(closes) })] },
      EMPTY_PORTFOLIO,
    );

    const buys = result.signals.filter((s) => s.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.allowAdd).toBe(true);
  });

  it("vend au retour à l'ancre", () => {
    const strategy = new GridStrategy({ stepPct: 1, levels: 5 }, "15m", 20);
    const closes = Array.from({ length: 20 }, () => 10);
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: "Aa", priceUsd: 10.2, candles: candles(closes) })] },
      WITH_POSITION,
    );
    expect(result.signals.filter((s) => s.side === "sell")).toHaveLength(1);
  });
});

describe("dca_rotation", () => {
  it("achète la cible sous-allouée", () => {
    const strategy = new DcaRotationStrategy({
      targetAlloc: { SOL: 0.4, USDC: 0.6 },
      driftTriggerPct: 5,
      topupUsdc: 25,
    });
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: SOL_MINT, symbol: "SOL", priceUsd: 100 })] },
      EMPTY_PORTFOLIO,
    );

    const buys = result.signals.filter((s) => s.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.assetMint).toBe(SOL_MINT);
    expect(buys[0]?.suggestedSizeUsd).toBeGreaterThan(0);
  });

  it("n'achète pas si la dérive est sous le seuil", () => {
    const strategy = new DcaRotationStrategy({
      targetAlloc: { SOL: 0.4 },
      driftTriggerPct: 5,
      topupUsdc: 25,
    });
    const result = strategy.evaluate(
      { tsMs: 0, assets: [asset({ mint: SOL_MINT, symbol: "SOL", priceUsd: 100 })] },
      {
        ...EMPTY_PORTFOLIO,
        navUsd: 1000,
        cashUsd: 0,
        positions: [
          {
            mint: SOL_MINT,
            symbol: "SOL",
            qty: 4,
            avgEntryUsd: 100,
            valueUsd: 400,
            unrealizedPnlUsd: 0,
            unrealizedPnlPct: 0,
            stopLossUsd: null,
            takeProfitUsd: null,
            peakPriceUsd: null,
            ageMs: 1000,
          },
        ],
      },
    );
    expect(result.signals.filter((s) => s.side === "buy")).toHaveLength(0);
  });
});
