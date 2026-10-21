import { loadConfig } from "../config/loader.js";
import type { AppConfig, AppEnv, Mode } from "../config/schema.js";
import { JupiterClient } from "../jupiter/client.js";
import { PriceApi } from "../jupiter/price.js";
import { TokensApi } from "../jupiter/tokens.js";
import { openDb, resolveDbPath, type DB } from "../state/db.js";
import { migrate } from "../state/migrations.js";
import { defaultJupiterRps } from "../config/schema.js";
import { getProjectRoot } from "../utils/paths.js";

/**
 * Contexte d'exécution partagé par les commandes.
 *
 * Assemble la configuration, la base, et les clients Jupiter. C'est le seul
 * endroit où l'on décide *quelles* implémentations concretes sont utilisées :
 * le moteur, lui, ne connaît que des interfaces.
 */
export interface Runtime {
  root: string;
  config: AppConfig;
  env: AppEnv;
  mode: Mode;
  db: DB;
  jupiter: JupiterClient;
  priceApi: PriceApi;
  tokensApi: TokensApi;
}

export interface CreateRuntimeOptions {
  root?: string;
  /** Forçage du mode (CLI). */
  mode?: Mode;
  /** Emplacement explicite de la base (défaut : `config.database.path`). */
  dbPath?: string;
  /** Ouvre la base sans appliquer les migrations. */
  skipMigrations?: boolean;
}

export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  const root = options.root ?? getProjectRoot();
  const loaded = loadConfig({ root, mode: options.mode });

  const dbPath = options.dbPath ?? resolveDbPath(root, loaded.config.database.path);
  const db = openDb({ path: dbPath });
  if (!options.skipMigrations) migrate(db);

  const jupiter = new JupiterClient({
    apiKey: loaded.env.JUPITER_API_KEY ?? null,
    rps: loaded.env.JUPITER_RPS ?? defaultJupiterRps(loaded.env.JUPITER_API_KEY),
    retries: loaded.config.execution.retries,
  });

  return {
    root,
    config: loaded.config,
    env: loaded.env,
    mode: loaded.mode,
    db,
    jupiter,
    priceApi: new PriceApi(jupiter),
    tokensApi: new TokensApi(jupiter),
  };
}

/** Ferme proprement le contexte (base + clients). */
export function closeRuntime(runtime: Runtime): void {
  try {
    runtime.db.close();
  } catch {
    // déjà fermée
  }
}
