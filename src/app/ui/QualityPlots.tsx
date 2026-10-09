/**
 * The observed vs calculated scatter for single-crystal data (Fo² vs Fc², or
 * |Fo| vs |Fc|) with the Fo = Fc line. Each point is one measured reflection,
 * so the plot is a genuine test of the model: a point off the line is a
 * reflection the model gets wrong, and a pattern among such points names the
 * error (strong reflections sagging below the line at the top is extinction).
 *
 * Log axes are the default: F² spans four or more decades, and on linear axes
 * the weak reflections collapse into the corner while the strong ones decide
 * the picture. Points are coloured by their standardized residual |Δ|/σ when
 * the rows carry σ, otherwise by phase (magnetic satellites in the magnetic
 * colour).
 */

import { useState } from "react";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import { MAGNETIC_COLOR, PHASE_COLORS } from "@/visualization/reflectionTicks";
import { clientToSvgUser, nearestPointIndex } from "@/visualization/hitTest";
import { color as theme, mono as themeMono, fz } from "@/app/theme";
import { SegmentedToggle } from "@/app/ui/SegmentedToggle";

/** A selection shared with other views: which reflection is spotlighted. */
type Selection = { hkl: string; kind: ReflectionObsCalc["kind"]; phaseId?: string };

export type ScatterScale = "log" | "linear";
export type ScatterQuantity = "F2" | "F";

/** |Δ|/σ tiers: within noise, worth a look, an outlier. */
const Z_TIERS = [
  { max: 3, color: theme.primary, opacity: 0.4, label: "|Δ|/σ < 3" },
  { max: 5, color: "#d9822b", opacity: 0.9, label: "3 – 5" },
  { max: Infinity, color: theme.warnInk, opacity: 0.95, label: "> 5" },
] as const;

/** Standardized residual of a row in F² units, when it carries σ. */
export function rowZ(row: ReflectionObsCalc): number | undefined {
  return row.sigma !== undefined && row.sigma > 0 ? (row.iObs - row.iCalc) / row.sigma : undefined;
}

function pointColor(row: ReflectionObsCalc, multiPhase: boolean, byZ: boolean): { fill: string; opacity: number } {
  if (byZ) {
    const z = Math.abs(rowZ(row) ?? 0);
    const tier = Z_TIERS.find((t) => z < t.max) ?? Z_TIERS[2];
    return { fill: tier.color, opacity: tier.opacity };
  }
  if (row.kind === "magnetic") return { fill: MAGNETIC_COLOR, opacity: 0.55 };
  if (!multiPhase) return { fill: theme.primary, opacity: 0.55 };
  return { fill: PHASE_COLORS[(row.phaseIndex ?? 0) % PHASE_COLORS.length]!, opacity: 0.55 };
}

// SVG user space: a square plotting area A with room for tick labels and axis
// titles on the left and bottom only (the rendered box is fluid: viewBox +
// width 100%), so no empty margin sits above or right of the plot.
const PL = 44;
const PB = 34;
const PT = 8;
const PR = 10;
const A = 248;
const W = PL + A + PR;
const H = PT + A + PB;
/** How far (user units) a click may land from a dot and still select it. */
const HIT_RADIUS = 7;

const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
function decadeLabel(e: number): string {
  if (e === 0) return "1";
  if (e === 1) return "10";
  return `10${[...String(e)].map((c) => SUP[c] ?? c).join("")}`;
}

/** A 1-2-5 step giving about `target` ticks over [0, max]. */
function niceStep(max: number, target = 4): number {
  const raw = max / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function axisLine(x1: number, y1: number, x2: number, y2: number): JSX.Element {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={theme.border} strokeWidth={1} />;
}

/** The log/linear and F²/|F| switches (also usable in a panel header). */
export function ScatterToolbar({ scale, quantity, onScale, onQuantity }: {
  scale: ScatterScale;
  quantity: ScatterQuantity;
  onScale: (s: ScatterScale) => void;
  onQuantity: (q: ScatterQuantity) => void;
}): JSX.Element {
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      <SegmentedToggle
        options={[{ id: "log", label: "log", title: "Logarithmic axes: weak and strong reflections get equal room" }, { id: "linear", label: "linear", title: "Linear axes" }] as const}
        value={scale}
        onChange={onScale}
      />
      <SegmentedToggle
        options={[{ id: "F2", label: "F²", title: "Fo² vs Fc², the quantity the refinement fits" }, { id: "F", label: "|F|", title: "|Fo| vs |Fc|" }] as const}
        value={quantity}
        onChange={onQuantity}
      />
    </span>
  );
}

