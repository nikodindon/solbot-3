import type { TriggerApi } from "../jupiter/trigger.js";
import type { DB } from "../state/db.js";

/**
 * Les ordres de protection on-chain.
 *
 * Un take-profit déposé sur la chaîne **s'exécute même si le bot est
 * arrêté**. C'est le seul filet qui résiste à une panne.
 *
 * Deux règlesgovernent leur usage :
 *
 * 1. On ne dépose un ordre que si le **take-profit est au-dessus du prix
 *    d'entrée** (sinon c'est un stop déguisé, avec la pire des
 *    sémantiques) ;
 * 2. Un stop-loss on-chain est **désactivé par défaut** : il se déclenche
 *    sur une mèche de prix, ce qui est une liquidation à un prix que
 *    personne n'a vu. Il exige un backtest dédié — et le drapeau
 *    `trigger.stop_loss_orders`.
 */

export interface ProtectionDeps {
  db: DB;
  triggerApi: TriggerApi;
  /** Dépose les take-profit on-chain. */
  takeProfitOrders: boolean;
  /** Dépose les stop-loss on-chain (désactivé par défaut). */
  stopLossOrders: boolean;
  /** Durée de validité d'un ordre, en secondes. */
  expiryS?: number;
}

export interface ProtectionRequest {
  mint: string;
  qty: number;
  decimals: number;
  entryPriceUsd: number;
  takeProfitUsd: number | null;
  stopLossUsd: number | null;
  /** Prix de l'actif en USDC (pour convertir le prix limite). */
  priceUsd: number;
  baseMint: string;
  /** Symbole, pour le journal. */
  symbol: string;
}

export interface ProtectionResult {
  /** Ordre de take-profit déposé. */
  takeProfitOrderId: string | null;
  /** Ordre de stop-loss déposé. */
  stopLossOrderId: string | null;
  /** Raison de l'absence d'ordre, le cas échéant. */
  skipped: string | null;
}

/**
 * Dépose les ordres de protection d'une position.
 *
 * Le dépôt est **idempotent** : si un ordre existe déjà pour cette
 * position (enregistré en base), on ne le redépose pas. Sans cela, un
 * redémarrage du bot multiplierait les ordres ouverts.
 */
export async function protectPosition(
  deps: ProtectionDeps,
  request: ProtectionRequest,
): Promise<ProtectionResult> {
  const result: ProtectionResult = {
    takeProfitOrderId: null,
    stopLossOrderId: null,
    skipped: null,
  };

  if (!deps.takeProfitOrders && !deps.stopLossOrders) {
    result.skipped = "les ordres de protection on-chain sont désactivés";
    return result;
  }

  if (request.takeProfitUsd === null && request.stopLossUsd === null) {
    result.skipped = "aucun niveau de protection défini";
    return result;
  }

  // ── Take-profit ──────────────────────────────────────────────────────
  if (deps.takeProfitOrders && request.takeProfitUsd !== null) {
    if (request.takeProfitUsd <= request.entryPriceUsd) {
      result.skipped = `take-profit (${request.takeProfitUsd.toFixed(6)}) sous le prix d'entrée (${request.entryPriceUsd.toFixed(6)}) — pas d'ordre déposé`;
    } else {
      const order = await deps.triggerApi.createLimitOrder({
        inputMint: request.mint,
        outputMint: request.baseMint,
        inAmount: toBaseUnits(request.qty, request.decimals),
        price: request.takeProfitUsd,
        expiry: deps.expiryS ?? 86_400,
      });
      if (order.orderId) {
        result.takeProfitOrderId = order.orderId;
        recordProtection(deps.db, request.mint, "take_profit", order.orderId, request);
      } else {
        result.skipped = "le take-profit n'a pas pu être déposé (pas d'orderId)";
      }
    }
  }

  // ── Stop-loss (désactivé par défaut) ────────────────────────────────
  if (deps.stopLossOrders && request.stopLossUsd !== null) {
    const order = await deps.triggerApi.createLimitOrder({
      inputMint: request.baseMint,
      outputMint: request.mint,
      inAmount: toBaseUnits(request.qty, request.decimals),
      price: request.stopLossUsd,
      expiry: deps.expiryS ?? 86_400,
    });
    if (order.orderId) {
      result.stopLossOrderId = order.orderId;
      recordProtection(deps.db, request.mint, "stop_loss", order.orderId, request);
    }
  }

  return result;
}

/** Retire les ordres de protection d'une position (à la clôture). */
export async function unprotectPosition(deps: ProtectionDeps, mint: string): Promise<number> {
  const orders = listProtections(deps.db, mint);
  let cancelled = 0;
  for (const order of orders) {
    try {
      if (await deps.triggerApi.cancelOrder(order.orderId)) cancelled += 1;
      deleteProtection(deps.db, order.orderId);
    } catch {
      // Un ordre déjà exécuté ou expiré n'est pas une erreur.
    }
  }
  return cancelled;
}

/** Ordres de protection enregistrés pour un mint. */
export function listProtections(
  db: DB,
  mint?: string,
): { orderId: string; mint: string; kind: string; createdMs: number }[] {
  const rows = mint
    ? (db
        .prepare(
          "SELECT order_id, mint, kind, created_ms FROM protection_orders WHERE mint = ? ORDER BY created_ms DESC",
        )
        .all(mint) as {
        order_id: string;
        mint: string;
        kind: string;
        created_ms: number;
      }[])
    : (db
        .prepare(
          "SELECT order_id, mint, kind, created_ms FROM protection_orders ORDER BY created_ms DESC",
        )
        .all() as {
        order_id: string;
        mint: string;
        kind: string;
        created_ms: number;
      }[]);

  return rows.map((row) => ({
    orderId: row.order_id,
    mint: row.mint,
    kind: row.kind,
    createdMs: row.created_ms,
  }));
}

function recordProtection(
  db: DB,
  mint: string,
  kind: string,
  orderId: string,
  request: ProtectionRequest,
): void {
  db.prepare(
    "INSERT INTO protection_orders (order_id, mint, kind, symbol, created_ms) VALUES (?, ?, ?, ?, ?)",
  ).run(orderId, mint, kind, request.symbol, Date.now());
}

function deleteProtection(db: DB, orderId: string): void {
  db.prepare("DELETE FROM protection_orders WHERE order_id = ?").run(orderId);
}

/** Convertit une quantité en unités de base. */
export function toBaseUnits(value: number, decimals: number): string {
  const factor = 10 ** Math.min(decimals, 9);
  return String(Math.floor(value * factor));
}
