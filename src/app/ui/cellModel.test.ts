import { describe, it, expect } from "vitest";
import { buildCellAtoms, displayMoment, magneticSupercell } from "@/app/ui/cellModel";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { parseMagneticSymmetryOperation, parseSymmetryOperation } from "@/core/crystal/symmetry";

const P1: StructureModel["spaceGroup"] = {
  hermannMauguin: "P 1",
  operations: [parseSymmetryOperation("x,y,z")],
};

function cubicP1(sites: StructureModel["sites"]): StructureModel {
  return {
    id: "t",
    name: "t",
    cell: { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: P1,
    sites,
  };
}

const iso = { kind: "isotropic", bIso: 0.5 } as const;

describe("magneticSupercell", () => {
  it("is the denominator of each k component", () => {
    expect(magneticSupercell([0, 0, 0])).toEqual([1, 1, 1]);
    expect(magneticSupercell([0, 0, 0.5])).toEqual([1, 1, 2]);
    expect(magneticSupercell([1 / 3, 0, 0])).toEqual([3, 1, 1]);
    expect(magneticSupercell([0.25, 0.5, 0])).toEqual([4, 2, 1]);
  });
});

describe("buildCellAtoms — standard-setting cell fill", () => {
  // Region: P columns (a, a+2b, c) — det 2, the orthohexagonal pattern.
  const region = { P: [[1, 1, 0], [0, 2, 0], [0, 0, 1]], origin: [0, 0, 0] as Vec3 };
  const site = { label: "A1", element: "Fe", position: [0.4, 0.1, 0.3] as Vec3, occupancy: 1, adp: iso };

  it("fills the region with exactly det(P) lattice translates of a generic atom", () => {
    const without = buildCellAtoms(cubicP1([site]));
    expect(without).toHaveLength(1);
    const atoms = buildCellAtoms(cubicP1([site]), [1, 1, 1], undefined, undefined, region);
    // Hand-derived: t = (0,0,0) (shared with the parent cell — deduped) and
    // t = (1,1,0) are the only translates with P⁻¹·x ∈ [0,1]³.
    expect(atoms).toHaveLength(2);
    const extra = atoms.find((a) => a.cellIndex[0] === 1)!;
    expect(extra.cellIndex).toEqual([1, 1, 0]);
    expect(extra.xyz[0]).toBeCloseTo((0.4 + 1) * 5, 6);
    expect(extra.xyz[1]).toBeCloseTo((0.1 + 1) * 5, 6);
    expect(extra.xyz[2]).toBeCloseTo(0.3 * 5, 6);
  });

  it("an origin-shifted region still holds det(P) copies (volume is invariant)", () => {
    const shifted = { P: region.P, origin: [0.25, 0.25, 0] as Vec3 };
    const atoms = buildCellAtoms(cubicP1([site]), [1, 1, 1], undefined, undefined, shifted);
    // Parent-cell copy + region copies, region ∩ parent overlap deduped: the
    // region always contains exactly det(P) = 2 translates of a generic atom.
    const inRegion = atoms.filter((a) => {
      const f = a.xyz.map((v) => v / 5); // back to parent fractional
      const c0 = f[0]! - 0.25 - (f[1]! - 0.25) / 2;
      const c1 = (f[1]! - 0.25) / 2;
      const c2 = f[2]!;
      const inside = (v: number): boolean => v >= -0.021 && v <= 1.021;
      return inside(c0) && inside(c1) && inside(c2);
    });
    expect(inRegion).toHaveLength(2);
  });

  it("regionOnly drops the parent-cell atoms outside the standard region", () => {
    // A corner atom: without a region it fills all 8 parent-cell corners. With
    // the det-2 orthohexagonal region, corners (0,1,0)/(0,1,1) fall OUTSIDE it.
    const corner = { label: "C1", element: "Fe", position: [0, 0, 0] as Vec3, occupancy: 1, adp: iso };
    const both = buildCellAtoms(cubicP1([corner]), [1, 1, 1], undefined, undefined, region, false);
    const onlyRegion = buildCellAtoms(cubicP1([corner]), [1, 1, 1], undefined, undefined, region, true);

    // The out-of-region parent corner is present without regionOnly, gone with it.
    const at = (as: ReturnType<typeof buildCellAtoms>, f: Vec3): boolean =>
      as.some((a) => a.xyz.every((v, i) => Math.abs(v / 5 - f[i]!) < 1e-6));
    expect(at(both, [0, 1, 0])).toBe(true);
    expect(at(onlyRegion, [0, 1, 0])).toBe(false);
    expect(onlyRegion.length).toBeLessThan(both.length);

    // Every regionOnly atom lies inside the region (P⁻¹·x ∈ [0,1]³, ε-inclusive).
    for (const a of onlyRegion) {
      const [x, y, z] = a.xyz.map((v) => v / 5) as [number, number, number];
      const c0 = x - y / 2, c1 = y / 2, c2 = z;
      for (const c of [c0, c1, c2]) expect(c).toBeGreaterThanOrEqual(-0.03);
      for (const c of [c0, c1, c2]) expect(c).toBeLessThanOrEqual(1.03);
    }
  });

  it("moments on region copies carry the exact k-phase: cos 2πk·t flips odd translates", () => {
    const magOps = [parseMagneticSymmetryOperation("x,y,z,+1")];
    const entries = [{ key: "A1", siteLabel: "A1", components: [0, 0, 3] as Vec3 }];
    const atoms = buildCellAtoms(cubicP1([site]), [1, 1, 1], magOps, entries, region);
    const base = atoms.find((a) => a.cellIndex[0] === 0)!;
    const extra = atoms.find((a) => a.cellIndex[0] === 1)!; // t = (1,1,0)
    // k = (½,0,0): cos(2π·½·1) = −1 → the translated copy's arrow flips.
    expect(displayMoment(base, [0, 0, 3], [0.5, 0, 0])![2]).toBeCloseTo(3, 9);
    expect(displayMoment(extra, [0, 0, 3], [0.5, 0, 0])![2]).toBeCloseTo(-3, 9);
    // k = (0,0,½): t_z = 0 → same sign on both copies.
    expect(displayMoment(extra, [0, 0, 3], [0, 0, 0.5])![2]).toBeCloseTo(3, 9);
    // k = 0: identical arrows — the copies are the same physical moment.
    expect(displayMoment(extra, [0, 0, 3], [0, 0, 0])![2]).toBeCloseTo(3, 9);
  });
});

describe("buildCellAtoms — supercell tiling", () => {
  it("tiles the cell N times, tagging each copy with its cell index", () => {
    const atoms = buildCellAtoms(
      cubicP1([{ label: "A1", element: "Fe", position: [0.25, 0.5, 0.75], occupancy: 1, adp: iso }]),
      [1, 1, 2],
    );
    expect(atoms).toHaveLength(2); // two cells stacked along c
    const zs = atoms.map((a) => a.xyz[2]).sort((x, y) => x - y);
    expect(zs[0]).toBeCloseTo(0.75 * 5, 6); // cell 0
    expect(zs[1]).toBeCloseTo(0.75 * 5 + 5, 6); // cell 1 (+c)
    expect(atoms.map((a) => a.cellIndex[2]).sort()).toEqual([0, 1]);
  });
});

describe("buildCellAtoms", () => {
  it("places a general-position atom once, in Cartesian Å", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "A1", element: "Fe", position: [0.25, 0.5, 0.75], occupancy: 1, adp: iso },
    ]));
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.element).toBe("Fe");
    // orthogonal 5 Å cell → x = frac·5 (tolerant: cos(90°) is ~6e-17, not 0)
    const [x, y, z] = atoms[0]!.xyz;
    expect(x).toBeCloseTo(1.25, 9);
    expect(y).toBeCloseTo(2.5, 9);
    expect(z).toBeCloseTo(3.75, 9);
  });

  it("duplicates a corner atom onto all 8 cell corners", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "O1", element: "O", position: [0, 0, 0], occupancy: 1, adp: iso },
    ]));
    expect(atoms).toHaveLength(8); // 2^3 boundary images at the origin
    for (const a of atoms) {
      for (const c of a.xyz) expect(Math.min(Math.abs(c), Math.abs(c - 5))).toBeLessThan(1e-6);
    }
  });

  it("expands by symmetry operations (P-1 inversion doubles a general site)", () => {
    const structure: StructureModel = {
      ...cubicP1([{ label: "A1", element: "Mn", position: [0.2, 0.3, 0.4], occupancy: 1, adp: iso }]),
      spaceGroup: {
        hermannMauguin: "P -1",
        operations: [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,-z")],
      },
    };
    // x,y,z and its inversion (wrapped into the cell) — two distinct interior atoms.
    expect(buildCellAtoms(structure)).toHaveLength(2);
  });
});

