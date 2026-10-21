/** Petits helpers d'affichage CLI (stdout lisible, en plus des logs JSON structurés). */

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(color: string, text: string): string {
  return useColor ? `${color}${text}${RESET}` : text;
}

export function heading(title: string): void {
  const width = Math.max(0, 58 - title.length);
  console.log(`\n  ${paint(DIM, "──")} ${title} ${paint(DIM, "─".repeat(width))}`);
}

export function ok(label: string, detail?: string): void {
  console.log(`  ${paint(GREEN, "✔")} ${label}${detail ? ` ${paint(DIM, detail)}` : ""}`);
}

export function fail(label: string, detail?: string): void {
  console.log(`  ${paint(RED, "✘")} ${label}${detail ? ` ${paint(DIM, detail)}` : ""}`);
}

export function warn(label: string, detail?: string): void {
  console.log(`  ${paint(YELLOW, "!")} ${label}${detail ? ` ${paint(DIM, detail)}` : ""}`);
}

export function info(label: string, detail?: string): void {
  console.log(`  ${paint(DIM, "·")} ${label}${detail ? ` ${paint(DIM, detail)}` : ""}`);
}

export function note(text: string): void {
  console.log(`    ${paint(DIM, text)}`);
}

export function blank(): void {
  console.log("");
}
