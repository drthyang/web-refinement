import { describe, it, expect } from "vitest";
import {
  buildSpaceGroup,
  completeSpaceGroup,
  expandGenerators,
  isKnownSpaceGroup,
  knownSpaceGroups,
  latticeCenteringTranslations,
} from "@/core/crystal/spaceGroups";
import {
  composeOperations,
  isReflectionAbsent,
  operationKey,
  parseSymmetryOperation,
  siteMultiplicity,
} from "@/core/crystal/symmetry";
import { parseCif } from "@/parsers/cif";
import { classifyPointGroup } from "@/core/crystal/pointGroup";
import { exampleStructure } from "@/examples/mn3ga";
import { dataExists, readData } from "@/testSupport/data";
import type { SpaceGroup } from "@/core/crystal/types";

const keySet = (sg: SpaceGroup) => new Set(sg.operations.map(operationKey));

/** A group is closed iff composing any two members lands back in the set. */
function isClosed(sg: SpaceGroup): boolean {
  const keys = keySet(sg);
  for (const a of sg.operations) {
    for (const b of sg.operations) {
      if (!keys.has(operationKey(composeOperations(a, b)))) return false;
    }
  }
  return true;
}

describe("expandGenerators — group closure", () => {
  it("returns just the identity for no generators", () => {
    const ops = expandGenerators([]);
    expect(ops).toHaveLength(1);
    expect(operationKey(ops[0]!)).toBe(operationKey(parseSymmetryOperation("x,y,z")));
  });

  it("closes inversion into an order-2 group", () => {
    const ops = expandGenerators([parseSymmetryOperation("-x,-y,-z")]);
    expect(ops).toHaveLength(2);
  });

  it("is idempotent on an already-complete group", () => {
    const sg = buildSpaceGroup(216);
    const reclosed = expandGenerators(sg.operations);
    expect(reclosed).toHaveLength(sg.operations.length);
    expect(new Set(reclosed.map(operationKey))).toEqual(keySet(sg));
  });

  it("throws when closure exceeds the cap (guards bad generators)", () => {
    // Valid O_h generators (order 48), but capped at 10: must bail out loudly
    // rather than grind, which is how a genuinely non-closing set would present.
    const gens = ["z,x,y", "-y,x,z", "-x,-y,-z"].map(parseSymmetryOperation);
    expect(() => expandGenerators(gens, 10)).toThrow(/exceeded/);
  });
});

describe("buildSpaceGroup — known general-position multiplicities", () => {
  // Order = number of general positions (International Tables).
  const cases: [number | string, number][] = [
    [1, 1],
    [2, 2],
    [14, 4],
    [199, 24], // I2₁3: T (12) × 2 I-centring
    [216, 96], // F-4̄3m: T_d (24) × 4 F-centring
    [225, 192], // Fm-3̄m: O_h (48) × 4 F-centring
  ];
  it.each(cases)("space group %s has %i general positions", (id, order) => {
    const sg = buildSpaceGroup(id);
    expect(sg.operations).toHaveLength(order);
    // All operations distinct modulo lattice.
    expect(keySet(sg).size).toBe(order);
  });

  it("resolves by Hermann–Mauguin symbol and aliases to the same group", () => {
    const byNumber = buildSpaceGroup(216);
    expect(keySet(buildSpaceGroup("F -4 3 m"))).toEqual(keySet(byNumber));
    expect(keySet(buildSpaceGroup("F-43m"))).toEqual(keySet(byNumber));
    expect(buildSpaceGroup("P21/c").number).toBe(14);
  });

  it("carries the number and symbol through", () => {
    const sg = buildSpaceGroup(216);
    expect(sg.number).toBe(216);
    expect(sg.hermannMauguin).toBe("F -4 3 m");
  });

  it("throws on an unknown group", () => {
    expect(() => buildSpaceGroup(999)).toThrow(/Unknown space group/);
    expect(() => buildSpaceGroup("Zz9")).toThrow(/Unknown space group/);
  });

  it("produces genuinely closed groups", () => {
    for (const [id] of cases) expect(isClosed(buildSpaceGroup(id))).toBe(true);
  });
});

describe("special-position multiplicities match Wyckoff values", () => {
  // Cross-check the built F-4̄3m against known Wyckoff multiplicities: the origin
  // 4a, the body-diagonal 16e (x,x,x), and a general position 96i.
  const sg = buildSpaceGroup(216);
  it("4a at the origin", () => {
    expect(siteMultiplicity(sg.operations, [0, 0, 0])).toBe(4);
  });
  it("16e along the body diagonal (x,x,x)", () => {
    expect(siteMultiplicity(sg.operations, [0.15, 0.15, 0.15])).toBe(16);
  });
  it("96i general position", () => {
    expect(siteMultiplicity(sg.operations, [0.11, 0.23, 0.37])).toBe(96);
  });
});

