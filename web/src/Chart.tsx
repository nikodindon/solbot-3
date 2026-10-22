import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface Series {
  label: string;
  /** Valeurs alignées sur `time`. */
  values: (number | null)[];
  color: string;
  width?: number;
  /** Remplissage sous la courbe. */
  fill?: boolean;
}

export interface ChartProps {
  title?: string;
  legend?: boolean;
  /** Axe des temps (secondes). */
  time: number[];
  series: Series[];
  height?: number;
  /** Borne basse forcée sur l'axe Y. */
  yMin?: number;
}

/**
 * Graphique temporel (uPlot).
 *
 * uPlot est choisi pour une raison précise : c'est la seule bibliothèque qui
 * dessine des dizaines de milliers de points sans ramer. Un dashboard qui
 * saccade n'est pas un dashboard qu'on consulte.
 */
export function Chart({
  title,
  legend = true,
  time,
  series,
  height = 220,
  yMin,
}: ChartProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const plot = useRef<uPlot | null>(null);

  // Les options uPlot ne sont pas stables à chaque rendu : on les
  // reconstruit seulement quand les données changent.
  const options = useMemo(
    () =>
      ({
        width: container.current?.clientWidth ?? 600,
        height,
        series: [
          {},
          ...series.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: s.width ?? 2,
            fill: s.fill ? `${s.color}22` : undefined,
            points: { show: false },
          })),
        ],
        axes: [
          {
            stroke: "#8b949e",
            grid: { stroke: "#21262d", width: 1 },
            ticks: { stroke: "#21262d" },
            font: "11px ui-monospace, monospace",
          },
          {
            stroke: "#8b949e",
            grid: { stroke: "#21262d", width: 1 },
            ticks: { stroke: "#21262d" },
            font: "11px ui-monospace, monospace",
            size: 68,
          },
        ],
        scales: {
          x: { time: true },
          y: {
            auto: yMin === undefined,
            ...(yMin !== undefined ? { range: (_u: unknown, dataMin: number) => [yMin, dataMin * 1.02] } : {}),
          },
        },
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
      }) as uPlot.Options,
    [series, height, yMin],
  );

  useEffect(() => {
    if (!container.current) return;

    plot.current = new uPlot(options, [time, ...series.map((s) => s.values)], container.current);

    return () => {
      plot.current?.destroy();
      plot.current = null;
    };
  }, [options, time, series]);

  // Redimensionnement : le graphe suit la largeur du conteneur.
  useEffect(() => {
    const onResize = (): void => {
      if (!container.current || !plot.current) return;
      plot.current.setSize({ width: container.current.clientWidth, height });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [height]);

  return (
    <div>
      {title ? <div className="legend">{title}</div> : null}
      {legend && series.length > 1 ? (
        <div className="legend">
          {series.map((s) => (
            <span key={s.label} style={{ color: s.color }}>
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="chart">
        <div ref={container} />
      </div>
    </div>
  );
}