describe("buildCellAtoms — doped / mixed sites", () => {
  it("full single-element site: occupancy 1, no mixture", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "Fe1", element: "Fe", position: [0.25, 0.5, 0.75], occupancy: 1, adp: iso },
    ]));
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.occupancy).toBe(1);
    expect(atoms[0]!.mixture).toBeUndefined();
  });

  it("co-located elements merge into ONE atom carrying the mixture (desc. occupancy)", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "Fe1", element: "Fe", position: [0.5, 0.5, 0.5], occupancy: 0.45, adp: iso },
      { label: "Co1", element: "Co", position: [0.5, 0.5, 0.5], occupancy: 0.55, adp: iso },
    ]));
    // One sphere at the shared position, not two overlapping ones.
    expect(atoms).toHaveLength(1);
    const at = atoms[0]!;
    expect(at.mixture).toBeDefined();
    expect(at.mixture!.map((f) => f.element)).toEqual(["Co", "Fe"]); // higher occ first
    expect(at.mixture!.map((f) => f.occupancy)).toEqual([0.55, 0.45]);
    expect(at.occupancy).toBeCloseTo(1, 9);
    // The representative (drawn) element is the dominant one.
    expect(at.element).toBe("Co");
  });

  it("single partial-occupancy site: mixture with a vacancy remainder", () => {
    const atoms = buildCellAtoms(cubicP1([
      { label: "Na1", element: "Na", position: [0.2, 0.3, 0.3], occupancy: 0.6, adp: iso },
    ]));
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.occupancy).toBeCloseTo(0.6, 9);
    expect(atoms[0]!.mixture).toEqual([{ element: "Na", occupancy: 0.6 }]);
  });

  it("high-entropy 6-cation site collapses to a single 6-way split sphere", () => {
    const p: Vec3 = [0.5, 0.66, 0.25];
    const cations = ["Co", "Fe", "Ni", "Mn", "Cu", "Zn"].map((element, i) => ({
      label: `${element}${i}`, element, position: p, occupancy: 1 / 6, adp: iso,
    }));
    const atoms = buildCellAtoms(cubicP1(cations));
    expect(atoms).toHaveLength(1); // one sphere, not six overlapping
    expect(atoms[0]!.mixture).toHaveLength(6);
    expect(atoms[0]!.occupancy).toBeCloseTo(1, 6);
  });
});