describe("completeSpaceGroup — integration hook", () => {
  it("closes a partial (generating) operation list", () => {
    const partial: SpaceGroup = {
      number: 2,
      operations: [parseSymmetryOperation("-x,-y,-z")], // missing the implied identity
    };
    const completed = completeSpaceGroup(partial);
    expect(completed.operations).toHaveLength(2);
  });

  it("builds operations from a number when none are present", () => {
    const symbolOnly: SpaceGroup = { number: 216, operations: [] };
    const completed = completeSpaceGroup(symbolOnly);
    expect(completed.operations).toHaveLength(96);
    expect(completed.hermannMauguin).toBe("F -4 3 m");
  });

  it("leaves an already-complete group untouched (same reference)", () => {
    const full = buildSpaceGroup(14);
    const completed = completeSpaceGroup(full);
    expect(completed).toBe(full);
  });

  it("returns an unknown symbol-only group unchanged rather than throwing", () => {
    const unknown: SpaceGroup = { hermannMauguin: "Fddd-nonstandard", operations: [] };
    expect(completeSpaceGroup(unknown)).toBe(unknown);
  });
});

describe("discovery helpers", () => {
  it("reports known groups (all 230)", () => {
    expect(isKnownSpaceGroup(216)).toBe(true);
    expect(isKnownSpaceGroup("Fm-3m")).toBe(true);
    expect(isKnownSpaceGroup(1)).toBe(true);
    expect(isKnownSpaceGroup(230)).toBe(true); // Ia-3d — the full table now covers all 230
    expect(isKnownSpaceGroup(0)).toBe(false);
    expect(isKnownSpaceGroup(231)).toBe(false);
    expect(isKnownSpaceGroup("Zz9")).toBe(false);
    expect(knownSpaceGroups()).toHaveLength(230);
  });
});

// Golden validation against real International Tables data: the built F-4̄3m must
// reproduce the GaNb₄Se₈ CIF's 96 operations exactly (as a set, mod lattice).
const CIF = "GaNb4Se8_XRD/GaNb4Se8_100K.cif";
describe.skipIf(!dataExists(CIF))("golden: F-4̄3m vs GaNb₄Se₈ CIF", () => {
  it("generators reproduce the CIF operation set exactly", () => {
    const parsed = parseCif(readData(CIF));
    expect(parsed.spaceGroup.number).toBe(216);
    const built = buildSpaceGroup(216);
    expect(built.operations.length).toBe(parsed.spaceGroup.operations.length);
    expect(keySet(built)).toEqual(keySet(parsed.spaceGroup));
  });
});

describe("lattice-centering completion (systematic-absence generation, F2.2)", () => {
  it("maps each Hermann–Mauguin lattice letter to its centring translations", () => {
    expect(latticeCenteringTranslations("P 1")).toEqual([]);
    expect(latticeCenteringTranslations("C 1 2 1")).toEqual([[0.5, 0.5, 0]]);
    expect(latticeCenteringTranslations("I 21 3")).toEqual([[0.5, 0.5, 0.5]]);
    expect(latticeCenteringTranslations("F m -3 m")).toEqual([[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]]);
    // R centring is setting-dependent → deliberately not added (F2.4).
    expect(latticeCenteringTranslations("R -3 m")).toEqual([]);
  });

  it("adds the centring implied by the symbol to a primitive-only operation list", () => {
    // A CIF that lists only the identity but names a C lattice: the centring copy
    // must be recovered, or the C absences (h+k odd) would be missed.
    const completed = completeSpaceGroup({
      operations: [parseSymmetryOperation("x,y,z")],
      hermannMauguin: "C 1 2 1",
    });
    expect(completed.operations.length).toBe(2); // identity + C-centring
    // C-centring rule: hkl present iff h+k even.
    expect(isReflectionAbsent(completed.operations, 1, 0, 0)).toBe(true); // h+k=1 → absent
    expect(isReflectionAbsent(completed.operations, 2, 1, 3)).toBe(true); // h+k=3 → absent
    expect(isReflectionAbsent(completed.operations, 1, 1, 0)).toBe(false); // h+k=2 → present
    expect(isReflectionAbsent(completed.operations, 0, 0, 5)).toBe(false); // h+k=0 → present
  });

  it("recovers F-centring absences from a primitive-only list (all-even or all-odd)", () => {
    const f = completeSpaceGroup({
      operations: [parseSymmetryOperation("x,y,z")],
      hermannMauguin: "F m -3 m",
    });
    expect(f.operations.length).toBe(4); // identity + 3 F-centrings
    expect(isReflectionAbsent(f.operations, 1, 0, 0)).toBe(true); // mixed parity → absent
    expect(isReflectionAbsent(f.operations, 2, 1, 0)).toBe(true); // mixed → absent
    expect(isReflectionAbsent(f.operations, 1, 1, 1)).toBe(false); // all odd → present
    expect(isReflectionAbsent(f.operations, 2, 2, 0)).toBe(false); // all even → present
  });

  it("is a no-op on a group whose operation list already contains the centring", () => {
    const full = buildSpaceGroup("F m -3 m"); // 192 ops, centring already present
    const again = completeSpaceGroup(full);
    expect(again.operations.length).toBe(full.operations.length);
  });
});

