import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { listDecisions } from "../state/decisions.js";
import { listEquity } from "../state/equity.js";
import { listTrades } from "../state/trades.js";
import type { DB } from "../state/db.js";
import { buildDashboardState, type DashboardConfig } from "./state.js";

/**
 * Le dashboard — **strictement en lecture seule**.
 *
 * Aucune route n'accepte d'écriture : ni POST, ni PUT, ni DELETE, ni aucune
 * route d'action. Un bug dans le front ne peut donc pas placer d'ordre, ni
 * lever le kill-switch, ni corriger une position.
 *
 * C'est vérifié par un test : la propriété « lecture seule » est une
 * **donnée**, pas une intention.
 */

export interface DashboardServerOptions {
  host: string;
  port: number;
  db: DB;
  config: DashboardConfig;
  /** Jeton d'accès. Si défini, toutes les routes l'exigent. */
  token?: string | undefined;
  /** Répertoire des fichiers statiques (front compilé). */
  staticDir?: string | undefined;
  /** Notifié à chaque broadcast SSE. */
  onBroadcast?: (kind: string, payload: unknown) => void;
}

export class DashboardServer {
  private readonly server: http.Server;
  /** Clients connectés au flux SSE. */
  private readonly clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly options: DashboardServerOptions) {
    this.server = http.createServer((request, response) => {
      this.handle(request, response);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });

    // Battement de cœur : sans lui, les proxies ferment les connexions
    // inactives et le front perd le flux sans le signaler.
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        client.write(": ping\n\n");
      }
    }, 15_000);

    const address = this.server.address();
    if (address && typeof address === "object") {
      return `http://${this.options.host}:${address.port}`;
    }
    return `http://${this.options.host}:${this.options.port}`;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** Pousse un événement vers tous les clients SSE. */
  broadcast(kind: string, payload: unknown): void {
    const frame = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
    this.options.onBroadcast?.(kind, payload);
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    // ── Méthode : lecture seule ────────────────────────────────────────
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.json(response, 405, {
        error: "méthode non autorisée",
        detail: "le dashboard est en lecture seule",
      });
      return;
    }

    // ── Jeton d'accès ──────────────────────────────────────────────────
    if (this.options.token && !this.isAuthorized(request, url)) {
      this.json(response, 401, { error: "authentification requise" });
      return;
    }

    // ── API ────────────────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      this.handleApi(url, response);
      return;
    }

    // ── Fichiers statiques ─────────────────────────────────────────────
    if (this.options.staticDir) {
      this.serveStatic(url.pathname, response);
      return;
    }

    this.json(response, 404, { error: "not found" });
  }

  private handleApi(url: URL, response: http.ServerResponse): void {
    try {
      this.handleApiRoute(url, response);
    } catch (error) {
      // Une erreur de projection ne doit pas **tuer** le dashboard : on
      // répond 500 et on continue de servir.
      this.json(response, 500, {
        error: "erreur interne",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleApiRoute(url: URL, response: http.ServerResponse): void {
    const { db, config } = this.options;

    switch (url.pathname) {
      case "/api/state": {
        this.json(response, 200, buildDashboardState(db, config));
        return;
      }
      case "/api/positions": {
        const state = buildDashboardState(db, config);
        this.json(response, 200, { positions: state.portfolio.positions });
        return;
      }
      case "/api/trades": {
        const limit = clampLimit(url.searchParams.get("limit"), 200);
        const mode = url.searchParams.get("mode") ?? config.mode;
        this.json(response, 200, { trades: listTrades(db, { mode, limit }) });
        return;
      }
      case "/api/strategies": {
        const state = buildDashboardState(db, config);
        this.json(response, 200, {
          pilot: state.allocation.pilot,
          scores: state.allocation.scores,
        });
        return;
      }
      case "/api/decisions": {
        const limit = clampLimit(url.searchParams.get("limit"), 200);
        const kind = url.searchParams.get("kind");
        const strategy = url.searchParams.get("strategy") ?? undefined;
        const mint = url.searchParams.get("mint") ?? undefined;
        const since = url.searchParams.get("since");
        const decisions = listDecisions(db, {
          limit,
          kind: kind ? [kind as never] : undefined,
          strategy,
          mint,
        });
        const filtered = since
          ? decisions.filter((d) => d.tsMs >= Number.parseInt(since, 10))
          : decisions;
        this.json(response, 200, { decisions: filtered });
        return;
      }
      case "/api/equity": {
        const limit = clampLimit(url.searchParams.get("limit"), 2000);
        const mode = url.searchParams.get("mode") ?? config.mode;
        this.json(response, 200, { equity: listEquity(db, { mode, limit }) });
        return;
      }
      case "/api/watchlist": {
        const state = buildDashboardState(db, config);
        this.json(response, 200, { markets: state.markets });
        return;
      }
      case "/api/stream": {
        this.openStream(response);
        return;
      }
      default:
        this.json(response, 404, { error: "not found" });
    }
  }

  /** Ouvre le flux SSE. */
  private openStream(response: http.ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 3000\n\n");
    response.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

    this.clients.add(response);
    response.on("close", () => {
      this.clients.delete(response);
    });
  }

  /** Vérifie le jeton : en-tête `Authorization` ou paramètre `?token=`. */
  private isAuthorized(request: http.IncomingMessage, url: URL): boolean {
    const token = this.options.token;
    if (!token) return true;

    const header = request.headers.authorization;
    if (header && header.startsWith("Bearer ") && header.slice(7) === token) return true;

    return url.searchParams.get("token") === token;
  }

  /** Sert un fichier statique, en interdisant la traversée de chemin. */
  private serveStatic(pathname: string, response: http.ServerResponse): void {
    const dir = this.options.staticDir;
    if (!dir) {
      this.json(response, 404, { error: "not found" });
      return;
    }

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dir, relative);
    // Interdit de sortir du répertoire statique (`../../etc/passwd`).
    if (!target.startsWith(path.resolve(dir))) {
      this.json(response, 403, { error: "forbidden" });
      return;
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      this.json(response, 404, { error: "not found" });
      return;
    }

    const contentType = contentTypeFor(target);
    response.writeHead(200, { "content-type": contentType });
    fs.createReadStream(target).pipe(response);
  }

  private json(response: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

function clampLimit(raw: string | null, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, 5_000);
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

/**
 * Avertissement d'exposition.
 *
 * Un dashboard sans jeton, écoutant sur une interface publique, est un
 * dashboard **ouvert à la lecture** par tout l'internet. Le mot « lecture
 * seule » rassure, mais il faut le dire.
 */
export function exposureWarning(host: string, token: string | undefined): string | null {
  const isPublic = host === "0.0.0.0" || host === "::" || host === "";
  if (!isPublic) return null;
  if (token) return null;
  return `le dashboard écoute sur ${host} sans jeton d'accès (DASHBOARD_TOKEN) : ses données sont lisibles par quiconque atteint cette interface.`;
}
