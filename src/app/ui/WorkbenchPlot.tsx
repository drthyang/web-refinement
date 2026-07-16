/**
 * Powder-pattern chart, rebuilt to the design handoff spec: a custom SVG plot
 * (viewBox 860×560, preserveAspectRatio="none") with auto-scaled y/x "nice"
 * ticks, obs/calc/bkg/diff series, a difference band, a Bragg-reflection tick
 * row (coloured per phase), excluded-region scrims, draggable fit-range handles,
 * and drag-to-zoom on the x-axis. Fed by the real refinement curves.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PowderCurves } from "@/core/workflow/powder";
import type { PhaseTicks } from "@/visualization/reflectionTicks";
import { color, mono } from "@/app/theme";

export interface FitRangeSelection {
  readonly min: number;
  readonly max: number;
}

/** A detected ("found") peak, flagged with a ▽ marker above the pattern. */
export interface FoundPeak {
  /** Position in the plot's current display unit (x-axis). */
  readonly x: number;
  /** d-spacing in Å (for the tooltip). */
  readonly d: number;
}

interface Props {
  readonly curves: PowderCurves;
  readonly xLabel: string;
  readonly fitRange?: FitRangeSelection;
  readonly onFitRangeChange?: (range: FitRangeSelection) => void;
  readonly phases?: readonly PhaseTicks[];
  /**
   * Detected peaks to flag with downward ▽ triangles *above* the pattern — the
   * magnetic-analysis "found peaks" (intensity the nuclear fit leaves
   * unexplained). Deliberately a different mark from the Bragg-tick phase rows
   * below, so found peaks don't read as another indexed phase.
   */
  readonly foundPeaks?: readonly FoundPeak[];
  readonly showBackground?: boolean;
  /** Increment to zoom the view onto the active fit range (no-op without one). */
  readonly focusFitToken?: number;
  /** Increment to zoom in on the currently-highlighted reflection, centred, at a
   *  moderate zoom (from "Show in pattern" in the F_obs/F_calc plot). */
  readonly focusPeakToken?: number;
  /**
   * A reflection spotlighted from elsewhere (e.g. a point clicked in the
   * F_obs/F_calc plot): its hkl ("h k l") and kind. Draws an arrow + guide line
   * down to its Bragg position (on the matching phase row) and pans the view to
   * reveal it if it is off-screen.
   */
  readonly highlight?: { readonly hkl: string; readonly kind: "nuclear" | "magnetic"; readonly phaseId?: string } | null;
  /**
   * Called when a Bragg tick is clicked (or the current pick is toggled off) —
   * the *same* selection channel as the F_obs/F_calc plot, so a tick click and a
   * scatter-point click share one spotlight and each replaces the other. Passes
   * the tick's hkl + phase kind + phase id, or null to clear.
   */
  readonly onHighlight?: (sel: { hkl: string; kind: "nuclear" | "magnetic"; phaseId?: string } | null) => void;
  /**
   * Called on a plain click in the data area (a press-and-release without the
   * drag that starts a rubber zoom, and not on a Bragg tick), with the clicked
   * x in data units — e.g. the magnetic page's "add a residual peak here".
   */
  readonly onPlotClick?: (x: number) => void;
}

// Fixed plot geometry (SVG user units); the SVG stretches to its container.
// Vertical stack (top→bottom): intensity plot, x-axis ticks/labels, a Bragg
// reflection tick band, then the difference band — each with clear separation.
const X0 = 58;
const RIGHT_PAD = 14; // right margin; the drawable width fills to boxW − RIGHT_PAD
const VB_H = 560; // viewBox height (user units); width is measured to avoid distortion
const TOP = 14;
const BASE = 356; // main-region baseline
const MAINH = BASE - TOP - 6; // intensity drawable height
const X_LABEL_Y = 372; // x-axis tick labels (below the axis marks)
const TICK_TOP = 382; // Bragg tick band (below the x-axis labels)
const TICK_H = 9; // tick mark height at the default row spacing
const TICK_ROW = 13; // vertical step per phase row (> tick height so rows never overlap)
const TICK_MAX_BOT = 420; // tick band floor (just above the difference band)
const DIFF_Y = 470; // difference-band zero line
const DIFF_A = 46; // difference band half-height
const CAP_Y = 522; // fit-handle caps, below the difference band
// Found-peak (▽) markers: a row of downward triangles just below the legend,
// above the intensity plot — a distinct mark from the Bragg tick rows below.
const FOUND_TOP = 30; // flat top edge of the triangle
const FOUND_H = 8; // triangle height (apex points down toward the peak x)
const FOUND_W = 5; // triangle half-width

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