describe("R-lattice centring is setting-aware (F2.4)", () => {
  const identity = [parseSymmetryOperation("x,y,z")];
  const hexCell = { a: 5, b: 5, c: 12, alpha: 90, beta: 90, gamma: 120 };
  const rhombCell = { a: 5, b: 5, c: 5, alpha: 60, beta: 60, gamma: 60 };

  it("adds obverse centring for an R group in the HEXAGONAL setting", () => {
    const sg = completeSpaceGroup({ operations: identity, hermannMauguin: "R -3 m" }, hexCell);
    expect(sg.operations.length).toBe(3); // identity + 2 obverse centrings
    // Obverse rule: reflection present iff −h+k+l ≡ 0 (mod 3).
    expect(isReflectionAbsent(sg.operations, 0, 0, 3)).toBe(false); // −0+0+3 = 3 → present
    expect(isReflectionAbsent(sg.operations, 3, 0, 0)).toBe(false); // −3 → present
    expect(isReflectionAbsent(sg.operations, 1, -2, 0)).toBe(false); // −1−2 = −3 → present
    expect(isReflectionAbsent(sg.operations, 1, 0, 0)).toBe(true); // −1 → absent
    expect(isReflectionAbsent(sg.operations, 0, 1, 0)).toBe(true); // +1 → absent
    expect(isReflectionAbsent(sg.operations, 1, 1, 1)).toBe(true); // +1 → absent
  });

  it("adds NO centring for an R group in the primitive rhombohedral setting", () => {
    const sg = completeSpaceGroup({ operations: identity, hermannMauguin: "R -3 m" }, rhombCell);
    expect(sg.operations.length).toBe(1); // primitive → no centring
    expect(isReflectionAbsent(sg.operations, 1, 0, 0)).toBe(false);
  });
});

describe("full 230-group table (generated from gemmi, validated independently)", () => {
  it("covers all 230 numbers and nothing outside 1–230", () => {
    for (let n = 1; n <= 230; n++) expect(isKnownSpaceGroup(n), `SG${n}`).toBe(true);
    expect(isKnownSpaceGroup(0)).toBe(false);
    expect(isKnownSpaceGroup(231)).toBe(false);
    expect(knownSpaceGroups()).toHaveLength(230);
  });

  it("every group's operations form a valid crystallographic point group", () => {
    // A strong, gemmi-independent check: the rotation parts of a real space group
    // must classify as one of the 32 crystallographic point groups.
    for (let n = 1; n <= 230; n++) {
      const sg = buildSpaceGroup(n);
      expect(sg.operations.length, `SG${n}`).toBeGreaterThan(0);
      expect(classifyPointGroup(sg.operations).symbol, `SG${n} point group`).not.toBeNull();
    }
  });

  it("closure holds for a sample across all seven crystal systems", () => {
    for (const n of [1, 2, 14, 19, 62, 88, 123, 141, 148, 166, 176, 194, 221, 227, 230]) {
      expect(isClosed(buildSpaceGroup(n)), `SG${n}`).toBe(true);
    }
  });

  it("general-position multiplicities match International Tables (hand-listed, independent of gemmi)", () => {
    const ita: [number, number][] = [
      [1, 1], [2, 2], [14, 4], [19, 4], [47, 8], [62, 8], [123, 16], [139, 32],
      [148, 18], [166, 36], [176, 12], [191, 24], [194, 24], [221, 48],
      [225, 192], [227, 192], [229, 96], [230, 96],
    ];
    for (const [n, mult] of ita) expect(buildSpaceGroup(n).operations.length, `SG${n}`).toBe(mult);
  });

  it("buildSpaceGroup(194) reproduces the demo's parsed P6₃/mmc operations exactly", () => {
    expect(keySet(buildSpaceGroup(194))).toEqual(keySet(exampleStructure().spaceGroup));
  });

  it("resolves common Hermann–Mauguin spellings (full + compact + bar-dropped)", () => {
    expect(buildSpaceGroup("P21/c").number).toBe(14);
    expect(buildSpaceGroup("Fm-3m").number).toBe(225);
    expect(buildSpaceGroup("Fm3m").number).toBe(225);
    expect(buildSpaceGroup("Pnma").number).toBe(62);
    expect(buildSpaceGroup("Fd-3m").number).toBe(227);
    expect(buildSpaceGroup("P63/mmc").number).toBe(194);
    // "P3" (143) and "P-3" (147) must not collide via bar-dropping.
    expect(buildSpaceGroup("P3").number).toBe(143);
    expect(buildSpaceGroup("P-3").number).toBe(147);
  });
});
