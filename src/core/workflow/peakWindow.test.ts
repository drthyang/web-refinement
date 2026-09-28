import { describe, it, expect } from "vitest";
import { buildPeaks, buildPowderProblem } from "@/core/workflow/powder";
import { applyParameters } from "@/core/workflow/apply";
import { resolveTies } from "@/core/refinement/constraints";
import { PEAK_WINDOW_FWHM } from "@/core/diffraction/profile";
import { buildPowderSpec } from "@/app/powderSpec";
import { exampleStructure } from "@/examples/mn3ga";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * Finite-difference width columns across a peak's support edge.
 *
 * Each peak is evaluated only inside ±PEAK_WINDOW_FWHM·Γ, and that edge moves
 * with every width parameter. With a hard cutoff, a data point crossing the
 * edge made y jump by the Lorentzian tail value, and a central difference
 * divided that jump by 2h: the column spiked ∝ 1/h at that one point. On the
 * Mn₃Ga 30 K example the profW column at the engine's step gave JᵀJ ≈ 219
 * instead of ≈ 8.7, 91 % of it from one point, and profW's esd came out ~5×
 * too small. Here a data point sits exactly on the strongest peak's edge, so
 * every step, however small, crosses it.
 */
describe("width columns across the peak-support edge", () => {
  const structure = exampleStructure();
  // Caglioti U,V,W plus a TCH Lorentzian (X,Y): a pseudo-Voigt with real tails.
  const inst = { kind: "constantWavelength" as const, wavelength: 1.54, radiationKind: "neutron" as const, u: 60, v: -12, w: 230, x: 8, y: 2 };
  const STEP = 80 / 1199;

  function patternOn(grid: readonly number[]): PowderPattern {
    return {
      id: "p", name: "edge", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 },
      points: grid.map((x) => ({ x, yObs: 100, sigma: 10 })),
    };
  }

  /** The strongest peak's upper support edge, where synthesizePattern puts it. */
  function strongestEdge(pattern: PowderPattern): number {
    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.id] = p.value;
    const peaks = buildPeaks(pattern, applyParameters(structure, spec.bindings, resolveTies(spec.params, values)));
    const top = peaks.reduce((a, b) => (b.intensity > a.intensity ? b : a));
    expect(top.eta ?? 0).toBeGreaterThan(0.2); // a real Lorentzian component
    return top.center + PEAK_WINDOW_FWHM * top.fwhm;
  }

  it("the profW column is the same at every step size, and zero at the edge point", () => {
    const provisional = Array.from({ length: 1200 }, (_, i) => 10 + i * STEP);
    const edge = strongestEdge(patternOn(provisional));
    // Re-lay the grid so that one point sits exactly on that edge.
    const k = Math.round((edge - 10) / STEP);
    const grid = Array.from({ length: 1200 }, (_, i) => (i === k ? edge : edge + (i - k) * STEP));
    const pattern = patternOn(grid);
    expect(strongestEdge(pattern)).toBe(grid[k]); // the shifted grid still places that peak there

    const spec = buildPowderSpec(structure, pattern, inst, true, 3, {});
    const params = spec.params.map((p) => ({ ...p, value: p.kind === "scale" ? 4 : p.value, fixed: p.kind !== "profileW" }));
    const problem = buildPowderProblem(structure, pattern, params, spec.bindings, spec.profile);
    const w = params.find((p) => p.kind === "profileW")!;
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;

    // Central differences from 10⁻³·|W| down to 10⁻⁷·|W| (the engine uses 10⁻⁵).
    const columns = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7].map((rel) => {
      const h = Math.abs(w.value) * rel;
      const yF = problem.calculate({ ...values, [w.id]: w.value + h });
      const yB = problem.calculate({ ...values, [w.id]: w.value - h });
      let jtj = 0;
      for (let i = 0; i < grid.length; i++) {
        const c = (yF[i]! - yB[i]!) / (2 * h);
        jtj += problem.weights[i]! * c * c;
      }
      const cEdge = (yF[k]! - yB[k]!) / (2 * h);
      return { rel, jtj, edgeShare: (problem.weights[k]! * cEdge * cEdge) / jtj };
    });
    const ref = columns[0]!.jtj;
    expect(ref).toBeGreaterThan(0);
    for (const c of columns) {
      // With a hard cutoff, JᵀJ grew ∝ 1/h² (7·10⁶× too large at 10⁻⁷) and the
      // edge point held 6 % → 99.99999 % of it. Now that point carries only
      // the other peaks' share (~2·10⁻⁸).
      expect(Math.abs(c.jtj / ref - 1), `JᵀJ at h = ${c.rel}·|W|`).toBeLessThan(1e-5);
      expect(c.edgeShare, `edge point's share of JᵀJ at h = ${c.rel}·|W|`).toBeLessThan(1e-6);
    }
  });
});
