import { describe, expect, it } from "vitest";
import type { AllocatorConfig, RiskConfig } from "../../src/config/schema.js";
import { DEFAULT_COST_CONFIG } from "../../src/execution/costs.js";
import { RiskManager, type RiskFlags } from "../../src/risk/risk-manager.js";
import type { Signal } from "../../src/strategies/types.js";

const RISK: RiskConfig = {
  max_position_pct: 5,
  max_positions: 6,
  max_asset_exposure_pct: 15,
  daily_loss_limit_pct: 3,
  max_drawdown_pct: 15,
  stop_loss_pct: 8,
  take_profit_pct: 15,
  trailing_stop: { activation_pct: 6, retrace_pct: 3 },
  max_price_impact_pct: 1,
  max_slippage_bps: 100,
  min_time_between_trades_s: 300,
  sol_gas_reserve: 0.05,
};

const ALLOCATOR: AllocatorConfig = {
  score_window_days: 7,
  min_trades_to_score: 10,
  hysteresis_pct: 15,
  min_edge_over_costs: 3,
  pilot_allocation_pct: 100,
};

const SIGNAL: Signal = {
  assetMint: "Aa",
  symbol: "AAA",
  side: "buy",
  confidence: 0.6,
  expectedMoveBps: 500,
  ttlMs: 90_000,
  reason: "test",
};

function flags(partial: Partial<RiskFlags> = {}): RiskFlags {
  return {
    killSwitch: false,
    pausedUntilMs: null,
    solBalanceSol: null,
    cashUsd: 1000,
    navUsd: 1000,
    assetExposureUsd: 0,
    totalExposureUsd: 0,
    openPositions: 0,
    lastTradeTsByMint: null,
    priceUsd: 1,
    liquidityUsd: 10_000_000,
    priceUsable: true,
    priceGuardReason: null,
    ...partial,
  };
}

function request(partial: Partial<Parameters<RiskManager["checkEntry"]>[0]> = {}) {
  return {
    signal: SIGNAL,
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    outputMint: "Aa",
    solPriceUsd: 100,
    needsAta: false,
    nowMs: 1_000_000,
    ...partial,
  };
}

function manager(): RiskManager {
  return new RiskManager(RISK, ALLOCATOR, DEFAULT_COST_CONFIG);
}

describe("RiskManager", () => {
  it("autorise une entrée conforme", () => {
    const decision = manager().checkEntry(request(), flags());
    expect(decision.allowed).toBe(true);
    expect(decision.rule).toBeNull();
    expect(decision.sizeUsd).toBeGreaterThan(0);
    expect(decision.sizeUsd).toBeLessThanOrEqual(50); // 5 % du NAV
  });

  it("rejette tout entrée si le kill-switch est actif", () => {
    const decision = manager().checkEntry(request(), flags({ killSwitch: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("kill_switch");
  });

  it("rejette pendant la pause de perte journalière", () => {
    const decision = manager().checkEntry(request(), flags({ pausedUntilMs: 2_000_000 }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("daily_loss_pause");
  });

  it("rejette un prix inutilisable", () => {
    const decision = manager().checkEntry(
      request(),
      flags({ priceUsable: false, priceGuardReason: "prix périmé" }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("data_guard");
  });

  it("rejette au-delà du nombre maximal de positions", () => {
    const decision = manager().checkEntry(request(), flags({ openPositions: 6 }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("max_positions");
  });

  it("laisse ajouter à une position existante même à la limite de positions", () => {
    const decision = manager().checkEntry(
      request(),
      flags({ openPositions: 6, assetExposureUsd: 10 }),
    );
    expect(decision.rule).not.toBe("max_positions");
  });

  it("rejette un edge net insuffisant face aux coûts", () => {
    const decision = manager().checkEntry(
      request({ signal: { ...SIGNAL, expectedMoveBps: 5 } }),
      flags(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("edge_net");
    // Le message chiffre le seuil : c'est l'outil de réglage.
    expect(decision.message).toMatch(/edge .* bps < seuil .* bps/);
  });

  it("exempte les signaux de rééquilibrage du filtre d'edge", () => {
    const rebalance = { ...SIGNAL, expectedMoveBps: 0, edgeExempt: true } as Signal;
    const decision = manager().checkEntry(request({ signal: rebalance }), flags());
    expect(decision.rule).not.toBe("edge_net");
  });

  it("rejette un impact de prix trop élevé", () => {
    const decision = manager().checkEntry(request(), flags({ liquidityUsd: 1_000 }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("price_impact");
  });

  it("rejette pendant le cooldown", () => {
    const decision = manager().checkEntry(request(), flags({ lastTradeTsByMint: 900_000 }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("cooldown");
  });

  it("rejette si le SOL passe sous la réserve de gaz", () => {
    const decision = manager().checkEntry(request(), flags({ solBalanceSol: 0.01 }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("gas_reserve");
  });

  it("rejette une taille trop petite", () => {
    // 3 $ : l'edge passe (le seuil de coût est proportionnel au notionnel),
    // mais c'est de la poussière de trade (10 % de la taille max = 5 $).
    const decision = manager().checkEntry(request(), flags({ cashUsd: 3 }));
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe("size_too_small");
  });

  it("dimensionne par le plus petit des plafonds", () => {
    const decision = manager().checkEntry(request(), flags({ cashUsd: 20 }));
    expect(decision.sizeUsd).toBeCloseTo(20, 6);
  });

  it("ne bloque jamais une sortie, même en kill-switch", () => {
    const manager = new RiskManager(RISK, ALLOCATOR, DEFAULT_COST_CONFIG);
    const gate = manager.checkExit(flags({ killSwitch: true, pausedUntilMs: 9_999_999 }));
    expect(gate.allowed).toBe(true);
  });

  it("bloque une sortie si le prix est inutilisable", () => {
    const manager = new RiskManager(RISK, ALLOCATOR, DEFAULT_COST_CONFIG);
    const gate = manager.checkExit(flags({ priceUsable: false, priceGuardReason: "périmé" }));
    expect(gate.allowed).toBe(false);
    expect(gate.message).toMatch(/périmé/);
  });

  it("chiffre les motifs de refus", () => {
    const decision = manager().checkEntry(request(), flags({ openPositions: 6 }));
    expect(decision.metrics.openPositions).toBe(6);
    expect(decision.metrics.navUsd).toBe(1000);
  });
});
