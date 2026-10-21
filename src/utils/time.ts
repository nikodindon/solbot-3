/** Helpers temporels (UTC uniquement — le bot raisonne en journée UTC). */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clé de journée UTC au format `YYYY-MM-DD`. */
export function utcDayKey(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Horodatage du prochain minuit UTC (strictement futur). */
export function nextUtcMidnight(ts: number = Date.now()): number {
  const day = new Date(ts);
  const midnight = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return midnight;
}

/** Durée écoulée en secondes, arrondie à l'entier. */
export function secondsSince(ts: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - ts) / 1000));
}
