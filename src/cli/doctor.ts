import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { MIN_NODE_MAJOR, MIN_NODE_MINOR, SOL_MINT, USDC_MINT } from "../constants.js";
import { loadConfig } from "../config/loader.js";
import type { Mode } from "../config/schema.js";
import { JupiterClient, JupiterError } from "../jupiter/client.js";
import { PriceApi } from "../jupiter/price.js";
import { TokensApi } from "../jupiter/tokens.js";
import { probeRpc } from "../solana/connection.js";
import { closeDb, openDb } from "../state/db.js";
import { currentVersion, migrate, tablesOf } from "../state/migrations.js";
import { messageOf } from "../utils/errors.js";
import { getConfigPath, getProjectRoot, getStopFilePath } from "../utils/paths.js";
import { EnvSigner } from "../wallet/signer.js";
import { blank, fail, heading, note, ok, warn } from "./output.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** Un échec critique fait sortir `doctor` en code 1. */
  critical: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  mode: Mode;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  root?: string;
  /** Ignore les appels réseau (diagnostic local uniquement). */
  offline?: boolean;
}

/**
 * Diagnostic complet de l'environnement.
 *
 * Chaque contrôle est indépendant : un échec n'empêche pas les suivants
 * (l'utilisateur voit toute la liste d'un coup).
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const root = options.root ?? getProjectRoot();
  const checks: DoctorCheck[] = [];

  const push = (check: DoctorCheck): void => {
    checks.push(check);
  };

  // ── Node ────────────────────────────────────────────────────────────────
  const nodeVersion = process.versions.node;
  const [major, minor] = nodeVersion.split(".").map((n) => Number.parseInt(n, 10));
  const nodeOk =
    (major ?? 0) > MIN_NODE_MAJOR ||
    ((major ?? 0) === MIN_NODE_MAJOR && (minor ?? 0) >= MIN_NODE_MINOR);
  push({
    name: "node",
    ok: nodeOk,
    critical: true,
    detail: nodeOk
      ? `v${nodeVersion}`
      : `v${nodeVersion} — requis ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} (node:sqlite)`,
  });

  // ── Configuration ───────────────────────────────────────────────────────
  let mode: Mode = "paper";
  let databasePath = `${root}/data/solbot3.sqlite`;
  try {
    const loaded = loadConfig({ root });
    mode = loaded.mode;
    databasePath = resolveDbPath(root, loaded.config.database.path);
    const source = loaded.sources.usedExample ? "config.example.yaml" : "config.yaml";
    push({
      name: "config",
      ok: true,
      critical: true,
      detail: `${source} — mode ${loaded.mode}, intervalle ${loaded.config.loop_interval_s}s`,
    });
    if (loaded.sources.usedExample) {
      push({
        name: "config (copie)",
        ok: false,
        critical: false,
        detail: "aucun config/config.yaml : le fichier d'exemple est utilisé (copiez-le)",
      });
    }
  } catch (error) {
    push({
      name: "config",
      ok: false,
      critical: true,
      detail: messageOf(error),
    });
  }

  // ── Fichier .env ────────────────────────────────────────────────────────
  const envPath = `${root}/.env`;
  const envExists = fs.existsSync(envPath);
  push({
    name: "env",
    ok: envExists,
    critical: false,
    detail: envExists ? envPath : `${envPath} absent (lancez \`init\`)`,
  });

  // ── Wallet ──────────────────────────────────────────────────────────────
  let signer: EnvSigner | undefined;
  try {
    signer = await EnvSigner.fromEnv(process.env);
    push({ name: "wallet", ok: true, critical: true, detail: signer.address });
  } catch (error) {
    push({ name: "wallet", ok: false, critical: false, detail: messageOf(error) });
  }

  // ── RPC ─────────────────────────────────────────────────────────────────
  let connection: Connection | undefined;
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  const fallbackUrl = process.env.SOLANA_RPC_FALLBACK_URL?.trim();
  if (!options.offline) {
    const primary = await probeRpc(rpcUrl ?? "https://api.mainnet-beta.solana.com");
    if (primary.ok) {
      connection = new Connection(primary.url, "confirmed");
      push({
        name: "rpc",
        ok: true,
        critical: true,
        detail: `${primary.url} — slot ${primary.slot} (${primary.latencyMs} ms)`,
      });
    } else {
      push({ name: "rpc", ok: false, critical: true, detail: `${primary.url} — ${primary.error}` });
    }

    if (fallbackUrl) {
      const fallback = await probeRpc(fallbackUrl);
      push({
        name: "rpc (secours)",
        ok: fallback.ok,
        critical: false,
        detail: fallback.ok
          ? `${fallback.url} — slot ${fallback.slot} (${fallback.latencyMs} ms)`
          : `${fallback.url} — ${fallback.error}`,
      });
    }
  } else {
    push({ name: "rpc", ok: true, critical: false, detail: "ignoré (--offline)" });
  }

  // ── Jupiter ────────────────────────────────────────────────────────────
  if (!options.offline) {
    const apiKey = process.env.JUPITER_API_KEY?.trim();
    push({
      name: "jupiter (clé)",
      ok: Boolean(apiKey),
      critical: false,
      detail: apiKey ? "clé API renseignée" : "aucune clé API — débit limité à 0,5 req/s",
    });

    const client = new JupiterClient({ apiKey, rps: parseRps(process.env.JUPITER_RPS) });
    try {
      const prices = await new PriceApi(client).refresh([SOL_MINT, USDC_MINT], { fresh: true });
      const sol = prices.get(SOL_MINT);
      push({
        name: "jupiter (Price v3)",
        ok: sol !== undefined,
        critical: false,
        detail: sol ? `SOL ${sol.usdPrice} $` : "aucun prix renvoyé",
      });
    } catch (error) {
      push({ name: "jupiter (Price v3)", ok: false, critical: false, detail: describe(error) });
    }

    try {
      const tokens = await new TokensApi(client).searchMints([SOL_MINT, USDC_MINT]);
      push({
        name: "jupiter (Tokens v2)",
        ok: tokens.size > 0,
        critical: false,
        detail: `${tokens.size} token(s) résolus`,
      });
    } catch (error) {
      push({ name: "jupiter (Tokens v2)", ok: false, critical: false, detail: describe(error) });
    }
  }

  // ── Base de données ─────────────────────────────────────────────────────
  if (!fs.existsSync(databasePath)) {
    push({
      name: "database",
      ok: false,
      critical: false,
      detail: `${databasePath} absente (elle sera créée au premier démarrage)`,
    });
  } else {
    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb({ path: databasePath });
      const version = currentVersion(db);
      const tables = tablesOf(db).length;
      push({
        name: "database",
        ok: version > 0,
        critical: false,
        detail: `schéma v${version} — ${tables} tables`,
      });
    } catch (error) {
      push({ name: "database", ok: false, critical: false, detail: messageOf(error) });
    } finally {
      if (db) closeDb(db);
    }
  }

  // ── Soldes ──────────────────────────────────────────────────────────────
  if (connection && signer) {
    try {
      const solLamports = await connection.getBalance(signer.publicKey);
      const sol = Number(solLamports) / 1e9;
      const usdc = await splBalance(connection, signer.address, USDC_MINT);
      push({
        name: "soldes",
        ok: true,
        critical: false,
        detail: `${sol.toFixed(5)} SOL · ${usdc.toFixed(2)} USDC`,
      });
    } catch (error) {
      push({ name: "soldes", ok: false, critical: false, detail: messageOf(error) });
    }
  } else {
    push({ name: "soldes", ok: false, critical: false, detail: "wallet ou RPC indisponible" });
  }

  // ── Kill-switch ─────────────────────────────────────────────────────────
  const stopPath = getStopFilePath(root);
  if (fs.existsSync(stopPath)) {
    push({
      name: "kill-switch",
      ok: false,
      critical: false,
      detail: `${stopPath} présent — les entrées sont coupées (retirez-le pour reprendre)`,
    });
  } else {
    push({ name: "kill-switch", ok: true, critical: false, detail: "aucun fichier STOP" });
  }

  const okResult = checks.filter((c) => c.critical).every((c) => c.ok);
  return { ok: okResult, mode, checks };
}

/** Affiche le résultat du diagnostic. */
export function printDoctor(result: DoctorResult): void {
  heading("solbot3 doctor — diagnostic de l'environnement");
  for (const check of result.checks) {
    if (check.ok) {
      ok(check.name, check.detail);
    } else if (check.critical) {
      fail(check.name, check.detail);
    } else {
      warn(check.name, check.detail);
    }
  }
  blank();
  if (result.ok) {
    ok("Environnement opérationnel", `mode ${result.mode}`);
  } else {
    fail("Environnement incomplet", "corrigez les points ci-dessus avant de lancer le moteur");
  }
  blank();
  note(`configuration attendue : ${getConfigPath()}`);
  blank();
}

