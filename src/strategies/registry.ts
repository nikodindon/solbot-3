import type { StrategiesConfig } from "../config/schema.js";
import { DcaRotationStrategy, DCA_ROTATION_DEFAULTS } from "./dca-rotation.js";
import { GRID_DEFAULTS, GridStrategy } from "./grid.js";
import { MEAN_REVERSION_DEFAULTS, MeanReversionStrategy } from "./mean-reversion.js";
import { RegimeSwitchStrategy } from "./regime-switch.js";
import { RelativeStrengthStrategy } from "./relative-strength.js";
import { TREND_BREAKOUT_DEFAULTS, TrendBreakoutStrategy } from "./trend-breakout.js";
import type { Strategy } from "./types.js";

/**
 * Registre de stratégies.
 *
 * Une stratégie = une ligne dans la table. Ajouter une stratégie ne doit
 * jamais demander de modifier un `if/else` à six branches.
 */

export interface BuiltStrategy {
  strategy: Strategy;
  enabled: boolean;
}

export function buildStrategies(cfg: StrategiesConfig): BuiltStrategy[] {
  const built: BuiltStrategy[] = [];

  const trend = cfg.trend_breakout;
  const trendStrategy = new TrendBreakoutStrategy(
    {
      emaFast: trend.params.ema_fast,
      emaSlow: trend.params.ema_slow,
      breakoutLookback: trend.params.breakout_lookback,
      rsiPeriod: trend.params.rsi_period,
      rsiMax: trend.params.rsi_max,
      volumeMult: trend.params.volume_mult,
      atrStopMult: trend.params.atr_stop_mult,
    },
    trend.timeframe,
  );
  built.push({ enabled: trend.enabled, strategy: trendStrategy });

  const meanRev = cfg.mean_reversion;
  const meanRevStrategy = new MeanReversionStrategy(
    {
      window: meanRev.params.window,
      zEntry: meanRev.params.z_entry,
      zExit: meanRev.params.z_exit,
    },
    meanRev.timeframe,
  );
  built.push({ enabled: meanRev.enabled, strategy: meanRevStrategy });

  const grid = cfg.grid;
  built.push({
    enabled: grid.enabled,
    strategy: new GridStrategy(
      {
        stepPct: grid.params.step_pct,
        levels: grid.params.levels,
      },
      grid.timeframe,
    ),
  });

  const dca = cfg.dca_rotation;
  built.push({
    enabled: dca.enabled,
    strategy: new DcaRotationStrategy({
      targetAlloc: dca.params.target_alloc,
      driftTriggerPct: dca.params.drift_trigger_pct,
      topupUsdc: dca.params.topup_usdc,
    }),
  });

  const relative = cfg.relative_strength;
  built.push({
    enabled: relative.enabled,
    strategy: new RelativeStrengthStrategy(
      {
        lookbackH: relative.params.lookback_h,
        topN: relative.params.top_n,
        rebalanceH: relative.params.rebalance_h,
      },
      relative.timeframe,
    ),
  });

  const regimeSwitch = cfg.regime_switch;
  built.push({
    enabled: regimeSwitch.enabled,
    strategy: new RegimeSwitchStrategy([
      // La tendance suit le mouvement, le range joue le retour à la moyenne.
      { strategy: trendStrategy, regimes: ["trending"] },
      { strategy: meanRevStrategy, regimes: ["ranging"] },
    ]),
  });

  return built;
}

/** Stratégies activées, dans l'ordre de la configuration. */
export function enabledStrategies(cfg: StrategiesConfig): Strategy[] {
  return buildStrategies(cfg)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.strategy);
}

/**
 * Descripteur canonique du jeu de stratégies.
 *
 * C'est ce qui est **haché** pour lier un backtest à une configuration : y
 * figurent les noms, les paramètres et l'ordre d'évaluation. Changer un
 * seul paramètre change l'empreinte, et impose de rejouer le backtest.
 */
export function strategySetDescriptor(cfg: StrategiesConfig): string {
  return JSON.stringify({
    trend_breakout: {
      enabled: cfg.trend_breakout.enabled,
      timeframe: cfg.trend_breakout.timeframe,
      params: cfg.trend_breakout.params,
    },
    mean_reversion: {
      enabled: cfg.mean_reversion.enabled,
      timeframe: cfg.mean_reversion.timeframe,
      params: cfg.mean_reversion.params,
    },
    grid: {
      enabled: cfg.grid.enabled,
      timeframe: cfg.grid.timeframe,
      params: cfg.grid.params,
    },
    dca_rotation: {
      enabled: cfg.dca_rotation.enabled,
      params: cfg.dca_rotation.params,
    },
    relative_strength: {
      enabled: cfg.relative_strength.enabled,
      timeframe: cfg.relative_strength.timeframe,
      params: cfg.relative_strength.params,
    },
    regime_switch: {
      enabled: cfg.regime_switch.enabled,
      params: cfg.regime_switch.params,
    },
  });
}

/** Valeurs par défaut exportées, pour les tests et la documentation. */
export const DEFAULT_PARAMS = {
  trend_breakout: TREND_BREAKOUT_DEFAULTS,
  mean_reversion: MEAN_REVERSION_DEFAULTS,
  grid: GRID_DEFAULTS,
  dca_rotation: DCA_ROTATION_DEFAULTS,
};
