import { useEffect, useMemo, useState } from "react";
import { Chart } from "../Chart";
import { api, type ChartBundle, type DashboardState, type StrategyScore } from "../api";
import { classFor, dateTime, pct, usd } from "../format";

/**
 * Vue d'ensemble : l'état du bot en un coup d'œil.
 *
 * NAV, cash, drawdown, PnL du jour, garde-fous, et la courbe d'équité avec
 * la référence buy & hold.
 */
export function OverviewView({ state }: { state: DashboardState | null }) {
  const [charts, setCharts] = useState<ChartBundle | null>(null);

  useEffect(() => {
    void api
      .state()
      .then((next) => setCharts(next.charts))
      .catch(() => setCharts(null));
  }, [state?.nav.usd]);

  // Chaque stratégie en shadow a sa propre couleur : on alterne entre un
  // bleu et un orange pour rester lisible même avec six stratégies.
  const shadowSeries = useMemo(
    () =>
      (charts?.shadows ?? []).map((shadow, index) => ({
        label: shadow.name,
        values: shadow.nav,
        color: index % 2 === 0 ? "#d29922" : "#a371f7",
        width: 1.5,
      })),
    [charts],
  );

  if (!state) {
    return <div className="empty">Chargement…</div>;
  }

  const { nav, guards, counters, portfolio } = state;
  const pnlPct = nav.initial > 0 ? ((nav.usd - nav.initial) / nav.initial) * 100 : 0;

  return (
    <>
      <div className="cards">
        <Card label="NAV" value={usd(nav.usd)} hint={`cash ${usd(nav.cash)}`} />
        <Card
          label="PnL"
          value={pct(pnlPct)}
          tone={classFor(pnlPct)}
          hint={`réalisé ${usd(nav.realized)}`}
        />
        <Card
          label="Drawdown"
          value={`${nav.drawdownPct.toFixed(2)} %`}
          tone={nav.drawdownPct > 0 ? "down" : ""}
          hint={`pic ${usd(nav.peak)}`}
        />
        <Card
          label="Positions"
          value={String(portfolio.positions.length)}
          hint={`${usd(nav.positions)} engagés`}
        />
        <Card
          label="Frais"
          value={usd(portfolio.costs.feesUsd)}
          hint={`${portfolio.costs.trades} exécutions`}
        />
        <Card
          label="Perte du jour"
          value={`${guards.dailyDropPct.toFixed(2)} %`}
          tone={guards.dailyDropPct > 0 ? "down" : ""}
          hint={guards.pausedUntilMs ? "entrées en pause" : "entrées actives"}
        />
      </div>

      {charts && charts.time.length > 1 ? (
        <>
          <Chart
            title="Équité du portefeuille et référence buy & hold"
            time={charts.time}
            series={[
              { label: "NAV", values: charts.nav, color: "#58a6ff", fill: true },
              { label: "Buy & hold SOL", values: charts.benchmark, color: "#3fb950" },
              { label: "Cash", values: charts.cash, color: "#8b949e" },
            ]}
          />
          {shadowSeries.length > 0 ? (
            <Chart
              title="Équité des stratégies en shadow (celle qui pilote est en bleu)"
              time={charts.time}
              series={shadowSeries}
            />
          ) : null}
        </>
      ) : (
        <div className="empty">Pas encore d'historique d'équité.</div>
      )}

      <div className="cards">
        <Card label="Ticks" value={String(counters.ticks)} hint="depuis le démarrage" />
        <Card label="Signaux" value={String(counters.signals)} hint="émis" />
        <Card label="Rejets" value={String(counters.rejections)} hint="par le risque" />
        <Card
          label="Buy & hold SOL"
          value={pct(state.benchmarks.solBuyHoldPct)}
          tone={classFor(state.benchmarks.solBuyHoldPct)}
          hint="référence"
        />
      </div>

      <div className="cards">
        <Card
          label="Pilote"
          value={state.allocation.pilot ?? "—"}
          hint={
            state.allocation.scores.length > 0
              ? `${state.allocation.scores.length} stratégie(s) en shadow`
              : "aucun shadow"
          }
        />
        <Card
          label="Kill-switch"
          value={guards.killSwitchAtMs ? "ACTIF" : "inactif"}
          tone={guards.killSwitchAtMs ? "down" : ""}
          hint={guards.killSwitchAtMs ? dateTime(guards.killSwitchAtMs) : "entrées actives"}
        />
        <Card
          label="Dernière donnée"
          value={state.clock.lastTickAgeS === null ? "—" : `${state.clock.lastTickAgeS} s`}
          tone={state.clock.fresh ? "" : "down"}
          hint={state.clock.fresh ? "à jour" : "périmée"}
        />
      </div>
    </>
  );
}

function Card({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`}>{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/** Vue « Stratégies » : le classement des performances en shadow. */
export function StrategiesView({ state }: { state: DashboardState | null }) {
  if (!state) return <div className="empty">Chargement…</div>;

  const scores: StrategyScore[] = state.allocation.scores;

  if (scores.length === 0) {
    return (
      <div className="empty">
        Aucune stratégie n'a encore joué en shadow. Les portefeuilles fantômes
        se remplissent au fil des ticks.
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Stratégie</th>
            <th>NAV shadow</th>
            <th>Score</th>
            <th>Trades</th>
            <th>Éligible</th>
            <th>Pilotage</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score) => (
            <tr key={score.name}>
              <td>{score.name}</td>
              <td>{usd(score.navUsd)}</td>
              <td className={classFor(score.scorePct)}>{pct(score.scorePct)}</td>
              <td>{score.trades}</td>
              <td className="text">
                {score.eligible ? "oui" : <span className="muted">{score.reason}</span>}
              </td>
              <td className="text">
                {state.allocation.pilot === score.name ? (
                  <span className="tag buy">pilote</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
