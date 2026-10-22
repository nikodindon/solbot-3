import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewView, StrategiesView } from "../src/views/Overview";
import { PositionsView, TradesView } from "../src/views/Tables";
import type { DashboardState } from "../src/api";

const STATE: DashboardState = {
  clock: { now: 1_700_000_000_000, fresh: true, lastTickAt: 1_699_999_990_000, lastTickAgeS: 10 },
  mode: "paper",
  nav: {
    usd: 1042.5,
    cash: 900,
    positions: 142.5,
    realized: 12.25,
    drawdownPct: 3.2,
    initial: 1000,
    peak: 1077.1,
  },
  portfolio: {
    positions: [
      {
        mint: "Aa",
        symbol: "AAA",
        qty: 100,
        avgEntryUsd: 2,
        priceUsd: 2.5,
        valueUsd: 250,
        unrealizedUsd: 50,
        unrealizedPct: 25,
        stopLossUsd: 1.84,
        takeProfitUsd: 2.3,
        peakPriceUsd: 2.6,
        ageMs: 3_600_000,
        entryFrictionUsd: 0.1,
      },
    ],
    costs: { feesUsd: 12.5, trades: 30, notionalUsd: 5000 },
  },
  allocation: {
    pilot: "mean_reversion",
    changed: false,
    scores: [
      {
        name: "mean_reversion",
        scorePct: 4.25,
        trades: 20,
        eligible: true,
        reason: null,
        navUsd: 1042.5,
      },
      {
        name: "trend_breakout",
        scorePct: -1.2,
        trades: 3,
        eligible: false,
        reason: "3 trade(s) < 10 requis",
        navUsd: 988,
      },
    ],
  },
  guards: {
    stopFile: false,
    killSwitchAtMs: null,
    pausedUntilMs: null,
    dayAnchorUsd: 1040,
    dailyDropPct: 0,
    dailyLimitPct: 3,
  },
  markets: [],
  benchmarks: { cashUsd: 900, solBuyHoldPct: 12.5 },
  counters: { ticks: 100, trades: 30, signals: 40, rejections: 12, decisions: 200 },
};

describe("vue d'ensemble", () => {
  it("affiche le NAV, le PnL et le drawdown", () => {
    render(<OverviewView state={STATE} />);

    expect(screen.getByText("NAV")).toBeTruthy();
    expect(screen.getByText("1042.50 $")).toBeTruthy();
    expect(screen.getByText("+4.25 %")).toBeTruthy();
    expect(screen.getByText("3.20 %")).toBeTruthy();
  });

  it("affiche l'état des garde-fous", () => {
    render(<OverviewView state={STATE} />);
    expect(screen.getAllByText("Kill-switch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("inactif").length).toBeGreaterThan(0);
    expect(screen.getAllByText("à jour").length).toBeGreaterThan(0);
  });

  it("signale un état périmé", () => {
    const stale = { ...STATE, clock: { ...STATE.clock, fresh: false } };
    render(<OverviewView state={stale} />);
    expect(screen.getByText("périmée")).toBeTruthy();
  });
});

describe("vue stratégies", () => {
  it("classe les stratégies et désigne la pilote", () => {
    render(<StrategiesView state={STATE} />);
    expect(screen.getAllByText("mean_reversion").length).toBeGreaterThan(0);
    expect(screen.getAllByText("trend_breakout").length).toBeGreaterThan(0);
    expect(screen.getByText("pilote")).toBeTruthy();
    // Une stratégie inéligible affiche la raison.
    expect(screen.getByText(/3 trade\(s\) < 10 requis/)).toBeTruthy();
  });

  it("explique l'absence de shadow", () => {
    render(<StrategiesView state={{ ...STATE, allocation: { ...STATE.allocation, scores: [] } }} />);
    expect(screen.getByText(/portefeuilles fantômes/)).toBeTruthy();
  });
});

describe("vue positions", () => {
  it("liste les positions valorisées", () => {
    render(<PositionsView state={STATE} />);
    expect(screen.getAllByText("AAA").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.500000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("250.00 $").length).toBeGreaterThan(0);
  });

  it("explique l'absence de position", () => {
    render(<PositionsView state={{ ...STATE, portfolio: { ...STATE.portfolio, positions: [] } }} />);
    expect(screen.getByText(/Aucune position ouverte/)).toBeTruthy();
  });
});

describe("vue trades", () => {
  it("affiche un tableau vide quand il n'y a rien", () => {
    render(<TradesView state={STATE} />);
    expect(screen.getByText(/Aucun trade/)).toBeTruthy();
  });
});
