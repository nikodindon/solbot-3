import type { Timeframe } from "../config/schema.js";
import { getMergedCandles } from "../state/imported-candles.js";
import type { DB } from "../state/db.js";

/**
 * Slippage.
 *
 * Trois modes :
 * - `rtse` : la borne est calculée par Jupiter (Real-Time Slippage
 *   Execution). C'est le **mode par défaut** : laisser Jupiter gérer le
 *   slippage est plus sûr que de fixer une borne soi-même ;
 * - `adaptive` : la borne est déduite de la volatilité récente (ATR) de
 *   l'actif, bornée par `min_bps`/`max_bps` ;
 * - un nombre fixe de bps : à réserver aux cas documentés.
 *
 * Après un échec de slippage, la borne est **élargie** d'un facteur
 * (`slippage_bump_factor`), sans jamais dépasser `risk.max_slippage_bps`.
 */

export interface SlippageAdaptiveConfig {
  timeframe: Timeframe;
  /** Nombre de bougies moyennées par l'ATR. */
  period: number;
  /** Multiplicateur de l'ATR (1 = 1 ATR de borne). */
  multiplier: number;
  minBps: number;
  maxBps: number;
}

export const DEFAULT_ADAPTIVE: SlippageAdaptiveConfig = {
  timeframe: "15m",
  period: 14,
  multiplier: 1,
  minBps: 10,
  maxBps: 100,
};

/**
 * ATR de l'actif, en pourcentage du dernier prix.
 *
 * L'ATR est calculé sur les bougies **clôturées** : une bougie en cours
 * n'a pas de haut ni de bas définitifs.
 */
export function atrPct(
  db: DB,
  mint: string,
  nowMs: number,
  cfg: SlippageAdaptiveConfig,
): number | null {
  const candles = getMergedCandles(db, mint, cfg.timeframe, { toMs: nowMs });
  if (candles.length < cfg.period + 1) return null;

  const window = candles.slice(-(cfg.period + 1));
  const trueRanges: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const high = window[i]?.high ?? 0;
    const low = window[i]?.low ?? 0;
    const previousClose = window[i - 1]?.close ?? 0;
    trueRanges.push(
      Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)),
    );
  }
  if (trueRanges.length === 0) return null;

  const atr = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
  const lastClose = window[window.length - 1]?.close ?? 0;
  if (lastClose <= 0) return null;

  return atr / lastClose;
}

/**
 * Borne de slippage adaptative, en bps.
 *
 * Retourne `null` quand l'historique est insuffisant : l'appelant doit alors
 * **repli sur RTSE**, plutôt que d'inventer une borne.
 */
export function adaptiveSlippageBps(
  db: DB,
  mint: string,
  nowMs: number,
  cfg: SlippageAdaptiveConfig,
): number | null {
  const pct = atrPct(db, mint, nowMs, cfg);
  if (pct === null) return null;

  const bps = pct * 10_000 * cfg.multiplier;
  return Math.max(cfg.minBps, Math.min(cfg.maxBps, Math.ceil(bps)));
}

/**
 * Élargit une borne après un échec de slippage.
 *
 * ⚠ Une borne **fournie explicitement** (CLI ou configuration) n'est jamais
 * élargie : si l'utilisateur a dit 50 bps, on ne passe pas à 100 bps
 * derrière son dos. Seules les bornes calculées (adaptive) sont élargies.
 */
export function bumpSlippageBps(
  current: number | undefined,
  factor: number,
  maxBps: number,
): number | undefined {
  if (current === undefined) return undefined;
  return Math.min(maxBps, Math.ceil(current * factor));
}

/** Représentation lisible d'un mode de slippage, pour le journal. */
export function describeSlippage(
  mode: "rtse" | "adaptive" | number,
  resolvedBps: number | undefined,
): string {
  if (mode === "rtse") return "rtse (borne gérée par Jupiter)";
  if (mode === "adaptive") {
    return resolvedBps === undefined
      ? "adaptive (historique insuffisant → repli sur RTSE)"
      : `adaptive (${resolvedBps} bps)`;
  }
  return `${mode} bps`;
}
