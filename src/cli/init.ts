import fs from "node:fs";
import path from "node:path";
import { WalletError } from "../utils/errors.js";
import { upsertEnvVar } from "../utils/env-file.js";
import { getEnvPath, getProjectRoot } from "../utils/paths.js";
import { generateWallet } from "../wallet/create.js";
import { blank, heading, note, ok, warn } from "./output.js";

export interface InitOptions {
  root?: string;
  /** Écraser une clé existante (opération destructive). */
  force?: boolean;
  /** N'affiche pas le guide de financement (usage en test). */
  quiet?: boolean;
}

export interface InitResult {
  address: string;
  envPath: string;
  /** Le fichier `.env` vient d'être créé. */
  created: boolean;
  /** La clé a été injectée dans un `.env` préexistant. */
  patched: boolean;
}

/** Gabarit minimal utilisé si `.env.example` est absent. */
const FALLBACK_ENV_TEMPLATE = `# ── Wallet (généré par \`npm run solbot3 -- init\`) ──
BS58_PRIVATE_KEY=

# ── Jupiter ──
JUPITER_API_KEY=
JUPITER_RPS=

# ── Solana RPC ──
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_RPC_FALLBACK_URL=

# ── Données historiques ──
GECKO_API_KEY=

# ── Telegram (optionnel) ──
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ── Dashboard (optionnel mais recommandé si exposé) ──
DASHBOARD_TOKEN=

# ── Divers ──
LOG_LEVEL=info
`;

/**
 * Crée le wallet de trading.
 *
 * - la clé privée est écrite dans `.env` avec les permissions `600` ;
 * - un `.env` déjà porteur d'une clé n'est **jamais** écrasé sans `--force` ;
 * - la clé n'apparaît dans aucun log, jamais.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const root = options.root ?? getProjectRoot();
  const envPath = getEnvPath(root);
  const force = options.force === true;

  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : null;
  const hasKey =
    existing !== null && /^\s*(?:export\s+)?BS58_PRIVATE_KEY\s*=\s*\S+/m.test(existing);

  if (hasKey && !force) {
    throw new WalletError("un wallet existe déjà dans .env — aucune clé n'a été écrasée", {
      hint: "utilisez --force si vous intendez de perdre la clé actuelle",
    });
  }

  const wallet = await generateWallet();

  const examplePath = path.join(root, ".env.example");
  const template = fs.existsSync(examplePath)
    ? fs.readFileSync(examplePath, "utf8")
    : FALLBACK_ENV_TEMPLATE;

  const base = existing ?? template;
  const content = upsertEnvVar(base, "BS58_PRIVATE_KEY", wallet.secretKeyBase58);

  fs.writeFileSync(envPath, content, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  const result: InitResult = {
    address: wallet.address,
    envPath,
    created: existing === null,
    patched: existing !== null,
  };

  if (!options.quiet) printInitSummary(result);
  return result;
}

function printInitSummary(result: InitResult): void {
  heading("solbot3 init — création du wallet de trading");
  ok("Wallet généré", result.address);
  ok(result.created ? ".env créé (chmod 600)" : ".env mis à jour (chmod 600)", result.envPath);
  blank();
  warn("Cette clé contrôle des fonds réels.");
  note("• Sauvegardez-la dans un gestionnaire de mots de passe.");
  note("• Ne la partagez JAMAIS, ne la committez JAMAIS.");
  blank();
  note("Prochaines étapes :");
  note(`  1. Envoyez du SOL (≥ 0.05) sur ${result.address} → frais réseau`);
  note("  2. Envoyez de l'USDC (capital de trading, 20 à 50 USDC pour commencer)");
  note("  3. Renseignez JUPITER_API_KEY dans .env → https://developers.jup.ag/portal");
  note("  4. Lancez : npm run solbot3 -- doctor");
  blank();
}
