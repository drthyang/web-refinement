import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import type { SymmetryOperation } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { identifyMagneticGroup, identifyMagneticGroupAnySetting } from "@/core/magnetic/bnsOg";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";

function det3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

/**
 * The magnetic group that leaves an axial vector m on the origin site
 * invariant (the FindSpinGroup construction for a single-site k = 0
 * structure): operations with det(R)·R·m = m are unprimed, those with
 * det(R)·R·m = −m are primed, and all others are dropped.
 */
function momentStabilizer(parent: readonly SymmetryOperation[], m: Vec3): SymmetryOperation[] {
  const out: SymmetryOperation[] = [];
  for (const op of parent) {
    const R = op.rotation;
    const d = det3(R);
    const v = [0, 1, 2].map((i) => d * (R[i]![0]! * m[0] + R[i]![1]! * m[1] + R[i]![2]! * m[2]));
    if (v.every((x, i) => x === m[i])) out.push({ ...op, timeReversal: 1 });
    else if (v.every((x, i) => x === -m[i]!)) out.push({ ...op, timeReversal: -1 });
  }
  return out;
}

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

  it("a cyclic 3-fold on a primitive lattice is R3 in hexagonal axes (det 3), not null", () => {
    // Rhombohedral axes: the hexagonal standard setting is reached only by the
    // det-3 cell (a−b, b−c, a+b+c) of ITA §1.5.1, with R-centring cosets.
    const rhombo = ["x,y,z", "z,x,y", "y,z,x"].map(parseSymmetryOperation);
    expect(identifyMagneticGroup(rhombo)).toBeNull();
    const res = identifyMagneticGroupAnySetting(rhombo);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("146.10"); // R3
    expect(res!.transformation).toBe("(a-b, b-c, a+b+c; 0, 0, 0)");
    expect(det3(res!.P)).toBe(3);
  });
});

