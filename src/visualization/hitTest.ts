/**
 * Nearest-point hit testing for scatter plots.
 *
 * Per-point invisible "halo" circles are the wrong click target for a dense
 * scatter: the browser hands the click to the TOPMOST halo under the pointer,
 * so in a crowded region a later-drawn neighbour whose halo merely overlaps
 * the spot wins over the dot the user actually aimed at. Selecting the
 * NEAREST point to the click, over the whole plot, picks the intended dot
 * regardless of draw order or density — and it is one handler and zero extra
 * DOM nodes instead of one halo per point.
 */

export interface PlotPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Index of the point nearest to (x, y), or −1 when none lies within `radius`
 * (same units as the points). Ties go to the earliest point. Non-finite
 * points are skipped.
 */
export function nearestPointIndex(points: readonly PlotPoint[], x: number, y: number, radius: number): number {
  let best = -1;
  let bestD2 = radius * radius;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/**
 * Map a client (screen) coordinate onto an SVG's user space. Uses the current
 * screen transform when the element provides one (this accounts for the
 * viewBox, any letterboxing from `preserveAspectRatio`, and CSS transforms);
 * otherwise scales by the rendered box against the given user-space size —
 * exact for a plot whose viewBox aspect matches its box.
 */
export function clientToSvgUser(
  svg: {
    getScreenCTM?: () => { inverse: () => DOMMatrixLike } | null;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  },
  clientX: number,
  clientY: number,
  userSize: { readonly width: number; readonly height: number },
): PlotPoint {
  const ctm = svg.getScreenCTM?.();
  if (ctm) {
    const inv = ctm.inverse();
    // x' = a·x + c·y + e ; y' = b·x + d·y + f  (the 2-D affine part of the matrix).
    return { x: inv.a * clientX + inv.c * clientY + inv.e, y: inv.b * clientX + inv.d * clientY + inv.f };
  }
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: NaN, y: NaN };
  return {
    x: ((clientX - rect.left) / rect.width) * userSize.width,
    y: ((clientY - rect.top) / rect.height) * userSize.height,
  };
}

/** The affine part of a DOMMatrix — all this module reads. */
export interface DOMMatrixLike {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}
