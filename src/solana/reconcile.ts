import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { DB } from "../state/db.js";
import { insertEvent } from "../state/events.js";
import { addLot, listPositions, reducePositionFifo, setStops } from "../state/portfolio-repo.js";
import { insertTrade } from "../state/trades.js";
import { tokenAmountOf, tokenDecimalsOf, tokenInfoOf } from "./tokens.js";
import { getTokenMeta } from "../state/market-data.js";

/**
 * Réconciliation on-chain.
 *
 * Au démarrage, **la chaîne fait foi**. Chaque position locale est
 * comparée au solde réel :
 * - **adoptée** : le solde est là, la position locale non ;
 * - **ajustée** : les quantités diffèrent (FIFO) ;
 * - **clôturée** : la position locale existe, le solde non.
 *
 * Chaque action est journalisée. Une divergence non expliquée est un signal
 * d'alerte : la réconciliation **n'efface rien** silencieusement, elle
 * trace.
 */

export interface ChainBalance {
  mint: string;
  amount: number;
  decimals: number;
}

export interface ReconciliationOptions {
  db: DB;
  connection: Connection;
  /** Adresse du wallet (le taker). */
  owner: string;
  /** Soldes des tokens SPL, hors devise de base. */
  balances: ChainBalance[];
  /** Mints de la devise de base : ils ne sont jamais adoptés comme position. */
  baseMint: string;
  /** Stop-loss par défaut, en %. */
  defaultStopLossPct: number;
  /** Take-profit par défaut, en %. */
  defaultTakeProfitPct: number;
  /** Prix de référence, pour valoriser les positions adoptées. */
  prices: Map<string, number>;
  nowMs?: number;
}

export type ReconciliationAction = "adopted" | "adjusted" | "closed" | "skipped";

export interface ReconciliationEntry {
  action: ReconciliationAction;
  mint: string;
  symbol: string;
  localQty: number;
  chainQty: number;
  note: string;
}

export interface ReconciliationResult {
  entries: ReconciliationEntry[];
  adopted: number;
  adjusted: number;
  closed: number;
  skipped: number;
}

/** Soldes SPL du wallet, hors devise de base. */
export async function fetchChainBalances(
  connection: Connection,
  owner: string,
  baseMint: string,
): Promise<ChainBalance[]> {
  const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  const out: ChainBalance[] = [];
  for (const { account } of accounts.value) {
    const info = tokenInfoOf(account);
    const mint = info.mint;
    if (typeof mint !== "string" || mint === baseMint) continue;
    const numeric = tokenAmountOf(account);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    out.push({ mint, amount: numeric, decimals: tokenDecimalsOf(account) });
  }
  return out;
}

/**
 * Réconcilie le portefeuille local avec la chaîne.
 *
 * L'ordre est important : on traite d'abord les positions locales (ajuster
 * ou clôturer), puis on adopte ce qui reste sur la chaîne et que le local
 * ignore.
 */