/** The arrows must match the structure factor: m′ = θ·det(R)·R·m with the k-phase. */
describe("displayMoment — θ-signed arrows", () => {
  const close = (a: Vec3, b: Vec3): void => {
    expect(a[0]).toBeCloseTo(b[0]!, 6);
    expect(a[1]).toBeCloseTo(b[1]!, 6);
    expect(a[2]).toBeCloseTo(b[2]!, 6);
  };
  const mn3ga = (ops: StructureModel["spaceGroup"]["operations"]): StructureModel => ({
    id: "t", name: "t",
    cell: { a: 5.42, b: 4.34, c: 5.32, alpha: 90, beta: 60.7, gamma: 90 },
    spaceGroup: { operations: ops },
    sites: [{ label: "Mn1", element: "Mn", oxidationState: 2, position: [0.343, 0.25, 0.833], occupancy: 1, adp: iso }],
  });
  // Mn₃Ga P2₁'/m': 2₁ and m primed, inversion not. A 2e site (y = ¼) with an
  // ac-plane moment: the orbit partner carries the SAME moment.
  const nuclear = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map(parseSymmetryOperation);
  const magnetic = ["x,y,z,+1", "-x,1/2+y,-z,-1", "-x,-y,-z,+1", "x,1/2-y,z,-1"].map(parseMagneticSymmetryOperation);
  const m: Vec3 = [-1.577, 0, -1.349];

  it("P2₁'/m' 2e pair is ferromagnetically aligned (the type-III θ regression)", () => {
    const atoms = buildCellAtoms(mn3ga(nuclear), [1, 1, 1], magnetic);
    expect(atoms).toHaveLength(2);
    for (const at of atoms) close(displayMoment(at, m)!, m);
  });

  it("the arrow does not depend on which magnetic op reaches the atom", () => {
    // The partner is reached both by 2₁′ (θ=−1) and by unprimed inversion; a
    // symmetry-allowed moment gives the same arrow either way. Reversing the op
    // list changes which op is found first — the arrangement must not change.
    const a1 = buildCellAtoms(mn3ga(nuclear), [1, 1, 1], magnetic);
    const a2 = buildCellAtoms(mn3ga(nuclear), [1, 1, 1], [...magnetic].reverse());
    for (const at1 of a1) {
      const at2 = a2.find((a) => Math.hypot(a.xyz[0] - at1.xyz[0], a.xyz[1] - at1.xyz[1], a.xyz[2] - at1.xyz[2]) < 1e-6)!;
      close(displayMoment(at1, m)!, displayMoment(at2, m)!);
    }
  });

  it("type-III primed 2-fold flips the partner arrow (AFM); unprimed keeps it (FM)", () => {
    const nuc = [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,z")];
    const s = { ...cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]), spaceGroup: { operations: nuc } };
    const mz: Vec3 = [0, 0, 2];
    const partnerArrow = (ops: SymmetryOperation[]): Vec3 => {
      const atoms = buildCellAtoms(s, [1, 1, 1], ops);
      expect(atoms).toHaveLength(2);
      const partner = atoms.find((a) => a.mag!.rot[0]![0]! === -1)!; // placed by the 2-fold
      return displayMoment(partner, mz)!;
    };
    close(partnerArrow(["x,y,z,+1", "-x,-y,z,+1"].map(parseMagneticSymmetryOperation)), [0, 0, 2]);
    close(partnerArrow(["x,y,z,+1", "-x,-y,z,-1"].map(parseMagneticSymmetryOperation)), [0, 0, -2]);
  });

  it("nuclear-orbit atoms unreachable by the magnetic ops carry no arrow", () => {
    const nuc = [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,z")];
    const s = { ...cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]), spaceGroup: { operations: nuc } };
    const atoms = buildCellAtoms(s, [1, 1, 1], [parseMagneticSymmetryOperation("x,y,z,+1")]);
    expect(atoms).toHaveLength(2);
    expect(atoms.filter((a) => displayMoment(a, [0, 0, 1]) !== null)).toHaveLength(1);
  });
});

