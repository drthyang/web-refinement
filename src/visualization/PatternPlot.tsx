/**
 * Powder pattern plot: observed (points), calculated (line), and difference
 * curve below. Pure SVG, no chart library. Presentation only.
 */

import { useCallback, useRef } from "react";
import type { PowderCurves } from "@/core/workflow/powder";
import type { PhaseTicks } from "@/visualization/reflectionTicks";
import { clippedPolylinePoints, extent, linearScale } from "@/visualization/scale";

/** Inclusive abscissa window selected on the plot. */
export interface FitRangeSelection {
  readonly min: number;
  readonly max: number;
}

interface Props {
  readonly curves: PowderCurves;
  readonly xLabel?: string;
  readonly width?: number;
  readonly height?: number;
  /** Current fit-range window (data units). When set, draggable handles show. */
  readonly fitRange?: FitRangeSelection;
  /** Called while the user drags either handle, with the updated window. */
  readonly onFitRangeChange?: (range: FitRangeSelection) => void;
  /** Bragg reflection tick rows (one per phase / magnetic), each coloured. */
  readonly phases?: readonly PhaseTicks[];
}

const TICK_ROW_H = 9;

export function PatternPlot({
  curves,
  xLabel = "x",
  width = 760,
  height = 380,
  fitRange,
  onFitRangeChange,
  phases,
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const margin = { top: 16, right: 16, bottom: 40, left: 56 };
  const plotW = width - margin.left - margin.right;
  const tickRows = phases?.length ?? 0;
  const tickBandH = tickRows > 0 ? tickRows * TICK_ROW_H + 4 : 0;
  const availH = height - margin.top - margin.bottom - tickBandH;
  const mainH = availH * 0.72;
  const diffH = availH * 0.28;
  const tickTop = margin.top + mainH + 2;
  const diffTop = margin.top + mainH + tickBandH;

  const [xMin, xMax] = extent(curves.x);

  // Calc/difference are only meaningful where the data is fitted, so clip them
  // to the fit window (the full extent when no window is set). Excluded data is
  // still shown as faint observed points.
  const clipLo = fitRange ? fitRange.min : xMin;
  const clipHi = fitRange ? fitRange.max : xMax;
  const inFitRange = (x: number): boolean => x >= clipLo && x <= clipHi;
  const clipped = <T,>(arr: readonly T[]): T[] => arr.filter((_, i) => inFitRange(curves.x[i]!));

  // Observed points are shown across the whole pattern (faded outside), so the
  // y-scale spans all of them; calc/background only span the clipped window.
  const [yMin, yMax] = extent([...curves.yObs, ...clipped(curves.yCalc), ...clipped(curves.yBackground ?? [])]);
  const [dMin, dMax] = extent(clipped(curves.diff));

  const sx = linearScale(xMin, xMax, margin.left, margin.left + plotW);
  const sy = linearScale(yMin, yMax, margin.top + mainH, margin.top);
  const sd = linearScale(Math.min(dMin, -1), Math.max(dMax, 1), diffTop + diffH, diffTop + 8);

  const calcLine = clippedPolylinePoints(curves.x, curves.yCalc, sx, sy, clipLo, clipHi);
  const backgroundLine = curves.yBackground ? clippedPolylinePoints(curves.x, curves.yBackground, sx, sy, clipLo, clipHi) : "";
  const diffLine = clippedPolylinePoints(curves.x, curves.diff, sx, sd, clipLo, clipHi);

  const plotBottom = diffTop + diffH;
  const showHandles = fitRange !== undefined && onFitRangeChange !== undefined;

  // Lay out phase legend entries after the obs/calc/diff/bkg items.
  let legendX = margin.left + (curves.yBackground ? 192 : 140);
  const phaseLegend = (phases ?? []).map((phase) => {
    const x = legendX;
    legendX += 16 + phase.label.length * 6.2 + 8;
    return { phase, x };
  });

  // Map a pointer event to a clamped data-space abscissa, correcting for any CSS
  // scaling of the SVG (the element is not laid out at its intrinsic pixel size
  // when the container shrinks it).
  const eventToData = useCallback(
    (clientX: number): number => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return xMin;
      const px = (clientX - rect.left) * (width / rect.width);
      const data = sx.invert(px);
      return Math.min(xMax, Math.max(xMin, data));
    },
    [sx, xMin, xMax, width],
  );

  const startDrag = useCallback(
    (handle: "min" | "max") => (e: React.PointerEvent<SVGRectElement>) => {
      if (!showHandles) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent): void => {
        const value = eventToData(ev.clientX);
        // Keep min < max; a dragged handle stops at the other one.
        if (handle === "min") onFitRangeChange!({ min: Math.min(value, fitRange!.max), max: fitRange!.max });
        else onFitRangeChange!({ min: fitRange!.min, max: Math.max(value, fitRange!.min) });
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [showHandles, eventToData, onFitRangeChange, fitRange],
  );

  const minPx = fitRange ? sx(Math.min(xMax, Math.max(xMin, fitRange.min))) : margin.left;
  const maxPx = fitRange ? sx(Math.min(xMax, Math.max(xMin, fitRange.max))) : margin.left + plotW;

  return (
    <svg ref={svgRef} width={width} height={height} role="img" aria-label="Powder pattern observed vs calculated">
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
      {/* observed as small circles (subsampled for density); excluded data faded */}
      {curves.x.map((x, i) =>
        i % 3 === 0 ? (
          <circle key={i} cx={sx(x)} cy={sy(curves.yObs[i]!)} r={1.6} fill="#c1272d" opacity={inFitRange(x) ? 0.7 : 0.18} />
        ) : null,
      )}
      {/* calculated line */}
      <polyline points={calcLine} fill="none" stroke="#1f4e79" strokeWidth={1.4} />
      {curves.yBackground && (
        <polyline points={backgroundLine} fill="none" stroke="#8a5a00" strokeWidth={1.2} strokeDasharray="5 3" />
      )}
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
      {/* reflection ticks: one coloured row per phase (nuclear/magnetic) */}
      {phases?.map((phase, row) => {
        const yc = tickTop + row * TICK_ROW_H + TICK_ROW_H / 2;
        return (
          <g key={phase.id} stroke={phase.color} strokeWidth={1}>
            {phase.ticks.map((t, i) =>
              t.x >= xMin && t.x <= xMax ? (
                <line key={i} x1={sx(t.x)} y1={yc - 3.2} x2={sx(t.x)} y2={yc + 3.2}>
                  <title>{`${phase.label}  ${t.hkl}  d=${t.d.toFixed(3)} Å`}</title>
                </line>
              ) : null,
            )}
          </g>
        );
      })}
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
        {curves.yBackground && (
          <>
            <line x1={margin.left + 148} y1={margin.top + 6} x2={margin.left + 164} y2={margin.top + 6} stroke="#8a5a00" strokeWidth={1.5} strokeDasharray="5 3" />
            <text x={margin.left + 168} y={margin.top + 9} fill="#333">bkg</text>
          </>
        )}
        {phaseLegend.map(({ phase, x }) => (
          <g key={phase.id}>
            <line x1={x} y1={margin.top + 2} x2={x} y2={margin.top + 10} stroke={phase.color} strokeWidth={1.5} />
            <text x={x + 6} y={margin.top + 9} fill="#333">{phase.label}</text>
          </g>
        ))}
      </g>
      {/* fit-range handles: shaded excluded regions + draggable grips */}
      {showHandles && (
        <g>
          {minPx > margin.left && (
            <rect x={margin.left} y={margin.top} width={minPx - margin.left} height={plotBottom - margin.top} fill="#1f4e79" opacity={0.06} />
          )}
          {maxPx < margin.left + plotW && (
            <rect x={maxPx} y={margin.top} width={margin.left + plotW - maxPx} height={plotBottom - margin.top} fill="#1f4e79" opacity={0.06} />
          )}
          {([["min", minPx], ["max", maxPx]] as const).map(([handle, px]) => (
            <g key={handle}>
              <line x1={px} y1={margin.top} x2={px} y2={plotBottom} stroke="#1f4e79" strokeWidth={1.5} />
              <rect
                x={px - 5}
                y={margin.top}
                width={10}
                height={plotBottom - margin.top}
                fill="transparent"
                style={{ cursor: "ew-resize" }}
                onPointerDown={startDrag(handle)}
              />
              <rect x={px - 4} y={margin.top} width={8} height={12} rx={2} fill="#1f4e79" style={{ cursor: "ew-resize" }} onPointerDown={startDrag(handle)} />
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
