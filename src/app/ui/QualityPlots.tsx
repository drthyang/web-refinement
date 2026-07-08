/**
 * Refinement-quality validation plots:
 *  - F_obs vs F_calc with the F_obs = F_calc line (spots bad reflections / scale
 *    / extinction), and
 *  - the normal probability plot (Abrahams & Keve 1971): ordered weighted
 *    residuals vs expected normal quantiles; ideal is the slope-1 / intercept-0
 *    line, and departures reveal model error *and* mis-weighted σ.
 */

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

export function QualityPlots({ obsCalc, npp }: { obsCalc: readonly ReflectionObsCalc[]; npp: NormalProbabilityPlot }): JSX.Element {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20, marginTop: 4 }}>
      <FobsFcalc rows={obsCalc} />
      <NormalProb npp={npp} />
    </div>
  );
}

function FobsFcalc({ rows }: { rows: readonly ReflectionObsCalc[] }): JSX.Element {
  const pts = rows.map((r) => ({ fc: Math.sqrt(Math.max(r.iCalc, 0)), fo: Math.sqrt(Math.max(r.iObs, 0)) }));
  const max = Math.max(1e-9, ...pts.map((p) => Math.max(p.fc, p.fo)));
  const sx = (v: number): number => PAD + (v / max) * (SIZE - 2 * PAD);
  const sy = (v: number): number => SIZE - PAD - (v / max) * (SIZE - 2 * PAD);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={svgStyle} role="img" aria-label="F observed vs F calculated">
        {axisLine(PAD, SIZE - PAD, SIZE - PAD, SIZE - PAD)}
        {axisLine(PAD, PAD, PAD, SIZE - PAD)}
        {/* F_obs = F_calc reference line. */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(max)} y2={sy(max)} stroke={theme.primary} strokeWidth={1.25} strokeDasharray="5 4" />
        {pts.map((p, i) => (
          <circle key={i} cx={sx(p.fc)} cy={sy(p.fo)} r={2.6} fill={theme.primary} fillOpacity={0.5} />
        ))}
        <text x={SIZE / 2} y={SIZE - 8} textAnchor="middle" fontSize={11} fill={theme.secondary}>|F_calc|</text>
        <text x={12} y={SIZE / 2} textAnchor="middle" fontSize={11} fill={theme.secondary} transform={`rotate(-90 12 ${SIZE / 2})`}>|F_obs|</text>
      </svg>
      <figcaption style={cap}>F_obs vs F_calc — points on the dashed line = perfect. {rows.length} reflections.</figcaption>
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
