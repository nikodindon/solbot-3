import { useEffect, useState } from "react";
import { api, type DashboardState, type Decision, type Trade } from "../api";
import { ago, classFor, dateTime, qty, usd } from "../format";

/** Vue « Positions » : les positions ouvertes et leur valorisation. */
export function PositionsView({ state }: { state: DashboardState | null }) {
  if (!state) return <div className="empty">Chargement…</div>;

  const positions = state.portfolio.positions;

  if (positions.length === 0) {
    return <div className="empty">Aucune position ouverte.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Actif</th>
            <th>Quantité</th>
            <th>Entrée</th>
            <th>Marché</th>
            <th>Valeur</th>
            <th>PnL latent</th>
            <th>Stop</th>
            <th>TP</th>
            <th>Âge</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.mint}>
              <td>{position.symbol}</td>
              <td>{qty(position.qty)}</td>
              <td>{position.avgEntryUsd.toFixed(6)}</td>
              <td>{position.priceUsd.toFixed(6)}</td>
              <td>{usd(position.valueUsd)}</td>
              <td className={classFor(position.unrealizedUsd)}>
                {usd(position.unrealizedUsd)} ({classFor(position.unrealizedPct) ? "" : ""}
                {position.unrealizedPct.toFixed(2)} %)
              </td>
              <td>{position.stopLossUsd?.toFixed(6) ?? "—"}</td>
              <td>{position.takeProfitUsd?.toFixed(6) ?? "—"}</td>
              <td>{ago(Date.now() - position.ageMs, Date.now())}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Vue « Trades » : l'historique des exécutions. */
export function TradesView({ state }: { state: DashboardState | null }) {
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    void api
      .trades(300)
      .then((data) => setTrades(data.trades))
      .catch(() => setTrades([]));
  }, [state?.counters.trades]);

  if (trades.length === 0) {
    return <div className="empty">Aucun trade enregistré.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Horodatage</th>
            <th>Stratégie</th>
            <th>Actif</th>
            <th>Sens</th>
            <th>Prix</th>
            <th>Quantité</th>
            <th>Notionnel</th>
            <th>Frais</th>
            <th>PnL</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={`${trade.tsMs}-${trade.mint}-${trade.side}`}>
              <td>{dateTime(trade.tsMs)}</td>
              <td className="text">{trade.strategy}</td>
              <td>{trade.symbol}</td>
              <td className="text">
                <span className={`tag ${trade.side}`}>{trade.side}</span>
              </td>
              <td>{trade.priceUsd.toFixed(8)}</td>
              <td>{qty(trade.qty, 6)}</td>
              <td>{usd(trade.notionalUsd)}</td>
              <td>{usd(trade.feeUsd, 4)}</td>
              <td className={classFor(trade.realizedPnlUsd)}>
                {trade.realizedPnlUsd === null ? "—" : usd(trade.realizedPnlUsd)}
              </td>
              <td className="text muted">{trade.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Vue « Décisions » : le journal explicable, filtrable. */
export function DecisionsView({ state }: { state: DashboardState | null }) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [kind, setKind] = useState("");
  const [strategy, setStrategy] = useState("");

  useEffect(() => {
    void api
      .decisions({ limit: 300, kind: kind || undefined, strategy: strategy || undefined })
      .then((data) => setDecisions(data.decisions))
      .catch(() => setDecisions([]));
  }, [kind, strategy, state?.counters.decisions]);

  const strategies = [...new Set((state?.allocation.scores ?? []).map((s) => s.name))];

  return (
    <>
      <div className="filters">
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">tous les types</option>
          {["signal", "reject", "trade", "exit", "note", "regime", "alloc", "guard", "error"].map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ),
          )}
        </select>
        <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
          <option value="">toutes les stratégies</option>
          {strategies.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="muted">{decisions.length} ligne(s)</span>
      </div>

      {decisions.length === 0 ? (
        <div className="empty">Aucune décision pour ce filtre.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Horodatage</th>
                <th>Type</th>
                <th>Stratégie</th>
                <th>Décision</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((decision, index) => (
                <tr key={`${decision.tsMs}-${index}`}>
                  <td>{dateTime(decision.tsMs)}</td>
                  <td className="text">
                    <span className="tag">{decision.kind}</span>
                  </td>
                  <td className="text muted">{decision.strategy ?? "—"}</td>
                  <td className="text">{decision.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Vue « Données » : fraîcheur des prix, couverture des bougies, liquidité. */
export function MarketsView({ state }: { state: DashboardState | null }) {
  if (!state) return <div className="empty">Chargement…</div>;

  const markets = state.markets;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Actif</th>
            <th>Prix</th>
            <th>Liquidité</th>
            <th>Âge du prix</th>
            <th>Bougies</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <tr key={market.mint}>
              <td>{market.symbol}</td>
              <td>{market.priceUsd === null ? "n/d" : market.priceUsd.toFixed(8)}</td>
              <td>
                {market.liquidityUsd === null
                  ? "n/d"
                  : `${(market.liquidityUsd / 1_000_000).toFixed(2)} M$`}
              </td>
              <td className={market.fresh ? "" : "down"}>
                {market.ageS === null ? "n/d" : `${market.ageS} s`}
              </td>
              <td className="text muted">
                {market.candles.map((c) => `${c.tf}:${c.count}`).join(" · ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