/**
 * Display form of an hkl label: magnetic satellite indices are non-integer
 * (G ± k), and a fractional k like 1/3 would print its full float — trim to
 * 3 decimals for reading. Display only; matching still uses the raw string.
 */
function formatHkl(hkl: string): string {
  return hkl
    .split(" ")
    .map((s) => {
      const v = Number(s);
      if (!Number.isFinite(v)) return s;
      const r = Math.round(v);
      return Math.abs(v - r) < 5e-4 ? String(r) : String(+v.toFixed(3));
    })
    .join(" ");
}

export function WorkbenchPlot({
  curves,
  xLabel,
  fitRange,
  onFitRangeChange,
  phases,
  foundPeaks,
  showBackground = true,
  focusFitToken = 0,
  focusPeakToken = 0,
  highlight: highlightSel = null,
  onHighlight,
  onPlotClick,
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingGrip = useRef(false);

  const xs = curves.x;
  const fullMin = xs.length ? Math.min(...xs) : 0;
  const fullMax = xs.length ? Math.max(...xs) : 1;

  const [view, setView] = useState<{ min: number; max: number } | null>(null);
  const [rubber, setRubber] = useState<{ x0: number; x1: number } | null>(null);

  // A Bragg tick click is the *same* selection as an F_obs/F_calc point click:
  // both flow through `onHighlight` into one shared spotlight (`highlightSel`),
  // so clicking a tick draws the arrow+guide line and replaces any prior pick,
  // and clicking a scatter point replaces the tick pick. There is no separate
  // per-plot selection state — the parent owns the single selection.

  // The viewBox width tracks the rendered pixel aspect ratio so the plot fills
  // its (width-controlled, fixed-height) box with SQUARE units — no horizontal
  // text/line stretching, and the plot uses the full width at any window size.
  const [boxW, setBoxW] = useState(860);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) setBoxW(Math.max(560, Math.round((VB_H * r.width) / r.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const X1 = boxW - RIGHT_PAD;
  const XW = X1 - X0;
  // When the domain changes (new data, or an x-axis unit switch), default the
  // zoom to the active fit range — switching units lands on the region being
  // fitted — or to the full range when no window is set. Keyed only on the
  // domain, so dragging the fit handles doesn't fight the user by re-zooming.
  useEffect(() => {
    if (fitRange && (fitRange.min > fullMin + 1e-9 || fitRange.max < fullMax - 1e-9)) {
      const pad = (fitRange.max - fitRange.min) * 0.08;
      setView({ min: Math.max(fullMin, fitRange.min - pad), max: Math.min(fullMax, fitRange.max + pad) });
    } else {
      setView(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the domain
  }, [fullMin, fullMax]);

  // Explicit "focus the fit range" command from the toolbar: zoom onto the
  // active fit window (small pad), same framing the unit-switch default uses.
  useEffect(() => {
    if (focusFitToken === 0) return;
    if (fitRange && (fitRange.min > fullMin + 1e-9 || fitRange.max < fullMax - 1e-9)) {
      const pad = (fitRange.max - fitRange.min) * 0.08;
      setView({ min: Math.max(fullMin, fitRange.min - pad), max: Math.min(fullMax, fitRange.max + pad) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on the command token only
  }, [focusFitToken]);

  const vlo = view ? view.min : fullMin;
  const vhi = view ? view.max : fullMax;
  const vspan = vhi - vlo || 1;
  const sx = (x: number): number => X0 + ((x - vlo) / vspan) * XW;

  // Fit window (defaults to full domain) clips the calc/diff curves.
  const fitLo = fitRange ? fitRange.min : fullMin;
  const fitHi = fitRange ? fitRange.max : fullMax;
  const fitActive = fitRange !== undefined && (fitLo > fullMin + 1e-9 || fitHi < fullMax - 1e-9);

  // y auto-scale to the *observed* data in view only. Basing it on the calc too
  // would make the axis (and every marker) rescale on every refinement cycle;
  // observed peaks dominate the height anyway, so this keeps the frame stable.
  const yObs = curves.yObs;
  let yTop = 1;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i]! >= vlo && xs[i]! <= vhi) yTop = Math.max(yTop, yObs[i]!);
  }
  yTop *= 1.06;
  const sy = (y: number): number => BASE - (Math.min(Math.max(y, 0), yTop) / yTop) * MAINH;

  // Difference band scaled to its own max in view (with headroom) so a poor fit
  // fills the band instead of clipping flat against its edge; a floor keeps a
  // near-perfect fit from blowing up noise. It rescales as the fit converges,
  // which reads as the residual shrinking — the intended Rietveld behaviour.
  let dPeak = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i]! >= vlo && xs[i]! <= vhi) dPeak = Math.max(dPeak, Math.abs(curves.diff[i] ?? 0));
  }
  const dm = Math.max(dPeak * 1.1, yTop * 0.02, 1e-9);
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

  // Observed markers are the heaviest part of the SVG (thousands of circles) and
  // do not change while the calculated curve animates during a refinement, so
  // memoize them on their stable inputs — React then skips re-rendering them
  // every cycle, keeping the live update cheap and flicker-free.
  const obsMarkers = useMemo(() => {
    const mx = (x: number): number => X0 + ((x - vlo) / vspan) * XW;
    const my = (y: number): number => BASE - (Math.min(Math.max(y, 0), yTop) / yTop) * MAINH;
    const out: JSX.Element[] = [];
    for (let i = 0; i < xs.length; i += 2) {
      const x = xs[i]!;
      if (x < vlo || x > vhi) continue;
      out.push(<circle key={i} cx={mx(x)} cy={my(yObs[i]!)} r={1.3} fill={color.obs} opacity={0.5} />);
    }
    return out;
  }, [xs, yObs, vlo, vhi, vspan, yTop, XW]);

  // The single selected reflection (from a scatter-point OR a Bragg-tick click):
  // locate its Bragg tick so we can spotlight that peak. Prefer the row whose
  // *phase id* matches (so the right phase lights up when two phases share an
  // hkl); then the row whose *kind* matches (a k = 0 magnetic satellite sharing
  // an hkl with a nuclear peak lights the magnetic row); then any hkl match. Both
  // the tick emphasis and the arrow read from this, so a tick click and a scatter
  // click resolve to exactly the same peak.
  const highlight = useMemo(() => {
    if (!highlightSel || !phases) return null;
    const indexed = phases.map((p, row) => ({ p, row }));
    const rowsInOrder = [
      ...indexed.filter(({ p }) => highlightSel.phaseId !== undefined && p.id === highlightSel.phaseId),
      ...indexed.filter(({ p }) => p.kind === highlightSel.kind),
      ...indexed.filter(({ p }) => p.kind !== highlightSel.kind),
    ];
    for (const { p, row } of rowsInOrder) {
      const t = p.ticks.find((tk) => tk.hkl === highlightSel.hkl);
      if (t) return { x: t.x, hkl: t.hkl, d: t.d, color: p.color, row, label: p.label };
    }
    return null;
  }, [highlightSel, phases]);

  // Row geometry: at up to three phase rows the fixed spacing applies; more
  // rows (e.g. two nuclear phases + the magnetic-analysis rows) compress the
  // spacing and tick height so the band stays above the difference band.
  const nRows = phases?.length ?? 0;
  const tickStep = nRows > 3 ? Math.min(TICK_ROW, Math.floor((TICK_MAX_BOT - TICK_TOP - TICK_H) / (nRows - 1))) : TICK_ROW;
  const tickH = tickStep < TICK_ROW ? Math.max(5, tickStep - 2) : TICK_H;

  // Bragg tick rows are also static during a refinement (positions depend on the
  // structure, not the fit) and there can be hundreds — memoize them too. A tick
  // click toggles the shared selection through `onHighlight`, exactly like an
  // F_obs/F_calc point (the emphasised tick is the resolved `highlight`).
  const braggTicks = useMemo(() => {
    const mx = (x: number): number => X0 + ((x - vlo) / vspan) * XW;
    return (phases ?? []).map((phase, row) => {
      const y1 = TICK_TOP + row * tickStep;
      const y2 = y1 + tickH;
      return (
        <g key={phase.id} stroke={phase.color}>
          {phase.ticks.map((t, i) => {
            if (t.x < vlo || t.x > vhi) return null;
            const picked = !!highlight && highlight.row === row && highlight.hkl === t.hkl;
            const toggle = (): void =>
              onHighlight?.(picked ? null : { hkl: t.hkl, kind: phase.kind, phaseId: phase.id });
            return (
              <g key={i} className="wb-tick" style={{ cursor: "pointer" }} onClick={toggle}>
                <line
                  className="wb-mark"
                  x1={mx(t.x)} y1={picked ? y1 - 3 : y1} x2={mx(t.x)} y2={picked ? y2 + 3 : y2}
                  strokeWidth={1}
                  {...(picked ? { style: { strokeWidth: 2.6, strokeOpacity: 1 } } : {})}
                />
                <line x1={mx(t.x)} y1={y1 - 4} x2={mx(t.x)} y2={y2 + 4} stroke="transparent" strokeWidth={9}>
                  <title>{`${phase.label}  (${formatHkl(t.hkl)})  d ${t.d.toFixed(3)} Å`}</title>
                </line>
              </g>
            );
          })}
        </g>
      );
    });
  }, [phases, vlo, vhi, vspan, XW, highlight, onHighlight, tickStep, tickH]);

  // Pan to reveal a freshly-spotlighted peak when it sits outside the zoom
  // window — keyed on the pick only, so re-zooming/panning doesn't fight the user.
  useEffect(() => {
    if (!highlight) return;
    if (highlight.x >= vlo && highlight.x <= vhi) return;
    const span = vhi - vlo;
    let min = highlight.x - span / 2;
    let max = highlight.x + span / 2;
    if (min < fullMin) { min = fullMin; max = fullMin + span; }
    if (max > fullMax) { max = fullMax; min = fullMax - span; }
    setView({ min: Math.max(min, fullMin), max: Math.min(max, fullMax) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the pick only
  }, [highlightSel?.hkl, highlightSel?.kind, highlightSel?.phaseId]);

  // "Show in pattern" command: zoom in on the highlighted reflection, centred, at
  // a moderate zoom — a small fraction of the full domain to each side, so the
  // peak has context and isn't blown up to fill the frame. Keyed on the command
  // token only, so it fires exactly when requested (including on mount after the
  // view switches from Validation back to the pattern).
  useEffect(() => {
    if (focusPeakToken === 0 || !highlight) return;
    const hw = Math.max((fullMax - fullMin) * 0.06, 1e-9);
    setView({ min: highlight.x - hw, max: highlight.x + hw });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on the command token only
  }, [focusPeakToken]);

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
      const px = ((clientX - rect.left) / rect.width) * boxW; // user-space px
      return vlo + ((px - X0) / XW) * vspan;
    },
    [vlo, vspan, boxW, XW],
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
    // A press on a Bragg tick is that tick's own click (spotlight toggle) — it
    // must not double as a data-area click.
    const onTick = (e.target as Element).closest?.(".wb-tick") != null;
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
      if (hi - lo > vspan * 0.02) {
        setView({ min: Math.max(lo, fullMin), max: Math.min(hi, fullMax) });
      } else if (!onTick && x1 >= vlo && x1 <= vhi) {
        // Press-and-release without a drag: a plain click in the data area.
        onPlotClick?.(x1);
      }
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
    <div style={{ position: "relative", width: "100%", flex: 1, minHeight: 320 }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${boxW} ${VB_H}`}
        preserveAspectRatio="none"
        onPointerDown={startZoom}
        onDoubleClick={() => setView(null)}
        style={{ position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "crosshair" }}
      >
        <rect x={0} y={0} width={boxW} height={VB_H} fill={color.raised} />

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
            <text x={sx(v)} y={X_LABEL_Y} textAnchor="middle" fontSize={10} fontFamily={mono} fill={color.faint}>
              {formatX(v, vspan)}
            </text>
          </g>
        ))}
        <text x={(X0 + X1) / 2} y={550} textAnchor="middle" fontSize={11} fontFamily={mono} fill={color.faint}>
          {xLabel}
        </text>

        {/* observed markers (memoized — see obsMarkers) */}
        {obsMarkers}
        {/* background, calc */}
        {showBackground && curves.yBackground && <polyline points={bkgLine} fill="none" stroke={color.bkg} strokeWidth={1.2} strokeDasharray="5 3" opacity={0.9} />}
        <polyline points={calcLine} fill="none" stroke={color.calc} strokeWidth={1.4} />

        {/* difference band */}
        <line x1={X0} y1={DIFF_Y} x2={X1} y2={DIFF_Y} stroke="#e0d8c9" strokeDasharray="4 3" />
        <polyline points={diffLine} fill="none" stroke={color.diff} strokeWidth={1} />
        <text x={16} y={DIFF_Y} fontSize={10} fontFamily={mono} fill={color.faint} textAnchor="middle" transform={`rotate(-90 16 ${DIFF_Y})`}>
          Difference
        </text>

        {/* Bragg reflection ticks, one coloured row per phase. Each tick has a
            wide transparent hit line so it brightens on hover (see <style>). */}
        <style>{".wb-tick .wb-mark{stroke-opacity:.7}.wb-tick:hover .wb-mark{stroke-opacity:1;stroke-width:2}"}</style>
        {braggTicks}

        {/* Found-peak markers: downward ▽ triangles above the pattern at each
            detected (unexplained-residual) peak — a distinct mark from the
            Bragg tick rows below, so they don't read as another indexed phase.
            Magnetic-analysis only (absent elsewhere). */}
        {foundPeaks && foundPeaks.length > 0 && (
          <g>
            {foundPeaks.map((p, i) => {
              if (p.x < vlo || p.x > vhi) return null;
              const px = sx(p.x);
              return (
                <g key={i}>
                  <path
                    d={`M ${(px - FOUND_W).toFixed(1)} ${FOUND_TOP} L ${(px + FOUND_W).toFixed(1)} ${FOUND_TOP} L ${px.toFixed(1)} ${FOUND_TOP + FOUND_H} Z`}
                    fill={color.obs}
                    stroke={color.raised}
                    strokeWidth={0.8}
                  />
                  <rect x={px - 6} y={FOUND_TOP - 2} width={12} height={FOUND_H + 6} fill="transparent">
                    <title>{`found peak · d ${p.d.toFixed(3)} Å`}</title>
                  </rect>
                </g>
              );
            })}
          </g>
        )}

        {/* Spotlight for a reflection picked in the F_obs/F_calc plot: an arrow
            at the top, a dashed guide through the intensity region, and a bold
            tick on the matching Bragg row — linking the scatter point to its
            peak. (Off-screen picks are panned into view by the effect above.) */}
        {highlight && highlight.x >= vlo && highlight.x <= vhi && (() => {
          const hx = sx(highlight.x);
          const tickY2 = TICK_TOP + highlight.row * tickStep + tickH + 3;
          const right = hx > (X0 + X1) / 2;
          return (
            <g pointerEvents="none">
              {/* ink (not primary — that equals the calc/hkl blue) so the guide
                  reads over the blue calc curve; matches the scatter's pick ring. */}
              <line x1={hx} y1={TOP + 12} x2={hx} y2={tickY2} stroke={color.ink} strokeWidth={1.1} strokeDasharray="3 3" opacity={0.55} />
              <path d={`M ${hx - 5} ${TOP} L ${hx + 5} ${TOP} L ${hx} ${TOP + 11} Z`} fill={color.ink} />
              <line x1={hx} y1={TICK_TOP + highlight.row * tickStep - 3} x2={hx} y2={tickY2} stroke={highlight.color} strokeWidth={2.6} />
              <text
                x={right ? hx - 8 : hx + 8}
                y={TOP + 26}
                textAnchor={right ? "end" : "start"}
                fontSize={11}
                fontFamily={mono}
                fontWeight={600}
                fill={color.ink}
                stroke={color.raised}
                strokeWidth={3}
                paintOrder="stroke"
              >
                {formatHkl(highlight.hkl)}
              </text>
            </g>
          );
        })()}

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

        {/* legend: the series, then one vertical-tick entry per phase row (the
            phase legend) — or a generic "hkl" entry when no rows are supplied. */}
        <g fontSize={11} fill={color.secondary} fontFamily={mono}>
          <circle cx={X0 + 6} cy={24} r={2} fill={color.obs} />
          <text x={X0 + 13} y={27}>obs</text>
          <line x1={X0 + 40} y1={24} x2={X0 + 56} y2={24} stroke={color.calc} strokeWidth={1.6} />
          <text x={X0 + 60} y={27}>calc</text>
          <line x1={X0 + 88} y1={24} x2={X0 + 104} y2={24} stroke={color.diff} strokeWidth={1.6} />
          <text x={X0 + 108} y={27}>diff</text>
          <line x1={X0 + 134} y1={24} x2={X0 + 150} y2={24} stroke={color.bkg} strokeWidth={1.6} strokeDasharray="5 3" />
          <text x={X0 + 154} y={27}>bkg</text>
          {(() => {
            const phaseEntries = phases && phases.length > 0
              ? phases.map((p) => ({ color: p.color, label: p.label, shape: "line" as const }))
              : [{ color: color.hkl, label: "hkl", shape: "line" as const }];
            // The ▽ "found" key leads the dynamic entries when found peaks exist.
            const entries = [
              ...(foundPeaks && foundPeaks.length > 0
                ? [{ color: color.obs, label: "found", shape: "triangle" as const }]
                : []),
              ...phaseEntries,
            ];
            let x = X0 + 182;
            return entries.map((e, i) => {
              const gx = x;
              x += 10 + e.label.length * 6.6 + 16;
              return (
                <g key={i}>
                  {e.shape === "triangle" ? (
                    <path d={`M ${gx - 4} 20 L ${gx + 4} 20 L ${gx} 28 Z`} fill={e.color} />
                  ) : (
                    <line x1={gx} y1={19} x2={gx} y2={29} stroke={e.color} strokeWidth={2} />
                  )}
                  <text x={gx + 7} y={27}>{e.label}</text>
                </g>
              );
            });
          })()}
        </g>
      </svg>
      {/* corner overlays (HTML on top of the SVG). wR lives in the
          Refinement-quality rail, judged against R_exp. */}
      {highlight && (
        <div style={tickPickOverlay} onClick={() => onHighlight?.(null)} title="Click to dismiss (or click the tick again)">
          <span style={{ width: 9, height: 9, borderRadius: 2, background: highlight.color, display: "inline-block" }} />
          <span style={{ fontFamily: mono, fontSize: 12, color: color.ink }}>
            ({formatHkl(highlight.hkl)}) · d {highlight.d.toFixed(4)} Å
          </span>
          <span style={{ fontSize: 11, color: color.secondary }}>{highlight.label}</span>
        </div>
      )}
      {zoomed && (
        <div style={zoomOverlay}>
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

const zoomOverlay: CSSProperties = { position: "absolute", bottom: 6, right: 8, display: "flex", alignItems: "center", gap: 6, background: "rgba(255,253,249,0.85)", borderRadius: 8, padding: "3px 6px" };
const tickPickOverlay: CSSProperties = { position: "absolute", top: 6, right: 8, display: "flex", alignItems: "center", gap: 7, background: "rgba(255,253,249,0.92)", border: `1px solid ${color.border}`, borderRadius: 8, padding: "3px 9px", cursor: "pointer" };