describe("displayMoment — commensurate k-phase", () => {
  it("k = (0,0,½): the copy in the next cell along c is reversed", () => {
    const s = cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]);
    const atoms = buildCellAtoms(s, [1, 1, 2]);
    expect(atoms).toHaveLength(2);
    const arrow = (n: number): Vec3 => displayMoment(atoms.find((a) => a.cellIndex[2] === n)!, [0, 0, 1.5], [0, 0, 0.5])!;
    expect(arrow(0)[2]).toBeCloseTo(1.5, 6);
    expect(arrow(1)[2]).toBeCloseTo(-1.5, 6);
  });

  it("k = (0,0,½): a z≈0 boundary duplicate drawn at z=1 belongs to the next cell", () => {
    const s = cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0], occupancy: 1, adp: iso }]);
    const atoms = buildCellAtoms(s); // z = 0 atom + its z = 1 face duplicate
    expect(atoms).toHaveLength(2);
    const xs = atoms.map((a) => displayMoment(a, [1, 0, 0], [0, 0, 0.5])![0]).sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-1, 6);
    expect(xs[1]).toBeCloseTo(1, 6);
  });
});

describe("buildCellAtoms — split-orbit moment entries", () => {
  // Nuclear group {1, 2z}, magnetic group = {1} only: the 2-atom orbit splits
  // into two 1-atom orbits. With per-orbit moment entries every atom finds its
  // anchor; without them the split-off atom has no arrow (legacy behaviour,
  // asserted above).
  const nuc = [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("-x,-y,z")];
  const s = { ...cubicP1([{ label: "A1", element: "Mn", position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }]), spaceGroup: { operations: nuc } };
  const magOps = [parseMagneticSymmetryOperation("x,y,z,+1")];

  it("every nuclear-orbit atom carries an arrow from its own orbit's entry", () => {
    const entries = [
      { key: "A1", siteLabel: "A1", components: [0, 0, 1] as Vec3 },
      { key: "A1#2", siteLabel: "A1", position: [0.9, 0.8, 0.3] as Vec3, components: [0, 0, -2] as Vec3 },
    ];
    const atoms = buildCellAtoms(s, [1, 1, 1], magOps, entries);
    expect(atoms).toHaveLength(2);
    // Both atoms have a placing op, each keyed to its orbit's entry.
    expect(atoms.map((a) => a.mag?.momentKey).sort()).toEqual(["A1", "A1#2"]);
    // And each arrow uses its own entry's components.
    for (const a of atoms) {
      const entry = entries.find((e) => e.key === a.mag!.momentKey)!;
      const arrow = displayMoment(a, entry.components)!;
      expect(arrow[2]).toBeCloseTo(entry.components[2]!, 6);
    }
  });
});
