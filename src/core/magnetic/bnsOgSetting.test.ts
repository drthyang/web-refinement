import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { identifyMagneticGroup, identifyMagneticGroupAnySetting } from "@/core/magnetic/bnsOg";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";

describe("identifyMagneticGroupAnySetting — exact match through a setting search", () => {
  it("standard-setting group matches directly", () => {
    const P2M = ["x,y,z", "-x,y,-z", "-x,-y,-z", "x,-y,z"].map(parseSymmetryOperation);
    const res = identifyMagneticGroupAnySetting(P2M);
    expect(res).not.toBeNull();
    expect(res!.direct).toBe(true);
    expect(res!.identity.parentNumber).toBe(10); // P2/m
  });

  it("a-unique P2/m (axis permutation away from standard) is recovered", () => {
    // 2-fold along a, mirror ⊥ a: not the BNS standard (b-unique) setting.
    const aUnique = ["x,y,z", "x,-y,-z", "-x,-y,-z", "-x,y,z"].map(parseSymmetryOperation);
    expect(identifyMagneticGroup(aUnique)).toBeNull(); // exact lookup misses
    const res = identifyMagneticGroupAnySetting(aUnique);
    expect(res).not.toBeNull();
    expect(res!.direct).toBe(false);
    expect(res!.identity.parentNumber).toBe(10);
    expect(res!.identity.magtype).toBe(1);
  });

  it("off-origin P-1 (inversion at ¼,0,0) is recovered with the origin shift", () => {
    const shifted = ["x,y,z", "1/2-x,-y,-z"].map(parseSymmetryOperation);
    expect(identifyMagneticGroup(shifted)).toBeNull();
    const res = identifyMagneticGroupAnySetting(shifted);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("2.4"); // type-I P-1
    expect(res!.transformation).toContain("1/4");
  });

  it("primed operations keep their θ through the transformation (P2'/m' a-unique)", () => {
    const ops = [
      { ...parseSymmetryOperation("x,y,z"), timeReversal: 1 as const },
      { ...parseSymmetryOperation("x,-y,-z"), timeReversal: -1 as const },
      { ...parseSymmetryOperation("-x,-y,-z"), timeReversal: 1 as const },
      { ...parseSymmetryOperation("-x,y,z"), timeReversal: -1 as const },
    ];
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.parentNumber).toBe(10);
    expect(res!.identity.magtype).toBe(3); // a type-III group of P2/m
    expect(res!.identity.bnsSymbol).toContain("'");
  });

  it("returns null when no signed-permutation setting matches (rhombohedral 3-fold)", () => {
    // P3-type group expressed with the cyclic-permutation 3-fold (rhombohedral
    // basis): the hexagonal standard setting is not reachable by signed axis
    // permutations, so the honest answer is null.
    const rhombo = ["x,y,z", "z,x,y", "y,z,x"].map(parseSymmetryOperation);
    expect(identifyMagneticGroupAnySetting(rhombo)).toBeNull();
  });
});

describe("orthohexagonal (det-2) settings: orthorhombic subgroups of hexagonal parents", () => {
  const ops194 = mn3gaPowgenExample().structure.spaceGroup.operations; // P6₃/mmc
  const reps = latticeRepresentatives(magneticSubgroupLattice(ops194, [0, 0, 0]));

  it("the mmm-type subgroup of P6₃/mmc identifies as a Cmcm-family group", () => {
    // The orthorhombic t-subgroup of a hexagonal parent lives in the C-centred
    // orthohexagonal cell (a, a+2b, c) — unreachable by axis permutations
    // alone. Its type-I representative must now carry a standard label with an
    // orthorhombic C-centred parent (#63 Cmcm for P6₃/mmc).
    const ortho = reps.filter(
      (r) =>
        r.subgroupOrder === 8 &&
        r.candidate.isTypeI &&
        r.candidate.standard === null &&
        r.settingMatch !== undefined,
    );
    expect(ortho.length).toBeGreaterThan(0);
    const parents = ortho.map((r) => r.settingMatch!.identity.parentNumber);
    expect(parents).toContain(63); // Cmcm
    const cmcm = ortho.find((r) => r.settingMatch!.identity.parentNumber === 63)!;
    // The reported transformation must be one of the orthohexagonal cells.
    expect(cmcm.settingMatch!.transformation).toMatch(/2a|2b|a\+|b\+|-a|-b/);
  });

  it("in-plane monoclinic subgroups identify as C2/m-family (#12)", () => {
    const c2m = reps.find(
      (r) =>
        r.subgroupOrder === 4 &&
        r.candidate.isTypeI &&
        r.settingMatch?.identity.parentNumber === 12,
    );
    expect(c2m).toBeDefined();
  });

  it("type-III orthorhombic candidates get labels too", () => {
    const typeIII = reps.filter(
      (r) =>
        r.subgroupOrder === 8 &&
        !r.candidate.isTypeI &&
        r.settingMatch !== undefined &&
        r.settingMatch.identity.parentNumber >= 16 &&
        r.settingMatch.identity.parentNumber <= 74,
    );
    expect(typeIII.length).toBeGreaterThan(0);
    for (const r of typeIII) expect(r.settingMatch!.identity.magtype).toBe(3);
  });
});

describe("setting search wired into the subgroup lattice", () => {
  it("Pmmm ⊃ P2 (2-fold along a) gets a settingMatch with parent #3", () => {
    const PMMM = [
      "x,y,z", "-x,-y,z", "-x,y,-z", "x,-y,-z",
      "-x,-y,-z", "x,y,-z", "x,-y,z", "-x,y,z",
    ].map(parseSymmetryOperation);
    const lattice = magneticSubgroupLattice(PMMM, [0, 0, 0]);
    const p2a = lattice.find(
      (c) =>
        c.classRepresentative &&
        c.subgroupOrder === 2 &&
        c.candidate.isTypeI &&
        c.candidate.operations.some((o) => o.xyz.replace(/\s/g, "") === "x,-y,-z"),
    );
    expect(p2a).toBeDefined();
    // 2-fold along a is not the standard (b-unique) P2 setting…
    expect(p2a!.candidate.standard).toBeNull();
    // …but the setting search identifies it.
    expect(p2a!.settingMatch).toBeDefined();
    expect(p2a!.settingMatch!.identity.parentNumber).toBe(3);
  });
});
