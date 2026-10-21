import type { Timeframe } from "../config/schema.js";
import {
  countImportedCandles,
  importedCoverage,
  upsertImportedCandles,
  type ImportedCandle,
} from "../state/imported-candles.js";
import type { DB } from "../state/db.js";
import { GeckoClient, type GeckoCfg } from "./gecko.js";

/**
 * Import d'historique OHLCV depuis GeckoTerminal.
 *
 * Pour chaque mint :
 * 1. on trouve le pool de plus grande réserve USD ;
 * 2. on remonte l'historique en 15 min jusqu'à la fenêtre demandée ;
 * 3. on stocke dans `candles_imported` (table distincte des bougies live).
 *
 * Un mint dont le pool est introuvable ou dont l'historique est vide est
 * **signalé, pas fatal** : un actif sans historique ne doit pas faire
 * échouer l'import des autres.
 */

export interface ImportOptions {
  db: DB;
  mints: string[];
  /** Timeframe importé (l'import est mono-timeframe par commodité). */
  tf: Timeframe;
  /** Fenêtre historique, en jours. */
  days: number;
  gecko?: GeckoCfg;
  /** Client injecté (tests). */
  client?: GeckoClient;
  /** Progression (logs). */
  onProgress?: (done: number, total: number, mint: string, candles: number) => void;
  /** Reimporte même si l'actif est déjà couvert. */
  force?: boolean;
}

export interface ImportResult {
  mintsTotal: number;
  mintsImported: number;
  /** Actifs déjà couverts : l'import est idempotent. */
  mintsSkipped: number;
  candlesTotal: number;
  /** Mints sans historique exploitable, avec le motif. */
  skipped: { mint: string; reason: string }[];
}

/** Nombre de bougies attendues sur `days` jours (96 par jour en 15 m). */
export function expectedCandles(days: number): number {
  return Math.round(days * 96);
}

/**
 * L'actif est-il déjà couvert ?
 *
 * L'import est **idempotent** : relancer la commande ne refait pas le
 * travail déjà fait. C'est important parce que chaque actif coûte une
 * dizaine d'appels à l'API publique, dont le quota est précieux.
 */
export function isAlreadyCovered(db: DB, mint: string, tf: Timeframe, days: number): boolean {
  const rows = countImportedCandles(db, mint, tf);
  if (rows < expectedCandles(days) * 0.8) return false;

  const coverage = importedCoverage(db).find((row) => row.tf === tf);
  if (!coverage?.newest) return false;

  // L'historique doit être récent : sinon il manque le haut de la fenêtre.
  const ageMs = Date.now() - coverage.newest;
  return ageMs < 3 * 24 * 3_600_000;
}

export async function importHistory(options: ImportOptions): Promise<ImportResult> {
  const { db, mints, tf, days } = options;
  const client = options.client ?? new GeckoClient(options.gecko);
  const sinceMs = Date.now() - days * 24 * 3_600_000;

  const result: ImportResult = {
    mintsTotal: mints.length,
    mintsImported: 0,
    mintsSkipped: 0,
    candlesTotal: 0,
    skipped: [],
  };

  for (const [index, mint] of mints.entries()) {
    let poolAddress: string | undefined;
    let candles: ImportedCandle[] = [];

    if (!options.force && isAlreadyCovered(db, mint, tf, days)) {
      result.mintsSkipped += 1;
      options.onProgress?.(index + 1, mints.length, mint, 0);
      continue;
    }

    try {
      const pool = await client.bestPool(mint);
      if (!pool) {
        result.skipped.push({ mint, reason: "pool introuvable" });
        options.onProgress?.(index + 1, mints.length, mint, 0);
        continue;
      }
      poolAddress = pool.address;

      const rows = await client.ohlcv(poolAddress, tf, sinceMs);
      candles = rows.map((row) => ({
        mint,
        tf,
        // GeckoTerminal renvoie des **secondes** : conversion en ms.
        ts: row[0] * 1000,
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        volumeUsd: row[5] > 0 ? row[5] : null,
        source: "geckoterminal",
      }));

      if (candles.length === 0) {
        result.skipped.push({ mint, reason: "historique vide" });
        options.onProgress?.(index + 1, mints.length, mint, 0);
        continue;
      }

      upsertImportedCandles(db, candles);
      result.mintsImported += 1;
      result.candlesTotal += candles.length;
    } catch (error) {
      result.skipped.push({
        mint,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    options.onProgress?.(index + 1, mints.length, mint, candles.length);
  }

  return result;
}
