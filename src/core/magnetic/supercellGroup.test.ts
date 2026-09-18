import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
import { expandMagneticSupercell, expandSpinField, type SupercellAtom } from "@/core/crystal/cellExpansion";
import { magneticCellGroup } from "@/core/magnetic/supercellGroup";
import { magneticStructureToMcif } from "@/core/export/cif";
import { parseCif, parseMagneticCif } from "@/parsers/cif";
import { HIGH_ENTROPY_CIF } from "@/examples/highEntropyWO4";
import { magneticIonCandidates } from "@/core/magnetic/magneticIons";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
const INV = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]] as const;

/** Multiset key of an expanded atom: kind, position, moment (all rounded). */
const atomKey = (a: SupercellAtom): string => {
  const r = (v: number): string => (Math.abs(v) < 5e-4 ? "0.000" : v.toFixed(3));
  const p = a.site.position.map(r).join(",");
  const m = (a.moment ?? [0, 0, 0]).map(r).join(",");
  return `${a.site.element}|${p}|${m}`;
};
const multiset = (atoms: readonly SupercellAtom[]): string[] => atoms.map(atomKey).sort();

describe("magneticCellGroup — the Shubnikov group of an explicit magnetic supercell", () => {
  const afm: StructureModel = {
    id: "afm", name: "AFM chain",
    cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: {
      number: 2, hermannMauguin: "P -1",
      operations: [
        { rotation: I3, translation: [0, 0, 0], xyz: "x,y,z" },
        { rotation: INV, translation: [0, 0, 0], xyz: "-x,-y,-z" },
      ],
    },
    sites: [{ label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }],
  };
  const model: MagneticModel = {
    id: "m", structureId: "afm", propagation: [[0, 0, 0.5]],
    operations: [
      { rotation: I3, translation: [0, 0, 0], xyz: "x,y,z", timeReversal: 1 },
      { rotation: INV, translation: [0, 0, 0], xyz: "-x,-y,-z", timeReversal: 1 },
    ],
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [0, 0, 3] }],
  };

  it("finds the anti-translation of a k = (0,0,½) antiferromagnet and reduces the cell to one atom", () => {
    const sup = expandMagneticSupercell(afm, model)!;
    expect(sup.n).toEqual([1, 1, 2]);
    const g = magneticCellGroup(afm, sup);
    // Parent translation c flips the moment → (x,y,z+½)' ; inversion keeps it (axial).
    expect(g.operations).toHaveLength(4);
    expect(g.centerings).toHaveLength(2);
    expect(g.hasAntiTranslations).toBe(true);
    const anti = g.centerings.find((c) => c.timeReversal === -1)!;
    expect(anti.translation).toEqual([0, 0, 0.5]);
    expect(g.representatives).toHaveLength(2);
    expect(g.asymmetricUnit).toHaveLength(1);
    expect(g.multiplicities).toEqual([2]);
  });

  it("does not admit a translation that changes the moments in any other way (k = ⅓ sinusoid)", () => {
    const third: MagneticModel = { ...model, propagation: [[0, 0, 1 / 3]] };
    const sup = expandMagneticSupercell(afm, third)!;
    expect(sup.n).toEqual([1, 1, 3]);
    const g = magneticCellGroup(afm, sup);
    // Translations by c rotate the phase by 120°: neither pure nor anti symmetry.
    expect(g.centerings).toHaveLength(1);
    expect(g.hasAntiTranslations).toBe(false);
    // Inversion (θ = +1) survives: it maps layer L → −L ≡ 3−L with cos(2πL/3) even.
    expect(g.operations.length).toBeGreaterThanOrEqual(2);
    // Everything the group claims is a genuine symmetry: the asymmetric unit
    // re-expands to the full atom set.
    const reduced: StructureModel = { ...afm, cell: sup.cell, sites: g.asymmetricUnit.map((a) => a.site), spaceGroup: { operations: g.operations } };
    const mag: MagneticModel = {
      ...third, propagation: [[0, 0, 0]], operations: g.operations,
      moments: g.asymmetricUnit.filter((a) => a.moment).map((a) => ({ siteLabel: a.site.label, frame: "crystallographic" as const, components: a.moment! })),
    };
    expect(multiset(expandSpinField(reduced, mag).atoms)).toEqual(multiset(sup.atoms));
  });
});

describe("mCIF of a k ≠ 0 structure is written in the magnetic cell's own group and round-trips", () => {
  it("AWO₄ (P2/c, k = ½ 0 0): 4 representatives × 2 centerings, 9-site asymmetric unit, identical re-expansion", () => {
    const structure = parseCif(HIGH_ENTROPY_CIF, "awo4");
    const ions = magneticIonCandidates(structure).map((i) => i.siteLabel);
    const k: Vec3 = [0.5, 0, 0];
    const reps = latticeRepresentatives(magneticSubgroupLattice(structure.spaceGroup.operations, k));
    const rep = reps.find((r) => buildMagneticModel(structure, k, ions, [...r.candidate.operations], { moment: 2, tieSameSite: true }).params.length > 0)!;
    const build = buildMagneticModel(structure, k, ions, [...rep.candidate.operations], { moment: 2, tieSameSite: true });
    const values = Object.fromEntries(build.params.map((p, i) => [p.id, 1.2 + 0.4 * i]));
    const magnetic = applyMagneticMoments(build.magnetic, build.bindings, values);

    const sup = expandMagneticSupercell(structure, magnetic)!;
    expect(sup.n).toEqual([2, 1, 1]);
    const g = magneticCellGroup(structure, sup);
    expect(structure.spaceGroup.operations).toHaveLength(4);
    expect(g.operations).toHaveLength(8); // every parent op, with and without the anti-translation a
    expect(g.representatives).toHaveLength(4);
    expect(g.centerings).toHaveLength(2);
    expect(g.hasAntiTranslations).toBe(true);
    expect(g.asymmetricUnit).toHaveLength(structure.sites.length); // 9: the doubled group does not split any parent orbit

    const mcif = magneticStructureToMcif(structure, magnetic, {});
    expect(mcif).toContain("_parent_space_group.child_transform_Pp_abc  '2a,b,c;0,0,0'");
    expect(mcif).toContain("_space_group_symop_magn_operation.xyz");
    expect(mcif).toContain("_space_group_symop_magn_centering.xyz");
    expect(mcif).toContain("BNS type IV"); // black-and-white lattice: named honestly, not as the parent-basis label
    expect(mcif).not.toContain('_space_group_magn.name_bns  "P2/c');
    // Atom loop holds the asymmetric unit only (9 rows), not the 2× expanded list.
    const back = parseMagneticCif(mcif);
    expect(back.structure.sites).toHaveLength(structure.sites.length);
    expect(back.structure.spaceGroup.operations).toHaveLength(8);
    // The parsed file re-expands to exactly the atoms and moments the app shows.
    expect(multiset(expandSpinField(back.structure, back.magnetic!).atoms)).toEqual(multiset(sup.atoms));
    // …and the moments are nonzero on the magnetic cations.
    expect(back.magnetic!.moments.some((m) => m.components.some((c) => Math.abs(c) > 0.5))).toBe(true);
  });
});