describe("F cubic parent: sub-cells of the face-centred lattice (MnO, Fm-3m, Mn at 0,0,0, k = 0)", () => {
  // Verified against FindSpinGroup 2026-09-21: these four candidates were left
  // with descriptive "primed: …" labels because their standard settings are
  // body-centred tetragonal, hexagonal-axes rhombohedral and C-centred
  // monoclinic cells of the F lattice.
  const fm3m = buildSpaceGroup(225).operations; // 192 ops, F cosets included

  it("moment ∥ [001] → I4/mm'm' (139.537) in the body-centred tetragonal cell", () => {
    const ops = momentStabilizer(fm3m, [0, 0, 1]);
    expect(ops).toHaveLength(64);
    expect(identifyMagneticGroup(ops)).toBeNull();
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("139.537");
    expect(res!.identity.bnsSymbol).toBe("I4/mm'm'");
    expect(res!.transformation).toBe("((a-b)/2, (a+b)/2, c; 0, 0, 0)");
    expect(det3(res!.P)).toBeCloseTo(0.5, 12);
  });

  it("moment ∥ [111] → R-3m' (166.101) in obverse hexagonal axes", () => {
    const ops = momentStabilizer(fm3m, [1, 1, 1]);
    expect(ops).toHaveLength(48);
    expect(identifyMagneticGroup(ops)).toBeNull();
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("166.101");
    expect(res!.identity.bnsSymbol).toBe("R-3m'");
    expect(res!.transformation).toBe("((-a+b)/2, (-b+c)/2, a+b+c; 0, 0, 0)");
    expect(det3(res!.P)).toBeCloseTo(0.75, 12);
  });

  it("moment ∥ [110] → Im'm'm (71.536) with the unprimed mirror ⊥ c'", () => {
    const ops = momentStabilizer(fm3m, [1, 1, 0]);
    expect(ops).toHaveLength(32);
    expect(identifyMagneticGroup(ops)).toBeNull();
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("71.536");
    expect(res!.identity.bnsSymbol).toBe("Im'm'm");
    expect(res!.transformation).toMatch(/\/2/);
    expect(det3(res!.P)).toBeCloseTo(0.5, 12);
  });

  it("moment in a {100} mirror plane → C2'/m' (12.62), unique axis along a cube edge", () => {
    const ops = momentStabilizer(fm3m, [1, 2, 0]);
    expect(ops).toHaveLength(16);
    expect(identifyMagneticGroup(ops)).toBeNull();
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("12.62");
    expect(res!.identity.bnsSymbol).toBe("C2'/m'");
    // The unique axis b' is the cube edge normal to the mirror plane, c; the
    // C-centring (½,½,0) of the new cell is the F point (½,0,½).
    expect(res!.transformation).toBe("(a, c, (a-b)/2; 0, 0, 0)");
    expect(det3(res!.P)).toBeCloseTo(0.5, 12);
  });

  it("moment in a {110} mirror plane → C2'/m' (12.62), unique axis along a face diagonal", () => {
    const ops = momentStabilizer(fm3m, [1, 1, 2]); // in the (1-10) plane, generic
    expect(ops).toHaveLength(16);
    expect(identifyMagneticGroup(ops)).toBeNull();
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("12.62");
    expect(res!.identity.bnsSymbol).toBe("C2'/m'");
    // The unique axis b' is ±(a−b)/2.
    const b: Vec3 = [res!.P[0][1], res!.P[1][1], res!.P[2][1]];
    expect(Math.abs(b[0])).toBe(0.5);
    expect(b[1]).toBe(-b[0]);
    expect(b[2]).toBe(0);
    expect(det3(res!.P)).toBeCloseTo(0.5, 12);
  });

  it("the P-1 and P1 subgroups are named in the primitive rhombohedral cell", () => {
    const ops = momentStabilizer(fm3m, [1, 2, 3]); // generic direction: only -1 survives
    expect(ops).toHaveLength(8);
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res?.identity.bnsNumber).toBe("2.4"); // P-1
    expect(res!.transformation).toBe("((b+c)/2, (a+c)/2, (a+b)/2; 0, 0, 0)");
    expect(det3(res!.P)).toBeCloseTo(0.25, 12);
  });

  it("every class representative of the Fm-3m k = 0 lattice is labelled, the MnO four among them", () => {
    const parent = fm3m.map((o) => ({ ...o, timeReversal: 1 as const }));
    const reps = latticeRepresentatives(magneticSubgroupLattice(parent, [0, 0, 0]));
    expect(reps.length).toBeGreaterThan(90);
    const unlabelled = reps.filter((r) => r.candidate.standard === null && r.settingMatch === undefined);
    expect(unlabelled.map((r) => r.candidate.label)).toEqual([]);
    const numbers = new Set(reps.map((r) => r.candidate.standard?.bnsNumber ?? r.settingMatch!.identity.bnsNumber));
    for (const n of ["139.537", "166.101", "71.536", "12.62", "2.4", "1.1"]) expect(numbers, n).toContain(n);
    // The tetragonal ones live in a det-½ cell, the rhombohedral ones in a det-¾ cell.
    for (const r of reps) {
      const m = r.settingMatch;
      if (!m) continue;
      const p = m.identity.parentNumber;
      if (p >= 75 && p <= 142) expect(det3(m.P), m.transformation).toBeCloseTo(0.5, 12);
      if (p >= 143 && p <= 167) expect(det3(m.P), m.transformation).toBeCloseTo(0.75, 12);
    }
  });
});

