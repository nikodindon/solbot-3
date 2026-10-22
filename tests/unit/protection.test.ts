import { describe, expect, it } from "vitest";
import { closeDb, openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { listProtections, protectPosition, toBaseUnits } from "../../src/execution/protection.js";
import type { TriggerApi, TriggerOrder } from "../../src/jupiter/trigger.js";

function makeDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}

/** Faux Trigger API qui enregistre les ordres déposés. */
function fakeTrigger(): { api: TriggerApi; orders: TriggerOrder[] } {
  const orders: TriggerOrder[] = [];
  let counter = 0;
  const api = {
    createLimitOrder: (request: { price: number }) => {
      counter += 1;
      const order = { orderId: `order-${counter}`, status: "active" };
      orders.push(order);
      void request;
      return Promise.resolve(order);
    },
    listOrders: () => Promise.resolve(orders),
    cancelOrder: () => Promise.resolve(true),
  } as unknown as TriggerApi;
  return { api, orders };
}

const BASE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("ordres de protection on-chain", () => {
  it("dépose un take-profit quand il est au-dessus de l'entrée", async () => {
    const db = makeDb();
    try {
      const { api, orders } = fakeTrigger();
      const result = await protectPosition(
        {
          db,
          triggerApi: api,
          takeProfitOrders: true,
          stopLossOrders: false,
        },
        {
          mint: "Aa",
          qty: 100,
          decimals: 6,
          entryPriceUsd: 2,
          takeProfitUsd: 2.4,
          stopLossUsd: 1.8,
          priceUsd: 2,
          baseMint: BASE,
          symbol: "AAA",
        },
      );

      expect(result.takeProfitOrderId).toBe("order-1");
      expect(result.stopLossOrderId).toBeNull();
      expect(orders).toHaveLength(1);
      expect(listProtections(db, "Aa")).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });

  it("ne dépose PAS un take-profit sous le prix d'entrée", async () => {
    const db = makeDb();
    try {
      const { api, orders } = fakeTrigger();
      const result = await protectPosition(
        { db, triggerApi: api, takeProfitOrders: true, stopLossOrders: false },
        {
          mint: "Aa",
          qty: 100,
          decimals: 6,
          entryPriceUsd: 2,
          // Un take-profit sous l'entrée est un stop déguisé.
          takeProfitUsd: 1.5,
          stopLossUsd: 1.8,
          priceUsd: 2,
          baseMint: BASE,
          symbol: "AAA",
        },
      );

      expect(result.takeProfitOrderId).toBeNull();
      expect(result.skipped).toMatch(/sous le prix d'entrée/);
      expect(orders).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("ne dépose pas de stop-loss on-chain par défaut", async () => {
    const db = makeDb();
    try {
      const { api, orders } = fakeTrigger();
      const result = await protectPosition(
        { db, triggerApi: api, takeProfitOrders: false, stopLossOrders: false },
        {
          mint: "Aa",
          qty: 100,
          decimals: 6,
          entryPriceUsd: 2,
          takeProfitUsd: 2.4,
          stopLossUsd: 1.8,
          priceUsd: 2,
          baseMint: BASE,
          symbol: "AAA",
        },
      );

      expect(result.takeProfitOrderId).toBeNull();
      expect(result.stopLossOrderId).toBeNull();
      expect(result.skipped).toMatch(/désactivés/);
      expect(orders).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });

  it("dépose un stop-loss seulement si on l'autorise explicitement", async () => {
    const db = makeDb();
    try {
      const { api, orders } = fakeTrigger();
      const result = await protectPosition(
        { db, triggerApi: api, takeProfitOrders: false, stopLossOrders: true },
        {
          mint: "Aa",
          qty: 100,
          decimals: 6,
          entryPriceUsd: 2,
          takeProfitUsd: null,
          stopLossUsd: 1.8,
          priceUsd: 2,
          baseMint: BASE,
          symbol: "AAA",
        },
      );

      expect(result.stopLossOrderId).toBe("order-1");
      expect(orders).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });

  it("convertit les quantités en unités de base", () => {
    expect(toBaseUnits(1.5, 6)).toBe("1500000");
    expect(toBaseUnits(0.000001, 6)).toBe("1");
  });
});
