import http from "node:http";
import type { AppConfig } from "../config/schema.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * Serveur de supervision : `/healthz` et `/metrics`.
 *
 * `/healthz` est le healthcheck de Docker et de systemd : il renvoie **503**
 * quand le bot ne va pas bien (tick périmé, base inaccessible). C'est ce qui
 * permet au superviseur de redémarrer un bot bloqué.
 *
 * `/metrics` expose les compteurs au format Prometheus.
 *
 * Le serveur est **en lecture seule** : aucune route n'accepte d'écriture.
 */

export type HealthStatus = "ok" | "stale" | "degraded";

export interface HealthState {
  status: HealthStatus;
  mode: string;
  version: string;
  uptimeS: number;
  ticks: number;
  lastTickAt: number | null;
  lastTickAgeS: number | null;
  navUsd: number | null;
  positionsOpen: number | null;
  paused: boolean;
  killSwitch: boolean;
  lastBackupAt: number | null;
  db: string;
}

export interface MonitoringServerOptions {
  host: string;
  port: number;
  metrics: MetricsRegistry;
  /** Source de l'état de santé. */
  health: () => HealthState;
}

export class MonitoringServer {
  private readonly server: http.Server;

  constructor(private readonly options: MonitoringServerOptions) {
    this.server = http.createServer((request, response) => {
      const url = request.url ?? "/";

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }

      if (url === "/healthz" || url.startsWith("/healthz?")) {
        const health = this.options.health();
        const status = health.status === "ok" ? 200 : 503;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(health));
        return;
      }

      if (url === "/metrics" || url.startsWith("/metrics?")) {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        response.end(this.options.metrics.render());
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  }

  /** Démarre le serveur et résout l'adresse écouter. */
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.server.address();
    if (address && typeof address === "object") {
      return `http://${this.options.host}:${address.port}`;
    }
    return `http://${this.options.host}:${this.options.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

/** Construit l'état de santé à partir de l'état du moteur. */
export function buildHealthState(input: {
  cfg: AppConfig;
  version: string;
  startedAtMs: number;
  nowMs: number;
  ticks: number;
  lastTickAtMs: number | null;
  navUsd: number | null;
  positionsOpen: number | null;
  paused: boolean;
  killSwitch: boolean;
  lastBackupAtMs: number | null;
  dbError: string | null;
}): HealthState {
  const staleAfterS = Math.max(120, input.cfg.loop_interval_s * 3);
  const lastTickAgeS =
    input.lastTickAtMs === null ? null : Math.floor((input.nowMs - input.lastTickAtMs) / 1000);

  let status: HealthStatus = "ok";
  if (input.dbError !== null) status = "degraded";
  else if (lastTickAgeS === null || lastTickAgeS > staleAfterS) status = "stale";

  return {
    status,
    mode: input.cfg.mode,
    version: input.version,
    uptimeS: Math.floor((input.nowMs - input.startedAtMs) / 1000),
    ticks: input.ticks,
    lastTickAt: input.lastTickAtMs,
    lastTickAgeS,
    navUsd: input.navUsd,
    positionsOpen: input.positionsOpen,
    paused: input.paused,
    killSwitch: input.killSwitch,
    lastBackupAt: input.lastBackupAtMs,
    db: input.dbError === null ? "ok" : input.dbError,
  };
}
