import fs from "node:fs";
import path from "node:path";
import { computeMetrics, type ClosedTrade } from "../backtest/metrics.js";
import { listEquity } from "../state/equity.js";
import { listTrades } from "../state/trades.js";
import { listPositions } from "../state/portfolio-repo.js";
import type { DB } from "../state/db.js";

/**
 * Rapport quotidien en HTML.
 *
 * Un rapport **autonome** : un seul fichier, ouvrable dans un navigateur,
 * sans serveur ni dépendance. C'est ce qu'on veut le matin : un fichier
 * qu'on peut lire, archiver ou envoyer.
 *
 * Il est écrit dans `data/reports/`, hors du dépôt : c'est un artefact
 * d'exécution, pas une source.
 */

export interface DailyReportInput {
  /** Date du rapport (YYYY-MM-DD). */
  day: string;
  mode: string;
  equity: { tsMs: number; navUsd: number; cashUsd: number; positionsUsd: number }[];
  trades: {
    tsMs: number;
    symbol: string;
    side: "buy" | "sell";
    priceUsd: number;
    qty: number;
    notionalUsd: number;
    feeUsd: number;
    realizedPnlUsd: number | null;
    strategy: string;
    status: string;
  }[];
  positions: {
    symbol: string;
    qty: number;
    avgEntryUsd: number;
    valueUsd: number;
    unrealizedPct: number;
  }[];
  initialUsd: number;
}

export function renderDailyReport(input: DailyReportInput): string {
  const closed: ClosedTrade[] = input.trades
    .filter((t) => t.side === "sell" && t.realizedPnlUsd !== null)
    .map((t) => ({
      tsMs: t.tsMs,
      pnlUsd: t.realizedPnlUsd ?? 0,
      notionalUsd: t.notionalUsd,
      feeUsd: t.feeUsd,
    }));

  const metrics = computeMetrics({
    equity: input.equity.map((p) => ({ tsMs: p.tsMs, navUsd: p.navUsd })),
    trades: closed,
    initialUsd: input.initialUsd,
    days: 1,
  });

  const rows = (items: string[]): string =>
    items.length > 0
      ? items.join("\n")
      : '<tr><td colspan="6" class="muted">Aucune donnée.</td></tr>';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>solbot3 — rapport du ${escapeHtml(input.day)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0 auto; max-width: 960px; padding: 24px; color: #e6edf3; background: #0d1117; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; color: #8b949e; font-weight: 500;
       text-transform: uppercase; letter-spacing: .04em; }
  .muted { color: #8b949e; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px 14px; }
  .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; }
  .card .value { font-size: 20px; font-family: ui-monospace, monospace; margin-top: 4px; }
  .up { color: #3fb950; } .down { color: #f85149; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th { text-align: left; color: #8b949e; font-weight: 500; padding: 6px 10px;
       border-bottom: 1px solid #21262d; }
  td { padding: 6px 10px; border-bottom: 1px solid #21262d;
       font-family: ui-monospace, monospace; font-size: 12.5px; }
  footer { margin-top: 32px; color: #8b949e; font-size: 12px; }
</style>
</head>
<body>
  <h1>solbot3 — rapport du ${escapeHtml(input.day)}</h1>
  <div class="muted">mode ${escapeHtml(input.mode)}</div>

  <h2>Synthèse</h2>
  <div class="cards">
    ${card("NAV", `${metrics.finalNavUsd.toFixed(2)} $`)}
    ${card("PnL", `${(metrics.netPnlPct ?? 0).toFixed(2)} %`, (metrics.netPnlPct ?? 0) >= 0 ? "up" : "down")}
    ${card("Drawdown", `${(metrics.maxDrawdownPct ?? 0).toFixed(2)} %`)}
    ${card("Trades", String(metrics.trades))}
    ${card("Win rate", metrics.winRatePct === null ? "n/d" : `${metrics.winRatePct.toFixed(1)} %`)}
    ${card("Frais", `${metrics.feesUsd.toFixed(2)} $`)}
  </div>

  <h2>Positions au moment du rapport</h2>
  <table>
    <thead><tr><th>Actif</th><th>Quantité</th><th>Entrée</th><th>Valeur</th><th>PnL latent</th></tr></thead>
    <tbody>
      ${rows(
        input.positions.map(
          (p) => `<tr>
            <td>${escapeHtml(p.symbol)}</td>
            <td>${p.qty.toFixed(4)}</td>
            <td>${p.avgEntryUsd.toFixed(6)}</td>
            <td>${p.valueUsd.toFixed(2)} $</td>
            <td class="${p.unrealizedPct >= 0 ? "up" : "down"}">${p.unrealizedPct.toFixed(2)} %</td>
          </tr>`,
        ),
      )}
    </tbody>
  </table>

  <h2>Trades de la journée</h2>
  <table>
    <thead><tr><th>Heure</th><th>Actif</th><th>Sens</th><th>Prix</th><th>Notionnel</th><th>PnL</th></tr></thead>
    <tbody>
      ${rows(
        input.trades.map(
          (t) => `<tr>
            <td>${new Date(t.tsMs).toISOString().slice(11, 16)}</td>
            <td>${escapeHtml(t.symbol)}</td>
            <td>${t.side}</td>
            <td>${t.priceUsd.toFixed(8)}</td>
            <td>${t.notionalUsd.toFixed(2)} $</td>
            <td class="${(t.realizedPnlUsd ?? 0) >= 0 ? "up" : "down"}">${
              t.realizedPnlUsd === null ? "—" : `${t.realizedPnlUsd.toFixed(2)} $`
            }</td>
          </tr>`,
        ),
      )}
    </tbody>
  </table>

  <footer>Généré par solbot3 — document autonome, sans dépendance externe.</footer>
</body>
</html>
`;
}

/** Assemble les données et écrit le rapport. */
export function writeDailyReport(
  db: DB,
  options: { day: string; mode: string; outDir: string },
): { path: string; content: string } {
  const sinceMs = Date.parse(`${options.day}T00:00:00Z`);
  const untilMs = sinceMs + 86_400_000;

  const equity = listEquity(db, { mode: options.mode, fromMs: sinceMs, toMs: untilMs });
  const trades = listTrades(db, { mode: options.mode, limit: 10_000 }).filter(
    (t) => t.tsMs >= sinceMs && t.tsMs < untilMs,
  );
  const positions = listPositions(db).map((position) => ({
    symbol: position.symbol,
    qty: position.qty,
    avgEntryUsd: position.avgEntryUsd,
    valueUsd: position.qty * position.avgEntryUsd,
    unrealizedPct: 0,
  }));

  const content = renderDailyReport({
    day: options.day,
    mode: options.mode,
    equity,
    trades: trades.map((t) => ({
      tsMs: t.tsMs,
      symbol: t.symbol,
      side: t.side,
      priceUsd: t.priceUsd,
      qty: t.qty,
      notionalUsd: t.notionalUsd,
      feeUsd: t.feeUsd,
      realizedPnlUsd: t.realizedPnlUsd,
      strategy: t.strategy,
      status: t.status,
    })),
    positions,
    initialUsd: equity[0]?.navUsd ?? 0,
  });

  fs.mkdirSync(options.outDir, { recursive: true });
  const file = path.join(options.outDir, `daily-${options.day}.html`);
  fs.writeFileSync(file, content, "utf8");

  return { path: file, content };
}

function card(label: string, value: string, tone = ""): string {
  return `<div class="card"><div class="label">${label}</div><div class="value ${tone}">${value}</div></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
