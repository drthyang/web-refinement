import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import { exampleStructure } from "@/examples/mn3ga";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";

/**
 * The Rietveld obs/calc decomposition must return I_obs = I_calc when the
 * observed pattern IS the calculated one (a perfect fit) — the sanity floor for
 * an F_obs vs F_calc plot.
 */
describe("powderReflectionObsCalc (Rietveld decomposition)", () => {
  const structure = exampleStructure();
  const grid = Array.from({ length: 1400 }, (_, i) => 10 + (i * (120 - 10)) / 1399);
  const profile: PowderProfile = { shape: "gaussian" };
  const empty: PowderPattern = {
    id: "pat", name: "p", xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: 1.54 }, wavelength: 1.54,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const spec = buildStructureRefinement(structure, empty, {
    scale: 100, backgroundTerms: 2, width: 0.3, refineAdp: false, refinePositions: false,
  });
  const curves = powderCurves(structure, empty, spec.params, spec.bindings, profile);
  const pat: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: curves.yCalc[i] ?? 0 })) };

  it("recovers per-reflection I_obs ≈ I_calc for a self-consistent pattern", () => {
    const rows = powderReflectionObsCalc(structure, pat, spec.params, spec.bindings, profile);
    expect(rows.length).toBeGreaterThan(3);

    // Total intensity is conserved by the decomposition (obs = calc here).
    const sumObs = rows.reduce((a, r) => a + r.iObs, 0);
    const sumCalc = rows.reduce((a, r) => a + r.iCalc, 0);
    expect(Math.abs(sumObs / sumCalc - 1)).toBeLessThan(0.02);

    // The strongest, well-separated reflection matches closely.
    const strongest = rows.reduce((a, r) => (r.iCalc > a.iCalc ? r : a), rows[0]!);
    expect(Math.abs(strongest.iObs / strongest.iCalc - 1)).toBeLessThan(0.05);
  });
});
