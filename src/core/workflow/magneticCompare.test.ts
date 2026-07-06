import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { generateMagneticCandidates } from "@/core/magnetic/magneticGroups";
import { compareMagneticCandidates } from "@/core/workflow/magneticCompare";
import { exampleMagnetic, buildMagneticDataset } from "@/examples/mn3gaMagnetic";

const P21M = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map(parseSymmetryOperation);

describe("magnetic candidate comparison (procedure steps 5–7)", () => {
  const ex = exampleMagnetic();
  // Observed data generated from the true P2₁'/m' model + moments.
  const dataset = buildMagneticDataset(ex);
  const candidates = generateMagneticCandidates(P21M);
  const fits = compareMagneticCandidates(ex.structure, candidates, dataset, {
    magneticSiteLabels: ["Mn1_0", "Mn2_1", "Mn3_2"],
    maxIterations: 40,
  });

  it("ranks every candidate and returns them best-first", () => {
    expect(fits.length).toBe(candidates.length);
    for (let i = 1; i < fits.length; i++) {
      expect(fits[i - 1]!.wR).toBeLessThanOrEqual(fits[i]!.wR + 1e-9);
    }
  });

  it("selects the correct magnetic group (a–c plane moments) as best fit", () => {
    const best = fits[0]!;
    // The winning candidate must allow moments (non-zero dof) and fit well.
    expect(best.momentDof).toBeGreaterThan(0);
    expect(best.wR).toBeLessThan(2);
    // Its unprimed set is {identity, inversion} → the P2₁'/m' solution.
    const unprimed = best.candidate.operations
      .filter((o) => (o.timeReversal ?? 1) === 1)
      .map((o) => o.xyz);
    expect(unprimed.some((s) => s.includes("-x,-y,-z"))).toBe(true);
  });

  it("recovers non-zero moments (exact magnitudes need constraints — see step 6)", () => {
    // With ~20 reflections and 3 correlated Mn sites the moment magnitudes are
    // underdetermined (a real degeneracy), so we assert only that the winning
    // group carries substantial ordered moments — motivating the moment-size
    // restraint in the constrained refinement step.
    const best = fits[0]!;
    for (const sm of best.siteMoments) {
      expect(sm.magnitude).toBeGreaterThan(1.0);
      expect(Number.isFinite(sm.magnitude)).toBe(true);
    }
  });

  it("a wrong candidate (moment-forbidding symmetry) fits worse", () => {
    const worst = fits[fits.length - 1]!;
    expect(worst.wR).toBeGreaterThan(fits[0]!.wR);
  });

  it("a moment-size restraint (step 6) yields physical magnitudes ~2.6 μB", () => {
    const restrained = compareMagneticCandidates(ex.structure, candidates, dataset, {
      magneticSiteLabels: ["Mn1_0", "Mn2_1", "Mn3_2"],
      maxIterations: 40,
      momentRestraint: { target: 2.6, weight: 5 },
    });
    const best = restrained[0]!;
    for (const sm of best.siteMoments) {
      expect(sm.magnitude).toBeGreaterThan(2.0);
      expect(sm.magnitude).toBeLessThan(3.3);
    }
    // The restraint still lets the correct group win.
    expect(best.wR).toBeLessThan(5);
  });
});
