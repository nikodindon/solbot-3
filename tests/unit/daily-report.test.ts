import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderDailyReport, writeDailyReport } from "../../src/backtest/daily-report.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { insertEquityPoint } from "../../src/state/equity.js";
import { insertTrade } from "../../src/state/trades.js";

describe("rapport quotidien HTML", () => {
  it("produit un document autonome et lisible", () => {
    const html = renderDailyReport({
      day: "2026-10-22",
      mode: "paper",
      equity: [
        { tsMs: 1_700_000_000_000, navUsd: 1000, cashUsd: 1000, positionsUsd: 0 },
        { tsMs: 1_700_003_600_000, navUsd: 1042, cashUsd: 1042, positionsUsd: 0 },
      ],
      trades: [
        {
          tsMs: 1_700_001_000_000,
          symbol: "AAA",
          side: "buy",
          priceUsd: 2,
          qty: 25,
          notionalUsd: 50,
          feeUsd: 0.5,
          realizedPnlUsd: null,
          strategy: "mean_reversion",
          status: "simulated",
        },
      ],
      positions: [{ symbol: "AAA", qty: 25, avgEntryUsd: 2, valueUsd: 50, unrealizedPct: 4.2 }],
      initialUsd: 1000,
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("solbot3 — rapport du 2026-10-22");
    // Le document est autonome : aucune ressource externe.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).toContain("AAA");
    expect(html).toContain("1042.00 $");
  });

  it("échappe le HTML injecté dans les symboles", () => {
    const html = renderDailyReport({
      day: "2026-10-22",
      mode: "paper",
      equity: [],
      trades: [],
      positions: [
        {
          symbol: "<script>alert(1)</script>",
          qty: 1,
          avgEntryUsd: 1,
          valueUsd: 1,
          unrealizedPct: 0,
        },
      ],
      initialUsd: 0,
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("écrit le rapport dans le répertoire demandé", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solbot3-report-"));
    try {
      // Un horodatage **dans** la journée du rapport.
      const dayStart = Date.parse("2026-10-22T00:00:00Z");
      insertEquityPoint(db, {
        mode: "paper",
        tsMs: dayStart + 60_000,
        tickId: 1,
        navUsd: 1000,
        cashUsd: 1000,
        positionsUsd: 0,
        realizedPnlUsd: 0,
        drawdownPct: 0,
      });
      insertTrade(db, {
        tsMs: dayStart + 120_000,
        mode: "paper",
        strategy: "mean_reversion",
        mint: "Aa",
        symbol: "AAA",
        side: "buy",
        priceUsd: 2,
        qty: 25,
        notionalUsd: 50,
        feeUsd: 0.5,
        realizedPnlUsd: null,
        reason: "test",
        signature: null,
        status: "simulated",
      });

      const result = writeDailyReport(db, {
        day: "2026-10-22",
        mode: "paper",
        outDir: dir,
      });

      expect(fs.existsSync(result.path)).toBe(true);
      expect(path.basename(result.path)).toBe("daily-2026-10-22.html");
      expect(result.content).toContain("AAA");
    } finally {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
