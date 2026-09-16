/**
 * SVG figures for the refinement report (`report.ts`) — pure string producers,
 * no DOM: the observed / calculated / difference pattern with Bragg-tick rows,
 * the single-crystal |F_obs| vs |F_calc| plot, and the projected magnetic
 * structure with moment arrows (the arrangement the 3D viewer shows, seen down
 * c*). The figures style themselves through the report's CSS classes and
 * variables, so they follow its light/dark palette and print cleanly.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { fractionalToCartesian } from "@/core/crystal/unitCell";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import {
  buildCellAtoms,
  displayMoment,
  magneticSupercell,
  momentEntriesFrom,
  type CellAtom,
} from "@/core/crystal/cellExpansion";

/** Arrow / atom colour cycles (sublattices; elements), light-theme values. */
export const SUBLATTICE_COLORS = ["#cf3b52", "#4b5fc4", "#0e8074", "#b06f1f", "#8a4bc4", "#3f7fb2"];
export const ELEMENT_COLORS = ["#9d7bc9", "#c9938c", "#7ba3c9", "#8fbc8f", "#c9b07b", "#b98fb9"];

const px = (v: number): string => (Object.is(v, -0) ? "0" : v.toFixed(1));

function extent(...arrays: readonly (readonly number[])[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays) {
    for (const v of a) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === Infinity) return [0, 1];
  if (hi === lo) return [lo - 1, hi + 1];
  return [lo, hi];
}

/** "Nice" axis tick positions: 1 / 2 / 2.5 / 5 × 10ⁿ steps, about `target` of them. */
export function niceTicks(min: number, max: number, target = 7): { ticks: number[]; step: number } {
  if (!(max > min)) return { ticks: [min], step: 1 };
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // The nice multiple closest to the raw step (in ratio), so ~target ticks result.
  const step = [1, 2, 2.5, 5, 10]
    .map((m) => m * mag)
    .reduce((best, cand) => (Math.abs(Math.log(cand / raw)) < Math.abs(Math.log(best / raw)) ? cand : best));
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step - 1e-9) * step; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  return { ticks, step };
}

