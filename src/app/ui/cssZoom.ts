/**
 * The UI zoom on the root element — `--ui-zoom` in workbench.css, above 1 only
 * on dense large screens (a 4K monitor at 100%). Under a CSS zoom,
 * getBoundingClientRect() and window.innerWidth/innerHeight are in screen
 * pixels, while inline lengths (a fixed tooltip's left/top) and canvas sizes
 * are laid out before the zoom and then scaled by it. Anything placed or sized
 * from a measured rect therefore divides by this first.
 */
export function cssZoom(): number {
  if (typeof document === "undefined") return 1;
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
