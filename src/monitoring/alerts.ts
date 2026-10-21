import type { DB } from "../state/db.js";
import { kvGetNumber, kvSetNumber } from "../state/kv.js";

/**
 * Alertes avec cooldown **persisté**.
 *
 * Le cooldown est stocké en base et non en mémoire : une alerte ne doit pas
 * se redéclencher à chaque redémarrage du bot. C'est la différence entre
 * une alerte utile et un spam.
 */

export type AlertKind =
  | "gas_reserve"
  | "market_failure"
  | "execution_failure"
  | "reconciliation"
  | "kill_switch"
  | "stale_data"
  | "parity";

export interface AlertRule {
  kind: AlertKind;
  /** Délai minimal entre deux alertes de même nature, en minutes. */
  cooldownMin: number;
  /** Message affiché. */
  message: string;
  /** Gravité : `warning` ou `critical`. */
  severity: "warning" | "critical";
}

export interface AlertContext {
  db: DB;
  nowMs?: number;
}

export interface AlertDecision {
  /** L'alerte doit-elle être émise ? */
  emit: boolean;
  /** Raison de la non-émission (cooldown). */
  reason: string | null;
  rule: AlertRule;
}

function cooldownKey(kind: AlertKind): string {
  return `alert_last_${kind}`;
}

/**
 * Décide si une alerte doit être émise, et mémorise le cooldown.
 *
 * La décision et l'écriture du cooldown sont **atomiques du point de vue
 * de l'appelant** : `emit` est vrai une seule fois par fenêtre de cooldown.
 */
export function shouldEmitAlert(context: AlertContext, rule: AlertRule): AlertDecision {
  const { db } = context;
  const nowMs = context.nowMs ?? Date.now();
  const key = cooldownKey(rule.kind);
  const last = kvGetNumber(db, key);

  if (last !== null) {
    const elapsedMin = (nowMs - last) / 60_000;
    if (elapsedMin < rule.cooldownMin) {
      const remaining = Math.ceil(rule.cooldownMin - elapsedMin);
      return {
        emit: false,
        reason: `cooldown actif (${remaining} min restantes)`,
        rule,
      };
    }
  }

  kvSetNumber(db, key, nowMs, nowMs);
  return { emit: true, reason: null, rule };
}

/** Dernier déclenchement d'une alerte (pour le dashboard). */
export function lastAlertAt(db: DB, kind: AlertKind): number | null {
  return kvGetNumber(db, cooldownKey(kind));
}
