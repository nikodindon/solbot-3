import { SOL_MINT } from "../constants.js";
import type { DB } from "../state/db.js";
import { listDecisions } from "../state/decisions.js";
import { attestNavPeak, firstEquityPoint, listEquity } from "../state/equity.js";
import {
  closeAtOrBefore,
  getMergedCandles,
  type ImportedCandle,
} from "../state/imported-candles.js";
import { kvGetNumber, kvGet, STATE_KEYS } from "../state/kv.js";
import { listWatchlist, resolveSymbol } from "../state/market-data.js";
import { listPositions } from "../state/portfolio-repo.js";
import { costBreakdown, listTrades } from "../state/trades.js";
import { shadowNavSeries, shadowTradeCount } from "../allocator/shadow.js";

/**
 * L'état du dashboard.
 *
 * C'est une **projection** de la base, calculée à la demande. Le dashboard
 * ne possède aucun état propre : il lit, il n'écrit jamais.
 *
 * Tout est vérifiable : chaque chiffre affiché vient d'une table, et la
 * fraîcheur est explicite (« données vieilles de X s ») plutôt que
 * silencieuse.
 */

export interface DashboardConfig {
  mode: string;
  /** Âge maximal au-delà duquel les prix sont considérés périmés (secondes). */
  stalePriceMaxS: number;
  /** Timeframes affichés dans la vue « Données ». */
  timeframes: string[];
}

export interface ChartBundle {
  /** Axe des temps (secondes). */
  time: number[];
  /** NAV du portefeuille réel. */
  nav: number[];
  /** Cash seul. */
  cash: number[];
  /** Référence buy & hold SOL, normalisée sur le NAV de départ du run. */
  benchmark: number[];
  /** Une série par stratégie en shadow. */
  shadows: { name: string; time: number[]; nav: number[] }[];
}

export interface DashboardState {
  clock: {
    now: number;
    /** Le moteur tourne-t-il ? (dernier tick récent) */
    fresh: boolean;
    lastTickAt: number | null;
    lastTickAgeS: number | null;
  };
  mode: string;
  nav: {
    usd: number;
    cash: number;
    positions: number;
    realized: number;
    drawdownPct: number;
    /** NAV de départ du run — l'origine du PnL affiché. */
    initial: number;
    peak: number;
  };
  portfolio: {
    positions: DashboardPosition[];
    costs: { feesUsd: number; trades: number; notionalUsd: number };
  };
  allocation: {
    pilot: string | null;
    scores: StrategyScore[];
    changed: boolean;
  };
  guards: {
    stopFile: boolean;
    killSwitchAtMs: number | null;
    pausedUntilMs: number | null;
    dayAnchorUsd: number | null;
    dailyDropPct: number;
    dailyLimitPct: number;
  };
  markets: MarketRow[];
  benchmarks: {
    cashUsd: number;
    /** Performance du buy & hold SOL sur la fenêtre, en %. */
    solBuyHoldPct: number | null;
  };
  /** Séries prêtes à tracer. */
  charts: ChartBundle;
  counters: {
    ticks: number;
    trades: number;
    signals: number;
    rejections: number;
    decisions: number;
  };
}

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
  /** Friction d'entrée : la part du prix payé en frais de fill. */
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
  /** Âge du dernier prix connu, en secondes. */
  ageS: number | null;
  fresh: boolean;
  regime: string | null;
  candles: { tf: string; count: number }[];
}

