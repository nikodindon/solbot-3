import { describe, expect, it } from "vitest";
import { DashboardServer, exposureWarning } from "../../src/dashboard/server.js";
import { buildDashboardState } from "../../src/dashboard/state.js";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { addLot } from "../../src/state/portfolio-repo.js";
import { insertEquityPoint } from "../../src/state/equity.js";
import { insertDecision } from "../../src/state/decisions.js";
import { insertTrade } from "../../src/state/trades.js";

const CONFIG = { mode: "paper", stalePriceMaxS: 300, timeframes: ["5m", "15m", "1h"] };

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

async function withServer<T>(
  db: ReturnType<typeof openDb>,
  fn: (base: string) => Promise<T>,
  options: { token?: string } = {},
): Promise<T> {
  const server = new DashboardServer({
    host: "127.0.0.1",
    port: 0,
    db,
    config: CONFIG,
    token: options.token,
  });
  const address = await server.start();
  try {
    return await fn(address);
  } finally {
    await server.stop();
  }
}

describe("état du dashboard", () => {
  it("reflète la base", () => {
    const db = makeDb();
    try {
      insertEquityPoint(db, {
        mode: "paper",
        tsMs: 1000,
        tickId: 1,
        navUsd: 1000,
        cashUsd: 900,
        positionsUsd: 100,
        realizedPnlUsd: 0,
        drawdownPct: 0,
      });
      addLot(db, "Aa", "AAA", 100, 2, 1000);

      const state = buildDashboardState(db, CONFIG, 2000);

      expect(state.nav.usd).toBe(1000);
      expect(state.nav.cash).toBe(900);
      expect(state.portfolio.positions).toHaveLength(1);
      expect(state.portfolio.positions[0]?.symbol).toBe("AAA");
      expect(state.clock.fresh).toBe(true);
      expect(state.mode).toBe("paper");
    } finally {
      closeDb(db);
    }
  });

  it("signale un état périmé", () => {
    const db = makeDb();
    try {
      insertEquityPoint(db, {
        mode: "paper",
        tsMs: 1000,
        tickId: 1,
        navUsd: 1000,
        cashUsd: 1000,
        positionsUsd: 0,
        realizedPnlUsd: 0,
        drawdownPct: 0,
      });
      const state = buildDashboardState(db, CONFIG, 1000 + 3_600_000);
      expect(state.clock.fresh).toBe(false);
      expect(state.clock.lastTickAgeS).toBe(3600);
    } finally {
      closeDb(db);
    }
  });
});

describe("API du dashboard", () => {
  it("expose les endpoints attendus", async () => {
    const db = makeDb();
    try {
      insertEquityPoint(db, {
        mode: "paper",
        tsMs: 1000,
        tickId: 1,
        navUsd: 1000,
        cashUsd: 1000,
        positionsUsd: 0,
        realizedPnlUsd: 0,
        drawdownPct: 0,
      });
      insertDecision(db, {
        tsMs: 1000,
        tickId: 1,
        kind: "signal",
        strategy: "mean_reversion",
        mint: "Aa",
        line: "signal test",
      });
      insertTrade(db, {
        tsMs: 1000,
        mode: "paper",
        strategy: "mean_reversion",
        mint: "Aa",
        symbol: "AAA",
        side: "buy",
        priceUsd: 1,
        qty: 10,
        notionalUsd: 10,
        feeUsd: 0.1,
        realizedPnlUsd: null,
        reason: "test",
        signature: null,
        status: "simulated",
      });

      await withServer(db, async (base) => {
        for (const path of [
          "/api/state",
          "/api/positions",
          "/api/trades",
          "/api/strategies",
          "/api/decisions",
          "/api/equity",
          "/api/watchlist",
        ]) {
          const response = await fetch(`${base}${path}`);
          expect(response.status, `${path} doit répondre 200`).toBe(200);
          const body = (await response.json()) as Record<string, unknown>;
          expect(body).toBeTypeOf("object");
        }
      });
    } finally {
      closeDb(db);
    }
  });

  it("filtre les décisions par stratégie et par type", async () => {
    const db = makeDb();
    try {
      insertDecision(db, {
        tsMs: 1000,
        tickId: 1,
        kind: "signal",
        strategy: "mean_reversion",
        mint: "Aa",
        line: "signal A",
      });
      insertDecision(db, {
        tsMs: 2000,
        tickId: 2,
        kind: "reject",
        strategy: "trend_breakout",
        mint: "Bb",
        line: "rejet B",
      });

      await withServer(db, async (base) => {
        const byStrategy = (await (
          await fetch(`${base}/api/decisions?strategy=trend_breakout`)
        ).json()) as { decisions: { line: string }[] };
        expect(byStrategy.decisions).toHaveLength(1);
        expect(byStrategy.decisions[0]?.line).toBe("rejet B");

        const byKind = (await (await fetch(`${base}/api/decisions?kind=signal`)).json()) as {
          decisions: { line: string }[];
        };
        expect(byKind.decisions).toHaveLength(1);
        expect(byKind.decisions[0]?.line).toBe("signal A");
      });
    } finally {
      closeDb(db);
    }
  });

  it("n'accepte AUCUNE écriture", async () => {
    const db = makeDb();
    try {
      await withServer(db, async (base) => {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          for (const path of ["/api/state", "/api/trades", "/api/decisions", "/api/positions"]) {
            const response = await fetch(`${base}${path}`, { method });
            expect(response.status, `${method} ${path} doit être refusé`).toBe(405);
          }
        }
      });
    } finally {
      closeDb(db);
    }
  });

  it("exige le jeton quand il est configuré", async () => {
    const db = makeDb();
    try {
      await withServer(
        db,
        async (base) => {
          const sansJeton = await fetch(`${base}/api/state`);
          expect(sansJeton.status).toBe(401);

          const avecEntete = await fetch(`${base}/api/state`, {
            headers: { authorization: "Bearer secret" },
          });
          expect(avecEntete.status).toBe(200);

          const avecParametre = await fetch(`${base}/api/state?token=secret`);
          expect(avecParametre.status).toBe(200);
        },
        { token: "secret" },
      );
    } finally {
      closeDb(db);
    }
  });

  it("ouvre un flux SSE", async () => {
    const db = makeDb();
    try {
      await withServer(db, async (base) => {
        const response = await fetch(`${base}/api/stream`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);

        const reader = response.body?.getReader();
        const chunk = await reader?.read();
        const value: unknown = chunk?.value;
        const text = new TextDecoder().decode(
          value instanceof Uint8Array ? value : new Uint8Array(),
        );
        expect(text).toMatch(/event: hello/);
        await reader?.cancel();
      });
    } finally {
      closeDb(db);
    }
  });
});

describe("avertissement d'exposition", () => {
  it("avertit quand le dashboard est public sans jeton", () => {
    expect(exposureWarning("0.0.0.0", undefined)).toMatch(/sans jeton/);
    expect(exposureWarning("0.0.0.0", "secret")).toBeNull();
    expect(exposureWarning("127.0.0.1", undefined)).toBeNull();
  });
});
