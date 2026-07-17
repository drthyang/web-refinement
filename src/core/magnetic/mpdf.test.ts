import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import {
  computeNormalizedMpdf,
  enumerateSpinPairs,
  averageMomentSq,
  netMomentPerSpin,
  mpdfExtendedGrid,
  MPDF_GRID_EXTENSION,
  type MpdfSpin,
} from "@/core/magnetic/mpdf";

// a = b = 6 ≠ 4 = c/2 so the 4 Å AFM bond along c is the ONLY pair at 4 Å —
// with a = 4 the in-plane same-sublattice neighbours land on the same distance
// and their positive transverse correlation cancels the AFM peak.
const CELL: UnitCell = { a: 6, b: 6, c: 8, alpha: 90, beta: 90, gamma: 90 };
/** AFM stacking along c: +m at z=0, −m at z=½ (nearest inter-spin distance 4 Å). */
const AFM: MpdfSpin[] = [
  { position: [0, 0, 0], moment: [3, 0, 0] },
  { position: [0, 0, 0.5], moment: [-3, 0, 0] },
];
const FM: MpdfSpin[] = [
  { position: [0, 0, 0], moment: [3, 0, 0] },
  { position: [0, 0, 0.5], moment: [3, 0, 0] },
];

const GRID = mpdfExtendedGrid(12, 0.02);
const at = (r: number): number => Math.round(r / 0.02);

describe("mPDF kernel physics", () => {
  it("extended grid spans 0 … rMax + extension", () => {
    expect(GRID[0]).toBe(0);
    expect(GRID[GRID.length - 1]!).toBeCloseTo(12 + MPDF_GRID_EXTENSION, 9);
  });

  it("an AFM nearest-neighbour pair with transverse moments gives a NEGATIVE peak", () => {
    // Bond along c, moments along a ⇒ fully transverse: A_ij = −|m|² < 0.
    const f = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.1 });
    expect(f[at(4)]!).toBeLessThan(0);
    // The same-sublattice neighbour at 8 Å (parallel moments) is positive.
    expect(f[at(8)]!).toBeGreaterThan(0);
  });

  it("the FM case flips the 4 Å correlation positive", () => {
    const f = computeNormalizedMpdf(CELL, FM, GRID, { psigma: 0.1 });
    expect(f[at(4)]!).toBeGreaterThan(0);
  });

  it("the FM net-moment line keeps f(r) oscillating about zero (AFM unaffected)", () => {
    // Without the −4πrρ₀m̄² term a ferromagnet's baseline grows linearly; with
    // it the mean over several periods stays near zero.
    const f = computeNormalizedMpdf(CELL, FM, GRID, { psigma: 0.1 });
    const i0 = at(2);
    const i1 = at(14);
    let mean = 0;
    let scale = 0;
    for (let k = i0; k < i1; k++) {
      mean += f[k]!;
      scale = Math.max(scale, Math.abs(f[k]!));
    }
    mean /= i1 - i0;
    expect(Math.abs(mean)).toBeLessThan(0.05 * scale);
    expect(netMomentPerSpin(FM)).toBeCloseTo(3, 12);
    expect(netMomentPerSpin(AFM)).toBe(0);
    expect(averageMomentSq(AFM)).toBeCloseTo(9, 12);
  });

  it("ordScale is a pure multiplier and corrLength damps high r", () => {
    const f1 = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.1 });
    const f2 = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.1, ordScale: 2.5 });
    for (let k = 0; k < GRID.length; k += 37) expect(f2[k]!).toBeCloseTo(2.5 * f1[k]!, 10);
    const damped = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.1, corrLength: 3 });
    expect(Math.abs(damped[at(12)]!)).toBeLessThan(Math.abs(f1[at(12)]!) * 0.1);
    expect(damped[at(4)]! / f1[at(4)]!).toBeCloseTo(Math.exp(-4 / 3), 6);
  });

  it("a precomputed spin-pair list is bit-identical to inline enumeration", () => {
    const pairs = enumerateSpinPairs(CELL, AFM.map((s) => s.position), GRID[GRID.length - 1]! + 0.01);
    const a = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.1, qdamp: 0.02 });
    const b = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.1, qdamp: 0.02 }, pairs);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("collinear moments ALONG the bond contribute only baseline (A_ij = 0)", () => {
    // Moments parallel to c and the 4 Å bond along c: transverse part is zero,
    // so no δ peak at 4 Å — only the smooth B_ij baseline (no sharp feature).
    const longitudinal: MpdfSpin[] = [
      { position: [0, 0, 0], moment: [0, 0, 3] },
      { position: [0, 0, 0.5], moment: [0, 0, -3] },
    ];
    const f = computeNormalizedMpdf(CELL, longitudinal, GRID, { psigma: 0.05 });
    const transverse = computeNormalizedMpdf(CELL, AFM, GRID, { psigma: 0.05 });
    // The transverse config has a deep sharp peak at 4 Å; the longitudinal one
    // must be far smaller there (baseline only).
    expect(Math.abs(f[at(4)]!)).toBeLessThan(0.2 * Math.abs(transverse[at(4)]!));
  });
});