/** Construit l'état complet du dashboard. */
export function buildDashboardState(
  db: DB,
  cfg: DashboardConfig,
  nowMs: number = Date.now(),
): DashboardState {
  const equity = listEquity(db, { mode: cfg.mode, limit: 2000 });
  const last = equity[equity.length - 1];
  const first = equity[0];

  // L'affichage est tronqué (2 000 derniers points) : `first` est le début
  // de la **fenêtre**, pas le début du run. Tout ce qui se dit « depuis le
  // début » s'ancre sur ce point-là, sinon le PnL et la référence buy &
  // hold se rapportent à deux périodes différentes.
  const runStart = firstEquityPoint(db, cfg.mode) ?? first;
  const initial = runStart?.navUsd ?? 0;
  const navUsd = last?.navUsd ?? 0;
  const cash = last?.cashUsd ?? 0;
  const realized = last?.realizedPnlUsd ?? 0;
  const peak = attestNavPeak(db, cfg.mode, navUsd).peakUsd;
  const drawdownPct = peak > 0 ? Math.max(0, ((peak - navUsd) / peak) * 100) : 0;

  const positions = listPositions(db);
  const lastTickAt = equity[equity.length - 1]?.tsMs ?? null;
  const lastTickAgeS = lastTickAt === null ? null : Math.floor((nowMs - lastTickAt) / 1000);
  const fresh = lastTickAgeS !== null && lastTickAgeS <= cfg.stalePriceMaxS;

  // ── Positions valorisées ──────────────────────────────────────────────
  const marks = latestMarks(db, cfg, nowMs);
  const dashboardPositions: DashboardPosition[] = positions.map((position) => {
    const mark = marks.get(position.mint);
    const priceUsd = mark?.priceUsd ?? position.avgEntryUsd;
    const valueUsd = position.qty * priceUsd;
    const unrealizedUsd = (priceUsd - position.avgEntryUsd) * position.qty;
    return {
      mint: position.mint,
      // Le symbole stocké à l'ouverture peut être un mint tronqué : on
      // va chercher le vrai nom dans la base.
      symbol: resolveSymbol(db, position.mint, position.symbol),
      qty: position.qty,
      avgEntryUsd: position.avgEntryUsd,
      priceUsd,
      valueUsd,
      unrealizedUsd,
      unrealizedPct:
        position.avgEntryUsd > 0
          ? ((priceUsd - position.avgEntryUsd) / position.avgEntryUsd) * 100
          : 0,
      stopLossUsd: position.stopLossUsd,
      takeProfitUsd: position.takeProfitUsd,
      peakPriceUsd: position.peakPriceUsd,
      ageMs: nowMs - position.openedMs,
      entryFrictionUsd: 0,
    };
  });

  // ── Coûts ───────────────────────────────────────────────────────────
  const costs = costBreakdown(db);

  // ── Allocation (shadows) ────────────────────────────────────────────
  const pilot = kvGet(db, STATE_KEYS.allocatedStrategy) ?? null;
  const scores: StrategyScore[] = [];
  for (const shadow of shadowNames(db)) {
    const series = shadowNavSeries(db, shadow);
    const trades = shadowTradeCount(db, shadow, 0);
    const startNav = series[0]?.navUsd ?? 0;
    const endNav = series[series.length - 1]?.navUsd ?? 0;
    const scorePct = startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0;
    scores.push({
      name: shadow,
      scorePct,
      trades,
      eligible: trades >= 10,
      reason: trades >= 10 ? null : `${trades} trade(s) < 10 requis`,
      navUsd: endNav,
    });
  }

  // ── Garde-fous ───────────────────────────────────────────────────────
  const dayAnchorUsd = kvGetNumber(db, STATE_KEYS.dayStartNavUsd) ?? null;
  const dailyDropPct =
    dayAnchorUsd !== null && dayAnchorUsd > 0
      ? Math.max(0, ((dayAnchorUsd - navUsd) / dayAnchorUsd) * 100)
      : 0;

  // ── Marchés ──────────────────────────────────────────────────────────
  const watchlist = listWatchlist(db);
  const markets: MarketRow[] = watchlist.map((item) => {
    const mark = marks.get(item.mint);
    const candles = cfg.timeframes.map((tf) => ({
      tf,
      count: getMergedCandles(db, item.mint, tf as never, {}).length,
    }));
    return {
      mint: item.mint,
      symbol: item.symbol,
      priceUsd: mark?.priceUsd ?? null,
      liquidityUsd: mark?.liquidityUsd ?? null,
      ageS: mark?.ageS ?? null,
      fresh: mark?.fresh ?? false,
      regime: null,
      candles,
    };
  });

  // ── Benchmark buy & hold SOL ─────────────────────────────────────────
  //
  // **Même origine que le NAV** : le SOL est rapporté au cours qu'il avait
  // au départ du run, et la variation affichée couvre exactement cette
  // période. Ancrer sur la première bougie importée (trois mois plus tôt)
  // affichait +33 % pendant que SOL perdait 7 % sur la durée du run — deux
  // périodes présentées côte à côte comme si elles étaient les mêmes.
  const runStartMs = runStart?.tsMs ?? first?.tsMs ?? nowMs;
  const solCandles = getMergedCandles(db, SOL_MINT, "1h", { toMs: nowMs });
  const solAnchorUsd = closeAtOrBefore(solCandles, runStartMs) ?? solCandles[0]?.close ?? null;
  const solLastUsd = solCandles[solCandles.length - 1]?.close ?? null;
  const solBuyHoldPct =
    solAnchorUsd !== null && solLastUsd !== null && solAnchorUsd > 0
      ? ((solLastUsd - solAnchorUsd) / solAnchorUsd) * 100
      : null;

  const trades = listTrades(db, { mode: cfg.mode, limit: 10_000 });
  const decisions = listDecisions(db, { limit: 10_000 });

  // ── Séries pour les graphiques ───────────────────────────────────────
  const charts = buildCharts(db, equity, solCandles, solAnchorUsd, initial);

  return {
    clock: { now: nowMs, fresh, lastTickAt, lastTickAgeS },
    mode: cfg.mode,
    nav: {
      usd: navUsd,
      cash,
      positions: dashboardPositions.reduce((sum, p) => sum + p.valueUsd, 0),
      realized,
      drawdownPct,
      initial,
      peak,
    },
    portfolio: { positions: dashboardPositions, costs },
    allocation: { pilot: pilot || null, scores, changed: false },
    guards: {
      stopFile: false,
      killSwitchAtMs: kvGetNumber(db, STATE_KEYS.killSwitchAtMs),
      pausedUntilMs: kvGetNumber(db, STATE_KEYS.pausedUntilMs) ?? null,
      dayAnchorUsd,
      dailyDropPct,
      dailyLimitPct: 0,
    },
    markets,
    benchmarks: { cashUsd: cash, solBuyHoldPct },
    charts,
    counters: {
      ticks: kvGetNumber(db, STATE_KEYS.tickCount) ?? 0,
      trades: trades.length,
      signals: decisions.filter((d) => d.kind === "signal").length,
      rejections: decisions.filter((d) => d.kind === "reject").length,
      decisions: decisions.length,
    },
  };
}

