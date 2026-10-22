#!/usr/bin/env node
// Importé en premier : filtre l'avertissement expérimental de `node:sqlite`.
import "./utils/warnings.js";

import { Command } from "commander";
import {
  runBacktestImport,
  runBacktestOptimize,
  runBacktestRun,
  runBacktestWalkForward,
} from "./cli/backtest.js";
import { runBackup } from "./cli/backup.js";
import { runDashboard } from "./cli/dashboard.js";
import { runDoctor, printDoctor } from "./cli/doctor.js";
import { runGuard } from "./cli/guard.js";
import { runLabCommand } from "./cli/lab.js";
import { runInit } from "./cli/init.js";
import { runParity } from "./cli/parity.js";
import { runPaths } from "./cli/paths.js";
import { runPrice } from "./cli/price.js";
import { runReport } from "./cli/report.js";
import { runScan } from "./cli/scan.js";
import { runStart } from "./cli/start.js";
import { runSwap } from "./cli/swap.js";
import { runWatch } from "./cli/watch.js";
import { getVersionInfo } from "./cli/version.js";
import { messageOf } from "./utils/errors.js";
import { loadEnvFile } from "./utils/env-file.js";
import { getProjectRoot } from "./utils/paths.js";

// Le fichier `.env` est chargé au lancement de la CLI. Les variables déjà
// présentes dans l'environnement ne sont jamais écrasées.
loadEnvFile(getProjectRoot());

/** Collecte les options répétables (`--strategy a --strategy b`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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
    new Command("optimize")
      .description("walk-forward automatisé : optimise puis valide hors échantillon")
      .option(
        "--days <n>",
        "profondeur historique en jours",
        (value) => Number.parseInt(value, 10),
        90,
      )
      .option("--windows <n>", "nombre de fenêtres", (value) => Number.parseInt(value, 10), 3)
      .option("--timeframe <tf>", "timeframe rejoué (5m|15m|1h)", "15m")
      .option("--config <path>", "fichier de configuration alternatif")
      .action(
        async (options: { days: number; windows: number; timeframe: string; config?: string }) => {
          try {
            await runBacktestOptimize(options.days, options.windows, {
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
      .option("--timeframe <tf>", "timeframe rejoué (5m|15m|1h)", "15m")
      .action(
        async (options: { days: number; windows: number; config?: string; timeframe: string }) => {
          try {
            await runBacktestWalkForward(options.windows, options.days, {
              root: getProjectRoot(),
              configPath: options.config,
              timeframe: options.timeframe as "5m" | "15m" | "1h",
            });
          } catch (error) {
            console.error(`  ✘ ${messageOf(error)}`);
            process.exitCode = 1;
          }
        },
      ),
  );

program
  .command("backup")
  .description("sauvegarde la base (VACUUM INTO), liste ou restaure")
  .option("--list", "liste les sauvegardes", false)
  .option("--restore <fichier>", "restaure une sauvegarde")
  .action((options: { list?: boolean; restore?: string }) => {
    try {
      runBackup({
        root: getProjectRoot(),
        list: options.list === true,
        restore: options.restore,
      });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("guard")
  .description("le live est-il accessible ? (garde-fou : empreinte de configuration + critères)")
  .action(() => {
    try {
      const allowed = runGuard({ root: getProjectRoot() });
      if (!allowed) process.exitCode = 1;
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("parity")
  .description("compare le paper et le backtest sur la même période")
  .option("--days <n>", "période comparée en jours", (value) => Number.parseInt(value, 10), 30)
  .option("--mode <mode>", "mode paper comparé", "paper")
  .action((options: { days: number; mode: string }) => {
    try {
      runParity({ days: options.days, mode: options.mode, root: getProjectRoot() });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("lab")
  .description("laboratoire : paper uniquement, base séparée, mise plafonnée, stop obligatoire")
  .option("--strategy <nom>", "stratégie à jouer (répétable)", collect, [])
  .option("--duration <s>", "durée de la session (secondes)", (value) => Number.parseInt(value, 10))
  .action(async (options: { strategy: string[]; duration?: number }) => {
    try {
      await runLabCommand({
        root: getProjectRoot(),
        strategies: options.strategy,
        durationS: options.duration,
      });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("report")
  .description("métriques : PnL net, win rate, profit factor, drawdown, frais")
  .option("--days <n>", "période analysée en jours", (value) => Number.parseInt(value, 10), 30)
  .option("--mode <mode>", "mode analysé (paper|backtest|dry_run|live)", "paper")
  .option("--html", "écrit un rapport HTML autonome dans data/reports/", false)
  .option("--day <date>", "date du rapport HTML (YYYY-MM-DD)", (value) => value)
  .action((options: { days: number; mode: string; html?: boolean; day?: string }) => {
    try {
      runReport({
        days: options.days,
        mode: options.mode,
        root: getProjectRoot(),
        html: options.html === true,
        day: options.day,
      });
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
  .command("swap")
  .description("swap manuel, avec les mêmes garde-fous que le bot")
  .argument("<entrée>", "symbole ou mint vendu")
  .argument("<sortie>", "symbole ou mint acheté")
  .argument("<montant| max>", "montant en USDC, ou « max » pour tout vendre")
  .option("--dry-run", "devis réel + simulation, aucun ordre envoyé", false)
  .option("--live", "ordre réel (exige confirm_live, le garde-fou et une confirmation)", false)
  .option("--yes", "valide la confirmation (automatisation)", false)
  .action(
    async (
      input: string,
      output: string,
      amount: string,
      options: { dryRun?: boolean; live?: boolean; yes?: boolean },
    ) => {
      try {
        await runSwap({
          root: getProjectRoot(),
          input,
          output,
          amount,
          mode: options.live ? "live" : "dry_run",
          yes: options.yes === true,
        });
      } catch (error) {
        console.error(`  ✘ ${messageOf(error)}`);
        process.exitCode = 1;
      }
    },
  );

program
  .command("paths")
  .description("compare les chemins d'exécution sur les swaps réels (A/B)")
  .option("--days <n>", "période analysée en jours", (value) => Number.parseInt(value, 10), 7)
  .action((options: { days: number }) => {
    try {
      runPaths({ days: options.days, root: getProjectRoot() });
    } catch (error) {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("dashboard")
  .description("tableau de bord en lecture seule (API REST + SSE)")
  .option("--host <h>", "interface d'écoute", (value) => value)
  .option("--port <p>", "port d'écoute", (value) => Number.parseInt(value, 10))
  .action((options: { host?: string; port?: number }) => {
    void runDashboard({
      root: getProjectRoot(),
      host: options.host,
      port: options.port,
    }).catch((error: unknown) => {
      console.error(`  ✘ ${messageOf(error)}`);
      process.exitCode = 1;
    });
  });

program
  .command("version")
  .description("affiche les versions (bot, Node, plateforme)")
  .action(() => {
    const info = getVersionInfo();
    console.log(`solbot3 ${info.version} — node ${info.node} — ${info.platform}`);
  });

await program.parseAsync(process.argv);
