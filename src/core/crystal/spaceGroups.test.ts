import { describe, it, expect } from "vitest";
import {
  buildSpaceGroup,
  completeSpaceGroup,
  expandGenerators,
  extendedSymbol,
  isKnownSpaceGroup,
  knownSpaceGroups,
  latticeCenteringTranslations,
  resolveSpaceGroupSetting,
  SpaceGroupSettingError,
  settingForOperations,
  spaceGroupFromSetting,
  spaceGroupSettings,
  spaceGroupSymbol,
} from "@/core/crystal/spaceGroups";
import { SPACE_GROUP_DATA } from "@/core/crystal/spaceGroupData";
import { transformSpaceGroup } from "@/core/crystal/settings";
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

  it("throws for an unknown symbol-only group instead of returning it without operations", () => {
    const unknown: SpaceGroup = { hermannMauguin: "Fddd-nonstandard", operations: [] };
    expect(() => completeSpaceGroup(unknown)).toThrow(SpaceGroupSettingError);
  });

  it("throws when there is no space-group information at all", () => {
    expect(() => completeSpaceGroup({ operations: [] })).toThrow(/No space-group information/);
  });

  it("offers P 1 as the one choice when there is no space-group information", () => {
    let err: unknown;
    try {
      completeSpaceGroup({ operations: [] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SpaceGroupSettingError);
    expect((err as SpaceGroupSettingError).candidates.map((c) => c.symbol)).toEqual(["P 1"]);
    const p1 = completeSpaceGroup({ operations: [] }, undefined, { setting: "P 1" });
    expect(p1.number).toBe(1);
    expect(p1.operations.map((o) => o.xyz)).toEqual(["x,y,z"]);
    // Nothing else can be chosen without a symbol or number to fit.
    expect(() => completeSpaceGroup({ operations: [] }, undefined, { setting: "F d -3 m:2" })).toThrow(/only P 1 can be chosen/);
  });

  it("uses a Hall symbol to pick the setting", () => {
    const sg = completeSpaceGroup({ hermannMauguin: "F d -3 m", operations: [] }, undefined, { hall: "-F 4vw 2vw 3" });
    expect(sg.hermannMauguin).toBe("F d -3 m:2");
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

  it("every setting's operations form a valid crystallographic point group", () => {
    // A strong, gemmi-independent check: the rotation parts of a real space group
    // must classify as one of the 32 crystallographic point groups.
    for (const e of SPACE_GROUP_DATA) {
      const sg = spaceGroupFromSetting(e);
      expect(sg.operations.length, extendedSymbol(e)).toBeGreaterThan(0);
      expect(classifyPointGroup(sg.operations).symbol, `${extendedSymbol(e)} point group`).not.toBeNull();
    }
  });

  it("closure holds for a sample across all seven crystal systems", () => {
    for (const id of [1, 2, 14, 19, 62, "I 41/a:2", 123, "I 41/a m d:1", "R -3:H", "R -3 m:R", 176, 194, 221, "F d -3 m:2", 230]) {
      expect(isClosed(buildSpaceGroup(id)), `SG${id}`).toBe(true);
    }
  });

  it("general-position multiplicities match International Tables (hand-listed, independent of gemmi)", () => {
    const ita: [number, number][] = [
      [1, 1], [2, 2], [14, 4], [19, 4], [47, 8], [62, 8], [123, 16], [139, 32],
      [148, 18], [166, 36], [176, 12], [191, 24], [194, 24], [221, 48],
      [225, 192], [227, 192], [229, 96], [230, 96],
    ];
    // Per primitive cell, every setting of a number has the same order; the
    // count per conventional cell scales with its centring (R in rhombohedral
    // axes is primitive, "A 1" / "F 1" are centred settings of P1).
    const centrings = (ops: readonly string[]): number =>
      ops.map(parseSymmetryOperation).filter((o) => operationKey({ ...o, translation: [0, 0, 0] }) === operationKey(parseSymmetryOperation("x,y,z"))).length;
    for (const [n, mult] of ita) {
      const ref = SPACE_GROUP_DATA.find((x) => x.number === n && x.reference)!;
      expect(ref.ops.length, extendedSymbol(ref)).toBe(mult);
      for (const e of SPACE_GROUP_DATA.filter((x) => x.number === n)) {
        expect(e.ops.length / centrings(e.ops), extendedSymbol(e)).toBe(mult / centrings(ref.ops));
      }
    }
  });

  it("buildSpaceGroup(194) reproduces the demo's parsed P6₃/mmc operations exactly", () => {
    expect(keySet(buildSpaceGroup(194))).toEqual(keySet(exampleStructure().spaceGroup));
  });

  it("resolves common Hermann–Mauguin spellings (full + compact + bar-dropped)", () => {
    expect(buildSpaceGroup("P21/c").number).toBe(14);
    expect(buildSpaceGroup("Fm-3m").number).toBe(225);
    expect(buildSpaceGroup("Fm3m").number).toBe(225);
    expect(buildSpaceGroup("Pnma").number).toBe(62);
    expect(buildSpaceGroup("Fd-3m:2").number).toBe(227);
    expect(buildSpaceGroup("P63/mmc").number).toBe(194);
    // "P3" (143) and "P-3" (147) must not collide via bar-dropping.
    expect(buildSpaceGroup("P3").number).toBe(143);
    expect(buildSpaceGroup("P-3").number).toBe(147);
  });
});

describe("all 564 gemmi settings, resolved without guessing", () => {
  const hexCell = { a: 5, b: 5, c: 12, alpha: 90, beta: 90, gamma: 120 };
  const rhombCell = { a: 5, b: 5, c: 5, alpha: 60, beta: 60, gamma: 60 };

  it("holds every setting once, with exactly one reference setting per number", () => {
    expect(SPACE_GROUP_DATA).toHaveLength(564);
    expect(spaceGroupSettings()).toHaveLength(564);
    const refs = SPACE_GROUP_DATA.filter((e) => e.reference).map((e) => e.number);
    expect(refs).toEqual(Array.from({ length: 230 }, (_, i) => i + 1));
    // One Hall symbol per distinct operation set. Four pairs of entries are two
    // spellings of one setting (the e-glide groups: "A b a m" = "A c a m",
    // "C c c a:1" = "C c c b:1", …) and share both.
    const keys = new Set(SPACE_GROUP_DATA.map((e) => [...new Set(e.ops.map(parseSymmetryOperation).map(operationKey))].sort().join("|")));
    const halls = new Set(SPACE_GROUP_DATA.map((e) => e.hall));
    expect(keys.size).toBe(560);
    expect(halls.size).toBe(560);
    expect(resolveSpaceGroupSetting({ hermannMauguin: "A c a m" }).ops).toEqual(resolveSpaceGroupSetting({ hermannMauguin: "A b a m" }).ops);
    // An alias spelling with its (shared) Hall symbol is consistent, and the
    // Hall symbol alone is not ambiguous.
    for (const hm of ["A c a m", "A b a m"]) {
      expect(resolveSpaceGroupSetting({ hermannMauguin: hm, hall: "-A 2 2ab" }).hm).toBe(hm);
    }
    expect(resolveSpaceGroupSetting({ hall: "-A 2 2ab" }).number).toBe(64);
  });

  it("every setting is closed", () => {
    for (const e of SPACE_GROUP_DATA) expect(isClosed(spaceGroupFromSetting(e)), extendedSymbol(e)).toBe(true);
  });

  it("the reference setting of Fd-3m is origin choice 2; the two origins differ by (1/8,1/8,1/8)", () => {
    const o1 = buildSpaceGroup("F d -3 m:1");
    const o2 = buildSpaceGroup("F d -3 m:2");
    expect(o2.hermannMauguin).toBe("F d -3 m:2");
    expect(SPACE_GROUP_DATA.find((e) => e.number === 227 && e.reference)!.ext).toBe("2");
    expect(keySet(o1)).not.toEqual(keySet(o2));
    // ITA: origin choice 2 (at −3m) lies at (1/8,1/8,1/8) of the origin-1 frame,
    // so x₂ = x₁ − (1/8,1/8,1/8): 16c moves from (1/8,1/8,1/8) to (0,0,0).
    expect(keySet(transformSpaceGroup(o1, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [1 / 8, 1 / 8, 1 / 8]))).toEqual(keySet(o2));
    // Diamond Si in origin-2 coordinates, 8a (1/8,1/8,1/8): 8 atoms with the
    // origin-2 operations, 16 (the origin-1 16c orbit) with the wrong origin.
    expect(siteMultiplicity(o2.operations, [1 / 8, 1 / 8, 1 / 8])).toBe(8);
    expect(siteMultiplicity(o1.operations, [1 / 8, 1 / 8, 1 / 8])).toBe(16);
  });

  it("an H-M symbol or number shared by two origin choices is an error listing both", () => {
    for (const id of ["Fd-3m", "F d -3 m", 227, "P4/nmm", 129, "Pnnn", "I41/amd"] as const) {
      let err: unknown;
      try {
        buildSpaceGroup(id);
      } catch (e) {
        err = e;
      }
      expect(err, String(id)).toBeInstanceOf(SpaceGroupSettingError);
      const c = (err as SpaceGroupSettingError).candidates.map((x) => x.description).sort();
      expect(c, String(id)).toEqual(["origin choice 1", "origin choice 2"]);
      expect((err as Error).message).toMatch(/ambiguous/);
    }
  });

  it("explicit setting suffixes pick one: ':1'/':2', ICSD 'S'/'Z', '(origin choice 2)'", () => {
    expect(buildSpaceGroup("Fd-3m:1").hermannMauguin).toBe("F d -3 m:1");
    expect(buildSpaceGroup("F d -3 m :2").hermannMauguin).toBe("F d -3 m:2");
    expect(buildSpaceGroup("F d -3 m Z").hermannMauguin).toBe("F d -3 m:2");
    expect(buildSpaceGroup("F d -3 m S").hermannMauguin).toBe("F d -3 m:1");
    expect(buildSpaceGroup("P 4/n m m (origin choice 2)").hermannMauguin).toBe("P 4/n m m:2");
    expect(buildSpaceGroup("R -3 m H").hermannMauguin).toBe("R -3 m:H");
    expect(buildSpaceGroup("R -3 m:R").hermannMauguin).toBe("R -3 m:R");
    // A suffix the group does not have is unknown, not ignored.
    expect(() => buildSpaceGroup("P 21/c:2")).toThrow(SpaceGroupSettingError);
  });

  it("hexagonal vs rhombohedral axes are decided by the cell, or are an error without one", () => {
    expect(() => buildSpaceGroup("R-3m")).toThrow(/ambiguous.*hexagonal axes.*rhombohedral axes/);
    expect(() => buildSpaceGroup(166)).toThrow(SpaceGroupSettingError);
    expect(buildSpaceGroup("R-3m", hexCell).hermannMauguin).toBe("R -3 m:H");
    expect(buildSpaceGroup("R-3m", rhombCell).hermannMauguin).toBe("R -3 m:R");
    expect(buildSpaceGroup(166, hexCell).operations).toHaveLength(36);
    expect(buildSpaceGroup(166, rhombCell).operations).toHaveLength(12);
    expect(() => buildSpaceGroup("R-3m", { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 })).toThrow(/neither hexagonal/);
  });

  it("a number alone means the standard setting where ITA has only one", () => {
    expect(buildSpaceGroup(14).hermannMauguin).toBe("P 1 21/c 1");
    expect(buildSpaceGroup(62).hermannMauguin).toBe("P n m a");
    // Non-standard settings resolve by their own symbol.
    expect(buildSpaceGroup("P 1 21/n 1").number).toBe(14);
    expect(buildSpaceGroup("P21/n").hermannMauguin).toBe("P 1 21/n 1");
    expect(buildSpaceGroup("P 1 1 21/b").hermannMauguin).toBe("P 1 1 21/b");
    expect(buildSpaceGroup("Pbnm").number).toBe(62);
    expect(keySet(buildSpaceGroup("Pbnm"))).not.toEqual(keySet(buildSpaceGroup("Pnma")));
  });

  it("a Hall symbol names one setting; one that contradicts the symbol or number is an error", () => {
    expect(extendedSymbol(resolveSpaceGroupSetting({ hall: "-F 4vw 2vw 3" }))).toBe("F d -3 m:2");
    expect(extendedSymbol(resolveSpaceGroupSetting({ hall: "F 4d 2 3 -1d" }))).toBe("F d -3 m:1");
    expect(extendedSymbol(resolveSpaceGroupSetting({ hall: "  -p 2ybc " }))).toBe("P 1 21/c 1");
    expect(extendedSymbol(resolveSpaceGroupSetting({ hall: "-F 4vw 2vw 3", hermannMauguin: "Fd-3m", number: 227 }))).toBe("F d -3 m:2");
    expect(() => resolveSpaceGroupSetting({ hall: "-F 4vw 2vw 3", hermannMauguin: "F d -3 m:1" })).toThrow(/contradicts/);
    expect(() => resolveSpaceGroupSetting({ hall: "-F 4vw 2vw 3", number: 225 })).toThrow(/contradicts/);
    expect(() => resolveSpaceGroupSetting({ hermannMauguin: "Pnma", number: 14 })).toThrow(/contradicts/);
    expect(() => resolveSpaceGroupSetting({ hall: "P 7 q" })).toThrow(/not one of the 560 tabulated/);
  });

  it("a monoclinic symbol must fit the cell's oblique angle", () => {
    const cUnique = { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 104 };
    expect(() => buildSpaceGroup("P21/c", cUnique)).toThrow(/unique axis b.*γ = 104/);
    expect(() => buildSpaceGroup(14, cUnique)).toThrow(SpaceGroupSettingError);
    expect(buildSpaceGroup("P 1 1 21/b", cUnique).number).toBe(14);
    expect(buildSpaceGroup("P21/c", { ...cUnique, beta: 104, gamma: 90 }).number).toBe(14);
  });
});

describe("naming a structure from its operations alone", () => {
  it("identifies every tabulated setting from its own operations, in any order", () => {
    for (const e of SPACE_GROUP_DATA) {
      const ops = e.ops.map(parseSymmetryOperation).reverse();
      expect(settingForOperations(ops)?.hall, extendedSymbol(e)).toBe(e.hall);
    }
  });

  it("names a symbol-less group by its setting, and an origin-shifted one not at all", () => {
    const fd3m2 = buildSpaceGroup("F d -3 m:2");
    expect(spaceGroupSymbol({ operations: fd3m2.operations })).toBe("F d -3 m:2");
    expect(spaceGroupSymbol({ hermannMauguin: "Fd-3m:2", operations: fd3m2.operations })).toBe("Fd-3m:2");
    // P -1 with its centre at (1/4, 0, 0) is no tabulated setting.
    const shifted = ["x,y,z", "-x+1/2,-y,-z"].map(parseSymmetryOperation);
    expect(settingForOperations(shifted)).toBeUndefined();
    expect(spaceGroupSymbol({ operations: shifted })).toBeUndefined();
  });
});
