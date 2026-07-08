/**
 * Refinement-quality validation plots:
 *  - F_obs vs F_calc with the F_obs = F_calc line (spots bad reflections / scale
 *    / extinction), and
 *  - the normal probability plot (Abrahams & Keve 1971): ordered weighted
 *    residuals vs expected normal quantiles; ideal is the slope-1 / intercept-0
 *    line, and departures reveal model error *and* mis-weighted σ.
 */

import { useEffect, useState } from "react";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { NormalProbabilityPlot } from "@/core/refinement/diagnostics";
import { color as theme, mono as themeMono, fz } from "@/app/theme";

// SVG user-space size; the rendered box is fluid (viewBox + width:100%).
const SIZE = 300;
const PAD = 42;
/** Responsive square: fills its column up to a comfortable cap, keeps aspect. */
const svgStyle: React.CSSProperties = { width: "100%", height: "auto", maxWidth: 360, display: "block" };

function axisLine(x1: number, y1: number, x2: number, y2: number, dash = false): JSX.Element {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={theme.border} strokeWidth={1} {...(dash ? { strokeDasharray: "4 4" } : {})} />;
}

export function QualityPlots({ obsCalc, npp, stacked = false }: {
  obsCalc: readonly ReflectionObsCalc[];
  npp: NormalProbabilityPlot;
  /** One figure per row (for a narrow side rail) instead of reflowing columns. */
  stacked?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "repeat(auto-fit, minmax(200px, 1fr))", gap: stacked ? 12 : 20, marginTop: 4 }}>
      <FobsFcalc rows={obsCalc} />
      <NormalProb npp={npp} />
    </div>
  );
}

function FobsFcalc({ rows }: { rows: readonly ReflectionObsCalc[] }): JSX.Element {
  // Click a point to identify the reflection behind it (hkl, d, F values).
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => setSel(null), [rows]); // a new reflection list invalidates the pick
  const pts = rows.map((r) => ({ fc: Math.sqrt(Math.max(r.iCalc, 0)), fo: Math.sqrt(Math.max(r.iObs, 0)) }));
  const max = Math.max(1e-9, ...pts.map((p) => Math.max(p.fc, p.fo)));
  const sx = (v: number): number => PAD + (v / max) * (SIZE - 2 * PAD);
  const sy = (v: number): number => SIZE - PAD - (v / max) * (SIZE - 2 * PAD);
  const selRow = sel !== null ? rows[sel] : undefined;
  const selPt = sel !== null ? pts[sel] : undefined;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={svgStyle} role="img" aria-label="F observed vs F calculated">
        {axisLine(PAD, SIZE - PAD, SIZE - PAD, SIZE - PAD)}
        {axisLine(PAD, PAD, PAD, SIZE - PAD)}
        {/* F_obs = F_calc reference line. */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(max)} y2={sy(max)} stroke={theme.primary} strokeWidth={1.25} strokeDasharray="5 4" />
        {pts.map((p, i) => (
          <g key={i} onClick={() => setSel(i === sel ? null : i)} style={{ cursor: "pointer" }}>
            {/* transparent halo = comfortable click target for a 2.6 px dot */}
            <circle cx={sx(p.fc)} cy={sy(p.fo)} r={7} fill="transparent" />
            <circle cx={sx(p.fc)} cy={sy(p.fo)} r={2.6} fill={theme.primary} fillOpacity={0.5} />
          </g>
        ))}
        {selPt && selRow && (
          <g pointerEvents="none">
            <circle cx={sx(selPt.fc)} cy={sy(selPt.fo)} r={5.5} fill="none" stroke={theme.ink} strokeWidth={1.4} />
            <text
              x={sx(selPt.fc) < SIZE / 2 ? sx(selPt.fc) + 9 : sx(selPt.fc) - 9}
              y={Math.max(sy(selPt.fo) - 8, PAD + 10)}
              textAnchor={sx(selPt.fc) < SIZE / 2 ? "start" : "end"}
              fontSize={11.5}
              fontFamily={themeMono}
              fill={theme.ink}
            >
              {selRow.h} {selRow.k} {selRow.l}
            </text>
          </g>
        )}
        <text x={SIZE / 2} y={SIZE - 8} textAnchor="middle" fontSize={11} fill={theme.secondary}>|F_calc|</text>
        <text x={12} y={SIZE / 2} textAnchor="middle" fontSize={11} fill={theme.secondary} transform={`rotate(-90 12 ${SIZE / 2})`}>|F_obs|</text>
      </svg>
      <figcaption style={cap}>
        {selRow ? (
          <span style={{ fontFamily: themeMono, color: theme.ink }}>
            ({selRow.h} {selRow.k} {selRow.l}) · d {selRow.d.toFixed(4)} Å · F_obs {Math.sqrt(Math.max(selRow.iObs, 0)).toFixed(2)} · F_calc {Math.sqrt(Math.max(selRow.iCalc, 0)).toFixed(2)}
          </span>
        ) : (
          <>F_obs vs F_calc — points on the dashed line = perfect. {rows.length} reflections. Click a point for its (hkl).</>
        )}
      </figcaption>
    </figure>
  );
}

function NormalProb({ npp }: { npp: NormalProbabilityPlot }): JSX.Element {
  const xs = npp.points.map((p) => p.expected);
  const ys = npp.points.map((p) => p.observed);
  const lim = Math.max(1e-9, ...xs.map(Math.abs), ...ys.map(Math.abs));
  const sx = (v: number): number => PAD + ((v + lim) / (2 * lim)) * (SIZE - 2 * PAD);
  const sy = (v: number): number => SIZE - PAD - ((v + lim) / (2 * lim)) * (SIZE - 2 * PAD);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={svgStyle} role="img" aria-label="Normal probability plot">
        {axisLine(PAD, sy(0), SIZE - PAD, sy(0), true)}
        {axisLine(sx(0), PAD, sx(0), SIZE - PAD, true)}
        {/* Ideal slope-1 / intercept-0 line. */}
        <line x1={sx(-lim)} y1={sy(-lim)} x2={sx(lim)} y2={sy(lim)} stroke={theme.primary} strokeWidth={1.25} strokeDasharray="5 4" />
        {npp.points.map((p, i) => (
          <circle key={i} cx={sx(p.expected)} cy={sy(p.observed)} r={2} fill={theme.ink} fillOpacity={0.45} />
        ))}
        <text x={SIZE / 2} y={SIZE - 8} textAnchor="middle" fontSize={11} fill={theme.secondary}>expected quantile</text>
        <text x={12} y={SIZE / 2} textAnchor="middle" fontSize={11} fill={theme.secondary} transform={`rotate(-90 12 ${SIZE / 2})`}>ordered (obs−calc)/σ</text>
        <text x={SIZE - PAD} y={PAD} textAnchor="end" fontSize={11} fontFamily={themeMono} fill={theme.secondary}>
          slope {npp.slope.toFixed(2)} · int {npp.intercept.toFixed(2)}
        </text>
      </svg>
      <figcaption style={cap}>Normal probability plot — straight, slope 1, intercept 0 = ideal fit & weights.</figcaption>
    </figure>
  );
}

const cap: React.CSSProperties = { fontSize: fz.micro, color: theme.secondary, maxWidth: 360, marginTop: 5 };
