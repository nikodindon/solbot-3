import type { DB } from "../state/db.js";
import { queryAll, queryGet } from "../state/sql.js";

/**
 * Portefeuilles fantômes.
 *
 * Chaque stratégie active joue **son propre portefeuille** en parallèle du
 * capital réel. Un shadow n'est pas une simulation simplifiée : c'est le
 * même moteur de décision, appliqué à un livre virtuel, avec les mêmes
 * coûts. L'allocateur compare ensuite les performances et choisit la
 * stratégie qui pilote le capital réel.
 *
 * L'état d'un shadow est **reconstruit à partir de ses trades** (et non
 * stocké à part) : il ne peut pas y avoir de désynchronisation entre l'état
 * affiché et l'historique qui l'a produit.
 *
 * Le shadow utilise un **coût de revient moyen pondéré**, là où le capital
 * réel utilise le FIFO. C'est un choix assumé : un shadow n'a pas vocation
 * à être un ledger d'audit, il doit être **comparable** entre stratégies,
 * et le FIFO n'apporterait rien à cette comparaison.
 */

export interface ShadowPosition {
  mint: string;
  qty: number;
  avgEntryUsd: number;
  valueUsd: number;
}

export interface ShadowTrade {
  tsMs: number;
  mint: string;
  side: "buy" | "sell";
  qty: number;
  priceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  pnlUsd: number | null;
}

export interface ShadowBook {
  name: string;
  cashUsd: number;
  positions: Map<string, ShadowPosition>;
  /** Trades de la fenêtre courante, pour le score. */
  recentTrades: number;
}

export interface ShadowBookSpec {
  /** Capital virtuel initial du shadow. */
  initialCashUsd: number;
  /** Fraction du NAV investie par position (miroir du RiskManager réel). */
  positionPct: number;
}

/** Insère un trade de shadow. */
export function insertShadowTrade(db: DB, shadow: string, trade: ShadowTrade): void {
  db.prepare(
    `INSERT INTO shadow_trades
       (shadow, ts_ms, mint, side, qty, price_usd, notional_usd, fee_usd, pnl_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    shadow,
    trade.tsMs,
    trade.mint,
    trade.side,
    trade.qty,
    trade.priceUsd,
    trade.notionalUsd,
    trade.feeUsd,
    trade.pnlUsd,
  );
}

/** Enregistre un point de NAV pour un shadow. */
export function insertShadowNav(db: DB, shadow: string, tsMs: number, navUsd: number): void {
  db.prepare(
    `INSERT INTO shadow_nav (shadow, ts_ms, nav_usd) VALUES (?, ?, ?)
     ON CONFLICT(shadow, ts_ms) DO UPDATE SET nav_usd = excluded.nav_usd`,
  ).run(shadow, tsMs, navUsd);
}

/** Trades d'un shadow, du plus ancien au plus récent. */
export function listShadowTrades(
  db: DB,
  shadow: string,
  sinceMs?: number,
): {
  tsMs: number;
  mint: string;
  side: string;
  qty: number;
  priceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  pnlUsd: number | null;
}[] {
  const params: (string | number)[] = [shadow];
  let where = "shadow = ?";
  if (sinceMs !== undefined) {
    where += " AND ts_ms >= ?";
    params.push(sinceMs);
  }
  return queryAll<{
    ts_ms: number;
    mint: string;
    side: string;
    qty: number;
    price_usd: number;
    notional_usd: number;
    fee_usd: number;
    pnl_usd: number | null;
  }>(db, `SELECT * FROM shadow_trades WHERE ${where} ORDER BY ts_ms ASC, id ASC`, ...params).map(
    (row) => ({
      tsMs: row.ts_ms,
      mint: row.mint,
      side: row.side,
      qty: row.qty,
      priceUsd: row.price_usd,
      notionalUsd: row.notional_usd,
      feeUsd: row.fee_usd,
      pnlUsd: row.pnl_usd,
    }),
  );
}

/** Nombre de trades d'un shadow sur une fenêtre. */
export function shadowTradeCount(db: DB, shadow: string, sinceMs: number): number {
  const row = queryGet<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM shadow_trades WHERE shadow = ? AND ts_ms >= ?",
    shadow,
    sinceMs,
  );
  return row?.n ?? 0;
}

/** Série de NAV d'un shadow (du plus ancien au plus récent). */
export function shadowNavSeries(
  db: DB,
  shadow: string,
  sinceMs?: number,
): { tsMs: number; navUsd: number }[] {
  const params: (string | number)[] = [shadow];
  let where = "shadow = ?";
  if (sinceMs !== undefined) {
    where += " AND ts_ms >= ?";
    params.push(sinceMs);
  }
  return queryAll<{ ts_ms: number; nav_usd: number }>(
    db,
    `SELECT ts_ms, nav_usd FROM shadow_nav WHERE ${where} ORDER BY ts_ms ASC`,
    ...params,
  ).map((row) => ({ tsMs: row.ts_ms, navUsd: row.nav_usd }));
}

/**
 * Reconstruit l'état d'un shadow à partir de ses trades.
 *
 * Reconstruction **complète** : le cash et les positions sont redérivés de
 * l'historique. Si les deux divergeaient, l'allocateur comparerait des
 * chiffres qui n'existent pas.
 */
export function loadShadowBook(
  db: DB,
  name: string,
  spec: ShadowBookSpec,
  sinceMs?: number,
): ShadowBook {
  const book: ShadowBook = {
    name,
    cashUsd: spec.initialCashUsd,
    positions: new Map(),
    recentTrades: 0,
  };

  for (const trade of listShadowTrades(db, name, sinceMs)) {
    if (trade.side === "buy") {
      book.cashUsd -= trade.notionalUsd + trade.feeUsd;
      const position = book.positions.get(trade.mint);
      if (position) {
        const qty = position.qty + trade.qty;
        position.avgEntryUsd =
          qty > 0
            ? (position.avgEntryUsd * position.qty + trade.priceUsd * trade.qty) / qty
            : trade.priceUsd;
        position.qty = qty;
      } else {
        book.positions.set(trade.mint, {
          mint: trade.mint,
          qty: trade.qty,
          avgEntryUsd: trade.priceUsd,
          valueUsd: trade.qty * trade.priceUsd,
        });
      }
      book.recentTrades += 1;
    } else {
      const position = book.positions.get(trade.mint);
      book.cashUsd += trade.notionalUsd - trade.feeUsd;
      if (position) {
        position.qty = Math.max(0, position.qty - trade.qty);
        if (position.qty <= 1e-9) book.positions.delete(trade.mint);
      }
      book.recentTrades += 1;
    }
  }

  return book;
}

/** NAV d'un shadow à un instant donné, à partir de sa série et de ses prix. */
export function shadowNav(book: ShadowBook, prices: Map<string, number>): number {
  let positionsValue = 0;
  for (const position of book.positions.values()) {
    const price = prices.get(position.mint) ?? position.avgEntryUsd;
    positionsValue += position.qty * price;
  }
  return book.cashUsd + positionsValue;
}
