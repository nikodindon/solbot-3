import { Connection } from "@solana/web3.js";
import { DEFAULT_RPC_URL } from "../constants.js";
import { RpcError, messageOf } from "../utils/errors.js";
import { sleep } from "../utils/time.js";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface RpcProbe {
  url: string;
  ok: boolean;
  latencyMs: number;
  slot: number | null;
  error?: string;
}

export interface ResolvedConnection {
  connection: Connection;
  url: string;
  fallbackUsed: boolean;
}

/** Timeout par défaut des appels RPC. */
export const RPC_TIMEOUT_MS = 8_000;

export function createConnection(url: string, commitment: Commitment = "confirmed"): Connection {
  return new Connection(url, commitment);
}

/**
 * Teste la disponibilité d'un endpoint RPC (latence + slot).
 * Ne lève jamais : un diagnostic doit toujours pouvoir s'afficher.
 */
export async function probeRpc(
  url: string,
  options: { timeoutMs?: number; commitment?: Commitment } = {},
): Promise<RpcProbe> {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  const started = Date.now();
  try {
    const connection = createConnection(url, options.commitment ?? "confirmed");
    const slot = await withTimeout(
      connection.getSlot(),
      timeoutMs,
      `RPC ${url} ne répond pas en ${timeoutMs} ms`,
    );
    return { url, ok: true, latencyMs: Date.now() - started, slot: Number(slot) };
  } catch (error) {
    return {
      url,
      ok: false,
      latencyMs: Date.now() - started,
      slot: null,
      error: messageOf(error),
    };
  }
}

/**
 * Résout une connexion RPC en essayant l'URL principale puis, en cas d'échec,
 * le fournisseur de secours.
 *
 * Le fournisseur principal est retenté (2 tentatives) : une coupure réseau
 * brève ne doit pas empêcher le démarrage.
 */
export async function resolveConnection(
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number } = {},
): Promise<ResolvedConnection> {
  const primary = env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const fallback = env.SOLANA_RPC_FALLBACK_URL?.trim();

  const primaryProbe = await probeWithRetries(primary, options.timeoutMs);
  if (primaryProbe.ok) {
    return {
      connection: createConnection(primary),
      url: primary,
      fallbackUsed: false,
    };
  }

  if (fallback) {
    const fallbackProbe = await probeWithRetries(fallback, options.timeoutMs);
    if (fallbackProbe.ok) {
      return {
        connection: createConnection(fallback),
        url: fallback,
        fallbackUsed: true,
      };
    }
    throw new RpcError(
      `aucun endpoint RPC joignable — principal: ${primaryProbe.error ?? "injoignable"} ; secours: ${fallbackProbe.error ?? "injoignable"}`,
      { hint: "vérifiez SOLANA_RPC_URL et SOLANA_RPC_FALLBACK_URL dans .env" },
    );
  }

  throw new RpcError(
    `endpoint RPC injoignable (${primary}) — ${primaryProbe.error ?? "injoignable"}`,
    {
      hint: "vérifiez SOLANA_RPC_URL dans .env ou la connectivité réseau",
    },
  );
}

async function probeWithRetries(url: string, timeoutMs?: number): Promise<RpcProbe> {
  let last: RpcProbe = { url, ok: false, latencyMs: 0, slot: null, error: "inconnu" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await probeRpc(url, { timeoutMs });
    if (last.ok) return last;
    if (attempt < 2) await sleep(500 * attempt);
  }
  return last;
}

/** Impose un timeout à une promesse (les appels RPC n'en ont pas nativement). */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RpcError(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
