import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config/schema.js";
import type { DB } from "../state/db.js";
import { listPositions } from "../state/portfolio-repo.js";
import { listEquity } from "../state/equity.js";
import { listTrades } from "../state/trades.js";
import { kvGetNumber, kvDelete, kvSet, STATE_KEYS } from "../state/kv.js";
import { getStopFilePath } from "../utils/paths.js";

/**
 * Commandes Telegram.
 *
 * Le contrôleur ne parle **qu'à la base** : il fonctionne même si le moteur
 * est arrêté, et même après un redémarrage. C'est ce qui rend `/kill`
 * fiable — c'est la commande de secours.
 *
 * Un seul chat est autorisé : celui configuré. Tout le reste est ignoré.
 */

export interface ParsedCommand {
  name: string;
  args: string[];
}

/** Analyse une commande Telegram (`/pnl@monbot 7`). */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [rawName, ...args] = trimmed.split(/\s+/);
  // La forme `/commande@nomDuBot` est celle que Telegram envoie en groupe.
  const name = (rawName ?? "").split("@")[0]?.replace(/^\//, "").toLowerCase() ?? "";
  if (name === "") return null;
  return { name, args };
}

export interface CommandContext {
  db: DB;
  cfg: AppConfig;
  root: string;
  /** NAV courant, si connu. */
  navUsd?: number | null;
}

export class TelegramController {
  constructor(private readonly context: CommandContext) {}

  /** Exécute une commande et renvoie la réponse à envoyer. */
  handle(command: ParsedCommand): string {
    switch (command.name) {
      case "status":
        return this.status();
      case "positions":
        return this.positions();
      case "pnl":
        return this.pnl(Number.parseInt(command.args[0] ?? "7", 10));
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "kill":
        return this.kill();
      case "help":
        return this.help();
      default:
        return `Commande inconnue : /${command.name}`;
    }
  }

  status(): string {
    const { db, cfg } = this.context;
    const positions = listPositions(db);
    const lastTrade = listTrades(db, { limit: 1 })[0];
    const equity = listEquity(db, { limit: 1 })[0];

    return [
      `📊 *solbot3* — mode \`${cfg.mode}\``,
      `NAV : ${(this.context.navUsd ?? equity?.navUsd ?? 0).toFixed(2)} $`,
      `Positions : ${positions.length}`,
      `Kill-switch : ${this.killSwitchActive() ? "⚠️ actif" : "inactif"}`,
      `Pause manuelle : ${this.isPaused() ? "oui" : "non"}`,
      lastTrade
        ? `Dernier trade : ${new Date(lastTrade.tsMs).toISOString().slice(0, 16).replace("T", " ")} UTC`
        : "Aucun trade",
    ].join("\n");
  }

  positions(): string {
    const positions = listPositions(this.context.db);
    if (positions.length === 0) return "Aucune position ouverte.";

    const lines = positions.map((position) => {
      const pnlPct =
        position.avgEntryUsd > 0
          ? ((position.avgEntryUsd - position.avgEntryUsd) / position.avgEntryUsd) * 100
          : 0;
      return (
        `• ${position.symbol} — ${position.qty.toFixed(4)} @ ${position.avgEntryUsd.toFixed(6)} ` +
        `(${pnlPct.toFixed(2)} % d'écart moyen)`
      );
    });

    return [`📦 *${positions.length} position(s)*`, ...lines].join("\n");
  }

  pnl(days: number): string {
    const sinceMs = Date.now() - days * 86_400_000;
    const trades = listTrades(this.context.db, { limit: 10_000 }).filter((t) => t.tsMs >= sinceMs);
    const realized = trades.reduce((sum, t) => sum + (t.realizedPnlUsd ?? 0), 0);
    const fees = trades.reduce((sum, t) => sum + t.feeUsd, 0);
    const wins = trades.filter((t) => (t.realizedPnlUsd ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.realizedPnlUsd ?? 0) < 0).length;

    return [
      `💰 *PnL sur ${days} j*`,
      `Réalisé : ${realized.toFixed(2)} $`,
      `Frais : ${fees.toFixed(2)} $`,
      `Trades : ${trades.length} (${wins} gagnants / ${losses} perdants)`,
    ].join("\n");
  }

  pause(): string {
    kvSet(this.context.db, STATE_KEYS.manualPaused, "1", Date.now());
    return "⏸ Entrées en pause. Les sorties restent actives. `/resume` pour reprendre.";
  }

  resume(): string {
    kvDelete(this.context.db, STATE_KEYS.manualPaused);
    return "▶️ Reprise des entrées.";
  }

  kill(): string {
    // Le kill-switch est un **fichier** : il survit au redémarrage, et le
    // moteur le voit au tick suivant.
    // ⚠ La variable s'appelle `stopPath` et non `path` : un `path` local
    // masquerait le module `node:path`, et `path.dirname` vaudrait
    // `undefined` — le kill-switch échouerait alors **silencieusement**, ce
    // qui est le pire scénario pour une commande de secours.
    const stopPath = getStopFilePath(this.context.root);
    try {
      // Le répertoire `data/` peut ne pas encore exister.
      fs.mkdirSync(path.dirname(stopPath), { recursive: true });
      fs.writeFileSync(stopPath, "kill-switch (Telegram)\n", { flag: "wx" });
    } catch {
      // déjà présent
    }
    return `🛑 Kill-switch déclenché (${stopPath}). Les entrées sont coupées, les sorties restent actives.`;
  }

  help(): string {
    return [
      "Commandes disponibles :",
      "• `/status` — état du bot",
      "• `/positions` — positions ouvertes",
      "• `/pnl [jours]` — PnL de la période",
      "• `/pause` — suspendre les entrées",
      "• `/resume` — reprendre les entrées",
      "• `/kill` — kill-switch (coupe les entrées)",
    ].join("\n");
  }

  private isPaused(): boolean {
    return kvGetNumber(this.context.db, STATE_KEYS.manualPaused) !== null;
  }

  private killSwitchActive(): boolean {
    return fs.existsSync(getStopFilePath(this.context.root));
  }
}
