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
import { MAGNETIC_COLOR, PHASE_COLORS } from "@/visualization/reflectionTicks";
import { color as theme, mono as themeMono, fz } from "@/app/theme";

/** A selection shared with the pattern plot: which reflection is spotlighted. */
type Selection = { hkl: string; kind: ReflectionObsCalc["kind"]; phaseId?: string };

/**
 * Point colour matching the pattern plot's Bragg tick rows: magnetic satellites
 * get the magnetic colour, and each crystallographic phase its own colour. With
 * a single nuclear phase (or the single-crystal path, which carries no phase
 * index) the nuclear points keep the primary theme colour, unchanged.
 */
function pointColor(row: ReflectionObsCalc, multiPhase: boolean): string {
  if (row.kind === "magnetic") return MAGNETIC_COLOR;
  if (!multiPhase) return theme.primary;
  return PHASE_COLORS[(row.phaseIndex ?? 0) % PHASE_COLORS.length]!;
}

// SVG user-space size; the rendered box is fluid (viewBox + width:100%).
const SIZE = 300;
const PAD = 42;
/** Responsive square: fills its column up to a comfortable cap, keeps aspect. */
const svgStyle: React.CSSProperties = { width: "100%", height: "auto", maxWidth: 360, display: "block" };

function axisLine(x1: number, y1: number, x2: number, y2: number, dash = false): JSX.Element {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={theme.border} strokeWidth={1} {...(dash ? { strokeDasharray: "4 4" } : {})} />;
}

export function QualityPlots({ obsCalc, npp, stacked = false, onHighlight, selected = null }: {
  obsCalc: readonly ReflectionObsCalc[];
  npp: NormalProbabilityPlot;
  /** One figure per row (for a narrow side rail) instead of reflowing columns. */
  stacked?: boolean;
  /**
   * Called with the reflection behind a clicked F_obs/F_calc point — its "h k l",
   * kind, and phase (null on deselect) — so the caller can spotlight it in the
   * pattern plot on the matching phase's Bragg row.
   */
  onHighlight?: (sel: Selection | null) => void;
  /**
   * The shared selection (owned by the parent), so a Bragg-tick click in the
   * pattern plot highlights the matching scatter point here too — one selection
   * across both plots.
   */
  selected?: Selection | null;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gridTemplateColumns: stacked ? "1fr" : "repeat(auto-fit, minmax(200px, 1fr))", gap: stacked ? 12 : 20, marginTop: 4 }}>
      <FobsFcalc rows={obsCalc} selected={selected} {...(onHighlight ? { onHighlight } : {})} />
      <NormalProb npp={npp} />
    </div>
  );
}

