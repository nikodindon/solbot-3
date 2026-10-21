#!/usr/bin/env node
// Importé en premier : filtre l'avertissement expérimental de `node:sqlite`.
import "./utils/warnings.js";

import { Command } from "commander";
import { runDoctor, printDoctor } from "./cli/doctor.js";
import { runInit } from "./cli/init.js";
import { getVersionInfo } from "./cli/version.js";
import { messageOf } from "./utils/errors.js";
import { loadEnvFile } from "./utils/env-file.js";
import { getProjectRoot } from "./utils/paths.js";

// Le fichier `.env` est chargé au lancement de la CLI. Les variables déjà
// présentes dans l'environnement ne sont jamais écrasées.
loadEnvFile(getProjectRoot());

const program = new Command();

program
  .name("solbot3")
  .description(
    "Bot de trading spot sur Solana (Jupiter) — backtest → paper → dry-run → live encadré.",
  )
  .version(getVersionInfo().version, "-v, --version", "affiche la version")
  .showHelpAfterError();

program
  .command("init")
  .description("crée le wallet de trading et le fichier .env (chmod 600)")
  .option("--force", "écrase une clé existante (destructif)", false)
  .action(async (options: { force?: boolean }) => {
    try {
      await runInit({ root: getProjectRoot(), force: options.force === true });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      const hint = (error as { hint?: string }).hint;
      if (hint) console.error(`    → ${hint}`);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("diagnostic complet de l'environnement (Node, config, RPC, Jupiter, base, soldes)")
  .option("--offline", "n'effectue aucun appel réseau", false)
  .action(async (options: { offline?: boolean }) => {
    try {
      const result = await runDoctor({ root: getProjectRoot(), offline: options.offline === true });
      printDoctor(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("version")
  .description("affiche les versions (bot, Node, plateforme)")
  .action(() => {
    const info = getVersionInfo();
    console.log(`solbot3 ${info.version} — node ${info.node} — ${info.platform}`);
  });

await program.parseAsync(process.argv);
