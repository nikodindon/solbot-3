import fs from "node:fs";
import path from "node:path";
import { DashboardServer, exposureWarning } from "../dashboard/server.js";
import { blank, heading, info, note, warn } from "./output.js";
import { closeRuntime, createRuntime } from "./runtime.js";

export interface DashboardCliOptions {
  root?: string;
  host?: string;
  port?: number;
}

/**
 * `solbot3 dashboard` — le tableau de bord, **seul**.
 *
 * Le dashboard peut tourner indépendamment du moteur : il lit la base, il
 * n'écrit rien. C'est pratique pour consulter l'état depuis une autre
 * machine, ou pour faire tourner le front sur un poste de travail pendant
 * que le bot tourne sur le serveur.
 */
export async function runDashboard(options: DashboardCliOptions = {}): Promise<void> {
  const runtime = createRuntime({ root: options.root });
  // Le serveur est déclaré hors du `try` : s'il démarre puis qu'une erreur
  // survient, il faut **l'arrêter avant de fermer la base**. Sinon il
  // continuerait de servir des requêtes sur une base fermée.
  let server: DashboardServer | undefined;

  try {
    // L'hôte et le port peuvent être surchargés par l'environnement : dans
    // un conteneur, le serveur doit écouter sur 0.0.0.0 pour être atteignable
    // depuis l'hôte (le mapping de port ne peut pas traverser la boucle
    // locale du conteneur).
    const host = options.host ?? process.env.DASHBOARD_HOST ?? runtime.config.dashboard.host;
    const port =
      options.port ?? Number(process.env.DASHBOARD_PORT ?? runtime.config.dashboard.port);
    const token = process.env.DASHBOARD_TOKEN;

    server = new DashboardServer({
      host,
      port,
      db: runtime.db,
      config: {
        mode: runtime.config.mode,
        stalePriceMaxS: runtime.config.data.stale_price_max_s,
        timeframes: runtime.config.data.timeframes,
      },
      token,
      staticDir: findStaticDir(runtime.root),
    });

    const address = await server.start();

    heading("solbot3 dashboard");
    info("adresse", address);
    info("mode affiché", runtime.config.mode);
    info("authentification", token ? "jeton requis" : "aucun jeton (accès libre)");

    const warning = exposureWarning(host, token);
    if (warning) warn("exposition", warning);

    if (!findStaticDir(runtime.root)) {
      blank();
      note("front non compilé — l'API reste disponible (voir /api/state)");
    }

    blank();
    note("Ctrl+C pour arrêter");
    blank();

    // Le serveur tourne jusqu'à l'interruption.
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    if (server) await server.stop();
    closeRuntime(runtime);
  }
}

/** Cherche le front compilé (`web/dist`). */
function findStaticDir(root: string): string | undefined {
  for (const candidate of ["web/dist", "dist/dashboard", "public"]) {
    const dir = path.join(root, candidate);
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return undefined;
}