export function reconcileBalances(options: ReconciliationOptions): ReconciliationResult {
  const { db, balances, baseMint } = options;
  const nowMs = options.nowMs ?? Date.now();

  const entries: ReconciliationEntry[] = [];
  const chainByMint = new Map(balances.map((balance) => [balance.mint, balance]));

  // ── 1. Positions locales ───────────────────────────────────────────
  for (const position of listPositions(db)) {
    const chain = chainByMint.get(position.mint);
    const chainQty = chain ? chain.amount / 10 ** chain.decimals : 0;

    if (chainQty <= 0) {
      // La position n'existe plus on-chain : on la clôture.
      const reduce = reducePositionFifo(
        db,
        position.mint,
        position.qty,
        position.avgEntryUsd,
        nowMs,
      );
      entries.push({
        action: "closed",
        mint: position.mint,
        symbol: position.symbol,
        localQty: position.qty,
        chainQty: 0,
        note: `clôturée : plus de solde on-chain (PnL ${reduce.realizedPnlUsd.toFixed(2)} $)`,
      });
      insertTrade(db, {
        tsMs: nowMs,
        mode: "live",
        strategy: "reconcile",
        mint: position.mint,
        symbol: position.symbol,
        side: "sell",
        priceUsd: position.avgEntryUsd,
        qty: position.qty,
        notionalUsd: position.qty * position.avgEntryUsd,
        feeUsd: 0,
        realizedPnlUsd: reduce.realizedPnlUsd,
        reason: "réconciliation : position close on-chain",
        signature: null,
        status: "reconciled",
      });
      continue;
    }

    if (Math.abs(chainQty - position.qty) < 1e-9) continue; // rien à faire

    if (chainQty < position.qty) {
      // La chaîne a moins : on vend l'excédent (FIFO).
      const delta = position.qty - chainQty;
      const price = options.prices.get(position.mint) ?? position.avgEntryUsd;
      const reduce = reducePositionFifo(db, position.mint, delta, price, nowMs);
      entries.push({
        action: "adjusted",
        mint: position.mint,
        symbol: position.symbol,
        localQty: position.qty,
        chainQty,
        note: `ajustée : ${delta.toFixed(6)} unité(s) vendue(s) pour coller à la chaîne (PnL ${reduce.realizedPnlUsd.toFixed(2)} $)`,
      });
      continue;
    }

    // La chaîne a plus : on adopte l'excédent comme nouveau lot.
    const delta = chainQty - position.qty;
    const price = options.prices.get(position.mint);
    if (price === undefined) {
      entries.push({
        action: "skipped",
        mint: position.mint,
        symbol: position.symbol,
        localQty: position.qty,
        chainQty,
        note: "ajustement impossible : aucun prix de référence",
      });
      continue;
    }
    addLot(db, position.mint, position.symbol, delta, price, nowMs);
    entries.push({
      action: "adjusted",
      mint: position.mint,
      symbol: position.symbol,
      localQty: position.qty,
      chainQty,
      note: `ajustée : ${delta.toFixed(6)} unité(s) adoptée(s) à ${price.toFixed(6)} $`,
    });
  }

  // ── 2. Actifs présents sur la chaîne et inconnus du local ──────────
  const localMints = new Set(listPositions(db).map((position) => position.mint));
  for (const balance of balances) {
    if (balance.mint === baseMint) continue;
    if (localMints.has(balance.mint)) continue;

    const qty = balance.amount / 10 ** balance.decimals;
    if (qty <= 0) continue;

    const price = options.prices.get(balance.mint);
    const symbol = getTokenMeta(db, balance.mint)?.symbol ?? `${balance.mint.slice(0, 4)}…`;

    if (price === undefined) {
      entries.push({
        action: "skipped",
        mint: balance.mint,
        symbol,
        localQty: 0,
        chainQty: qty,
        note: "adoption impossible : aucun prix de référence (l'actif reste sur la chaîne)",
      });
      continue;
    }

    addLot(db, balance.mint, symbol, qty, price, nowMs);
    setStops(
      db,
      balance.mint,
      price * (1 - options.defaultStopLossPct / 100),
      price * (1 + options.defaultTakeProfitPct / 100),
      nowMs,
    );
    insertTrade(db, {
      tsMs: nowMs,
      mode: "live",
      strategy: "reconcile",
      mint: balance.mint,
      symbol,
      side: "buy",
      priceUsd: price,
      qty,
      notionalUsd: qty * price,
      feeUsd: 0,
      realizedPnlUsd: null,
      reason: "réconciliation : position adoptée depuis la chaîne",
      signature: null,
      status: "reconciled",
    });

    entries.push({
      action: "adopted",
      mint: balance.mint,
      symbol,
      localQty: 0,
      chainQty: qty,
      note: `adoptée : ${qty.toFixed(6)} unité(s) à ${price.toFixed(6)} $`,
    });
  }

  // ── 3. Journal ─────────────────────────────────────────────────────
  for (const entry of entries) {
    insertEvent(db, {
      tsMs: nowMs,
      level: entry.action === "skipped" ? "warn" : "info",
      kind: `reconcile_${entry.action}`,
      message: `${entry.symbol} (${entry.action}) — ${entry.note}`,
      details: JSON.stringify({
        mint: entry.mint,
        localQty: entry.localQty,
        chainQty: entry.chainQty,
      }),
    });
  }

  return {
    entries,
    adopted: entries.filter((e) => e.action === "adopted").length,
    adjusted: entries.filter((e) => e.action === "adjusted").length,
    closed: entries.filter((e) => e.action === "closed").length,
    skipped: entries.filter((e) => e.action === "skipped").length,
  };
}
