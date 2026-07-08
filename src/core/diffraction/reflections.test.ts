import { describe, it, expect } from "vitest";
import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { generateReflections } from "@/core/diffraction/reflections";

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

  it("stays bounded (does not hang) for an unreasonably large cell edge", () => {
    // A typo'd or diverged cell value must not blow the Miller loop up to an
    // astronomical size — the nMax cap keeps it fast and finite.
    const huge: UnitCell = { ...cell, a: 5000, b: 5000 };
    const t0 = Date.now();
    const out = generateReflections(huge, sg, 0.5, 6.0);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(12000);
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
