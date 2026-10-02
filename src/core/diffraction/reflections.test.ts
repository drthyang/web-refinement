import { describe, it, expect } from "vitest";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { generateReflections, ReflectionLimitError } from "@/core/diffraction/reflections";
import { reciprocalTensorA } from "@/core/crystal/unitCell";

const P63MMC_XYZ = [
  "x,y,z", "x-y,x,1/2+z", "-y,x-y,z", "-x,-y,1/2+z", "y-x,-x,z", "y,y-x,1/2+z",
  "y-x,y,z", "-x,y-x,1/2+z", "-y,-x,z", "x-y,-y,1/2+z", "x,x-y,z", "y,x,1/2+z",
  "-x,-y,-z", "y-x,-x,1/2-z", "y,y-x,-z", "x,y,1/2-z", "x-y,x,-z", "-y,x-y,1/2-z",
  "x-y,-y,-z", "x,x-y,1/2-z", "y,x,-z", "y-x,y,1/2-z", "-x,y-x,-z", "-y,-x,1/2-z",
];
const cell: UnitCell = { a: 5.413171, b: 5.413171, c: 4.364621, alpha: 90, beta: 90, gamma: 120 };
const sg: SpaceGroup = { operations: P63MMC_XYZ.map(parseSymmetryOperation) };
const refl = generateReflections(cell, sg, 1.0, 6.0);

describe("reflection generation (P6₃/mmc)", () => {
  it("returns a non-empty list sorted by decreasing d-spacing", () => {
    expect(refl.length).toBeGreaterThan(5);
    for (let i = 1; i < refl.length; i++) {
      expect(refl[i - 1]!.d).toBeGreaterThanOrEqual(refl[i]!.d - 1e-9);
    }
  });

  it("fails fast with a clear error for an unreasonably large cell edge (no silent truncation)", () => {
    // A typo'd or diverged cell value must not blow the Miller loop up to an
    // astronomical size — nor return a truncated list that looks valid.
    const huge: UnitCell = { ...cell, a: 5000, b: 5000 };
    const t0 = Date.now();
    expect(() => generateReflections(huge, sg, 0.5, 6.0)).toThrow(ReflectionLimitError);
    expect(() => generateReflections(huge, sg, 0.5, 6.0)).toThrow(/a = 5000.*Check the cell, or raise d_min/);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("excludes the 6₃ screw-absent (0 0 1) but keeps (0 0 2)", () => {
    const has001 = refl.some((r) => Math.abs(r.d - cell.c) < 1e-3);
    expect(has001).toBe(false);
    const has002 = refl.some((r) => Math.abs(r.d - cell.c / 2) < 1e-3);
    expect(has002).toBe(true);
  });

  it("assigns (0 0 2) multiplicity 2 and (1 0 0) multiplicity 6", () => {
    const r002 = refl.find((r) => Math.abs(r.d - cell.c / 2) < 1e-3);
    expect(r002?.multiplicity).toBe(2);
    const d100 = (cell.a * Math.sqrt(3)) / 2; // hexagonal d(100)
    const r100 = refl.find((r) => Math.abs(r.d - d100) < 1e-3);
    expect(r100?.multiplicity).toBe(6);
  });
});

/** Every (hkl) with dMin ≤ d ≤ dMax, by brute force over a generous box. */
function bruteForceCount(c: UnitCell, dMin: number, dMax: number, n: number): number {
  const A = reciprocalTensorA(c);
  let count = 0;
  for (let h = -n; h <= n; h++) {
    for (let k = -n; k <= n; k++) {
      for (let l = -n; l <= n; l++) {
        if (h === 0 && k === 0 && l === 0) continue;
        const inv = A.a11 * h * h + A.a22 * k * k + A.a33 * l * l + A.a12 * h * k + A.a13 * h * l + A.a23 * k * l;
        if (inv >= 1 / (dMax * dMax) && inv <= 1 / (dMin * dMin)) count++;
      }
    }
  }
  return count;
}

describe("reflection generation is complete (never truncated)", () => {
  const p1: SpaceGroup = { operations: [parseSymmetryOperation("x,y,z")] };

  it("returns every family of a large low-symmetry cell, beyond the old 12000 cap", () => {
    // P1, 15 × 16 × 17 Å: ≈ 33 000 (hkl) to d = 0.8 Å, i.e. ≈ 16 700 Friedel
    // pairs — the old loop stopped at 12000 in loop order (low h first), so the
    // list silently lacked every reflection with large positive h.
    const big: UnitCell = { a: 15, b: 16, c: 17, alpha: 90, beta: 90, gamma: 90 };
    const out = generateReflections(big, p1, 0.8, 20);
    expect(out.length).toBeGreaterThan(12000);
    const total = out.reduce((n, r) => n + r.multiplicity, 0);
    expect(total).toBe(bruteForceCount(big, 0.8, 20, 22));
    expect(Math.max(...out.map((r) => r.h))).toBe(18); // ⌊15/0.8⌋
    expect(out[out.length - 1]!.d).toBeGreaterThanOrEqual(0.8);
  });

  it("uses exact per-axis index bounds — an oblique triclinic cell is enumerated completely", () => {
    const tri: UnitCell = { a: 4.1, b: 6.3, c: 7.7, alpha: 63, beta: 71, gamma: 82 };
    const out = generateReflections(tri, p1, 0.7, 10);
    const total = out.reduce((n, r) => n + r.multiplicity, 0);
    expect(total).toBe(bruteForceCount(tri, 0.7, 10, 16));
  });
});
