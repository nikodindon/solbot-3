import type { DB } from "../state/db.js";
import { queryAll, queryGet } from "../state/sql.js";

/**
 * Positions et lots FIFO.
 *
 * Le coût de revient d'une position est **toujours dérivé des lots**, jamais
 * d'un champ cumulé : c'est ce qui élimine la dérive en virgule flottante
 * après de nombreux ajouts et ventes partielles.
 */

export interface Position {
  mint: string;
  symbol: string;
  qty: number;
  investedUsd: number;
  avgEntryUsd: number;
  realizedPnlUsd: number;
  peakPriceUsd: number | null;
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  openedMs: number;
  updatedMs: number;
}

export interface PositionLot {
  seq: number;
  mint: string;
  tsMs: number;
  qty: number;
  remaining: number;
  priceUsd: number;
}

export interface ReduceResult {
  position: Position | null;
  realizedPnlUsd: number;
  soldQty: number;
  proceedsUsd: number;
}

interface PositionRow {
  mint: string;
  symbol: string;
  qty: number;
  invested_usd: number;
  avg_entry_usd: number;
  realized_pnl_usd: number;
  peak_price_usd: number | null;
  stop_loss_usd: number | null;
  take_profit_usd: number | null;
  opened_ms: number;
  updated_ms: number;
}

function rowToPosition(row: PositionRow): Position {
  return {
    mint: row.mint,
    symbol: row.symbol,
    qty: row.qty,
    investedUsd: row.invested_usd,
    avgEntryUsd: row.avg_entry_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    peakPriceUsd: row.peak_price_usd,
    stopLossUsd: row.stop_loss_usd,
    takeProfitUsd: row.take_profit_usd,
    openedMs: row.opened_ms,
    updatedMs: row.updated_ms,
  };
}

export function listPositions(db: DB, onlyOpen = true): Position[] {
  const sql = onlyOpen
    ? "SELECT * FROM positions WHERE qty > 0 ORDER BY opened_ms ASC"
    : "SELECT * FROM positions ORDER BY opened_ms ASC";
  return queryAll<PositionRow>(db, sql).map(rowToPosition);
}

export function getPosition(db: DB, mint: string): Position | null {
  const row = queryGet<PositionRow>(db, "SELECT * FROM positions WHERE mint = ?", mint);
  return row ? rowToPosition(row) : null;
}

export function listLots(db: DB, mint: string): PositionLot[] {
  return queryAll<PositionLot & { ts_ms: number; remaining: number; price_usd: number }>(
    db,
    "SELECT seq, mint, ts_ms, qty, remaining, price_usd FROM position_lots WHERE mint = ? ORDER BY seq ASC",
    mint,
  ).map((row) => ({
    seq: row.seq,
    mint: row.mint,
    tsMs: row.ts_ms,
    qty: row.qty,
    remaining: row.remaining,
    priceUsd: row.price_usd,
  }));
}

/**
 * Ajoute un lot (achat ou ajout de position).
 *
 * Le `invested_usd` de la position est recalculé à partir des lots
 * restants, pas incrémenté : pas de dérive.
 */
