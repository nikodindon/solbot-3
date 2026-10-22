import { useCallback, useEffect, useState } from "react";
import { api, subscribe, type DashboardState } from "./api";
import { ago } from "./format";
import { OverviewView, StrategiesView } from "./views/Overview";
import { DecisionsView, MarketsView, PositionsView, TradesView } from "./views/Tables";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "strategies", label: "Stratégies" },
  { id: "positions", label: "Positions" },
  { id: "trades", label: "Trades" },
  { id: "decisions", label: "Décisions" },
  { id: "data", label: "Données" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const refresh = useCallback(() => {
    void api
      .state()
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  // Rafraîchissement périodique : le SSE est une amélioration, pas un
  // prérequis. Si le flux tombe, le dashboard continue de fonctionner.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Flux SSE : on rafraîchit l'état à chaque événement.
  useEffect(() => {
    const unsubscribe = subscribe(
      () => refresh(),
      () => setLive(false),
    );
    setLive(true);
    return () => {
      unsubscribe();
      setLive(false);
    };
  }, [refresh]);

  const status = state ? (state.clock.fresh ? "live" : "stale") : "dead";

  return (
    <div className="app">
      <header className="header">
        <h1>solbot3</h1>
        <span className={`badge ${status}`}>
          <span className="dot" />
          {status === "live" ? "en direct" : status === "stale" ? "données périmées" : "hors ligne"}
        </span>
        {state ? <span className="badge">mode {state.mode}</span> : null}
        {state ? (
          <span className="badge">
            dernier tick {ago(state.clock.lastTickAt, state.clock.now)}
          </span>
        ) : null}
        <span className="spacer" />
        {live ? <span className="badge">SSE</span> : null}
        {error ? <span className="badge">erreur : {error}</span> : null}
      </header>

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={tab === entry.id ? "active" : ""}
            onClick={() => setTab(entry.id)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === "overview" ? <OverviewView state={state} /> : null}
      {tab === "strategies" ? <StrategiesView state={state} /> : null}
      {tab === "positions" ? <PositionsView state={state} /> : null}
      {tab === "trades" ? <TradesView state={state} /> : null}
      {tab === "decisions" ? <DecisionsView state={state} /> : null}
      {tab === "data" ? <MarketsView state={state} /> : null}
    </div>
  );
}
