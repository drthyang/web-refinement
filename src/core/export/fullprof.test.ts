import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { structureToPcr } from "@/core/export/fullprof";

const identity = parseSymmetryOperation("x,y,z");
const structure: StructureModel = {
  id: "t",
  name: "MnO",
  cell: { a: 4.445, b: 4.445, c: 4.445, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "F m -3 m", operations: [identity] },
  sites: [
    { label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
    { label: "O1", element: "O", position: [0.5, 0.5, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.6 } },
  ],
};

describe("structureToPcr", () => {
  const pcr = structureToPcr(structure, { wavelength: 1.9, datFile: "mno.dat", background: [[2, 40], [65, 30], [130, 35]] });
  const lines = pcr.split("\n");

  it("emits the FullProf section skeleton in order", () => {
    expect(pcr.startsWith("COMM MnO")).toBe(true);
    for (const marker of [
      "!Job Npr Nph Nba Nex",
      "! Lambda1  Lambda2",
      "!Number of refined parameters",
      "!Nat Dis Ang Pr1",
      "<--Space group symbol",
      "!Atom   Typ",
      "#Cell Info",
    ]) {
      expect(pcr).toContain(marker);
    }
  });

  it("keeps Nba consistent with the background block", () => {
    const jobIdx = lines.findIndex((l) => l.startsWith("!Job"));
    const nba = lines[jobIdx + 1]!.trim().split(/\s+/).map(Number)[3];
    expect(nba).toBe(3); // three background points supplied
    const bkgHeader = lines.findIndex((l) => l.includes("Background  for Pattern"));
    // The three points sit between the header and the next comment line.
    const block = lines.slice(bkgHeader + 1, bkgHeader + 1 + 3);
    expect(block.every((l) => /^\s+[\d.]+\s+[\d.]+/.test(l))).toBe(true);
  });

  it("writes Nat, the space group, and one atom + code line per site", () => {
    const natIdx = lines.findIndex((l) => l.includes("!Nat Dis Ang"));
    expect(lines[natIdx + 1]!.trim().split(/\s+/).map(Number)[0]).toBe(2); // 2 sites
    expect(pcr).toContain("F m -3 m");
    expect(pcr).toMatch(/Mn1\s+Mn\s+0\.00000\s+0\.00000\s+0\.00000\s+0\.50000\s+1\.00000/);
    expect(pcr).toMatch(/O1\s+O\s+0\.50000\s+0\.50000\s+0\.50000\s+0\.60000\s+1\.00000/);
  });

  it("writes the wavelength and the refined cell", () => {
    expect(pcr).toContain("1.900000 1.900000");
    expect(pcr).toMatch(/4\.445000\s+4\.445000\s+4\.445000\s+90\.000000\s+90\.000000\s+90\.000000/);
  });

  it("converts an anisotropic ADP to an equivalent B_iso", () => {
    const aniso = structureToPcr({
      ...structure,
      sites: [{ label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "anisotropic", uAniso: [0.01, 0.01, 0.01, 0, 0, 0] } }],
    });
    // U_eq = 0.01 → B_iso = 8π²·0.01 ≈ 0.7896.
    expect(aniso).toMatch(/Fe1\s+Fe\s+0\.00000\s+0\.00000\s+0\.00000\s+0\.78957/);
  });
});
