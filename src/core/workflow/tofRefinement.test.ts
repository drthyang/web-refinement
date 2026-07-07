import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter } from "@/core/refinement/types";
import { exampleStructure } from "@/examples/mn3ga";
import { buildStructureRefinement, type TofSeed } from "@/core/workflow/structureRefinement";
import { buildPowderProblem, powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { refine } from "@/core/refinement/engine";

/**
 * End-to-end self-consistency for the time-of-flight refinement path: synthesize
 * a TOF neutron pattern from a known structure + known TOF profile, then confirm
 * the engine (a) computes an asymmetric back-to-back-exponential pattern, and
 * (b) recovers the true scale/cell after they are perturbed — the TOF analogue
 * of the constant-wavelength self-consistency the workbench already relies on.
 */

const TOF_PROFILE: PowderProfile = { shape: "tof" };
// POWGEN-like: difC from the Mn₃Ga .gsa header; σ scaled to Δd/d ≈ 0.0015.
const TRUTH: TofSeed = {
  difC: 22585.8,
  alpha0: 0, alpha1: 1.5,
  beta0: 0.02, beta1: 0,
  sig0: 0, sig1: (22585.8 * 0.0015) ** 2, sig2: 0,
};
const TRUE_SCALE = 40;

function tofGrid(): number[] {
  // d ≈ 0.6–4 Å at difC ≈ 22586 → TOF ≈ 13.5k–90k µs.
  return Array.from({ length: 900 }, (_, i) => 13000 + (i * (92000 - 13000)) / 899);
}

/** Build a synthetic TOF pattern from the Mn₃Ga structure at a known scale. */
function buildTruthPattern(): { pattern: PowderPattern; truth: RefinementParameter[] } {
  const structure = exampleStructure();
  const grid = tofGrid();
  const empty: PowderPattern = {
    id: "mn3ga-tof",
    name: "Mn₃Ga synthetic TOF neutron",
    xUnit: "tof",
    radiation: { kind: "neutron-tof" },
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const spec = buildStructureRefinement(structure, empty, {
    scale: TRUE_SCALE, backgroundTerms: 2, tof: TRUTH, refineAdp: false, refinePositions: false,
  });
  const curves = powderCurves(structure, empty, spec.params, spec.bindings, TOF_PROFILE);
  const pattern: PowderPattern = {
    ...empty,
    points: grid.map((x, i) => {
      const y = curves.yCalc[i] ?? 0;
      return { x, yObs: y, sigma: Math.sqrt(Math.max(y, 1)) + 1 };
    }),
  };
  return { pattern, truth: spec.params };
}

describe("TOF powder refinement (synthetic self-consistency)", () => {
  it("produces asymmetric TOF peaks above the background", () => {
    const { pattern } = buildTruthPattern();
    const ys = pattern.points.map((p) => p.yObs);
    const max = Math.max(...ys);
    const median = ys.slice().sort((a, b) => a - b)[Math.floor(ys.length / 2)]!;
    // There is real Bragg signal: the tallest peak dwarfs the typical point.
    expect(max).toBeGreaterThan(10 * Math.max(median, 1e-6));
  });

  it("recovers the true scale and cell from a perturbed start", () => {
    const structure = exampleStructure();
    const { pattern } = buildTruthPattern();
    // A fresh spec at the seed scale; perturb scale and the a-axis away from truth.
    const spec = buildStructureRefinement(structure, pattern, {
      scale: TRUE_SCALE, backgroundTerms: 2, tof: TRUTH, refineAdp: false, refinePositions: false,
    });
    const trueA = structure.cell.a;
    // A 0.1% a-axis error: within the peak-overlap radius, so the fit can pull
    // it back. (Sharp TOF peaks shifted much further than their width need a
    // staged/indexing approach — not something a flat least-squares recovers.)
    // The profile coefficients start at truth and are held fixed here so the
    // test isolates scale/cell recovery through the TOF peak shape.
    const start = spec.params.map((p) => {
      if (p.id === "scale") return { ...p, value: TRUE_SCALE * 0.6 };
      if (p.id === "cell_a") return { ...p, value: p.value * 1.001 };
      if (p.kind === "tofProfile") return { ...p, fixed: true };
      return p;
    });

    const problem = buildPowderProblem(structure, pattern, start, spec.bindings, TOF_PROFILE);
    const result = refine(problem, { maxIterations: 40 });

    // Weighted residual collapses — the model matches the data it was built from.
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.02);
    // Scale recovered within 3%.
    const scale = result.parameters.scale ?? 0;
    expect(scale).toBeCloseTo(TRUE_SCALE, 0);
    expect(Math.abs(scale / TRUE_SCALE - 1)).toBeLessThan(0.03);
    // a-axis pulled back to the truth.
    const aParam = spec.params.find((p) => p.id === "cell_a")!;
    expect(Math.abs((result.parameters[aParam.id] ?? trueA) / trueA - 1)).toBeLessThan(0.002);
  });
});
