/** Helpers numériques partagés (aucune dépendance externe). */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Écart-type de population. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = sum(values.map((v) => (v - mean) ** 2)) / values.length;
  return Math.sqrt(variance);
}

/**
 * Rang percentile d'une valeur dans un échantillon (0..1).
 * Utilisé pour la détection de régime (volatilité anormale).
 */
export function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return 0;
  let below = 0;
  for (const v of values) {
    if (v < value) below += 1;
  }
  return below / values.length;
}

/** Découpe un tableau en lots de taille `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk(): size doit être > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Division sûre : retourne `fallback` si le dénominateur est nul. */
export function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  return denominator === 0 ? fallback : numerator / denominator;
}

/** Arrondi à un pas donné (utile pour les quantités en unités de base). */
export function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
