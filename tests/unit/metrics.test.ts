import { describe, expect, it } from "vitest";
import { computeMetrics, maxDrawdownPct, sharpeDaily } from "../../src/backtest/metrics.js";

describe("métriques", () => {
  it("calcule le PnL et le taux de gain", () => {
    const metrics = computeMetrics({
      equity: [
        { tsMs: 0, navUsd: 1000 },
        { tsMs: 86_400_000, navUsd: 1100 },
      ],
      trades: [
        { tsMs: 0, pnlUsd: 60, notionalUsd: 500, feeUsd: 5 },
        { tsMs: 0, pnlUsd: 40, notionalUsd: 500, feeUsd: 5 },
        { tsMs: 0, pnlUsd: -20, notionalUsd: 500, feeUsd: 5 },
      ],
      initialUsd: 1000,
      days: 1,
    });

    expect(metrics.netPnlUsd).toBeCloseTo(100, 6);
    expect(metrics.netPnlPct).toBeCloseTo(10, 6);
    expect(metrics.trades).toBe(3);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(1);
    expect(metrics.winRatePct).toBeCloseTo(66.67, 1);
    expect(metrics.grossProfitUsd).toBeCloseTo(100, 6);
    expect(metrics.grossLossUsd).toBeCloseTo(20, 6);
    expect(metrics.profitFactor).toBeCloseTo(5, 6);
    expect(metrics.feesUsd).toBeCloseTo(15, 6);
  });

  it("renvoie null plutôt qu'une valeur inventée quand c'est incalculable", () => {
    const metrics = computeMetrics({
      equity: [{ tsMs: 0, navUsd: 1000 }],
      trades: [],
      initialUsd: 1000,
      days: 0,
    });

    // Aucun trade : win rate, profit factor, drawdown et Sharpe sont indéfinis.
    expect(metrics.winRatePct).toBeNull();
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.maxDrawdownPct).toBeNull();
    expect(metrics.sharpe).toBeNull();
    expect(metrics.trades).toBe(0);
  });

  it("ne déclare pas de profit factor quand il n'y a aucune perte", () => {
    const metrics = computeMetrics({
      equity: [
        { tsMs: 0, navUsd: 1000 },
        { tsMs: 1000, navUsd: 1100 },
      ],
      trades: [{ tsMs: 0, pnlUsd: 100, notionalUsd: 1000, feeUsd: 10 }],
      initialUsd: 1000,
      days: 1,
    });
    // Divider par zéro de pertes n'a pas de sens : la valeur est nulle (null).
    expect(metrics.profitFactor).toBeNull();
  });

  it("mesure le drawdown depuis le pic", () => {
    const equity = [
      { tsMs: 0, navUsd: 1000 },
      { tsMs: 1, navUsd: 1200 },
      { tsMs: 2, navUsd: 900 },
      { tsMs: 3, navUsd: 1000 },
    ];
    expect(maxDrawdownPct(equity)).toBeCloseTo(25, 6);
  });

  it("exige au moins trois journées pour un Sharpe", () => {
    const deuxJours = [
      { tsMs: 0, navUsd: 1000 },
      { tsMs: 86_400_000, navUsd: 1010 },
    ];
    expect(sharpeDaily(deuxJours)).toBeNull();

    const troisJours = [
      { tsMs: 0, navUsd: 1000 },
      { tsMs: 86_400_000, navUsd: 1010 },
      { tsMs: 172_800_000, navUsd: 1020 },
    ];
    const sharpe = sharpeDaily(troisJours);
    expect(sharpe).not.toBeNull();
    expect(Number.isFinite(sharpe as number)).toBe(true);
  });

  it("calcule le turnover sur le notionnel moyen", () => {
    const metrics = computeMetrics({
      equity: [
        { tsMs: 0, navUsd: 1000 },
        { tsMs: 86_400_000, navUsd: 1000 },
      ],
      trades: [{ tsMs: 0, pnlUsd: 0, notionalUsd: 500, feeUsd: 0 }],
      initialUsd: 1000,
      days: 2,
    });
    expect(metrics.turnover).toBeCloseTo(0.5, 6);
    expect(metrics.turnoverPerDay).toBeCloseTo(0.25, 6);
  });
});
