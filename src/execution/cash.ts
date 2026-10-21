import type { DB } from "../state/db.js";
import { kvGetNumber, kvSetNumber, STATE_KEYS } from "../state/kv.js";
import type { CashLedger } from "./executor.js";

/**
 * Cash virtuel, adossé au `bot_state`.
 *
 * Le paper et le backtest partagent **le même** ledger : c'est ce qui rend
 * leurs chiffres directement comparables.
 */
export class KvCash implements CashLedger {
  constructor(
    private readonly db: DB,
    private readonly initialUsdc: number,
  ) {}

  cashUsd(): number {
    return kvGetNumber(this.db, STATE_KEYS.paperCashUsdc) ?? this.initialUsdc;
  }

  solBalance(): number | null {
    return kvGetNumber(this.db, STATE_KEYS.paperSolBalance);
  }

  debit(usd: number): void {
    if (usd <= 0) return;
    kvSetNumber(this.db, STATE_KEYS.paperCashUsdc, this.cashUsd() - usd);
  }

  credit(usd: number): void {
    if (usd <= 0) return;
    kvSetNumber(this.db, STATE_KEYS.paperCashUsdc, this.cashUsd() + usd);
  }

  /**
   * Alimente le cash de départ **s'il n'existe pas encore**.
   *
   * Le portefeuille paper est **persistant** : un redémarrage doit retrouver
   * exactement l'état où il s'était arrêté (cash **et** positions). Réinitialiser
   * le cash à chaque démarrage, en laissant les positions en place, produirait
   * un NAV faux — c'est le bug que ce correctif adresse.
   */
  seed(usdc: number = this.initialUsdc): void {
    if (kvGetNumber(this.db, STATE_KEYS.paperCashUsdc) !== null) return;
    kvSetNumber(this.db, STATE_KEYS.paperCashUsdc, usdc);
  }
}
