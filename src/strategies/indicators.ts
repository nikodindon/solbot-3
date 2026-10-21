/**
 * Indicateurs techniques — fonctions pures, déterministes.
 *
 * Règle absolue : **une valeur non calculable vaut `null`**, jamais une
 * approximation silencieuse. Une stratégie qui reçoit `null` sait qu'elle
 * n'a pas assez d'histoire ; une stratégie qui reçoit `0` croit que le
 * marché est plat.
 */

export interface Series {
  values: number[];
}

/** Moyenne mobile exponentielle, amorcée par une SMA. */
export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i] ?? 0;
  let ema = sum / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] ?? 0) * k + ema * (1 - k);
  }
  return ema;
}

/** Série d'EMA (une valeur par point, à partir de la période). */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  if (values.length < period || period <= 0) return values.map(() => null);

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i] ?? 0;
  let current = sum / period;

  for (let i = 0; i < period - 1; i++) out.push(null);
  out.push(current);

  for (let i = period; i < values.length; i++) {
    current = (values[i] ?? 0) * k + current * (1 - k);
    out.push(current);
  }
  return out;
}

/** RSI de Wilder. */
export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1 || period <= 0) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range de Wilder. */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number | null {
  if (closes.length < period + 1 || period <= 0) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const high = highs[i] ?? 0;
    const low = lows[i] ?? 0;
    const prevClose = closes[i - 1] ?? 0;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trueRanges.length < period) return null;

  let value = 0;
  for (let i = 0; i < period; i++) value += trueRanges[i] ?? 0;
  let atr = value / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + (trueRanges[i] ?? 0)) / period;
  }
  return atr;
}

/** Plus haut des `period` dernières bougies, **hors bougie courante**. */
export function highestHigh(highs: number[], period: number): number | null {
  if (highs.length <= period || period <= 0) return null;
  let best = -Infinity;
  for (let i = highs.length - 1 - period; i < highs.length - 1; i++) {
    const value = highs[i];
    if (value !== undefined && value > best) best = value;
  }
  return Number.isFinite(best) ? best : null;
}

/** Plus bas des `period` dernières bougies, **hors bougie courante**. */
export function lowestLow(lows: number[], period: number): number | null {
  if (lows.length <= period || period <= 0) return null;
  let best = Infinity;
  for (let i = lows.length - 1 - period; i < lows.length - 1; i++) {
    const value = lows[i];
    if (value !== undefined && value < best) best = value;
  }
  return Number.isFinite(best) ? best : null;
}

/** Z-score du dernier prix par rapport à une moyenne glissante. */
export function zScore(values: number[], window: number): number | null {
  if (values.length < window || window <= 1) return null;
  const slice = values.slice(-window);
  const mean = slice.reduce((sum, v) => sum + v, 0) / slice.length;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / slice.length;
  const sigma = Math.sqrt(variance);
  const last = values[values.length - 1];
  if (last === undefined || sigma === 0) return null;
  return (last - mean) / sigma;
}

/** Médiane d'un échantillon. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Écart-type de population, en bps de variation logarithmique. */
export function volBpsPerBar(closes: number[], window: number): number | null {
  if (closes.length < window + 1 || window <= 1) return null;
  const slice = closes.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1] ?? 0;
    const current = slice[i] ?? 0;
    if (prev <= 0) return null;
    returns.push(Math.log(current / prev) * 10_000);
  }
  const mean = returns.reduce((sum, v) => sum + v, 0) / returns.length;
  const variance = returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/** Pente d'une moyenne mobile, en bps par bougie. */
export function emaSlopeBps(values: number[], period: number): number | null {
  const series = emaSeries(values, period).filter((v): v is number => v !== null);
  if (series.length < 2) return null;
  const last = series[series.length - 1] ?? 0;
  const previous = series[series.length - 2] ?? 0;
  if (previous <= 0) return null;
  return ((last - previous) / previous) * 10_000;
}

/** Borne la valeur entre `min` et `max`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
