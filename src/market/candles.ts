import type { Timeframe } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { getMergedCandles, type ImportedCandle } from "../state/imported-candles.js";
import { timeframeMs } from "../portfolio/portfolio.js";

/**
 * Source de bougies — le *seam* d'historique.
 *
 * Le moteur ne sait pas d'où viennent les bougies : il les demande. En live,
 * elles viennent de la base (import + direct fusionnés) ; en backtest, elles
 * sont en mémoire. C'est cette indirection qui rend le rejeu rapide : le live
 * ne peut pas se permettre de relire 90 jours d'historique à chaque tick.
 *
 * Contrat : `candles()` ne renvoie que des bougies **clôturées** et au plus
 * `limit` bougies (les plus récentes). Les stratégies n'ont besoin que d'une
 * fenêtre, et renvoyer tout l'historique à chaque tick rendrait le backtest
 * quadratiquement lent.
 */
export interface CandleSource {
  /** Bougies clôturées d'un actif, les plus récentes en dernier. */
  candles(mint: string, tf: Timeframe, nowMs: number, limit: number): ImportedCandle[];
}

/** Source en base — utilisée en live et en paper. */
export class DbCandleSource implements CandleSource {
  constructor(private readonly db: DB) {}

  candles(mint: string, tf: Timeframe, nowMs: number, limit: number): ImportedCandle[] {
    // Une bougie est clôturée quand la fin de son seau est atteinte.
    const toMs = nowMs - timeframeMs(tf);
    const rows = getMergedCandles(this.db, mint, tf, { toMs });
    return rows.length > limit ? rows.slice(rows.length - limit) : rows;
  }
}

/** Source en mémoire — utilisée par le backtest. */
export class MemoryCandleSource implements CandleSource {
  private readonly byKey = new Map<string, ImportedCandle[]>();

  constructor(candles: ImportedCandle[] = []) {
    this.load(candles);
  }

  load(candles: ImportedCandle[]): void {
    for (const candle of candles) {
      const key = `${candle.mint}|${candle.tf}`;
      const list = this.byKey.get(key);
      if (list) list.push(candle);
      else this.byKey.set(key, [candle]);
    }
    for (const list of this.byKey.values()) {
      list.sort((a, b) => a.ts - b.ts);
    }
  }

  candles(mint: string, tf: Timeframe, nowMs: number, limit: number): ImportedCandle[] {
    const list = this.byKey.get(`${mint}|${tf}`) ?? [];
    const closedUntil = nowMs - timeframeMs(tf);

    // Recherche binaire de la première bougie non clôturée.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((list[mid]?.ts ?? 0) <= closedUntil) low = mid + 1;
      else high = mid;
    }

    const start = Math.max(0, low - limit);
    return list.slice(start, low);
  }
}
