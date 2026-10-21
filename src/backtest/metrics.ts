/**
 * Métriques de performance.
 *
 * Règle absolue : **une métrique non calculable vaut `null`**, jamais `0`.
 * Un `0` de win rate signifie « aucun trade gagnant » ; un `null` signifie
 * « on ne sait pas ». La différence est entre un rapport honnête et un
 * rapport qui ment calmement.
 */

export interface EquitySample {
  tsMs: number;
  navUsd: number;
}

export interface ClosedTrade {
  tsMs: number;
  pnlUsd: number;
  notionalUsd: number;
  feeUsd: number;
}

export interface MetricsInput {
  equity: EquitySample[];
  trades: ClosedTrade[];
  initialUsd: number;
  days: number;
  /** Nombre de ticks traités (dénominateur du turnover journalier). */
  ticks?: number;
}

export interface PerformanceMetrics {
  initialNavUsd: number;
  finalNavUsd: number;
  netPnlUsd: number;
  netPnlPct: number | null;
  days: number;
  /** Trades clôturés (positions fermées). */
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  /** Sharpe annualisé sur clôtures quotidiennes. */
  sharpe: number | null;
  /** Notional total / NAV moyen. */
  turnover: number;
  turnoverPerDay: number;
  feesUsd: number;
  avgTradeUsd: number;
}

const EPSILON = 1e-9;

export function computeMetrics(input: MetricsInput): PerformanceMetrics {
  const { equity, trades, initialUsd, days } = input;

  const initialNavUsd = equity[0]?.navUsd ?? initialUsd;
  const finalNavUsd = equity[equity.length - 1]?.navUsd ?? initialUsd;

  const wins = trades.filter((t) => t.pnlUsd > EPSILON).length;
  const losses = trades.filter((t) => t.pnlUsd < -EPSILON).length;
  const decided = wins + losses;

  const grossProfitUsd = trades.filter((t) => t.pnlUsd > 0).reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossLossUsd = Math.abs(
    trades.filter((t) => t.pnlUsd < 0).reduce((sum, t) => sum + t.pnlUsd, 0),
  );

  const totalNotional = trades.reduce((sum, t) => sum + t.notionalUsd, 0);
  const avgNav =
    equity.length > 0 ? equity.reduce((sum, p) => sum + p.navUsd, 0) / equity.length : 0;
  const turnover = avgNav > 0 ? totalNotional / avgNav : 0;
  const feesUsd = trades.reduce((sum, t) => sum + t.feeUsd, 0);

  return {
    initialNavUsd,
    finalNavUsd,
    netPnlUsd: finalNavUsd - initialNavUsd,
    netPnlPct: initialUsd > 0 ? ((finalNavUsd - initialUsd) / initialUsd) * 100 : null,
    days,
    trades: trades.length,
    wins,
    losses,
    winRatePct: decided > 0 ? (wins / decided) * 100 : null,
    grossProfitUsd,
    grossLossUsd,
    profitFactor: grossLossUsd > EPSILON ? grossProfitUsd / grossLossUsd : null,
    maxDrawdownPct: maxDrawdownPct(equity),
    sharpe: sharpeDaily(equity),
    turnover,
    turnoverPerDay: days > 0 ? turnover / days : turnover,
    feesUsd,
    avgTradeUsd: trades.length > 0 ? totalNotional / trades.length : 0,
  };
}

/** Drawdown maximal, en %, depuis le pic d'équité. */
export function maxDrawdownPct(equity: EquitySample[]): number | null {
  if (equity.length < 2) return null;
  let peak = equity[0]?.navUsd ?? 0;
  let maxDd = 0;
  for (const point of equity) {
    const nav = point.navUsd;
    if (nav > peak) peak = nav;
    if (peak > 0) {
      const dd = ((peak - nav) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * Sharpe annualisé, calculé sur les **clôtures quotidiennes**.
 *
 * Exige au moins trois journées distinctes et une volatilité non nulle :
 * en dessous, la valeur serait un nombre inventé.
 */
export function sharpeDaily(equity: EquitySample[]): number | null {
  if (equity.length < 3) return null;

  const byDay = new Map<string, number>();
  for (const point of equity) {
    byDay.set(new Date(point.tsMs).toISOString().slice(0, 10), point.navUsd);
  }
  if (byDay.size < 3) return null;

  const navs = [...byDay.values()];
  const returns: number[] = [];
  for (let i = 1; i < navs.length; i++) {
    const previous = navs[i - 1] ?? 0;
    const current = navs[i] ?? 0;
    if (previous > 0) returns.push((current - previous) / previous);
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const sigma = Math.sqrt(variance);
  if (sigma === 0) return null;

  return (mean / sigma) * Math.sqrt(365);
}

/** Métriques « vides » : tout est `null` ou zéro, rien n'est inventé. */
export function emptyMetrics(initialUsd: number, days: number): PerformanceMetrics {
  return {
    initialNavUsd: initialUsd,
    finalNavUsd: initialUsd,
    netPnlUsd: 0,
    netPnlPct: 0,
    days,
    trades: 0,
    wins: 0,
    losses: 0,
    winRatePct: null,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    profitFactor: null,
    maxDrawdownPct: null,
    sharpe: null,
    turnover: 0,
    turnoverPerDay: 0,
    feesUsd: 0,
    avgTradeUsd: 0,
  };
}
