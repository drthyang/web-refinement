import { describe, it, expect } from "vitest";
import { WYCKOFF_TABLE, assignWyckoff } from "@/core/crystal/wyckoff";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { siteStabilizer } from "@/core/crystal/symmetry";
import { exampleStructure } from "@/examples/mn3ga";
import type { SpaceGroup } from "@/core/crystal/types";

/**
 * Wyckoff assignment. The table stores only {letter, representative}; the
 * multiplicity and site symmetry are COMPUTED, so these tests validate the
 * tabulated coordinates against the independently-known ITA multiplicities, the
 * orbit–stabilizer invariant, and round-trip assignment (each representative must
 * resolve back to its own letter — which also proves the locus matcher gives
 * every position a distinct identity).
 */

// 194 (P6₃/mmc) is not in the built-in generator table; take its real operations
// from the bundled Mn₃Ga structure (a parsed P6₃/mmc CIF).
const sg194: SpaceGroup = exampleStructure().spaceGroup;
function opsFor(n: number): SpaceGroup {
  return n === 194 ? sg194 : buildSpaceGroup(n);
}

// Independently-known ITA multiplicities per Wyckoff letter.
const EXPECTED_MULT: Record<number, Record<string, number>> = {
  1: { a: 1 },
  2: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 2 },
  14: { a: 2, b: 2, c: 2, d: 2, e: 4 },
  194: { a: 2, b: 2, c: 2, d: 2, e: 4, f: 4, g: 6, h: 6, i: 12, j: 12, k: 12, l: 24 },
  216: { a: 4, b: 4, c: 4, d: 4, e: 16, f: 24, g: 24, h: 48, i: 96 },
  225: { a: 4, b: 4, c: 8, d: 24, e: 24, f: 32, g: 48, h: 48, i: 96, j: 96, k: 192 },
};

describe("Wyckoff table — self-consistency & round-trip", () => {
  for (const numStr of Object.keys(WYCKOFF_TABLE)) {
    const number = Number(numStr);
    it(`space group ${number}: every representative round-trips to its own letter with the ITA multiplicity`, () => {
      const sg = opsFor(number);
      const groupOrder = sg.operations.length; // includes centring copies (F/I)
      const expected = EXPECTED_MULT[number]!;
      let prevMult = 0;
      for (const entry of WYCKOFF_TABLE[number]!) {
        const a = assignWyckoff(sg, entry.coord);
        expect(a, `${number}${entry.letter}`).not.toBeNull();
        expect(a!.letter, `${number}${entry.letter}`).toBe(entry.letter);
        expect(a!.multiplicity, `${number}${entry.letter} multiplicity`).toBe(expected[entry.letter]);
        // Orbit–stabilizer: multiplicity × |stabilizer| = group order (incl. centring).
        const order = siteStabilizer(sg.operations, entry.coord).length;
        expect(a!.multiplicity * order, `${number}${entry.letter} orbit-stabilizer`).toBe(groupOrder);
        // ITA lettering runs in non-decreasing multiplicity.
        expect(a!.multiplicity).toBeGreaterThanOrEqual(prevMult);
        prevMult = a!.multiplicity;
      }
    });
  }

  it("known site symmetries (validates the classifier on real Wyckoff sites)", () => {
    expect(assignWyckoff(sg194, [0.137, 0.274, 0.25])!.siteSymmetry).toBe("mm2"); // 6h
    expect(assignWyckoff(sg194, [1 / 3, 2 / 3, 0.75])!.siteSymmetry).toBe("-6m2"); // 2d
    expect(assignWyckoff(buildSpaceGroup(216), [0, 0, 0])!.siteSymmetry).toBe("-43m"); // 4a
    expect(assignWyckoff(buildSpaceGroup(225), [0, 0, 0])!.siteSymmetry).toBe("m-3m"); // 4a
  });
});

describe("assignWyckoff — real sites", () => {
  it("Mn₃Ga: Mn → 6h, Ga → 2d", () => {
    const s = exampleStructure();
    const mn = s.sites.find((x) => x.label === "Mn1")!;
    const ga = s.sites.find((x) => x.label === "Ga1")!;
    expect(assignWyckoff(s.spaceGroup, mn.position)!.label).toBe("6h");
    expect(assignWyckoff(s.spaceGroup, ga.position)!.label).toBe("2d");
  });

  it("a general position resolves to the highest letter", () => {
    expect(assignWyckoff(sg194, [0.11, 0.23, 0.37])!.label).toBe("24l");
    expect(assignWyckoff(buildSpaceGroup(225), [0.11, 0.23, 0.37])!.label).toBe("192k");
  });

  it("returns null for a space group not in the built-in table", () => {
    const unknown: SpaceGroup = { number: 62, operations: buildSpaceGroup(225).operations };
    expect(assignWyckoff(unknown, [0, 0, 0])).toBeNull();
  });
});
