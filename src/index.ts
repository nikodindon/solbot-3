#!/usr/bin/env node
// Importé en premier : filtre l'avertissement expérimental de `node:sqlite`.
import "./utils/warnings.js";

import { Command } from "commander";
import { runBacktestImport, runBacktestRun, runBacktestWalkForward } from "./cli/backtest.js";
import { runDoctor, printDoctor } from "./cli/doctor.js";
import { runInit } from "./cli/init.js";
import { runPrice } from "./cli/price.js";
import { runReport } from "./cli/report.js";
import { runScan } from "./cli/scan.js";
import { runStart } from "./cli/start.js";
import { runWatch } from "./cli/watch.js";
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
  .command("scan")
  .description("construit la watchlist et l'enregistre")
  .option("--top <n>", "n'affiche que les n premiers actifs", (value) => Number.parseInt(value, 10))
  .action(async (options: { top?: number }) => {
    try {
      await runScan({ top: options.top, root: getProjectRoot() });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("price")
  .description("prix en direct d'une paire (Price v3)")
  .argument("<entrée>", "symbole ou mint de l'actif vendu")
  .argument("<sortie>", "symbole ou mint de la devise reçue")
  .action(async (input: string, output: string) => {
    try {
      await runPrice(input, output, { root: getProjectRoot() });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("watch")
  .description("collecte continue des prix et des bougies, sans trader")
  .option("--interval <s>", "intervalle entre deux collectes (secondes)", (value) =>
    Number.parseInt(value, 10),
  )
  .option("--duration <s>", "durée totale (secondes)", (value) => Number.parseInt(value, 10))
  .option("--once", "un seul tick puis sortie", false)
  .action(async (options: { interval?: number; duration?: number; once?: boolean }) => {
    try {
      await runWatch({
        intervalS: options.interval,
        durationS: options.duration,
        once: options.once === true,
        root: getProjectRoot(),
      });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("backtest")
  .description("backtest : import d'historique, rejeu du moteur, walk-forward")
  .addCommand(
    new Command("import")
      .description("importe l'historique OHLCV (GeckoTerminal)")
      .option(
        "--days <n>",
        "profondeur historique en jours",
        (value) => Number.parseInt(value, 10),
        90,
      )
      .option("--timeframe <tf>", "timeframe importé (5m|15m|1h)", "15m")
      .action(async (options: { days: number; timeframe: string }) => {
        try {
          await runBacktestImport(options.days, {
            root: getProjectRoot(),
            timeframe: options.timeframe as "5m" | "15m" | "1h",
          });
        } catch (error) {
          console.error(`  ✘ ${messageOf(error)}`);
          process.exitCode = 1;
        }
      }),
  )
  .addCommand(
    new Command("run")
      .description("rejoue le moteur réel sur l'historique")
      .option(
        "--days <n>",
        "profondeur historique en jours",
        (value) => Number.parseInt(value, 10),
        90,
      )
      .option("--label <name>", "libellé du run", "backtest")
      .option("--timeframe <tf>", "timeframe rejoué (5m|15m|1h)", "15m")
      .option("--config <path>", "fichier de configuration alternatif")
      .action(
        async (options: { days: number; label: string; timeframe: string; config?: string }) => {
          try {
            await runBacktestRun(options.days, options.label, {
              root: getProjectRoot(),
              timeframe: options.timeframe as "5m" | "15m" | "1h",
              configPath: options.config,
            });
          } catch (error) {
            console.error(`  ✘ ${messageOf(error)}`);
            process.exitCode = 1;
          }
        },
      ),
  )
  .addCommand(
    new Command("walk-forward")
      .description("validation par fenêtres glissantes (PnL hors échantillon agrégé)")
      .option(
        "--days <n>",
        "profondeur historique en jours",
        (value) => Number.parseInt(value, 10),
        90,
      )
      .option("--windows <n>", "nombre de fenêtres", (value) => Number.parseInt(value, 10), 4)
      .option("--config <path>", "fichier de configuration alternatif")
      .action(async (options: { days: number; windows: number; config?: string }) => {
        try {
          await runBacktestWalkForward(options.windows, options.days, {
            root: getProjectRoot(),
            configPath: options.config,
          });
        } catch (error) {
          console.error(`  ✘ ${messageOf(error)}`);
          process.exitCode = 1;
        }
      }),
  );

program
  .command("report")
  .description("métriques : PnL net, win rate, profit factor, drawdown, frais")
  .option("--days <n>", "période analysée en jours", (value) => Number.parseInt(value, 10), 30)
  .option("--mode <mode>", "mode analysé (paper|backtest|dry_run|live)", "paper")
  .action((options: { days: number; mode: string }) => {
    try {
      runReport({ days: options.days, mode: options.mode, root: getProjectRoot() });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("start")
  .description("démarre le moteur (paper par défaut)")
  .option("--paper", "mode paper : aucun ordre envoyé, portefeuille virtuel", false)
  .option("--dry-run", "mode dry-run : vrais /order + simulation on-chain (phase 5)", false)
  .option("--live", "mode live : fonds réels (exige confirm_live et un backtest conforme)", false)
  .option("--interval <s>", "intervalle entre deux ticks (secondes)", (value) =>
    Number.parseInt(value, 10),
  )
  .option("--duration <s>", "durée totale (secondes)", (value) => Number.parseInt(value, 10))
  .option("--once", "un seul tick puis sortie", false)
  .action(
    async (options: {
      paper?: boolean;
      dryRun?: boolean;
      live?: boolean;
      interval?: number;
      duration?: number;
      once?: boolean;
    }) => {
      const mode = options.live ? "live" : options.dryRun ? "dry_run" : "paper";
      try {
        await runStart({
          root: getProjectRoot(),
          mode,
          intervalS: options.interval,
          durationS: options.duration,
          once: options.once === true,
        });
      } catch (error) {
        console.error(`  ✘ ${messageOf(error)}`);
        process.exitCode = 1;
      }
    },
  );

program
  .command("version")
  .description("affiche les versions (bot, Node, plateforme)")
  .action(() => {
    const info = getVersionInfo();
    console.log(`solbot3 ${info.version} — node ${info.node} — ${info.platform}`);
  });

await program.parseAsync(process.argv);
