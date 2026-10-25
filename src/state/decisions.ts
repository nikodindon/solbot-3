import type { DB } from "./db.js";
import { queryAll, queryGet } from "./sql.js";

/**
 * Journal de décisions.
 *
 * C'est la trace **explicable** du moteur : pour chaque tick, ce qui a été
 * décidé et pourquoi. Une décision sans ligne de journal est une décision
 * qui n'a jamais eu lieu.
 */

export type DecisionKind =
  | "signal"
  | "reject"
  | "trade"
  | "error"
  | "exit"
  | "note"
  | "regime"
  | "guard"
  /** Choix de la stratégie pilote par l'allocateur. */
  | "alloc";

export interface Decision {
  tsMs: number;
  tickId: number;
  kind: DecisionKind;
  strategy: string | null;
  mint: string | null;
  /** Une ligne lisible, journalisée telle quelle. */
  line: string;
  /** Données structurées complémentaires. */
  data?: Record<string, unknown>;
}

export function insertDecision(db: DB, decision: Decision): void {
  db.prepare(
    "INSERT INTO decisions (ts_ms, tick_id, kind, strategy, mint, line, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    decision.tsMs,
    decision.tickId,
    decision.kind,
    decision.strategy,
    decision.mint,
    decision.line,
    decision.data === undefined ? null : JSON.stringify(decision.data),
  );
}

export function insertDecisions(db: DB, decisions: Decision[]): void {
  if (decisions.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const decision of decisions) insertDecision(db, decision);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface DecisionsJournalStats {
  /** Total des lignes du journal. */
  total: number;
  /** Groupes contenant au moins deux lignes strictement identiques. */
  duplicateGroups: number;
  /** Lignes redondantes (total − une par groupe). */
  duplicateRows: number;
}

/**
 * État du journal : combien de lignes sont strictement redondantes.
 *
 * « Strictement identique » = même tick, même type, même stratégie, même
 * actif, même texte. Ces doublons viennent de ce que le portefeuille
 * fantôme et le livre réel écrivent la même phrase — ils n'apportent rien
 * et doublent le poids de la table.
 */
export function decisionsJournalStats(db: DB): DecisionsJournalStats {
  const row = queryGet<{ total: number; groups: number; dup_rows: number | null }>(
    db,
    `SELECT (SELECT COUNT(*) FROM decisions) AS total,
            COUNT(*) AS groups,
            COALESCE(SUM(c - 1), 0) AS dup_rows
       FROM (SELECT COUNT(*) AS c
               FROM decisions
              GROUP BY ts_ms, tick_id, kind, strategy, mint, line
             HAVING COUNT(*) > 1)`,
  );
  return {
    total: row?.total ?? 0,
    duplicateGroups: row?.groups ?? 0,
    duplicateRows: row?.dup_rows ?? 0,
  };
}

/**
 * Supprime les décisions strictement redondantes, en conservant la première
 * écrite de chaque groupe.
 *
 * Perte nulle : les lignes supprimées sont des copies exactes. Renvoie le
 * nombre de lignes supprimées.
 */
export function dedupeDecisions(db: DB): number {
  const result = db
    .prepare(
      `DELETE FROM decisions
        WHERE id NOT IN (
          SELECT MIN(id)
            FROM decisions
           GROUP BY ts_ms, tick_id, kind, strategy, mint, line
        )`,
    )
    .run();
  return Number(result.changes);
}

export function listDecisions(
  db: DB,
  options: { limit?: number; kind?: DecisionKind[]; strategy?: string; mint?: string } = {},
): Decision[] {
  const limit = options.limit ?? 200;
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.kind && options.kind.length > 0) {
    where.push(`kind IN (${options.kind.map(() => "?").join(",")})`);
    params.push(...options.kind);
  }
  if (options.strategy) {
    where.push("strategy = ?");
    params.push(options.strategy);
  }
  if (options.mint) {
    where.push("mint = ?");
    params.push(options.mint);
  }

  const sql = `SELECT * FROM decisions
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC LIMIT ?`;
  params.push(limit);

  const rows = queryAll<{
    ts_ms: number;
    tick_id: number;
    kind: string;
    strategy: string | null;
    mint: string | null;
    line: string;
    data: string | null;
  }>(db, sql, ...params);

  return rows.map((row) => ({
    tsMs: row.ts_ms,
    tickId: row.tick_id,
    kind: row.kind as DecisionKind,
    strategy: row.strategy,
    mint: row.mint,
    line: row.line,
    data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : undefined,
  }));
}

/** Compteur de rejets par règle — l'outil de réglage principal. */
export function countRejectionsByRule(db: DB, sinceMs: number): Record<string, number> {
  const rows = queryAll<{ rule: string; n: number }>(
    db,
    `SELECT json_extract(data, '$.rule') AS rule, COUNT(*) AS n
       FROM decisions
      WHERE kind = 'reject' AND ts_ms >= ?
      GROUP BY rule ORDER BY n DESC`,
    sinceMs,
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.rule) out[row.rule] = row.n;
  }
  return out;
}
