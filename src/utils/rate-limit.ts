import { sleep } from "./time.js";

/**
 * Token bucket — contrôle le débit sortant vers Jupiter.
 *
 * Le débit par défaut est imposé par le plan Jupiter : 0,5 req/s sans clé,
 * 1 req/s avec une clé (Free). `JUPITER_RPS` permet de forcer une autre valeur.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  readonly stats = {
    acquired: 0,
    waits: 0,
    totalWaitMs: 0,
    rejected: 0,
  };

  constructor(
    readonly ratePerSecond: number,
    readonly burst: number = Math.max(1, Math.ceil(ratePerSecond)),
  ) {
    if (ratePerSecond <= 0) throw new Error("TokenBucket: ratePerSecond doit être > 0");
    this.tokens = this.burst;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSecond);
    this.lastRefillMs = now;
  }

  /** Tente de prendre un jeton sans attendre. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.stats.acquired += 1;
      return true;
    }
    this.stats.rejected += 1;
    return false;
  }

  /** Millisecondes à attendre avant le prochain jeton disponible. */
  waitTimeMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const missing = 1 - this.tokens;
    return Math.ceil((missing / this.ratePerSecond) * 1000);
  }

  /** Attend l'obtention d'un jeton (bloquant). */
  async acquire(): Promise<void> {
    while (!this.tryAcquire()) {
      const wait = this.waitTimeMs();
      this.stats.waits += 1;
      this.stats.totalWaitMs += wait;
      await sleep(Math.max(1, Math.min(wait, 2_000)));
    }
  }
}
