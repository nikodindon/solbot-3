import { describe, expect, it } from "vitest";
import {
  backoffFromHeaders,
  JupiterClient,
  JupiterError,
  type FetchLike,
} from "../../src/jupiter/client.js";
import { TokenBucket } from "../../src/utils/rate-limit.js";

interface FakeResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function fakeFetch(responses: FakeResponse[]): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let index = 0;
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: {
        get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
      },
      text: () => Promise.resolve(response.body),
    });
  };
  return { fetch: impl, calls };
}

describe("client Jupiter", () => {
  it("envoie l'en-tête x-api-key", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const client = new JupiterClient({ apiKey: "ma-cle", rps: 100 }, fetch);

    await client.get("/price/v3", { ids: "So111" }, (raw) => raw);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ma-cle");
    expect(calls[0]?.url).toContain("ids=So111");
  });

  it("n'envoie pas d'en-tête de clé quand il n'y en a pas", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: "{}" }]);
    const client = new JupiterClient({ rps: 100 }, fetch);

    await client.get("/price/v3", {}, (raw) => raw);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("rejoue un 429 puis réussit", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 429, body: "rate limited", headers: { "x-ratelimit-reset": "1" } },
      { status: 200, body: '{"ok":true}' },
    ]);
    const client = new JupiterClient({ rps: 100, retries: 3 }, fetch);

    const result = await client.get("/price/v3", {}, (raw) => raw);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(client.stats.rateLimited).toBe(1);
    expect(client.stats.retries).toBe(1);
  });

  it("rejoue un 5xx puis réussit", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503, body: "unavailable" },
      { status: 200, body: '{"ok":true}' },
    ]);
    const client = new JupiterClient({ rps: 100, retries: 3 }, fetch);

    await client.get("/price/v3", {}, (raw) => raw);
    expect(calls).toHaveLength(2);
  });

  it("ne rejoue jamais un 4xx", async () => {
    const { fetch, calls } = fakeFetch([{ status: 400, body: "bad request" }]);
    const client = new JupiterClient({ rps: 100, retries: 3 }, fetch);

    await expect(client.get("/price/v3", {}, (raw) => raw)).rejects.toThrow(JupiterError);
    expect(calls).toHaveLength(1);
    expect(client.stats.retries).toBe(0);
  });

  it("abat le nombre de tentatives quand les retries sont épuisés", async () => {
    const { fetch, calls } = fakeFetch([{ status: 500, body: "boom" }]);
    const client = new JupiterClient({ rps: 100, retries: 1 }, fetch);

    await expect(client.get("/price/v3", {}, (raw) => raw)).rejects.toThrow(JupiterError);
    expect(calls).toHaveLength(2);
  });

  it("refuse une réponse qui ne respecte pas le schéma", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: '{"unexpected": true}' }]);
    const client = new JupiterClient({ rps: 100 }, fetch);

    await expect(
      client.get("/price/v3", {}, (raw) => {
        const value = raw as { unexpected: boolean };
        if (!("expected" in value)) throw new Error("schéma invalide");
        return value;
      }),
    ).rejects.toThrow(/schéma invalide/);
  });

  it("lit x-ratelimit-reset comme un timestamp absolu", () => {
    const now = Math.floor(Date.now() / 1000);
    const wait = backoffFromHeaders({
      get: (n) => (n === "x-ratelimit-reset" ? String(now + 5) : null),
    });
    expect(wait).toBeGreaterThan(3_000);
    expect(wait).toBeLessThanOrEqual(6_000);
  });

  it("borne l'attente quand l'en-tête est absent", () => {
    const wait = backoffFromHeaders({ get: () => null });
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(2_000);
  });
});

describe("token bucket", () => {
  it("refuse un jeton quand le débit est épuisé", () => {
    const bucket = new TokenBucket(1, 1);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
    expect(bucket.waitTimeMs()).toBeGreaterThan(0);
  });

  it("attend effectivement entre deux requêtes (débit de 1 req/s)", async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: "{}" },
      { status: 200, body: "{}" },
      { status: 200, body: "{}" },
    ]);
    const client = new JupiterClient({ rps: 1, retries: 0 }, fetch);

    const started = Date.now();
    await client.get("/price/v3", {}, (raw) => raw);
    await client.get("/price/v3", {}, (raw) => raw);
    await client.get("/price/v3", {}, (raw) => raw);
    const elapsed = Date.now() - started;

    // 3 requêtes à 1 req/s : au moins ~2 s d'attente cumulées.
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(client.bucketStats().acquired).toBe(3);
  });
});
