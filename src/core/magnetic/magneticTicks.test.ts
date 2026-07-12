import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { decomposeMagneticRepresentation } from "@/core/magnetic/irreps";
import { generateMagneticCandidates, littleGroup } from "@/core/magnetic/magneticGroups";
import { isotropySubgroup, type IrrepSelection } from "@/core/magnetic/isotropy";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { magneticPhaseTicks } from "@/visualization/reflectionTicks";

/**
 * Regression: a magnetic model built from the representation-analysis (irrep)
 * route must yield magnetic Bragg ticks exactly as the magnetic-space-group
 * route does. Guards against the "no magnetic ticks with irreps" class of bug at
 * the core level — both routes feed `magneticPhaseTicks` a model with nonzero
 * moments and a defined subgroup operation list.
 */
const iso = { kind: "isotropic", bIso: 0.3 } as const;
const k0: Vec3 = [0, 0, 0];
const P2M = ["x,y,z", "-x,y,-z", "-x,-y,-z", "x,-y,z"].map(parseSymmetryOperation);

const structure: StructureModel = {
  id: "t", name: "t",
  cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { operations: P2M },
  sites: [{ label: "M", element: "Mn", oxidationState: 2, position: [0.13, 0.27, 0.41], occupancy: 1, adp: iso }],
};

function tickCount(ops: SymmetryOperation[]): number {
  const build = buildMagneticModel(structure, k0, ["M"], ops, { moment: 2, tieSameSite: true });
  const amps: Record<string, number> = {};
  for (const p of build.params) amps[p.id] = p.value;
  const applied = applyMagneticMoments(build.magnetic, build.bindings, amps);
  return magneticPhaseTicks(structure, applied, 0.5, 6, (d) => d, { id: "m", label: "m", color: "#f0f" }).ticks.length;
}

describe("magnetic Bragg ticks — irrep route matches the MSG route", () => {
  const lg = littleGroup(P2M, k0);

  it("the MSG route produces magnetic ticks", () => {
    const cands = generateMagneticCandidates(lg);
    for (const c of cands.slice(0, 4)) expect(tickCount([...c.operations])).toBeGreaterThan(0);
  });

  it("every real irrep's isotropy subgroup produces magnetic ticks", () => {
    const dec = decomposeMagneticRepresentation(structure, k0, ["M"], lg);
    expect(dec.terms.length).toBeGreaterThan(0);
    for (const term of dec.terms) {
      const sel: IrrepSelection[] = [{ irrep: term.irrep }];
      const combo = isotropySubgroup(structure, k0, ["M"], lg, sel);
      if ("failure" in combo) continue;
      expect(tickCount([...combo.operations])).toBeGreaterThan(0);
    }
  });
});