function axisLabelFor(v: number, step: number): string {
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const s = v.toFixed(Math.min(d, 6));
  return s === "-0" ? "0" : s;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One polyline through (x, y), thinned to at most ~6000 vertices. */
function polyline(xs: readonly number[], ys: readonly number[], X: (x: number) => number, Y: (y: number) => number): string {
  const n = Math.min(xs.length, ys.length);
  const stride = Math.max(1, Math.ceil(n / 6000));
  let d = "";
  for (let i = 0; i < n; i += stride) {
    const y = ys[i]!;
    if (!Number.isFinite(y)) continue;
    d += `${d ? "L" : "M"}${px(X(xs[i]!))} ${px(Y(y))}`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Observed / calculated / difference pattern

export interface FigureCurves {
  readonly x: readonly number[];
  readonly yObs: readonly number[];
  readonly yCalc: readonly number[];
  readonly diff: readonly number[];
  readonly yBackground?: readonly number[];
}

export interface FigureTickRow {
  readonly label: string;
  readonly color: string;
  /** Tick positions in the figure's x unit. */
  readonly x: readonly number[];
}

export interface PatternFigureOptions {
  readonly xLabel: string;
  readonly yLabel?: string;
  /** Bragg-position rows drawn under the difference curve (one per phase). */
  readonly ticks?: readonly FigureTickRow[];
  /** The refined window; data outside it is shaded as excluded. */
  readonly fitRange?: { readonly min: number; readonly max: number };
  /** Observed points as dots (diffraction convention) or a line (dense data). */
  readonly observedAs?: "dots" | "line";
  /** Legend names for the curves (defaults: observed / calculated / difference). */
  readonly legend?: { readonly obs?: string; readonly calc?: string; readonly diff?: string; readonly background?: string };
}

/**
 * The fit figure: observed and calculated curves over the full data range, the
 * difference on its own zero-centred band beneath, then a row of Bragg ticks
 * per phase. Coordinates are the caller's display unit; nothing is converted.
 */
export function patternFigureSvg(c: FigureCurves, o: PatternFigureOptions): string {
  const n = c.x.length;
  if (n === 0) return "";
  const W = 1000;
  const L = 68;
  const R = 16;
  const T = 14;
  const H1 = 300;
  const GAP = 10;
  const H2 = 86;
  const TICK_H = 14;
  const AX = 40;
  const rows = (o.ticks ?? []).filter((r) => r.x.length > 0);
  const tickBlock = rows.length > 0 ? 8 + rows.length * TICK_H : 0;
  const H = T + H1 + GAP + H2 + tickBlock + AX;

  const [xmin, xmax] = extent(c.x);
  const X = (x: number): number => L + ((x - xmin) / (xmax - xmin)) * (W - L - R);
  const curvesForY: (readonly number[])[] = [c.yObs, c.yCalc];
  if (c.yBackground) curvesForY.push(c.yBackground);
  const [y0, y1] = extent(...curvesForY);
  const pad = (y1 - y0) * 0.05;
  const ymin = y0 - pad;
  const ymax = y1 + pad;
  const Y1 = (y: number): number => T + H1 - ((y - ymin) / (ymax - ymin)) * H1;
  const [d0, d1] = extent(c.diff);
  const dmax = Math.max(Math.abs(d0), Math.abs(d1)) || 1;
  const top2 = T + H1 + GAP;
  const Y2 = (d: number): number => top2 + H2 / 2 - (d / dmax) * (H2 / 2) * 0.9;
  const bottom = top2 + H2 + tickBlock;

  let s = "";
  // Excluded regions (outside the fit window), shaded across both panels.
  if (o.fitRange) {
    const lo = Math.max(xmin, Math.min(o.fitRange.min, o.fitRange.max));
    const hi = Math.min(xmax, Math.max(o.fitRange.min, o.fitRange.max));
    if (lo > xmin) s += `<rect class="excl" x="${px(L)}" y="${px(T)}" width="${px(X(lo) - L)}" height="${px(bottom - T)}"/>`;
    if (hi < xmax) s += `<rect class="excl" x="${px(X(hi))}" y="${px(T)}" width="${px(W - R - X(hi))}" height="${px(bottom - T)}"/>`;
  }
  // Frames and gridlines.
  const yt = niceTicks(ymin, ymax, 6);
  for (const t of yt.ticks) {
    if (t < ymin || t > ymax) continue;
    s += `<line class="grid" x1="${px(L)}" x2="${px(W - R)}" y1="${px(Y1(t))}" y2="${px(Y1(t))}"/>`;
    s += `<text class="axistext" x="${px(L - 8)}" y="${px(Y1(t) + 3.5)}" text-anchor="end">${axisLabelFor(t, yt.step)}</text>`;
  }
  s += `<rect class="frame" x="${px(L)}" y="${px(T)}" width="${px(W - L - R)}" height="${px(H1)}"/>`;
  s += `<rect class="frame" x="${px(L)}" y="${px(top2)}" width="${px(W - L - R)}" height="${px(H2)}"/>`;
  s += `<line class="zero" x1="${px(L)}" x2="${px(W - R)}" y1="${px(Y2(0))}" y2="${px(Y2(0))}"/>`;
  const xt = niceTicks(xmin, xmax, 9);
  for (const t of xt.ticks) {
    if (t < xmin || t > xmax) continue;
    s += `<line class="tickmark" x1="${px(X(t))}" x2="${px(X(t))}" y1="${px(bottom)}" y2="${px(bottom + 5)}"/>`;
    s += `<text class="axistext" x="${px(X(t))}" y="${px(bottom + 18)}" text-anchor="middle">${axisLabelFor(t, xt.step)}</text>`;
  }
  s += `<text class="axistitle" x="${px(L + (W - L - R) / 2)}" y="${px(H - 6)}" text-anchor="middle">${esc(o.xLabel)}</text>`;
  s += `<text class="axistitle" transform="translate(14 ${px(T + H1 / 2)}) rotate(-90)" text-anchor="middle">${esc(o.yLabel ?? "Intensity")}</text>`;
  s += `<text class="axistext" x="${px(L - 8)}" y="${px(Y2(0) + 3.5)}" text-anchor="end">0</text>`;

  // Curves: background (dashed), observed, calculated, difference.
  if (c.yBackground) s += `<path class="bkg" d="${polyline(c.x, c.yBackground, X, Y1)}"/>`;
  const dots = (o.observedAs ?? (n <= 12000 ? "dots" : "line")) === "dots";
  if (dots) {
    const stride = Math.max(1, Math.ceil(n / 8000));
    let d = "";
    for (let i = 0; i < n; i += stride) {
      const y = c.yObs[i]!;
      if (!Number.isFinite(y)) continue;
      d += `M${px(X(c.x[i]!))} ${px(Y1(y))}h0`;
    }
    s += `<path class="obs" d="${d}"/>`;
  } else {
    s += `<path class="obsline" d="${polyline(c.x, c.yObs, X, Y1)}"/>`;
  }
  s += `<path class="calc" d="${polyline(c.x, c.yCalc, X, Y1)}"/>`;
  s += `<path class="diff" d="${polyline(c.x, c.diff, X, Y2)}"/>`;

  // Bragg-tick rows.
  rows.forEach((row, i) => {
    const y = top2 + H2 + 8 + i * TICK_H + 2;
    let d = "";
    for (const x of row.x) {
      if (x < xmin || x > xmax) continue;
      d += `M${px(X(x))} ${px(y)}v${TICK_H - 5}`;
    }
    s += `<path d="${d}" stroke="${row.color}" stroke-width="1"/>`;
    s += `<text class="ticklabel" x="${px(L - 8)}" y="${px(y + 8)}" text-anchor="end" fill="${row.color}">${esc(row.label)}</text>`;
  });

  // Legend, top right of the main panel.
  const lg = o.legend ?? {};
  const items: { cls: string; label: string }[] = [
    { cls: "obs", label: lg.obs ?? "observed" },
    { cls: "calc", label: lg.calc ?? "calculated" },
    { cls: "diff", label: lg.diff ?? "difference" },
    ...(c.yBackground ? [{ cls: "bkg", label: lg.background ?? "background" }] : []),
  ];
  let lx = W - R - 12;
  const ly = T + 18;
  for (const it of [...items].reverse()) {
    const w = it.label.length * 6.6 + 30;
    lx -= w;
    s += `<line class="${it.cls === "obs" ? "obsline" : it.cls}" x1="${px(lx)}" x2="${px(lx + 16)}" y1="${px(ly)}" y2="${px(ly)}"/>`;
    s += `<text class="legend" x="${px(lx + 21)}" y="${px(ly + 3.5)}">${esc(it.label)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Observed, calculated and difference curves">${s}</svg>`;
}

// ---------------------------------------------------------------------------
// Single crystal: |F_obs| vs |F_calc|

export interface FobsFcalcPoint {
  /** Observed and calculated intensities (F²); plotted as √ → |F|. */
  readonly obs: number;
  readonly calc: number;
  readonly magnetic?: boolean;
}

export function fobsFcalcSvg(points: readonly FobsFcalcPoint[]): string {
  const S = 440;
  const L = 58;
  const R = 16;
  const T = 14;
  const B = 44;
  const inner = S - L - R;
  const innerH = S - T - B;
  const fo = points.map((p) => Math.sqrt(Math.max(0, p.obs)));
  const fc = points.map((p) => Math.sqrt(Math.max(0, p.calc)));
  const [, hi0] = extent(fo, fc);
  const hi = hi0 * 1.04 || 1;
  const X = (v: number): number => L + (v / hi) * inner;
  const Y = (v: number): number => T + innerH - (v / hi) * innerH;
  let s = "";
  const t = niceTicks(0, hi, 6);
  for (const v of t.ticks) {
    if (v > hi) continue;
    s += `<line class="grid" x1="${px(L)}" x2="${px(S - R)}" y1="${px(Y(v))}" y2="${px(Y(v))}"/>`;
    s += `<line class="grid" y1="${px(T)}" y2="${px(T + innerH)}" x1="${px(X(v))}" x2="${px(X(v))}"/>`;
    s += `<text class="axistext" x="${px(L - 8)}" y="${px(Y(v) + 3.5)}" text-anchor="end">${axisLabelFor(v, t.step)}</text>`;
    s += `<text class="axistext" x="${px(X(v))}" y="${px(T + innerH + 16)}" text-anchor="middle">${axisLabelFor(v, t.step)}</text>`;
  }
  s += `<rect class="frame" x="${px(L)}" y="${px(T)}" width="${px(inner)}" height="${px(innerH)}"/>`;
  s += `<line class="unity" x1="${px(X(0))}" y1="${px(Y(0))}" x2="${px(X(hi))}" y2="${px(Y(hi))}"/>`;
  let dn = "";
  let dm = "";
  for (let i = 0; i < points.length; i++) {
    const seg = `M${px(X(fc[i]!))} ${px(Y(fo[i]!))}h0`;
    if (points[i]!.magnetic) dm += seg; else dn += seg;
  }
  if (dn) s += `<path class="pt" d="${dn}"/>`;
  if (dm) s += `<path class="ptmag" d="${dm}"/>`;
  s += `<text class="axistitle" x="${px(L + inner / 2)}" y="${px(S - 8)}" text-anchor="middle">|F_calc|</text>`;
  s += `<text class="axistitle" transform="translate(14 ${px(T + innerH / 2)}) rotate(-90)" text-anchor="middle">|F_obs|</text>`;
  const nMag = points.filter((p) => p.magnetic).length;
  s += `<text class="legend" x="${px(L + 10)}" y="${px(T + 16)}">${points.length} reflections${nMag > 0 ? ` · ${nMag} magnetic` : ""}</text>`;
  return `<svg viewBox="0 0 ${S} ${S}" role="img" aria-label="Observed versus calculated structure-factor amplitudes">${s}</svg>`;
}

// ---------------------------------------------------------------------------
// Magnetic structure, projected down c*

interface Projected {
  readonly atom: CellAtom;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Cartesian moment (µ_B) or null. */
  readonly m: Vec3 | null;
}

/**
 * The magnetic (super)cell viewed down c* (a–b plane; a ∥ x, b in x–y by the
 * orthogonalization convention), with the moment arrows the 3D viewer shows:
 * the viewer's own expansion (`buildCellAtoms` / `displayMoment`), so the
 * figure is exactly the model the intensities were computed from. In-plane
 * components are arrows; a significant out-of-plane part gets a ⊙ / ⊗ marker.
 */
export function magneticProjectionSvg(
  structure: StructureModel,
  magnetic: MagneticModel,
  k: Vec3,
): { svg: string; subKeys: string[]; elements: string[] } {
  const entries = momentEntriesFrom(magnetic);
  const supercell = magneticSupercell(k);
  const atoms = buildCellAtoms(structure, supercell, magnetic.operations, entries);
  const momByKey = new Map(entries.map((e) => [e.key, e]));
  const subKeys = entries.map((e) => e.key);
  const elements = [...new Set(structure.sites.map((s) => s.element))];

  const pts: Projected[] = atoms.map((atom) => {
    const entry = atom.mag ? momByKey.get(atom.mag.momentKey) : undefined;
    const mc = entry ? displayMoment(atom, entry.components, k, entry.sinComponents) : null;
    return {
      atom,
      x: atom.xyz[0]!,
      y: atom.xyz[1]!,
      z: atom.xyz[2]!,
      m: mc ? crystalComponentsToCartesian(structure.cell, mc) : null,
    };
  });

  // Viewport: the projected supercell corners plus a margin.
  const corners: Vec3[] = [];
  for (const i of [0, supercell[0]]) for (const j of [0, supercell[1]]) for (const l of [0, supercell[2]]) {
    corners.push(fractionalToCartesian(structure.cell, [i, j, l]));
  }
  const M = 1.9;
  const xmin = Math.min(...corners.map((c) => c[0]!), ...pts.map((p) => p.x)) - M;
  const xmax = Math.max(...corners.map((c) => c[0]!), ...pts.map((p) => p.x)) + M;
  const ymin = Math.min(...corners.map((c) => c[1]!), ...pts.map((p) => p.y)) - M;
  const ymax = Math.max(...corners.map((c) => c[1]!), ...pts.map((p) => p.y)) + M;
  const S = Math.min(62, 760 / (xmax - xmin)); // px per Å, capped for huge cells
  const W = (xmax - xmin) * S;
  const H = (ymax - ymin) * S;
  const PX = (x: number): number => (x - xmin) * S;
  const PY = (y: number): number => H - (y - ymin) * S; // +y up

  let s = "";
  const line = (a: Vec3, b: Vec3, cls: string, w: number): void => {
    s += `<line x1="${px(PX(a[0]!))}" y1="${px(PY(a[1]!))}" x2="${px(PX(b[0]!))}" y2="${px(PY(b[1]!))}" class="${cls}" stroke-width="${w}"/>`;
  };

  // Cell wireframe, projected: the 12 supercell edges (c-direction edges thin —
  // they foreshorten under the down-c* view).
  const corner = (i: number, j: number, l: number): Vec3 =>
    fractionalToCartesian(structure.cell, [i * supercell[0], j * supercell[1], l * supercell[2]]);
  for (const l of [0, 1]) {
    line(corner(0, 0, l), corner(1, 0, l), "cell", l === 0 ? 1.6 : 1);
    line(corner(0, 0, l), corner(0, 1, l), "cell", l === 0 ? 1.6 : 1);
    line(corner(1, 0, l), corner(1, 1, l), "cell", l === 0 ? 1.6 : 1);
    line(corner(0, 1, l), corner(1, 1, l), "cell", l === 0 ? 1.6 : 1);
  }
  for (const i of [0, 1]) for (const j of [0, 1]) line(corner(i, j, 0), corner(i, j, 1), "cell", 0.8);

  // Exchange-network guide lines: magnetic atoms within 1.2× their minimum
  // pair distance (capped at 3.5 Å), same depth layer only.
  const magAtoms = pts.filter((p) => p.m);
  const zmid = (Math.min(...pts.map((p) => p.z)) + Math.max(...pts.map((p) => p.z))) / 2;
  let dmin = Infinity;
  for (let i = 0; i < magAtoms.length; i++) {
    for (let j = i + 1; j < magAtoms.length; j++) {
      const d = Math.hypot(magAtoms[i]!.x - magAtoms[j]!.x, magAtoms[i]!.y - magAtoms[j]!.y, magAtoms[i]!.z - magAtoms[j]!.z);
      if (d > 0.5 && d < dmin) dmin = d;
    }
  }
  const cutoff = Math.min(dmin * 1.2, 3.5);
  for (let i = 0; i < magAtoms.length; i++) {
    for (let j = i + 1; j < magAtoms.length; j++) {
      const a = magAtoms[i]!;
      const b = magAtoms[j]!;
      if ((a.z < zmid) !== (b.z < zmid)) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d > 0.5 && d < cutoff) line([a.x, a.y, 0], [b.x, b.y, 0], "bond", a.z < zmid ? 1.1 : 0.8);
    }
  }

  // Atoms: filled below the depth midplane, outlined above.
  const elColor = (el: string): string => ELEMENT_COLORS[Math.max(0, elements.indexOf(el)) % ELEMENT_COLORS.length]!;
  const drawAtoms = (filter: (p: Projected) => boolean): void => {
    for (const p of pts.filter(filter)) {
      const lo = p.z < zmid;
      const c = elColor(p.atom.element);
      const r = (p.m ? 9 : 8) * (lo ? 1 : 0.9);
      s += lo
        ? `<circle cx="${px(PX(p.x))}" cy="${px(PY(p.y))}" r="${r.toFixed(1)}" fill="${c}"/>`
        : `<circle cx="${px(PX(p.x))}" cy="${px(PY(p.y))}" r="${r.toFixed(1)}" fill="var(--panel)" stroke="${c}" stroke-width="1.8"/>`;
    }
  };
  drawAtoms((p) => !p.m);
  drawAtoms((p) => !!p.m);

  // Moment arrows (in-plane component), centred on the atom; out-of-plane
  // component as a ⊙ / ⊗ marker beside it.
  const AS = 13.5; // px per µ_B
  for (const p of pts) {
    if (!p.m) continue;
    const key = p.atom.mag!.momentKey;
    const color = SUBLATTICE_COLORS[Math.max(0, subKeys.indexOf(key)) % SUBLATTICE_COLORS.length]!;
    const [mx, my, mz] = p.m;
    const mag = Math.hypot(mx!, my!, mz!);
    const inPlane = Math.hypot(mx!, my!);
    const cx = PX(p.x);
    const cy = PY(p.y);
    if (mag < 1e-6) continue;
    if (inPlane > 0.05 * mag) {
      const len = inPlane * AS;
      const ux = mx! / inPlane;
      const uy = my! / inPlane;
      const x1 = cx - (ux * len) / 2;
      const y1 = cy + (uy * len) / 2;
      const x2 = cx + (ux * len) / 2;
      const y2 = cy - (uy * len) / 2;
      const hw = 4.6;
      const hl = 8.5;
      const bx = x2 - ux * hl;
      const by = y2 + uy * hl;
      s += `<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(bx)}" y2="${px(by)}" stroke="${color}" stroke-width="2.6"/>`;
      s += `<polygon points="${px(x2)},${px(y2)} ${px(bx - uy * hw)},${px(by - ux * hw)} ${px(bx + uy * hw)},${px(by + ux * hw)}" fill="${color}"/>`;
    }
    if (Math.abs(mz!) > 0.1 * mag) {
      // ⊙ (out of the page) / ⊗ (into the page), offset to the atom's side.
      const gx = cx + 12;
      const gy = cy - 12;
      s += `<circle cx="${px(gx)}" cy="${px(gy)}" r="5" fill="none" stroke="${color}" stroke-width="1.6"/>`;
      s += mz! > 0
        ? `<circle cx="${px(gx)}" cy="${px(gy)}" r="1.7" fill="${color}"/>`
        : `<path d="M ${px(gx - 3.2)} ${px(gy - 3.2)} l 6.4 6.4 m 0 -6.4 l -6.4 6.4" stroke="${color}" stroke-width="1.4"/>`;
    }
  }

  // a / b axes glyph, bottom-right corner.
  {
    const av = fractionalToCartesian(structure.cell, [1, 0, 0]);
    const bv = fractionalToCartesian(structure.cell, [0, 1, 0]);
    const ox = xmax - 2.6;
    const oy = ymin + 0.9;
    for (const [v, name] of [[av, "a"], [bv, "b"]] as const) {
      const nrm = Math.hypot(v[0]!, v[1]!);
      if (nrm < 1e-6) continue;
      const u = [v[0]! / nrm, v[1]! / nrm];
      const x2 = ox + u[0]! * 1.3;
      const y2 = oy + u[1]! * 1.3;
      line([ox, oy, 0], [x2, y2, 0], "axis", 1.6);
      s += `<circle cx="${px(PX(x2))}" cy="${px(PY(y2))}" r="2.1" class="axisdot"/>`;
      s += `<text x="${px(PX(x2) + u[0]! * 10 - 3)}" y="${px(PY(y2) - u[1]! * 12 + 4)}" class="lbl">${name}</text>`;
    }
  }

  return {
    svg: `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Projection of the magnetic structure down c-star with moment arrows">${s}</svg>`,
    subKeys,
    elements,
  };
}