/** Forme utile d'un compte de token parsé par le RPC. */
interface ParsedTokenAccount {
  data: {
    parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } };
  };
}

async function splBalance(connection: Connection, owner: string, mint: string): Promise<number> {
  const response = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
    mint: new PublicKey(mint),
  });
  let total = 0;
  let decimals = 0;
  for (const { account } of response.value) {
    const parsed = account as unknown as ParsedTokenAccount;
    const amount = parsed.data.parsed?.info?.tokenAmount;
    const value = Number(amount?.amount ?? 0);
    if (Number.isFinite(value)) total += value;
    if (typeof amount?.decimals === "number") decimals = amount.decimals;
  }
  // L'USDC du Circle a 6 décimales.
  return total / 10 ** (decimals || 6);
}

/** Convertit `JUPITER_RPS` (chaîne) en nombre, en tolérant une valeur vide. */
function parseRps(raw: string | undefined): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function describe(error: unknown): string {
  if (error instanceof JupiterError) return `${error.message}`;
  return messageOf(error);
}

/** Applique les migrations manquantes (utilisé par `doctor --migrate`). */
export function applyMigrations(
  root: string,
  dbPath?: string,
): { version: number; applied: number } {
  const target = dbPath ?? `${root}/data/solbot3.sqlite`;
  const db = openDb({ path: target });
  try {
    const applied = migrate(db);
    return { version: currentVersion(db), applied };
  } finally {
    closeDb(db);
  }
}

/** Résout un chemin de base relatif à la racine du projet. */
function resolveDbPath(root: string, configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}
