import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import { leBailExtract } from "@/core/workflow/leBail";
import { exampleStructure } from "@/examples/mn3ga";
import { powderCurves } from "@/core/workflow/powder";
import { powderParameters, powderBindings } from "@/examples/synthetic";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { gaussian } from "@/core/diffraction/profile";

const neutron = { kind: "neutron" as const, wavelength: 1.54 };

describe("Le Bail intensity extraction", () => {
  const structure = exampleStructure();
  // Synthesize an observed pattern from the real structure (known peaks).
  const grid = Array.from({ length: 600 }, (_, i) => 15 + (i * 90) / 600);
  const empty: PowderPattern = { id: "p", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points: grid.map((x) => ({ x, yObs: 0 })) };
  const curves = powderCurves(structure, empty, powderParameters(structure, 80), powderBindings(structure, "p"));
  const obs: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: curves.yCalc[i]! })) };

  const result = leBailExtract(obs, structure.cell, structure.spaceGroup, { fwhm: 0.5, cycles: 12 });

  it("extracts a non-empty set of reflection intensities", () => {
    expect(result.reflections.length).toBeGreaterThan(5);
    expect(result.reflections.every((r) => r.intensity >= 0)).toBe(true);
  });

  it("reproduces the observed pattern (fit reconstructs the data)", () => {
    let num = 0, den = 0;
    for (let i = 0; i < result.yObs.length; i++) {
      num += Math.abs(result.yObs[i]! - result.yCalc[i]!);
      den += Math.abs(result.yObs[i]!);
    }
    expect(num / den).toBeLessThan(0.05);
  });

  it("gives the strongest extracted reflection substantial intensity", () => {
    const maxI = Math.max(...result.reflections.map((r) => r.intensity));
    expect(maxI).toBeGreaterThan(0);
  });

  it("is continuous in the width as a support edge crosses a data point", () => {
    // The cell prefit refines the Le Bail FWHM by finite differences, and each
    // reflection's support (±12 FWHM) moves with it. Pick the width that puts
    // the strongest reflection's edge exactly on a grid point, then step across.
    const top = result.reflections.reduce((a, b) => (b.intensity > a.intensity ? b : a));
    const j = grid.findIndex((x) => x > top.center + 6);
    const fwhm = (grid[j]! - top.center) / 12;
    const run = (f: number) => leBailExtract(obs, structure.cell, structure.spaceGroup, { fwhm: f, shape: "pseudoVoigt", eta: 0.5, cycles: 12 }).yCalc;
    const [lo, hi] = [run(fwhm * (1 - 1e-9)), run(fwhm * (1 + 1e-9))];
    const peak = Math.max(...hi);
    // A hard cutoff jumped by up to 7·10⁻⁴ of the peak (the tail there, and every norm_k).
    for (let i = 0; i < grid.length; i++) expect(Math.abs(hi[i]! - lo[i]!) / peak, `point ${i}`).toBeLessThan(1e-7);
  });

  it("gives an isolated peak on a high background its whole net area in one cycle", () => {
    // One reflection (100 of a P1 cell whose b and c are too short to put any
    // other line in the window) of 500 counts on a background of 1000. The partition divides the net counts by the net calculation; when
    // it divided by the gross one, each cycle grew the intensity only by the
    // peak-to-background ratio, from a start of 1.
    const spaceGroup = { operations: [parseSymmetryOperation("x,y,z")] };
    const cell = { a: 4, b: 2.5, c: 2.5, alpha: 90, beta: 90, gamma: 90 };
    const center = (2 * Math.asin(1.54 / 8) * 180) / Math.PI;
    const x = Array.from({ length: 400 }, (_, i) => 18 + (i * 8) / 400);
    const g = x.map((xi) => gaussian(xi, center, 0.2));
    const sum = g.reduce((a, b) => a + b, 0);
    const pattern: PowderPattern = { id: "p", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points: x.map((xi, i) => ({ x: xi, yObs: 1000 + (500 * g[i]!) / sum })) };
    const lb = leBailExtract(pattern, cell, spaceGroup, { fwhm: 0.2, shape: "gaussian", background: 1000, cycles: 1 });
    expect(lb.reflections.length).toBe(1);
    expect(lb.reflections[0]!.intensity).toBeCloseTo(500, 0);
  });
});