describe("rhombohedral axes → hexagonal axes (det 3)", () => {
  it("-3m' of a primitive cubic parent (moment ∥ [111]) is R-3m' in the det-3 hexagonal cell", () => {
    // Pm-3m's 3-fold subgroups are rhombohedral with a = b = c, α = 90°: the
    // hexagonal cell is (a−b, b−c, a+b+c), never a fractional F sub-cell.
    const ops = momentStabilizer(buildSpaceGroup(221).operations, [1, 1, 1]);
    expect(ops).toHaveLength(12);
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.bnsNumber).toBe("166.101");
    expect(res!.transformation).toBe("(a-b, b-c, a+b+c; 0, 0, 0)");
    expect(det3(res!.P)).toBe(3);
  });

  it("R-3m written in rhombohedral axes is recovered with its primes", () => {
    // The 12 ops of -3m in rhombohedral axes (3-fold = cyclic permutation,
    // 2-folds along [1-10]-type directions), m' variant: R-3m' (166.101).
    const unprimed = ["x,y,z", "z,x,y", "y,z,x", "-x,-y,-z", "-z,-x,-y", "-y,-z,-x"];
    const primed = ["-y,-x,-z", "-x,-z,-y", "-z,-y,-x", "y,x,z", "x,z,y", "z,y,x"];
    const ops = [
      ...unprimed.map((s) => ({ ...parseSymmetryOperation(s), timeReversal: 1 as const })),
      ...primed.map((s) => ({ ...parseSymmetryOperation(s), timeReversal: -1 as const })),
    ];
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res?.identity.bnsNumber).toBe("166.101");
    expect(res?.identity.magtype).toBe(3);
    expect(det3(res!.P)).toBe(3);
  });
});

describe("a fractional cell applies only when its basis vectors are lattice translations", () => {
  it("mm2 with diagonal mirrors on a primitive lattice is Cmm2 (35) in an integer det-2 cell, not Pmm2", () => {
    // ((a−b)/2, (a+b)/2, c) would turn these ops into Pmm2's, but neither
    // (a±b)/2 is a translation of a primitive lattice; the true cell is the
    // C-centred (a+b, −a+b, c).
    const ops = ["x,y,z", "-x,-y,z", "y,x,z", "-y,-x,z"].map(parseSymmetryOperation);
    const res = identifyMagneticGroupAnySetting(ops);
    expect(res).not.toBeNull();
    expect(res!.identity.parentNumber).toBe(35);
    expect(res!.P.flat().every((x) => Number.isInteger(x))).toBe(true);
    expect(det3(res!.P)).toBe(2);
  });
});

describe("P6₃/mmc regression: the Mn₃Ga lattice keeps every setting-search label", () => {
  it("102 class representatives, 56 named through the search, none unlabelled", () => {
    const ops194 = mn3gaPowgenExample().structure.spaceGroup.operations;
    const reps = latticeRepresentatives(magneticSubgroupLattice(ops194, [0, 0, 0]));
    expect(reps).toHaveLength(102);
    expect(reps.filter((r) => r.candidate.standard === null && r.settingMatch === undefined)).toEqual([]);
    const byNumber = (x: string, y: string): number => {
      const [p, q] = x.split(".").map(Number) as [number, number];
      const [r, s] = y.split(".").map(Number) as [number, number];
      return p - r || q - s;
    };
    const named = reps.filter((r) => r.settingMatch).map((r) => r.settingMatch!.identity.bnsNumber).sort(byNumber);
    // Snapshot taken before the cubic sub-cells were added (2026-09-22): the
    // hexagonal parent must be untouched by them.
    expect(named).toEqual([
      "4.7", "4.9", "5.13", "5.13", "5.15", "5.15", "6.18", "6.20", "8.32", "8.34", "9.37", "9.39",
      "11.50", "11.52", "11.53", "11.54", "12.58", "12.60", "12.61", "12.62",
      "15.85", "15.87", "15.88", "15.89", "20.31", "20.33", "20.34", "20.34",
      "36.172", "36.174", "36.175", "36.176", "38.187", "38.189", "38.190", "38.191",
      "40.203", "40.205", "40.206", "40.207",
      "63.457", "63.459", "63.460", "63.461", "63.462", "63.463", "63.464", "63.465",
      "149.21", "149.23", "174.133", "174.135", "187.209", "187.211", "187.212", "187.213",
    ]);
    // Every cell used is an integer (det 1 or 2) one: the hexagonal lattice has no fractional sub-cells.
    for (const r of reps) {
      if (r.settingMatch) expect(r.settingMatch.P.flat().every((x) => Number.isInteger(x)), r.settingMatch.transformation).toBe(true);
    }
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