export function FobsFcalc({ rows, onHighlight, selected = null, onLocate, maxWidth = 360, initialScale = "log", initialQuantity = "F2", scale: scaleProp, quantity: quantityProp, toolbar = true, compact = false }: {
  rows: readonly ReflectionObsCalc[];
  onHighlight?: (sel: Selection | null) => void;
  selected?: Selection | null;
  /** Jump to this reflection elsewhere (e.g. its peak in a pattern). */
  onLocate?: (row: ReflectionObsCalc) => void;
  maxWidth?: number;
  initialScale?: ScatterScale;
  initialQuantity?: ScatterQuantity;
  /** Controlled axes (with `toolbar={false}`, the caller renders ScatterToolbar). */
  scale?: ScatterScale | undefined;
  quantity?: ScatterQuantity | undefined;
  /** Draw the log/linear and F²/|F| switches above the plot (default true). */
  toolbar?: boolean;
  /** One-line caption. */
  compact?: boolean;
}): JSX.Element {
  const [scaleState, setScale] = useState<ScatterScale>(initialScale);
  const [quantityState, setQuantity] = useState<ScatterQuantity>(initialQuantity);
  const scale = scaleProp ?? scaleState;
  const quantity = quantityProp ?? quantityState;
  const value = (i: number): number => (quantity === "F2" ? i : Math.sqrt(Math.max(i, 0)));

  // Fully controlled by the parent's shared selection; clicking a point toggles
  // that same selection. Match the phase too when the selection carries one.
  const sel = selected
    ? rows.findIndex((r) =>
        `${r.h} ${r.k} ${r.l}` === selected.hkl && r.kind === selected.kind &&
        (selected.phaseId === undefined || r.phaseId === selected.phaseId))
    : -1;
  const select = (i: number): void => {
    const r = rows[i]!;
    onHighlight?.(i === sel ? null : { hkl: `${r.h} ${r.k} ${r.l}`, kind: r.kind, ...(r.phaseId !== undefined ? { phaseId: r.phaseId } : {}) });
  };

  const vals = rows.map((r) => ({ c: value(r.iCalc), o: value(r.iObs) }));
  const span = A;
  let sx: (v: number) => number;
  let sy: (v: number) => number;
  let ticks: { v: number; label: string }[];
  let lo = 0, hi = 1;
  // Log axes: decades from the 2nd percentile of the positive values up (at
  // most six), so a few near-zero intensities do not stretch the axes into
  // empty decades; anything below is counted as off-axis.
  const positive = vals.flatMap((p) => [p.c, p.o]).filter((v) => v > 0).sort((a, b) => a - b);
  if (scale === "log" && positive.length > 0) {
    hi = Math.ceil(Math.log10(positive[positive.length - 1]!));
    lo = Math.max(Math.floor(Math.log10(positive[Math.floor(0.02 * (positive.length - 1))]!)), hi - 6);
    if (hi - lo < 1) lo = hi - 1;
    const to = (v: number): number => (Math.log10(v) - lo) / (hi - lo);
    sx = (v) => PL + to(v) * span;
    sy = (v) => PT + A - to(v) * span;
    ticks = Array.from({ length: hi - lo + 1 }, (_, i) => ({ v: Math.pow(10, lo + i), label: decadeLabel(lo + i) }));
  } else {
    const max = Math.max(1e-9, ...vals.map((p) => Math.max(p.c, p.o)));
    sx = (v) => PL + (v / max) * span;
    sy = (v) => PT + A - (v / max) * span;
    const step = niceStep(max);
    ticks = [];
    for (let t = 0; t <= max * 1.0001; t += step) ticks.push({ v: t, label: t >= 1e4 ? t.toExponential(0) : String(+t.toPrecision(3)) });
  }
  const floor = Math.pow(10, lo);
  const visible = (p: { c: number; o: number }): boolean => scale === "linear" || (p.c >= floor && p.o >= floor);
  const hidden = vals.filter((p) => !visible(p)).length;
  // Off-axis points get NaN coordinates: never drawn, never hit.
  const plotPts = vals.map((p) => (visible(p) ? { x: sx(p.c), y: sy(p.o) } : { x: Number.NaN, y: Number.NaN }));
  const onPlotClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    const at = clientToSvgUser(e.currentTarget, e.clientX, e.clientY, { width: W, height: H });
    const i = nearestPointIndex(plotPts, at.x, at.y, HIT_RADIUS);
    if (i >= 0) select(i);
  };

  const byZ = rows.length > 0 && rows.every((r) => rowZ(r) !== undefined);
  const magCount = rows.reduce((n, r) => n + (r.kind === "magnetic" ? 1 : 0), 0);
  const multiPhase = rows.some((r) => (r.phaseIndex ?? 0) > 0);
  const legend: { label: string; color: string }[] = [];
  if (byZ) {
    legend.push(...Z_TIERS.map((t) => ({ label: t.label, color: t.color })));
  } else {
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
  }
  // Draw the outliers last so they sit on top of the crowd.
  const order = rows.map((_, i) => i).sort((a, b) => Math.abs(rowZ(rows[a]!) ?? 0) - Math.abs(rowZ(rows[b]!) ?? 0));
  const selRow = sel >= 0 ? rows[sel] : undefined;
  const selPt = sel >= 0 && visible(vals[sel]!) ? plotPts[sel] : undefined;
  const qLabel = quantity === "F2" ? ["Fc²", "Fo²"] : ["|Fc|", "|Fo|"];
  const lineLo = scale === "log" ? floor : 0;
  const lineHi = scale === "log" ? Math.pow(10, hi) : Math.max(1e-9, ...vals.map((p) => Math.max(p.c, p.o)));

  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6, maxWidth }}>
      {toolbar ? <ScatterToolbar scale={scale} quantity={quantity} onScale={setScale} onQuantity={setQuantity} /> : null}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", cursor: onHighlight ? "pointer" : undefined }} role="img" aria-label={`${qLabel[1]} against ${qLabel[0]}, ${scale} axes`} onClick={onPlotClick}>
        {ticks.map((t) => (
          <g key={t.label}>
            <line x1={sx(t.v)} y1={PT} x2={sx(t.v)} y2={PT + A} stroke={theme.subtle2} strokeWidth={1} />
            <line x1={PL} y1={sy(t.v)} x2={PL + A} y2={sy(t.v)} stroke={theme.subtle2} strokeWidth={1} />
            <text x={sx(t.v)} y={PT + A + 13} textAnchor="middle" fontSize={9.5} fontFamily={themeMono} fill={theme.secondary}>{t.label}</text>
            <text x={PL - 4} y={sy(t.v) + 3} textAnchor="end" fontSize={9.5} fontFamily={themeMono} fill={theme.secondary}>{t.label}</text>
          </g>
        ))}
        {axisLine(PL, PT + A, PL + A, PT + A)}
        {axisLine(PL, PT, PL, PT + A)}
        {/* Fo = Fc reference line. */}
        <line x1={sx(lineLo)} y1={sy(lineLo)} x2={sx(lineHi)} y2={sy(lineHi)} stroke={theme.primary} strokeWidth={1.25} strokeDasharray="5 4" />
        {order.map((i) => {
          const p = plotPts[i]!;
          if (!Number.isFinite(p.x)) return null;
          const c = pointColor(rows[i]!, multiPhase, byZ);
          return <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={c.fill} fillOpacity={c.opacity} pointerEvents="none" />;
        })}
        {legend.length > 1 && (
          <g fontSize={9.5} fontFamily={themeMono}>
            {legend.map((item, i) => (
              <g key={item.label}>
                <circle cx={PL + 7} cy={PT + 8 + i * 12} r={2.8} fill={item.color} fillOpacity={0.85} />
                <text x={PL + 13} y={PT + 11 + i * 12} fill={theme.secondary}>{item.label}</text>
              </g>
            ))}
          </g>
        )}
        {selPt && selRow && (() => {
          const { x: px, y: py } = selPt;
          const label = `${selRow.h} ${selRow.k} ${selRow.l}`;
          const ring = <circle cx={px} cy={py} r={5.5} fill="none" stroke={theme.ink} strokeWidth={1.6} pointerEvents="none" />;
          if (!onLocate) {
            return (
              <g pointerEvents="none">
                {ring}
                <text x={px < W / 2 ? px + 9 : px - 9} y={Math.max(py - 8, PT + 10)} textAnchor={px < W / 2 ? "start" : "end"} fontSize={11.5} fontFamily={themeMono} fill={theme.ink}>
                  {label}
                </text>
              </g>
            );
          }
          // A small clickable chip beside the point: the (hkl) plus a "view"
          // arrow that jumps to this reflection elsewhere.
          const labelW = label.length * 6.9;
          const padX = 8, gap = 7, arrowW = 11, chipH = 19;
          const chipW = padX + labelW + gap + arrowW + padX;
          const chipX = px > W / 2 ? px - 8 - chipW : px + 8;
          const chipY = Math.min(Math.max(py - chipH / 2, PT + 1), PT + A - chipH);
          const midY = chipY + chipH / 2;
          const ax = chipX + padX + labelW + gap;
          return (
            <g>
              {ring}
              <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onLocate(selRow); }}>
                <title>Show this reflection</title>
                <rect x={chipX} y={chipY} width={chipW} height={chipH} rx={6} fill={theme.raised} stroke={theme.primaryTintBorder} strokeWidth={1} />
                <text x={chipX + padX} y={midY + 4} fontSize={11.5} fontFamily={themeMono} fill={theme.ink}>{label}</text>
                <path d={`M ${ax} ${midY} H ${ax + 8} M ${ax + 5} ${midY - 3.2} L ${ax + 8.6} ${midY} L ${ax + 5} ${midY + 3.2}`} fill="none" stroke={theme.primary} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            </g>
          );
        })()}
        <text x={PL + A / 2} y={H - 5} textAnchor="middle" fontSize={11} fill={theme.secondary}>{qLabel[0]}</text>
        <text x={12} y={PT + A / 2} textAnchor="middle" fontSize={11} fill={theme.secondary} transform={`rotate(-90 12 ${PT + A / 2})`}>{qLabel[1]}</text>
      </svg>
      <figcaption style={cap}>
        {selRow ? (
          <span style={{ fontFamily: themeMono, color: theme.ink }}>
            {selRow.kind === "magnetic" ? "mag " : multiPhase ? `${selRow.phaseLabel ?? ""} ` : ""}
            ({selRow.h} {selRow.k} {selRow.l}) · d {selRow.d.toFixed(4)} Å · Fo² {selRow.iObs.toFixed(1)} · Fc² {selRow.iCalc.toFixed(1)}
            {rowZ(selRow) !== undefined ? ` · Δ/σ ${rowZ(selRow)!.toFixed(1)}` : ""}
          </span>
        ) : compact ? (
          <>{rows.length} reflections{hidden > 0 ? ` · ${hidden} off the log axes` : ""} · click a point for its (hkl)</>
        ) : (
          <>
            {rows.length} reflections{magCount > 0 ? ` (${magCount} magnetic)` : ""}; points on the dashed line agree.
            {hidden > 0 ? ` ${hidden} with a value ≤ ${decadeLabel(lo)} are off the log axes.` : ""}
            {" "}Click a point for its (hkl).
          </>
        )}
      </figcaption>
    </figure>
  );
}

const cap: React.CSSProperties = { fontSize: fz.micro, color: theme.secondary, lineHeight: 1.45 };
