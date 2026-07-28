/**
 * Boxcar (sliding-window) PDF refinement — the window plan and its guards.
 *
 * A boxcar fit slides a FIXED-width r-window across the data, refines the free
 * parameters inside each box (each box seeded from the previous one), and reads
 * how the refined values drift with the box-center r. A parameter that changes
 * with r is the classic local-vs-average-structure signature: the low-r boxes
 * see the local (instantaneous) structure, the high-r boxes the average one
 * (PDFgui calls the same procedure a boxcar refinement).
 *
 * The refinement itself is the existing sequential controller
 * (`refinement/sequential`) over the SAME pattern with per-box fit ranges —
 * this module only owns the window arithmetic, which is deliberately rigid:
 * every box has exactly the requested width. A trailing span narrower than one
 * box is NOT fitted as a shrunken box (its parameters would not be comparable
 * with the rest of the series); `scannedMax` reports where the plan actually
 * ends so the UI can say so.
 */

export type BoxcarDirection = "up" | "down";

/** One box of the plan: the inclusive fit window and its center (the abscissa
 *  the refined values are plotted against). */
export interface BoxcarWindow {
  readonly center: number;
  readonly min: number;
  readonly max: number;
}

export interface BoxcarPlanOptions {
  /** Scan span (Å) — normally the page's current fit window. */
  readonly range: { readonly min: number; readonly max: number };
  /** Fixed box width (Å). */
  readonly width: number;
  /** Center-to-center advance (Å); width/2 gives half-overlapping boxes. */
  readonly step: number;
  /** Scan direction: "up" = small r → large r (default), "down" = reverse. */
  readonly direction?: BoxcarDirection;
}

/** Float-tolerant containment: a box whose right edge lands on range.max after
 *  imperfect decimal arithmetic must still count as inside. */
const EPS = 1e-9;

/** Refuse plans beyond this many boxes — a mistyped step (0.01 Å over 30 Å)
 *  would otherwise queue thousands of refinements. */
export const BOXCAR_MAX_WINDOWS = 200;

/**
 * The boxcar plan: fixed-width windows advancing by `step`, first box flush
 * with `range.min`, every box fully inside the range. Returns them in scan
 * order (direction applied). Invalid inputs return an empty plan — call
 * {@link boxcarPlanIssue} for the user-facing reason.
 */
export function boxcarWindows(opts: BoxcarPlanOptions): BoxcarWindow[] {
  if (boxcarPlanIssue(opts) !== null) return [];
  const { range, width, step } = opts;
  const out: BoxcarWindow[] = [];
  // The loop's edge test and the count `boxcarPlanIssue` validated can differ
  // by one box on a boundary case (they apply the float tolerance in different
  // places), so the limit is enforced here too — it is a guard against a
  // mistyped step queueing thousands of refinements, and a guard that only
  // holds in the validator is not a guard.
  for (let i = 0; i <= BOXCAR_MAX_WINDOWS; i++) {
    const min = range.min + i * step;
    const max = min + width;
    if (max > range.max + EPS) break;
    out.push({ center: min + width / 2, min, max });
  }
  return opts.direction === "down" ? out.reverse() : out;
}

/** Whether consecutive boxes leave unfitted r between them (step > width) —
 *  a legal plan, but one whose span is sampled, not covered. */
export function boxcarHasGaps(opts: BoxcarPlanOptions): boolean {
  return opts.step > opts.width + EPS;
}

/** The end of the scanned span — where the last box's right edge lands. The UI
 *  reports it when the plan stops short of the fit window's end. */
export function boxcarScannedMax(opts: BoxcarPlanOptions): number | null {
  const windows = boxcarWindows(opts);
  if (windows.length === 0) return null;
  return Math.max(...windows.map((w) => w.max));
}

/**
 * Why this plan cannot run, as a user-facing message — or null when it can.
 * Checked in the same order a user would fix things: nonsense inputs first,
 * then the box-vs-range geometry, then the series length.
 */
export function boxcarPlanIssue(opts: BoxcarPlanOptions): string | null {
  const { range, width, step } = opts;
  if (!Number.isFinite(width) || width <= 0) return "Box width must be a positive number of Å.";
  if (!Number.isFinite(step) || step <= 0) return "Box step must be a positive number of Å.";
  const span = range.max - range.min;
  if (!(span > 0)) return "The fit window is empty — set a valid r range first.";
  if (width > span + EPS) {
    return `A ${fmt(width)} Å box does not fit inside the ${fmt(range.min)}–${fmt(range.max)} Å window — shrink the box or widen the fit window.`;
  }
  const count = Math.floor((span - width) / step + EPS) + 1;
  if (count < 2) {
    return "The plan has a single box — a boxcar needs at least two (shrink the step or the box, or widen the fit window).";
  }
  if (count > BOXCAR_MAX_WINDOWS) {
    return `${count} boxes is too many (limit ${BOXCAR_MAX_WINDOWS}) — increase the step or the box width.`;
  }
  return null;
}

function fmt(x: number): string {
  return String(+x.toFixed(3));
}
