/**
 * Registre de métriques Prometheus — maison, sans dépendance.
 *
 * Deux familles : les **compteurs** (monotones) et les **jauges** (instantanés).
 * Les étiquettes sont triées pour que le rendu soit déterministe : deux
 * scrapes du même état produisent exactement la même sortie, ce qui rend les
 * diffs lisibles.
 */

export type MetricType = "counter" | "gauge";

export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
}

export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  register(definition: MetricDefinition): void {
    this.definitions.set(definition.name, definition);
  }

  /** Incrémente un compteur. */
  inc(name: string, value = 1, labels?: Record<string, string | number>): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  /** Pose une jauge. */
  set(name: string, value: number, labels?: Record<string, string | number>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  get(name: string, labels?: Record<string, string | number>): number | undefined {
    const key = this.key(name, labels);
    return this.counters.get(key) ?? this.gauges.get(key);
  }

  /** Rendu au format d'exposition Prometheus 0.0.4. */
  render(): string {
    const lines: string[] = [];

    for (const definition of [...this.definitions.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entries = [...new Set([...this.counters.keys(), ...this.gauges.keys()])]
        .filter((key) => key.startsWith(`${definition.name}{`) || key === definition.name)
        .sort();

      if (entries.length === 0) continue;

      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);

      for (const entry of entries) {
        const value = this.counters.get(entry) ?? this.gauges.get(entry) ?? 0;
        lines.push(`${entry} ${value}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  private key(name: string, labels?: Record<string, string | number>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const rendered = Object.keys(labels)
      .sort()
      .map((label) => `${label}="${escapeLabel(String(labels[label]))}"`)
      .join(",");
    return `${name}{${rendered}}`;
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Les métriques du projet, avec leur aide. */
export const METRICS = {
  ticksTotal: "solbot3_ticks_total",
  tickErrorsTotal: "solbot3_tick_errors_total",
  navUsd: "solbot3_nav_usd",
  cashUsd: "solbot3_cash_usd",
  positionsOpen: "solbot3_positions_open",
  drawdownPct: "solbot3_drawdown_pct",
  dailyPnlUsd: "solbot3_daily_pnl_usd",
  pricesTotal: "solbot3_prices_total",
  signalsTotal: "solbot3_signals_total",
  rejectionsTotal: "solbot3_rejections_total",
  tradesTotal: "solbot3_trades_total",
  executionLatencyMs: "solbot3_execution_latency_ms",
  allocationChangesTotal: "solbot3_allocation_changes_total",
  pilotScorePct: "solbot3_pilot_score_pct",
  alertsTotal: "solbot3_alerts_total",
  notificationsTotal: "solbot3_notifications_total",
  backupsTotal: "solbot3_backups_total",
  uptimeSeconds: "solbot3_uptime_seconds",
  lastTickTimestamp: "solbot3_last_tick_timestamp_seconds",
  strategyScorePct: "solbot3_strategy_score_pct",
} as const;

export const METRIC_HELP: Record<string, string> = {
  [METRICS.ticksTotal]: "Nombre total de ticks traités",
  [METRICS.tickErrorsTotal]: "Nombre total de ticks en erreur",
  [METRICS.navUsd]: "Valeur nette du portefeuille, en USD",
  [METRICS.cashUsd]: "Cash disponible, en USD",
  [METRICS.positionsOpen]: "Nombre de positions ouvertes",
  [METRICS.drawdownPct]: "Drawdown courant depuis le pic d'équité, en %",
  [METRICS.dailyPnlUsd]: "PnL du jour, en USD",
  [METRICS.pricesTotal]: "Nombre total de prix obtenus",
  [METRICS.signalsTotal]: "Nombre total de signaux émis",
  [METRICS.rejectionsTotal]: "Nombre total de rejets par le risque",
  [METRICS.tradesTotal]: "Nombre total d'exécutions",
  [METRICS.executionLatencyMs]: "Latence d'exécution, en millisecondes",
  [METRICS.allocationChangesTotal]: "Nombre de changements de stratégie pilote",
  [METRICS.pilotScorePct]: "Score de la stratégie pilote, en %",
  [METRICS.alertsTotal]: "Nombre total d'alertes émises",
  [METRICS.notificationsTotal]: "Nombre total de notifications envoyées",
  [METRICS.backupsTotal]: "Nombre total de backups effectués",
  [METRICS.uptimeSeconds]: "Durée de fonctionnement, en secondes",
  [METRICS.lastTickTimestamp]: "Horodatage du dernier tick",
  [METRICS.strategyScorePct]: "Score d'une stratégie, en %",
};

/** Crée un registre avec toutes les métriques du projet déclarées. */
export function createRegistry(): MetricsRegistry {
  const registry = new MetricsRegistry();
  for (const [name, help] of Object.entries(METRIC_HELP)) {
    const type = name.endsWith("_total") ? "counter" : "gauge";
    registry.register({ name, type, help });
  }
  return registry;
}
