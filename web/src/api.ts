/**
 * Client de l'API du dashboard.
 *
 * Le dashboard est **en lecture seule** : ce module n'expose que des
 * requêtes `GET`. Il n'existe volontairement aucun moyen d'écrire depuis le
 * front.
 */

export interface DashboardPosition {
  mint: string;
  symbol: string;
  qty: number;
  avgEntryUsd: number;
  priceUsd: number;
  valueUsd: number;
  unrealizedUsd: number;
  unrealizedPct: number;
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  peakPriceUsd: number | null;
  ageMs: number;
  entryFrictionUsd: number;
}

export interface StrategyScore {
  name: string;
  scorePct: number;
  trades: number;
  eligible: boolean;
  reason: string | null;
  navUsd: number;
}

export interface MarketRow {
  mint: string;
  symbol: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  ageS: number | null;
  fresh: boolean;
  regime: string | null;
  candles: { tf: string; count: number }[];
}

export interface Decision {
  tsMs: number;
  tickId: number;
  kind: string;
  strategy: string | null;
  mint: string | null;
  line: string;
  data?: Record<string, unknown>;
}

export interface Trade {
  tsMs: number;
  mode: string;
  strategy: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  priceUsd: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnlUsd: number | null;
  reason: string | null;
  signature: string | null;
  status: string;
}

export interface EquityPoint {
  mode: string;
  tsMs: number;
  navUsd: number;
  cashUsd: number;
  positionsUsd: number;
  realizedPnlUsd: number;
  drawdownPct: number;
}

export interface ChartBundle {
  time: number[];
  nav: number[];
  cash: number[];
  benchmark: number[];
  shadows: { name: string; time: number[]; nav: number[] }[];
}

export interface DashboardState {
  clock: { now: number; fresh: boolean; lastTickAt: number | null; lastTickAgeS: number | null };
  mode: string;
  nav: {
    usd: number;
    cash: number;
    positions: number;
    realized: number;
    drawdownPct: number;
    initial: number;
    peak: number;
  };
  portfolio: {
    positions: DashboardPosition[];
    costs: { feesUsd: number; trades: number; notionalUsd: number };
  };
  allocation: { pilot: string | null; scores: StrategyScore[]; changed: boolean };
  guards: {
    stopFile: boolean;
    killSwitchAtMs: number | null;
    pausedUntilMs: number | null;
    dayAnchorUsd: number | null;
    dailyDropPct: number;
    dailyLimitPct: number;
  };
  markets: MarketRow[];
  benchmarks: { cashUsd: number; solBuyHoldPct: number | null };
  charts: ChartBundle;
  counters: {
    ticks: number;
    trades: number;
    signals: number;
    rejections: number;
    decisions: number;
  };
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${path} → HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  state: () => get<DashboardState>("/api/state"),
  positions: () => get<{ positions: DashboardPosition[] }>("/api/positions"),
  trades: (limit = 200) => get<{ trades: Trade[] }>(`/api/trades?limit=${limit}`),
  strategies: () =>
    get<{ pilot: string | null; scores: StrategyScore[] }>("/api/strategies"),
  decisions: (params: { limit?: number; kind?: string; strategy?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.kind) search.set("kind", params.kind);
    if (params.strategy) search.set("strategy", params.strategy);
    return get<{ decisions: Decision[] }>(`/api/decisions?${search.toString()}`);
  },
  equity: (limit = 2000) => get<{ equity: EquityPoint[] }>(`/api/equity?limit=${limit}`),
  watchlist: () => get<{ markets: MarketRow[] }>("/api/watchlist"),
};

/**
 * Flux SSE : ticks, trades, alertes.
 *
 * Le flux est une **amélioration**, jamais un prérequis : s'il tombe, le
 * dashboard continue de fonctionner en interrogeant l'API périodiquement.
 */
export function subscribe(
  onEvent: (kind: string, payload: unknown) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource("/api/stream");

  source.addEventListener("hello", () => onEvent("hello", null));
  source.addEventListener("tick", (event) => onEvent("tick", safeParse(event.data)));
  source.addEventListener("trade", (event) => onEvent("trade", safeParse(event.data)));
  source.addEventListener("alert", (event) => onEvent("alert", safeParse(event.data)));
  source.addEventListener("alloc", (event) => onEvent("alloc", safeParse(event.data)));
  source.onerror = () => {
    onError?.();
  };

  return () => {
    source.close();
  };
}

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