/**
 * Construit les séries des graphiques.
 *
 * Les deux courbes partagent **la même origine** (le NAV de départ du run)
 * : on veut comparer deux courbes dans la même unité, pas deux prix
 * différents, et pas davantage deux périodes différentes.
 */
function buildCharts(
  db: DB,
  equity: { tsMs: number; navUsd: number; cashUsd: number }[],
  solCandles: ImportedCandle[],
  solAnchorUsd: number | null,
  initialNav: number,
): ChartBundle {
  const time = equity.map((point) => Math.floor(point.tsMs / 1000));
  const nav = equity.map((point) => point.navUsd);
  const cash = equity.map((point) => point.cashUsd);

  // Buy & hold SOL, normalisé sur le NAV de départ du run.
  const benchmark: number[] = [];
  if (solAnchorUsd !== null && solAnchorUsd > 0 && initialNav > 0) {
    for (const point of equity) {
      // On prend le dernier close SOL connu à cet instant.
      let last = solAnchorUsd;
      for (const candle of solCandles) {
        if (candle.ts > point.tsMs) break;
        last = candle.close;
      }
      benchmark.push((last / solAnchorUsd) * initialNav);
    }
  }

  // Une série par stratégie en shadow.
  const shadows: { name: string; time: number[]; nav: number[] }[] = [];
  for (const name of shadowNames(db)) {
    const series = shadowNavSeries(db, name);
    if (series.length < 2) continue;
    shadows.push({
      name,
      time: series.map((point) => Math.floor(point.tsMs / 1000)),
      nav: series.map((point) => point.navUsd),
    });
  }

  return { time, nav, cash, benchmark, shadows };
}

/** Derniers prix connus, avec leur fraîcheur. */
function latestMarks(
  db: DB,
  cfg: DashboardConfig,
  nowMs: number,
): Map<
  string,
  { priceUsd: number; liquidityUsd: number | null; ageS: number | null; fresh: boolean }
> {
  const out = new Map<
    string,
    { priceUsd: number; liquidityUsd: number | null; ageS: number | null; fresh: boolean }
  >();

  const rows = db
    .prepare(
      `SELECT p.mint AS mint, p.price_usd AS price_usd, p.liquidity_usd AS liquidity_usd, p.ts_ms AS ts_ms
         FROM price_ticks p
         JOIN (SELECT mint, MAX(ts_ms) AS max_ts FROM price_ticks GROUP BY mint) m
           ON m.mint = p.mint AND m.max_ts = p.ts_ms
        GROUP BY p.mint`,
    )
    .all() as {
    mint: string;
    price_usd: number;
    liquidity_usd: number | null;
    ts_ms: number;
  }[];

  for (const row of rows) {
    const ageS = Math.floor((nowMs - row.ts_ms) / 1000);
    out.set(row.mint, {
      priceUsd: row.price_usd,
      liquidityUsd: row.liquidity_usd,
      ageS,
      fresh: ageS <= cfg.stalePriceMaxS,
    });
  }

  return out;
}

/** Noms des shadows enregistrés (les stratégies qui ont joué). */
function shadowNames(db: DB): string[] {
  const rows = db.prepare("SELECT DISTINCT shadow FROM shadow_nav ORDER BY shadow").all() as {
    shadow: string;
  }[];
  return rows.map((row) => row.shadow);
}
