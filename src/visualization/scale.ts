/**
 * Pure plotting math: map data coordinates to pixel coordinates. Kept separate
 * from the React component so it is unit-testable.
 */

export interface LinearScale {
  (value: number): number;
  readonly domainMin: number;
  readonly domainMax: number;
  /** Map a pixel coordinate back to a data value (inverse of the scale). */
  invert(pixel: number): number;
}

export function linearScale(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): LinearScale {
  const span = domainMax - domainMin || 1;
  const pixelSpan = rangeMax - rangeMin || 1;
  const fn = ((v: number): number =>
    rangeMin + ((v - domainMin) / span) * (rangeMax - rangeMin)) as {
    (value: number): number;
    domainMin: number;
    domainMax: number;
    invert(pixel: number): number;
  };
  fn.domainMin = domainMin;
  fn.domainMax = domainMax;
  fn.invert = (pixel: number): number => domainMin + ((pixel - rangeMin) / pixelSpan) * span;
  return fn;
}

export function extent(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return [min - 1, max + 1];
  }
  return [min, max];
}

/** Build an SVG polyline "x,y x,y …" path string from data arrays. */
export function polylinePoints(
  xs: readonly number[],
  ys: readonly number[],
  sx: LinearScale,
  sy: LinearScale,
): string {
  const n = Math.min(xs.length, ys.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`${sx(xs[i]!).toFixed(2)},${sy(ys[i]!).toFixed(2)}`);
  }
  return parts.join(" ");
}

/**
 * Like {@link polylinePoints} but only emits points whose abscissa lies within
 * the inclusive window [lo, hi]. Used to draw the calculated/difference curves
 * only over the active fit range, so excluded data reads as un-fitted.
 */
export function clippedPolylinePoints(
  xs: readonly number[],
  ys: readonly number[],
  sx: LinearScale,
  sy: LinearScale,
  lo: number,
  hi: number,
): string {
  const n = Math.min(xs.length, ys.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    if (x < lo || x > hi) continue;
    parts.push(`${sx(x).toFixed(2)},${sy(ys[i]!).toFixed(2)}`);
  }
  return parts.join(" ");
}
