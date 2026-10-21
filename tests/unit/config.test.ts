import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfigRaw } from "../../src/config/loader.js";
import { ConfigError } from "../../src/utils/errors.js";
import { makeTempRoot, removeTempRoot, writeConfig } from "../helpers.js";

describe("configuration", () => {
  it("applique les valeurs par défaut sur un YAML minimal", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: paper\n");
      const { config } = loadConfig({ root, env: {} });

      expect(config.mode).toBe("paper");
      expect(config.confirm_live).toBe(false);
      expect(config.loop_interval_s).toBe(30);
      expect(config.risk.max_position_pct).toBe(5);
      expect(config.allocator.min_edge_over_costs).toBe(3);
      expect(config.execution.path).toBe("meta_aggregator");
      expect(config.guard.min_backtest_days).toBe(60);
      expect(config.data.require_price_source).toEqual(["discovery", "candle"]);
    } finally {
      removeTempRoot(root);
    }
  });

  it("rejette une clé inconnue (fail-fast, jamais de silence)", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: paper\nmax_position_pct: 10\n");
      expect(() => loadConfig({ root, env: {} })).toThrow(ConfigError);
      expect(() => loadConfig({ root, env: {} })).toThrow(/max_position_pct/);
    } finally {
      removeTempRoot(root);
    }
  });

  it("rejette une valeur hors bornes", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "risk:\n  max_drawdown_pct: 500\n");
      expect(() => loadConfig({ root, env: {} })).toThrow(/max_drawdown_pct/);
    } finally {
      removeTempRoot(root);
    }
  });

  it("refuse le mode live sans confirm_live", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: live\nconfirm_live: false\n");
      expect(() => loadConfig({ root, env: {} })).toThrow(/confirm_live/);
    } finally {
      removeTempRoot(root);
    }
  });

  it("accepte le mode live avec confirm_live", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: live\nconfirm_live: true\n");
      const { config, mode } = loadConfig({ root, env: {} });
      expect(config.mode).toBe("live");
      expect(mode).toBe("live");
    } finally {
      removeTempRoot(root);
    }
  });

  it("le forçage CLI du mode live ne contourne pas le filet confirm_live", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: paper\nconfirm_live: false\n");
      expect(() => loadConfig({ root, env: {}, mode: "live" })).toThrow(/confirm_live/);
    } finally {
      removeTempRoot(root);
    }
  });

  it("valide les paramètres de stratégie (ema_slow > ema_fast)", () => {
    expect(() =>
      parseConfigRaw({
        strategies: { trend_breakout: { params: { ema_fast: 30, ema_slow: 20 } } },
      }),
    ).toThrow(/ema_slow/);
  });

  it("valide les paramètres de mean_reversion (z_exit < z_entry)", () => {
    expect(() =>
      parseConfigRaw({ strategies: { mean_reversion: { params: { z_entry: 1, z_exit: 3 } } } }),
    ).toThrow(/z_exit/);
  });

  it("retombe sur config.example.yaml quand config.yaml est absent", () => {
    const root = makeTempRoot();
    try {
      const { config, sources } = loadConfig({ root, env: {} });
      expect(sources.usedExample).toBe(true);
      expect(config.mode).toBe("paper");
    } finally {
      removeTempRoot(root);
    }
  });

  it("échoue explicitement quand aucun fichier de configuration n'existe", () => {
    const root = makeTempRoot();
    try {
      expect(() => loadConfig({ root, env: {}, yamlPath: path.join(root, "absent.yaml") })).toThrow(
        /configuration/,
      );
    } finally {
      removeTempRoot(root);
    }
  });

  it("rejette une clé privée au format invalide dans l'environnement", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: paper\n");
      expect(() => loadConfig({ root, env: { BS58_PRIVATE_KEY: "pas-une-cle" } })).toThrow(
        /BS58_PRIVATE_KEY/,
      );
    } finally {
      removeTempRoot(root);
    }
  });

  it("ignore les variables d'environnement vides", () => {
    const root = makeTempRoot();
    try {
      writeConfig(root, "mode: paper\n");
      const { env } = loadConfig({ root, env: { JUPITER_API_KEY: "", JUPITER_RPS: "" } });
      expect(env.JUPITER_API_KEY).toBeUndefined();
      expect(env.JUPITER_RPS).toBeUndefined();
    } finally {
      removeTempRoot(root);
    }
  });
});
