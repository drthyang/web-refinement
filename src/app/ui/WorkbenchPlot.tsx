/**
 * Powder-pattern chart, rebuilt to the design handoff spec: a custom SVG plot
 * (viewBox 860×560, preserveAspectRatio="none") with auto-scaled y/x "nice"
 * ticks, obs/calc/bkg/diff series, a difference band, a Bragg-reflection tick
 * row (coloured per phase), excluded-region scrims, draggable fit-range handles,
 * and drag-to-zoom on the x-axis. Fed by the real refinement curves.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PowderCurves } from "@/core/workflow/powder";
import type { PhaseTicks } from "@/visualization/reflectionTicks";
import { color, mono } from "@/app/theme";

export interface FitRangeSelection {
  readonly min: number;
  readonly max: number;
}

interface Props {
  readonly curves: PowderCurves;
  readonly xLabel: string;
  readonly wRpct: string;
  readonly fitRange?: FitRangeSelection;
  readonly onFitRangeChange?: (range: FitRangeSelection) => void;
  readonly phases?: readonly PhaseTicks[];
  readonly showBackground?: boolean;
}

// Fixed plot geometry (SVG user units); the SVG stretches to its container.
const X0 = 58;
const X1 = 846;
const XW = X1 - X0; // 788
const TOP = 14;
const BASE = 380; // main-region baseline
const MAINH = BASE - TOP - 10; // 356
const DIFF_Y = 458;
const DIFF_A = 58; // difference band half-height
const TICK_TOP = 384;
const TICK_BOT = 393;
const CAP_Y = 507;

function niceNum(x: number, round: boolean): number {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

function formatY(v: number): string {
  if (v === 0) return "0";
  if (Math.abs(v) >= 1000) return `${+(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatX(v: number, span: number): string {
  if (span >= 200) return String(Math.round(v));
  if (span >= 5) return v.toFixed(1);
  return v.toFixed(2);
}

export function WorkbenchPlot({
  curves,
  xLabel,
  wRpct,
  fitRange,
  onFitRangeChange,
  phases,
  showBackground = true,
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingGrip = useRef(false);

  const xs = curves.x;
  const fullMin = xs.length ? Math.min(...xs) : 0;
  const fullMax = xs.length ? Math.max(...xs) : 1;

  const [view, setView] = useState<{ min: number; max: number } | null>(null);
  const [rubber, setRubber] = useState<{ x0: number; x1: number } | null>(null);
  // Reset zoom when the underlying domain changes (e.g. new data or x-unit).
  useEffect(() => setView(null), [fullMin, fullMax]);

  const vlo = view ? view.min : fullMin;
  const vhi = view ? view.max : fullMax;
  const vspan = vhi - vlo || 1;
  const sx = (x: number): number => X0 + ((x - vlo) / vspan) * XW;

  // Fit window (defaults to full domain) clips the calc/diff curves.
  const fitLo = fitRange ? fitRange.min : fullMin;
  const fitHi = fitRange ? fitRange.max : fullMax;
  const fitActive = fitRange !== undefined && (fitLo > fullMin + 1e-9 || fitHi < fullMax - 1e-9);

  // y auto-scale to the data in view.
  let yTop = 1;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i]! < vlo || xs[i]! > vhi) continue;
    yTop = Math.max(yTop, curves.yObs[i]!, curves.yCalc[i]!);
  }
  yTop *= 1.06;
  const sy = (y: number): number => BASE - (Math.min(Math.max(y, 0), yTop) / yTop) * MAINH;

  let dm = 1;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i]! < vlo || xs[i]! > vhi || xs[i]! < fitLo || xs[i]! > fitHi) continue;
    dm = Math.max(dm, Math.abs(curves.diff[i]!));
  }
  const sdiff = (d: number): number => DIFF_Y - (Math.min(Math.max(d, -dm), dm) / dm) * DIFF_A;

  const poly = (ys: readonly number[], map: (y: number) => number, lo: number, hi: number): string => {
    const parts: string[] = [];
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      if (x < lo || x > hi) continue;
      parts.push(`${sx(x).toFixed(1)},${map(ys[i]!).toFixed(1)}`);
    }
    return parts.join(" ");
  };

  const calcLine = poly(curves.yCalc, sy, fitLo, fitHi);
  const bkgLine = curves.yBackground ? poly(curves.yBackground, sy, fitLo, fitHi) : "";
  const diffLine = poly(curves.diff, sdiff, fitLo, fitHi);

  // Y / X nice ticks.
  const yStep = niceNum(yTop / 4, true);
  const yTicks: number[] = [];
  for (let v = 0; v <= yTop + 1e-6; v += yStep) yTicks.push(v);
  const xStep = niceNum(vspan / 6, true);
  const xTicks: number[] = [];
  for (let v = Math.ceil(vlo / xStep) * xStep; v <= vhi + 1e-6; v += xStep) xTicks.push(v);

  // --- pointer helpers -------------------------------------------------------
  const clientToX = useCallback(
    (clientX: number): number => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return vlo;
      const px = ((clientX - rect.left) / rect.width) * 860; // user-space px
      return vlo + ((px - X0) / XW) * vspan;
    },
    [vlo, vspan],
  );

  const startGrip = (which: "min" | "max") => (e: React.PointerEvent): void => {
    if (!onFitRangeChange || !fitRange) return;
    e.stopPropagation();
    e.preventDefault();
    draggingGrip.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const v = Math.min(fullMax, Math.max(fullMin, clientToX(ev.clientX)));
      if (which === "min") onFitRangeChange({ min: Math.min(v, fitRange.max), max: fitRange.max });
      else onFitRangeChange({ min: fitRange.min, max: Math.max(v, fitRange.min) });
    };
    const up = (): void => {
      draggingGrip.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startZoom = (e: React.PointerEvent): void => {
    if (draggingGrip.current) return;
    const x0 = clientToX(e.clientX);
    setRubber({ x0, x1: x0 });
    const move = (ev: PointerEvent): void => setRubber({ x0, x1: clientToX(ev.clientX) });
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const x1 = clientToX(ev.clientX);
      const lo = Math.min(x0, x1);
      const hi = Math.max(x0, x1);
      setRubber(null);
      if (hi - lo > vspan * 0.02) setView({ min: Math.max(lo, fullMin), max: Math.min(hi, fullMax) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const zoomed = view !== null;
  const zoomOut = (): void => {
    const span = vhi - vlo;
    const c = (vlo + vhi) / 2;
    const ns = Math.min(span * 2, fullMax - fullMin);
    if (ns >= (fullMax - fullMin) * 0.999) return setView(null);
    setView({ min: Math.max(c - ns / 2, fullMin), max: Math.min(c + ns / 2, fullMax) });
  };

  const minPx = sx(Math.min(fullMax, Math.max(fullMin, fitLo)));
  const maxPx = sx(Math.min(fullMax, Math.max(fullMin, fitHi)));

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 480 }}>
      <svg
        ref={svgRef}
        viewBox="0 0 860 560"
        preserveAspectRatio="none"
        onPointerDown={startZoom}
        onDoubleClick={() => setView(null)}
        style={{ position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "crosshair" }}
      >
        <rect x={0} y={0} width={860} height={560} fill={color.raised} />

        {/* axes */}
        <line x1={X0} y1={TOP} x2={X0} y2={BASE} stroke="#c9c0b0" />
        <line x1={X0} y1={BASE} x2={X1} y2={BASE} stroke="#c9c0b0" />

        {/* y ticks */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={X0 - 4} y1={sy(v)} x2={X0} y2={sy(v)} stroke="#c9c0b0" />
            <text x={X0 - 7} y={sy(v) + 3} textAnchor="end" fontSize={9.5} fontFamily={mono} fill={color.faint}>
              {formatY(v)}
            </text>
          </g>
        ))}
        <text x={16} y={(TOP + BASE) / 2} fontSize={10} fontFamily={mono} fill={color.faint} textAnchor="middle" transform={`rotate(-90 16 ${(TOP + BASE) / 2})`}>
          Intensity (a.u.)
        </text>

        {/* x ticks */}
        {xTicks.map((v) => (
          <g key={v}>
            <line x1={sx(v)} y1={BASE} x2={sx(v)} y2={BASE + 4} stroke="#c9c0b0" />
            <text x={sx(v)} y={396} textAnchor="middle" fontSize={10} fontFamily={mono} fill={color.faint}>
              {formatX(v, vspan)}
            </text>
          </g>
        ))}
        <text x={(X0 + X1) / 2} y={552} textAnchor="middle" fontSize={11} fontFamily={mono} fill={color.faint}>
          {xLabel}
        </text>

        {/* observed markers */}
        {xs.map((x, i) =>
          i % 2 === 0 && x >= vlo && x <= vhi ? (
            <circle key={i} cx={sx(x)} cy={sy(curves.yObs[i]!)} r={1.3} fill={color.obs} opacity={0.5} />
          ) : null,
        )}
        {/* background, calc */}
        {showBackground && curves.yBackground && <polyline points={bkgLine} fill="none" stroke={color.bkg} strokeWidth={1.2} strokeDasharray="5 3" opacity={0.9} />}
        <polyline points={calcLine} fill="none" stroke={color.calc} strokeWidth={1.4} />

        {/* difference band */}
        <line x1={X0} y1={DIFF_Y} x2={X1} y2={DIFF_Y} stroke="#e0d8c9" strokeDasharray="4 3" />
        <polyline points={diffLine} fill="none" stroke={color.diff} strokeWidth={1} />
        <text x={16} y={DIFF_Y} fontSize={10} fontFamily={mono} fill={color.faint} textAnchor="middle" transform={`rotate(-90 16 ${DIFF_Y})`}>
          Difference
        </text>

        {/* Bragg reflection ticks, one coloured row per phase */}
        {phases?.map((phase, row) => (
          <g key={phase.id} stroke={phase.color} strokeWidth={1} opacity={0.75}>
            {phase.ticks.map((t, i) =>
              t.x >= vlo && t.x <= vhi ? (
                <line key={i} x1={sx(t.x)} y1={TICK_TOP + row * 5} x2={sx(t.x)} y2={TICK_BOT + row * 5}>
                  <title>{`${phase.label}  (${t.hkl})  d ${t.d.toFixed(3)} Å`}</title>
                </line>
              ) : null,
            )}
          </g>
        ))}

        {/* excluded-region scrims (dim data outside the fit range) */}
        {fitActive && (
          <>
            {minPx > X0 && (
              <>
                <rect x={X0} y={TOP} width={minPx - X0} height={BASE - TOP} fill={color.primary} opacity={0.06} />
                <rect x={X0} y={TOP} width={minPx - X0} height={CAP_Y - TOP} fill={color.raised} opacity={0.6} />
              </>
            )}
            {maxPx < X1 && (
              <>
                <rect x={maxPx} y={TOP} width={X1 - maxPx} height={BASE - TOP} fill={color.primary} opacity={0.06} />
                <rect x={maxPx} y={TOP} width={X1 - maxPx} height={CAP_Y - TOP} fill={color.raised} opacity={0.6} />
              </>
            )}
          </>
        )}

        {/* fit-range handles */}
        {onFitRangeChange && fitRange && (
          <>
            {(["min", "max"] as const).map((which) => {
              const px = which === "min" ? minPx : maxPx;
              return (
                <g key={which}>
                  <line x1={px} y1={TOP} x2={px} y2={CAP_Y} stroke={color.primary} strokeWidth={1.5} />
                  <rect x={px - 6} y={TOP} width={12} height={CAP_Y - TOP} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={startGrip(which)} />
                  <rect x={px - 4.5} y={CAP_Y} width={9} height={14} rx={3} fill={color.primary} style={{ cursor: "ew-resize" }} onPointerDown={startGrip(which)} />
                </g>
              );
            })}
          </>
        )}

        {/* rubber-band zoom selection */}
        {rubber && (
          <rect
            x={sx(Math.min(rubber.x0, rubber.x1))}
            y={TOP}
            width={Math.abs(sx(rubber.x1) - sx(rubber.x0))}
            height={BASE - TOP}
            fill={color.primary}
            opacity={0.14}
            stroke={color.primary}
            strokeWidth={1}
          />
        )}

        {/* legend */}
        <g fontSize={11} fill={color.secondary} fontFamily={mono}>
          <circle cx={X0 + 6} cy={24} r={2} fill={color.obs} />
          <text x={X0 + 13} y={27}>obs</text>
          <line x1={X0 + 40} y1={24} x2={X0 + 56} y2={24} stroke={color.calc} strokeWidth={1.6} />
          <text x={X0 + 60} y={27}>calc</text>
          <line x1={X0 + 88} y1={24} x2={X0 + 104} y2={24} stroke={color.diff} strokeWidth={1.6} />
          <text x={X0 + 108} y={27}>diff</text>
          <line x1={X0 + 134} y1={24} x2={X0 + 150} y2={24} stroke={color.bkg} strokeWidth={1.6} strokeDasharray="5 3" />
          <text x={X0 + 154} y={27}>bkg</text>
          <line x1={X0 + 182} y1={20} x2={X0 + 182} y2={28} stroke={color.hkl} strokeWidth={1.4} />
          <text x={X0 + 188} y={27}>hkl</text>
        </g>
      </svg>
      {/* corner overlays: wR and zoom controls (HTML on top of the SVG) */}
      <div style={wrOverlay}>
        <span style={{ ...uppercase, marginRight: 6 }}>wR</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: color.primary, fontFamily: mono }}>{wRpct}%</span>
      </div>
      {zoomed && (
        <div style={zoomOverlay}>
          <span style={{ fontFamily: mono, fontSize: 11, color: color.secondary }}>
            view {formatX(vlo, vspan)}–{formatX(vhi, vspan)}
          </span>
          <SmallButton onClick={zoomOut}>Zoom out</SmallButton>
          <SmallButton onClick={() => setView(null)}>Reset zoom</SmallButton>
        </div>
      )}
    </div>
  );
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ border: `1px solid ${color.control}`, background: hover ? "#f5f0e7" : "#fff", borderRadius: 7, padding: "1px 9px", fontSize: 11, cursor: "pointer" }}
    >
      {children}
    </button>
  );
}

const uppercase: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: color.faint };
const wrOverlay: CSSProperties = { position: "absolute", top: 6, right: 8, display: "flex", alignItems: "baseline", background: "rgba(255,253,249,0.85)", borderRadius: 8, padding: "2px 8px" };
const zoomOverlay: CSSProperties = { position: "absolute", bottom: 6, right: 8, display: "flex", alignItems: "center", gap: 6, background: "rgba(255,253,249,0.85)", borderRadius: 8, padding: "3px 6px" };
