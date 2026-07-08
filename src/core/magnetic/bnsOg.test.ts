import { describe, it, expect } from "vitest";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import {
  formatMagneticSymbol,
  identifyMagneticGroup,
  magneticGroupsForParent,
} from "@/core/magnetic/bnsOg";
import { MAGNETIC_GROUP_TABLE } from "@/core/magnetic/bnsOgTable";
import { generateMagneticCandidates } from "@/core/magnetic/magneticGroups";

/** Candidates from a built-in parent group, as the UI generates them. */
function candidatesFor(spaceGroupNumber: number) {
  const parent = buildSpaceGroup(spaceGroupNumber).operations.map((o) => ({
    ...o,
    timeReversal: 1 as const,
  }));
  return generateMagneticCandidates(parent);
}

describe("bundled BNS/OG table", () => {
  it("covers all 230 type-I and 674 type-III Shubnikov groups", () => {
    expect(MAGNETIC_GROUP_TABLE).toHaveLength(904);
    expect(MAGNETIC_GROUP_TABLE.filter((r) => r[0] === 1)).toHaveLength(230);
    expect(MAGNETIC_GROUP_TABLE.filter((r) => r[0] === 3)).toHaveLength(674);
  });

  it("has unique BNS numbers and covers every parent group 1–230", () => {
    const numbers = MAGNETIC_GROUP_TABLE.map((r) => r[1]);
    expect(new Set(numbers).size).toBe(numbers.length);
    const parents = new Set(MAGNETIC_GROUP_TABLE.map((r) => r[4]));
    for (let n = 1; n <= 230; n++) expect(parents.has(n)).toBe(true);
  });

  it("identifies every tabulated group from its own operations (round trip, unambiguous)", () => {
    // Feeding each entry's operations back through the signature lookup must
    // recover exactly that entry — this exercises parsing, centring expansion,
    // and signature uniqueness over the whole table.
    for (const row of MAGNETIC_GROUP_TABLE) {
      const ops = row[5].split(";").map((s) => {
        const parts = s.split(",");
        const spatial = parseSymmetryOperation(parts.slice(0, 3).join(","));
        return { ...spatial, timeReversal: (parts[3] === "-1" ? -1 : 1) as 1 | -1 };
      });
      const shifts = row[6] === "" ? [] : row[6].split(";").map((v) => {
        const t = v.split(",").map((c) => {
          const [num, den] = c.split("/");
          return den ? Number(num) / Number(den) : Number(num);
        });
        return t as [number, number, number];
      });
      const full = [
        ...ops,
        ...shifts.flatMap((t) =>
          ops.map((op) => ({
            ...op,
            translation: [
              (op.translation[0] + t[0]) % 1,
              (op.translation[1] + t[1]) % 1,
              (op.translation[2] + t[2]) % 1,
            ] as [number, number, number],
          })),
        ),
      ];
      const id = identifyMagneticGroup(full);
      expect(id?.bnsNumber, `entry ${row[1]} ${row[2]}`).toBe(row[1]);
    }
  });
});

describe("BNS/OG labels on k = 0 candidates", () => {
  it("labels the four P2₁/c (No. 14) candidates with the standard symbols and numbers", () => {
    const candidates = candidatesFor(14);
    expect(candidates).toHaveLength(4);
    const byBns = new Map(candidates.map((c) => [c.standard?.bnsNumber, c]));
    // Authoritative values straight from the bundled ISO-MAG table.
    expect(byBns.get("14.75")?.standard?.bnsSymbol).toBe("P2_1/c");
    expect(byBns.get("14.77")?.standard?.bnsSymbol).toBe("P2_1'/c");
    expect(byBns.get("14.78")?.standard?.bnsSymbol).toBe("P2_1/c'");
    expect(byBns.get("14.79")?.standard?.bnsSymbol).toBe("P2_1'/c'");
    expect(byBns.get("14.75")?.standard?.ogNumber).toBe("14.1.86");
    expect(byBns.get("14.79")?.standard?.ogNumber).toBe("14.5.90");
    // Display labels use pretty subscripts.
    expect(byBns.get("14.79")?.label).toBe("P2₁'/c'");
    // The type-I candidate is the unprimed parent.
    expect(candidates.find((c) => c.isTypeI)?.standard?.bnsNumber).toBe("14.75");
  });

  it("enumerates exactly the tabulated type-I/III groups of each parent (14, 216, 225)", () => {
    for (const parent of [14, 216, 225]) {
      const candidateLabels = candidatesFor(parent)
        .map((c) => c.standard?.bnsSymbol)
        .sort();
      const tableLabels = magneticGroupsForParent(parent)
        .map((g) => g.bnsSymbol)
        .sort();
      // Every candidate identified, and the θ-enumeration finds *all* of the
      // standard groups deriving from this parent — a bidirectional check of
      // generator and table against each other.
      expect(candidateLabels, `parent ${parent}`).toEqual(tableLabels);
    }
  });

  it("identifies the known P2₁'/m' ground state of the P2₁/m parent", () => {
    // Same parent listing as magneticGroups.test.ts (Mn₃Ga workflow).
    const parent = ["x,y,z", "-x,1/2+y,-z", "-x,-y,-z", "x,1/2-y,z"].map((s) => ({
      ...parseSymmetryOperation(s),
      timeReversal: 1 as const,
    }));
    const candidates = generateMagneticCandidates(parent);
    const p21pmp = candidates.find((c) => {
      const unprimed = c.operations.filter((o) => (o.timeReversal ?? 1) === 1);
      return unprimed.length === 2 && unprimed.some((o) => o.xyz.includes("-x,-y,-z"));
    });
    expect(p21pmp?.standard?.bnsSymbol).toBe("P2_1'/m'");
    expect(p21pmp?.standard?.parentNumber).toBe(11);
    expect(p21pmp?.label).toBe("P2₁'/m'");
    // OG symbol equals BNS symbol for types I–III.
    expect(p21pmp?.standard?.ogSymbol).toBe(p21pmp?.standard?.bnsSymbol);
  });

  it("returns null (and keeps the descriptive label) for a non-standard setting", () => {
    // P2₁/c with the unique axis moved to a (not a tabulated BNS setting).
    const parent = ["x,y,z", "x+1/2,-y,-z+1/2", "-x,-y,-z", "-x+1/2,y,z+1/2"].map((s) => ({
      ...parseSymmetryOperation(s),
      timeReversal: 1 as const,
    }));
    const candidates = generateMagneticCandidates(parent);
    expect(candidates).toHaveLength(4);
    for (const c of candidates) {
      expect(c.standard).toBeNull();
      if (!c.isTypeI) expect(c.label).toContain("primed");
    }
  });
});

describe("formatMagneticSymbol", () => {
  it("converts screw-axis subscripts and preserves primes and bars", () => {
    expect(formatMagneticSymbol("P2_1'/c'")).toBe("P2₁'/c'");
    expect(formatMagneticSymbol("Pn'ma'")).toBe("Pn'ma'");
    expect(formatMagneticSymbol("Fm'-3'm")).toBe("Fm'-3'm");
    expect(formatMagneticSymbol("P6_3/mm'c'")).toBe("P6₃/mm'c'");
  });
});
