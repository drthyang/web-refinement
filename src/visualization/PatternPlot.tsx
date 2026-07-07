/**
 * Powder pattern plot: observed (points), calculated (line), and difference
 * curve below. Pure SVG, no chart library. Presentation only.
 */

import { useCallback, useRef } from "react";
import type { PowderCurves } from "@/core/workflow/powder";
import { extent, linearScale, polylinePoints } from "@/visualization/scale";

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
}

export function PatternPlot({
  curves,
  xLabel = "x",
  width = 760,
  height = 380,
  fitRange,
  onFitRangeChange,
}: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const margin = { top: 16, right: 16, bottom: 40, left: 56 };
  const plotW = width - margin.left - margin.right;
  const mainH = (height - margin.top - margin.bottom) * 0.72;
  const diffH = (height - margin.top - margin.bottom) * 0.28;

  const [xMin, xMax] = extent(curves.x);
  const [yMin, yMax] = extent([...curves.yObs, ...curves.yCalc, ...(curves.yBackground ?? [])]);
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
  const backgroundLine = curves.yBackground ? polylinePoints(curves.x, curves.yBackground, sx, sy) : "";
  const diffLine = polylinePoints(curves.x, curves.diff, sx, sd);

  const plotBottom = margin.top + mainH + diffH;
  const showHandles = fitRange !== undefined && onFitRangeChange !== undefined;

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
      {/* observed as small circles (subsampled for density) */}
      {curves.x.map((x, i) =>
        i % 3 === 0 ? (
          <circle key={i} cx={sx(x)} cy={sy(curves.yObs[i]!)} r={1.6} fill="#c1272d" opacity={0.7} />
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
