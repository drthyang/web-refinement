/**
 * Schematic moment-arrow view: each magnetic moment drawn as an arrow in the
 * a–c plane (the plane the moments lie in for these structures). Pure SVG,
 * presentation only — a qualitative aid, not a crystal renderer.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { MagneticMoment } from "@/core/magnetic/types";
import { momentCartesian } from "@/core/magnetic/moment";
import { norm } from "@/core/math/vec3";

interface Props {
  readonly cell: UnitCell;
  readonly moments: readonly MagneticMoment[];
  readonly size?: number;
}

export function MomentArrows({ cell, moments, size = 300 }: Props): JSX.Element {
  const cart = moments.map((m) => momentCartesian(cell, m));
  const maxMag = Math.max(1e-6, ...cart.map((v) => norm(v)));
  const cols = Math.min(moments.length, 3) || 1;
  const cellW = size / cols;
  const arrowLen = cellW * 0.32;

  return (
    <svg width={size} height={cellW * 0.9 + 24} role="img" aria-label="Magnetic moment directions">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#8a1f1f" />
        </marker>
      </defs>
      {moments.map((m, i) => {
        const cx = cellW * (i % cols) + cellW / 2;
        const cy = (cellW * 0.9) / 2 + 4;
        const v = cart[i]!;
        // Project onto screen: x = component along Cartesian x, y = along z (up).
        const scale = (arrowLen / maxMag);
        const ex = cx + v[0]! * scale;
        const ey = cy - v[2]! * scale;
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="#8a1f1f" strokeWidth={2} markerEnd="url(#arrow)" />
            <circle cx={cx} cy={cy} r={2.5} fill="#333" />
            <text x={cx} y={cellW * 0.9 + 14} textAnchor="middle" fontSize={11} fill="#333">
              {m.siteLabel} · {norm(v).toFixed(2)}μB
            </text>
          </g>
        );
      })}
    </svg>
  );
}
