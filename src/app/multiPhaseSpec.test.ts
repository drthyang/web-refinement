import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { RefinementParameter } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { exampleStructure } from "@/examples/mn3ga";
import { buildSyntheticPowder } from "@/examples/synthetic";
import { buildMultiPhaseSpec, type MultiPhaseSpec } from "@/app/multiPhaseSpec";
import { multiPhaseCurves } from "@/core/workflow/multiPhase";

// Second phase: rock-salt MnO (F-centred cubic, reduced op set for the test).
const mno: StructureModel = {
  id: "mno", name: "MnO",
  cell: { a: 4.450147, b: 4.450147, c: 4.450147, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: {
    operations: ["x,y,z", "x,1/2+y,1/2+z", "1/2+x,y,1/2+z", "1/2+x,1/2+y,z"].map(parseSymmetryOperation),
  },
  sites: [
    { label: "Mn", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
    { label: "O", element: "O", position: [0.5, 0.5, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
  ],
};

const structure = exampleStructure();
const pattern = buildSyntheticPowder(structure);
// Caglioti (pseudo-Voigt) CW instrument so the anisotropic-microstructure
// models (Stephens / uniaxial Mustrain) are emitted.
const inst: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54, u: -46, v: 0, w: 1.2, x: 0.1, zero: 0 };

/** yCalc with per-id value overrides applied on top of the spec's parameters. */
function yCalcWith(spec: MultiPhaseSpec, overrides: Readonly<Record<string, number>>): number[] {
  const params: RefinementParameter[] = spec.params.map((p) =>
    overrides[p.id] !== undefined ? { ...p, value: overrides[p.id]! } : p,
  );
  return multiPhaseCurves(spec.phases, pattern, params, spec.bindings, spec.profile).yCalc;
}

const maxAbsDiff = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? 0))), 0);

// Regression: buildMultiPhaseSpec used to re-bind only the *scale* from the
// pattern to the phase id. Every other non-shared pattern-targeted binding
// (Stephens strain, uniaxial size/mustrain, per-phase corrections) kept the
// pattern id, which phaseBindingsFor routes to NO phase — the parameters showed
// up in the UI but had exactly zero effect on the calculated pattern.
describe("buildMultiPhaseSpec — per-phase pattern-targeted bindings", () => {
  it("binds every per-phase parameter to its own phase id (none left on the pattern)", () => {
    const spec = buildMultiPhaseSpec([structure, mno], pattern, inst, 4, {}, "generalized");
    spec.phases.forEach((phase, i) => {
      const phaseBindings = spec.bindings.filter((b) => b.parameterId.startsWith(`p${i}_`));
      expect(phaseBindings.length).toBeGreaterThan(0);
      for (const b of phaseBindings) expect(b.targetId).toBe(phase.id);
    });
  });

  it("perturbing a phase's Stephens strain parameters changes the multi-phase pattern", () => {
    const spec = buildMultiPhaseSpec([structure, mno], pattern, inst, 4, {}, "generalized");
    const base = yCalcWith(spec, {});
    spec.phases.forEach((_, i) => {
      const stephens = spec.params.filter((p) => p.kind === "stephensStrain" && p.id.startsWith(`p${i}_`));
      expect(stephens.length).toBeGreaterThan(0);
      const perturbed = yCalcWith(spec, Object.fromEntries(stephens.map((p) => [p.id, 5000])));
      expect(maxAbsDiff(perturbed, base)).toBeGreaterThan(1);
    });
  });

  it("perturbing a phase's uniaxial mustrain parameters changes the multi-phase pattern", () => {
    const spec = buildMultiPhaseSpec([structure, mno], pattern, inst, 4, {}, "uniaxial");
    const base = yCalcWith(spec, {});
    const mustrain = spec.params.filter(
      (p) => (p.kind === "mustrainPerp" || p.kind === "mustrainPar") && p.id.startsWith("p0_"),
    );
    expect(mustrain.length).toBe(2);
    const perturbed = yCalcWith(spec, Object.fromEntries(mustrain.map((p) => [p.id, 50])));
    expect(maxAbsDiff(perturbed, base)).toBeGreaterThan(1);
  });
});
