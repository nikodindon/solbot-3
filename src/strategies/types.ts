import type { Timeframe } from "../config/schema.js";
import type { ImportedCandle } from "../state/imported-candles.js";
import type { PortfolioView } from "../portfolio/portfolio.js";
import type { RegimeResult } from "../market/regime.js";

/**
 * Le contrat `Strategy`.
 *
 * Une stratégie est **pure** : elle observe un instantané de marché et un
 * portefeuille, et rend des signaux. Elle ne touche jamais au risque, à
 * l'exécution ni à la base. Une stratégie ne peut donc pas placer un ordre.
 *
 * Chaque stratégie est évaluée **seule**, puis confrontée aux autres par
 * l'allocateur : c'est ce qui permet de faire tourner plusieurs stratégies
 * en parallèle (shadow) et de choisir celle qui pilote le capital.
 */

/** Données dont une stratégie a besoin pour fonctionner. */
export interface DataRequirement {
  timeframe: Timeframe;
  /** Nombre minimum de bougies **clôturées** nécessaires. */
  bars: number;
}

/** Un actif, vu par une stratégie. */
export interface AssetSnapshot {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number | null;
  /**
   * Bougies clôturées **par timeframe**, de la plus ancienne à la plus
   * récente.
   *
   * Chaque stratégie lit le timeframe qu'elle a demandé : une stratégie en
   * 1 h et une stratégie en 15 m ne doivent pas voir la même fenêtre.
   */
  candles: Partial<Record<Timeframe, ImportedCandle[]>>;
  /** Régime de marché de cet actif (trending / ranging / idle). */
  regime?: RegimeResult;
}

/** Bougies d'un actif pour un timeframe donné. */
export function candlesFor(asset: AssetSnapshot, tf: Timeframe): ImportedCandle[] {
  return asset.candles[tf] ?? [];
}

/** L'instantané de marché complet. */
export interface MarketSnapshot {
  tsMs: number;
  assets: AssetSnapshot[];
}

/** Un signal d'action. */
export interface Signal {
  assetMint: string;
  symbol: string;
  side: "buy" | "sell";
  /** Confiance, de 0 à 1. */
  confidence: number;
  /** Mouvement attendu, **avant coûts**, en bps. */
  expectedMoveBps: number;
  /** Durée de validité du signal, en ms. */
  ttlMs: number;
  /** Explication, journalisée telle quelle. */
  reason: string;
  /** Stop-loss suggéré, en % de l'entrée. */
  stopLossPct?: number;
  /** Part de la position à vendre (0..1, défaut 1). */
  sellPortion?: number;
  /** Autorise un ajout à une position existante. */
  allowAdd?: boolean;
  /** Plafond indicatif de taille ; le RiskManager tranche. */
  suggestedSizeUsd?: number;
  /** Étiquettes libres (ex. `regime:trending`). */
  tags?: string[];
  /**
   * Signal **exempt** du filtre d'edge net.
   *
   * Un rééquilibrement de portefeuille n'est pas une pari sur un mouvement de
   * prix : son gain est une réduction de dérive. Lui appliquer un seuil d'edge
   * reviendrait à interdire toute gestion de portefeuille.
   */
  edgeExempt?: boolean;
}

/** Résultat d'évaluation : les signaux, plus des notes explicatives. */
export interface StrategyEval {
  signals: Signal[];
  /**
   * Explications lisibles — la matière du journal de décisions.
   * « pas de cassure (≤ plus haut 1.234) » vaut mieux qu'un silence.
   */
  notes: string[];
}

export interface Strategy {
  readonly name: string;
  readonly requires: DataRequirement[];
  evaluate(snapshot: MarketSnapshot, portfolio: PortfolioView): StrategyEval;
}

/** Extrait les bougies d'un actif pour un timeframe donné. */
export function candlesOf(assets: AssetSnapshot[], mint: string, tf: Timeframe): ImportedCandle[] {
  const asset = assets.find((a) => a.mint === mint);
  return asset ? candlesFor(asset, tf) : [];
}

/** FERMés uniquement : une bougie en cours ne décide rien. */
export function closedCloses(candles: ImportedCandle[]): number[] {
  return candles.map((candle) => candle.close);
}

export function closedHighs(candles: ImportedCandle[]): number[] {
  return candles.map((candle) => candle.high);
}

export function closedLows(candles: ImportedCandle[]): number[] {
  return candles.map((candle) => candle.low);
}

export function closedVolumes(candles: ImportedCandle[]): number[] {
  return candles.map((candle) => candle.volumeUsd ?? 0);
}