export function addLot(
  db: DB,
  mint: string,
  symbol: string,
  qty: number,
  priceUsd: number,
  tsMs: number,
): Position {
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO position_lots (mint, ts_ms, qty, remaining, price_usd) VALUES (?, ?, ?, ?, ?)",
    ).run(mint, tsMs, qty, qty, priceUsd);

    const existing = getPosition(db, mint);
    const reopening = existing !== null && existing.qty <= 0;
    const invested = (existing?.investedUsd ?? 0) + qty * priceUsd;
    const totalQty = (existing?.qty ?? 0) + qty;
    const avgEntry = totalQty > 0 ? invested / totalQty : 0;

    if (existing) {
      // Une position déjà close (qty = 0) **rouvre** : son pic est celui de
      // l'ancienne position, souvent très loin au-dessus. Le conserver
      // armerait le trailing stop immédiatement et l'entrée sortirait au
      // tick suivant. Un pic ne doit donc survivre qu'à un ajout.
      const peak = reopening ? priceUsd : (existing.peakPriceUsd ?? priceUsd);
      db.prepare(
        `UPDATE positions
            SET qty = ?, invested_usd = ?, avg_entry_usd = ?, updated_ms = ?,
                peak_price_usd = ?
          WHERE mint = ?`,
      ).run(totalQty, invested, avgEntry, tsMs, peak, mint);
    } else {
      db.prepare(
        `INSERT INTO positions
           (mint, symbol, qty, invested_usd, avg_entry_usd, realized_pnl_usd, peak_price_usd, opened_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(mint, symbol, totalQty, invested, avgEntry, priceUsd, tsMs, tsMs);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const position = getPosition(db, mint);
  if (!position) throw new Error(`addLot : position introuvable pour ${mint}`);
  return position;
}

/**
 * Vend `qty` en consommant les **plus anciens lots d'abord** (FIFO).
 *
 * Le PnL réalisé est `(prix de vente − prix du lot) × quantité`, ce qui est
 * la définition la plus simple et la plus auditable d'un coût de revient.
 */
export function reducePositionFifo(
  db: DB,
  mint: string,
  qty: number,
  priceUsd: number,
  tsMs: number,
): ReduceResult {
  const position = getPosition(db, mint);
  if (!position) {
    return { position: null, realizedPnlUsd: 0, soldQty: 0, proceedsUsd: 0 };
  }
  if (qty > position.qty + 1e-9) {
    throw new Error(
      `reducePositionFifo : vente de ${qty} supérieure à la position (${position.qty}) de ${mint}`,
    );
  }

  let realized = 0;
  let sold = 0;
  /** Coût de revient effectivement consommé (les lots DDS, pas une moyenne). */
  let consumedCost = 0;

  db.exec("BEGIN");
  try {
    const lots = listLots(db, mint);
    let remaining = qty;

    for (const lot of lots) {
      if (remaining <= 1e-9) break;
      if (lot.remaining <= 1e-9) continue;

      const take = Math.min(lot.remaining, remaining);
      realized += (priceUsd - lot.priceUsd) * take;
      consumedCost += take * lot.priceUsd;
      remaining -= take;
      sold += take;

      db.prepare("UPDATE position_lots SET remaining = ? WHERE seq = ?").run(
        Math.max(0, lot.remaining - take),
        lot.seq,
      );
    }

    // Cas limite : une position **sans lots** (base restaurée, état
    // partiellement reconstruit). La FIFO n'a rien à consommer, mais la
    // position doit tout de même être clôturée — sinon elle resterait
    // ouverte pour toujours.
    if (lots.length === 0 && sold === 0) {
      realized = (priceUsd - position.avgEntryUsd) * position.qty;
      sold = position.qty;
      consumedCost = position.investedUsd;
    }

    const newQty = Math.max(0, position.qty - sold);
    // Le coût de revient restant est celui des lots **non consommés** :
    // une moyenne au prorata ferait dériver le prix moyen.
    const newInvested = Math.max(0, position.investedUsd - consumedCost);
    const newRealized = position.realizedPnlUsd + realized;
    const newAvg = newQty > 0 ? newInvested / newQty : 0;

    db.prepare(
      `UPDATE positions
          SET qty = ?, invested_usd = ?, avg_entry_usd = ?, realized_pnl_usd = ?, updated_ms = ?
        WHERE mint = ?`,
    ).run(newQty, newInvested, newAvg, newRealized, tsMs, mint);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const updated = getPosition(db, mint);
  return {
    position: updated && updated.qty > 0 ? updated : null,
    realizedPnlUsd: realized,
    soldQty: sold,
    proceedsUsd: sold * priceUsd,
  };
}

/** Pose (ou remplace) le stop-loss et le take-profit d'une position. */
export function setStops(
  db: DB,
  mint: string,
  stopLossUsd: number | null,
  takeProfitUsd: number | null,
  tsMs: number,
): void {
  db.prepare(
    "UPDATE positions SET stop_loss_usd = ?, take_profit_usd = ?, updated_ms = ? WHERE mint = ?",
  ).run(stopLossUsd, takeProfitUsd, tsMs, mint);
}

/** Met à jour le plus haut historique (base du trailing stop). */
export function updatePeak(db: DB, mint: string, priceUsd: number, tsMs: number): void {
  db.prepare(
    "UPDATE positions SET peak_price_usd = MAX(COALESCE(peak_price_usd, 0), ?), updated_ms = ? WHERE mint = ?",
  ).run(priceUsd, tsMs, mint);
}

/** PnL réalisé cumulé de toutes les positions. */
export function realizedPnlTotal(db: DB): number {
  const row = queryGet<{ total: number | null }>(
    db,
    "SELECT SUM(realized_pnl_usd) AS total FROM positions",
  );
  return row?.total ?? 0;
}
