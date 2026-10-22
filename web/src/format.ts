/** Formatage — partagé par toutes les vues. */

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/d";
  return `${value.toFixed(digits)} $`;
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/d";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)} %`;
}

export function qty(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/d";
  return value.toFixed(digits);
}

export function ago(tsMs: number | null | undefined, nowMs: number): string {
  if (!tsMs) return "jamais";
  const seconds = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86400)} j`;
}

export function dateTime(tsMs: number | null | undefined): string {
  if (!tsMs) return "—";
  return new Date(tsMs).toISOString().slice(0, 16).replace("T", " ");
}

export function classFor(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}