export function FobsFcalc({ rows, onHighlight, selected = null }: {
  rows: readonly ReflectionObsCalc[];
  onHighlight?: (sel: Selection | null) => void;
  selected?: Selection | null;
}): JSX.Element {
  // Fully controlled by the parent's shared selection: the highlighted point is
  // the row matching `selected` (set by a click here OR a Bragg-tick click in the
  // pattern plot), and clicking a point toggles that same selection. Match the
  // phase too when the selection carries one, so the same hkl in two phases stays
  // distinct.
  const sel = selected
    ? rows.findIndex((r) =>
        `${r.h} ${r.k} ${r.l}` === selected.hkl && r.kind === selected.kind &&
        (selected.phaseId === undefined || r.phaseId === selected.phaseId))
    : -1;
  const select = (i: number): void => {
    const r = rows[i]!;
    onHighlight?.(i === sel ? null : { hkl: `${r.h} ${r.k} ${r.l}`, kind: r.kind, ...(r.phaseId !== undefined ? { phaseId: r.phaseId } : {}) });
  };
  const pts = rows.map((r) => ({ fc: Math.sqrt(Math.max(r.iCalc, 0)), fo: Math.sqrt(Math.max(r.iObs, 0)) }));
  const max = Math.max(1e-9, ...pts.map((p) => Math.max(p.fc, p.fo)));
  const sx = (v: number): number => PAD + (v / max) * (SIZE - 2 * PAD);
  const sy = (v: number): number => SIZE - PAD - (v / max) * (SIZE - 2 * PAD);
  const selRow = sel >= 0 ? rows[sel] : undefined;
  const selPt = sel >= 0 ? pts[sel] : undefined;
  const magCount = rows.reduce((n, r) => n + (r.kind === "magnetic" ? 1 : 0), 0);
  // Multi-phase once any reflection carries a non-primary phase index.
  const multiPhase = rows.some((r) => (r.phaseIndex ?? 0) > 0);
  // Legend entries: one per nuclear phase (in phase order) plus magnetic, built
  // from the reflections actually present. Shown only when there is more than one
  // series to distinguish (extra phases and/or magnetic satellites).
  const legend: { label: string; color: string }[] = [];
  if (multiPhase) {
    const seen = new Map<number, { label: string; color: string }>();
    for (const r of rows) {
      if (r.kind !== "nuclear") continue;
      const idx = r.phaseIndex ?? 0;
      if (!seen.has(idx)) seen.set(idx, { label: r.phaseLabel ?? `phase ${idx + 1}`, color: PHASE_COLORS[idx % PHASE_COLORS.length]! });
    }
    legend.push(...[...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v));
  } else if (magCount > 0) {
    legend.push({ label: "nuclear", color: theme.primary });
  }
  if (magCount > 0) legend.push({ label: "magnetic", color: MAGNETIC_COLOR });
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} style={svgStyle} role="img" aria-label="F observed vs F calculated">
        {axisLine(PAD, SIZE - PAD, SIZE - PAD, SIZE - PAD)}
        {axisLine(PAD, PAD, PAD, SIZE - PAD)}
        {/* F_obs = F_calc reference line. */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(max)} y2={sy(max)} stroke={theme.primary} strokeWidth={1.25} strokeDasharray="5 4" />
        {pts.map((p, i) => (
          <g key={i} onClick={() => select(i)} style={{ cursor: "pointer" }}>
            {/* transparent halo = comfortable click target for a 2.6 px dot */}
            <circle cx={sx(p.fc)} cy={sy(p.fo)} r={7} fill="transparent" />
            <circle cx={sx(p.fc)} cy={sy(p.fo)} r={2.6} fill={pointColor(rows[i]!, multiPhase)} fillOpacity={0.55} />
          </g>
        ))}
        {/* Per-series legend (phases + magnetic), stacked in the sparse top-left. */}
        {legend.length > 1 && (
          <g fontSize={9.5} fontFamily={themeMono}>
            {legend.map((item, i) => (
              <g key={item.label}>
                <circle cx={PAD + 6} cy={PAD + 2 + i * 12} r={2.6} fill={item.color} fillOpacity={0.8} />
                <text x={PAD + 12} y={PAD + 5 + i * 12} fill={theme.secondary}>{item.label}</text>
              </g>
            ))}
          </g>
        )}
        {selPt && selRow && (
          <g pointerEvents="none">
            <circle cx={sx(selPt.fc)} cy={sy(selPt.fo)} r={5.5} fill="none" stroke={pointColor(selRow, multiPhase)} strokeWidth={1.6} />
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
            <span style={{ color: pointColor(selRow, multiPhase), fontWeight: 600 }}>
              {selRow.kind === "magnetic" ? "mag " : multiPhase ? `${selRow.phaseLabel ?? ""} ` : ""}
            </span>
            ({selRow.h} {selRow.k} {selRow.l}) · d {selRow.d.toFixed(4)} Å · F_obs {Math.sqrt(Math.max(selRow.iObs, 0)).toFixed(2)} · F_calc {Math.sqrt(Math.max(selRow.iCalc, 0)).toFixed(2)}
          </span>
        ) : (
          <>F_obs vs F_calc — points on the dashed line = perfect. {rows.length} reflections{magCount > 0 ? ` (${magCount} magnetic)` : ""}. Click a point for its (hkl).</>
        )}
      </figcaption>
    </figure>
  );
}

export function NormalProb({ npp }: { npp: NormalProbabilityPlot }): JSX.Element {
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
