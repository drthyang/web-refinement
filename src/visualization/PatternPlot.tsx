/**
 * Powder pattern plot: observed (points), calculated (line), and difference
 * curve below. Pure SVG, no chart library. Presentation only.
 */

import type { PowderCurves } from "@/core/workflow/powder";
import { extent, linearScale, polylinePoints } from "@/visualization/scale";

interface Props {
  readonly curves: PowderCurves;
  readonly xLabel?: string;
  readonly width?: number;
  readonly height?: number;
}

export function PatternPlot({ curves, xLabel = "x", width = 760, height = 380 }: Props): JSX.Element {
  const margin = { top: 16, right: 16, bottom: 40, left: 56 };
  const plotW = width - margin.left - margin.right;
  const mainH = (height - margin.top - margin.bottom) * 0.72;
  const diffH = (height - margin.top - margin.bottom) * 0.28;

  const [xMin, xMax] = extent(curves.x);
  const [yMin, yMax] = extent([...curves.yObs, ...curves.yCalc]);
  const [dMin, dMax] = extent(curves.diff);

  const sx = linearScale(xMin, xMax, margin.left, margin.left + plotW);
  const sy = linearScale(yMin, yMax, margin.top + mainH, margin.top);
  const sd = linearScale(
    Math.min(dMin, -1),
    Math.max(dMax, 1),
    margin.top + mainH + diffH,
    margin.top + mainH + 8,
  );

  const calcLine = polylinePoints(curves.x, curves.yCalc, sx, sy);
  const diffLine = polylinePoints(curves.x, curves.diff, sx, sd);

  return (
    <svg width={width} height={height} role="img" aria-label="Powder pattern observed vs calculated">
      <rect x={0} y={0} width={width} height={height} fill="#fff" />
      {/* axes */}
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + mainH} stroke="#888" />
      <line
        x1={margin.left}
        y1={margin.top + mainH}
        x2={margin.left + plotW}
        y2={margin.top + mainH}
        stroke="#888"
      />
      {/* observed as small circles (subsampled for density) */}
      {curves.x.map((x, i) =>
        i % 3 === 0 ? (
          <circle key={i} cx={sx(x)} cy={sy(curves.yObs[i]!)} r={1.6} fill="#c1272d" opacity={0.7} />
        ) : null,
      )}
      {/* calculated line */}
      <polyline points={calcLine} fill="none" stroke="#1f4e79" strokeWidth={1.4} />
      {/* difference */}
      <line
        x1={margin.left}
        y1={sd(0)}
        x2={margin.left + plotW}
        y2={sd(0)}
        stroke="#ccc"
        strokeDasharray="3 3"
      />
      <polyline points={diffLine} fill="none" stroke="#2e7d32" strokeWidth={1} />
      {/* labels */}
      <text x={margin.left + plotW / 2} y={height - 8} textAnchor="middle" fontSize={12} fill="#333">
        {xLabel}
      </text>
      <text
        x={14}
        y={margin.top + mainH / 2}
        textAnchor="middle"
        fontSize={12}
        fill="#333"
        transform={`rotate(-90 14 ${margin.top + mainH / 2})`}
      >
        Intensity
      </text>
      {/* legend */}
      <g fontSize={11}>
        <circle cx={margin.left + 8} cy={margin.top + 6} r={2} fill="#c1272d" />
        <text x={margin.left + 16} y={margin.top + 9} fill="#333">obs</text>
        <line x1={margin.left + 44} y1={margin.top + 6} x2={margin.left + 60} y2={margin.top + 6} stroke="#1f4e79" strokeWidth={1.5} />
        <text x={margin.left + 64} y={margin.top + 9} fill="#333">calc</text>
        <line x1={margin.left + 96} y1={margin.top + 6} x2={margin.left + 112} y2={margin.top + 6} stroke="#2e7d32" strokeWidth={1.5} />
        <text x={margin.left + 116} y={margin.top + 9} fill="#333">diff</text>
      </g>
    </svg>
  );
}
