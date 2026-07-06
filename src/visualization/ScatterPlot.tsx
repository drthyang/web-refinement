/**
 * Observed vs calculated scatter plot for single-crystal intensities, with the
 * y = x reference line. Pure SVG.
 */

import type { SingleCrystalCalc } from "@/core/workflow/singleCrystal";
import { extent, linearScale } from "@/visualization/scale";

interface Props {
  readonly rows: readonly SingleCrystalCalc[];
  readonly size?: number;
}

export function ScatterPlot({ rows, size = 380 }: Props): JSX.Element {
  const margin = 48;
  const obs = rows.map((r) => r.iObs);
  const calc = rows.map((r) => r.iCalc);
  const [lo, hi] = extent([...obs, ...calc, 0]);
  const sx = linearScale(lo, hi, margin, size - 12);
  const sy = linearScale(lo, hi, size - margin, 12);

  return (
    <svg width={size} height={size} role="img" aria-label="Observed vs calculated intensities">
      <rect x={0} y={0} width={size} height={size} fill="#fff" />
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="#bbb" strokeDasharray="4 4" />
      <line x1={margin} y1={12} x2={margin} y2={size - margin} stroke="#888" />
      <line x1={margin} y1={size - margin} x2={size - 12} y2={size - margin} stroke="#888" />
      {rows.map((r, i) => (
        <circle key={i} cx={sx(r.iObs)} cy={sy(r.iCalc)} r={3} fill="#1f4e79" opacity={0.7} />
      ))}
      <text x={size / 2} y={size - 8} textAnchor="middle" fontSize={12} fill="#333">
        I(obs)
      </text>
      <text
        x={14}
        y={size / 2}
        textAnchor="middle"
        fontSize={12}
        fill="#333"
        transform={`rotate(-90 14 ${size / 2})`}
      >
        I(calc)
      </text>
    </svg>
  );
}
