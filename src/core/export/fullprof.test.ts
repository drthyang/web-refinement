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

describe("structureToPcr — TOF", () => {
  const pcr = structureToPcr(structure, {
    title: "MnO_TOF",
    datFile: "mno.dat",
    instrument: { kind: "tof", difC: 22585.8, difA: -3.55, difB: 0.24, zero: -15.13 },
    dataRange: [14300, 282000],
    background: [[14300, 20], [150000, 15], [282000, 12]],
  });
  const lines = pcr.split("\n");

  it("selects the TOF job/profile (Job −1, Npr 9) and TOF header blocks", () => {
    const jobIdx = lines.findIndex((l) => l.startsWith("!Job"));
    const flags = lines[jobIdx + 1]!.trim().split(/\s+/).map(Number);
    expect(flags[0]).toBe(-1); // Job = neutron TOF
    expect(flags[1]).toBe(9); // Npr = back-to-back exp ⊗ pV
    expect(flags[3]).toBe(3); // Nba matches the 3 background points
    for (const marker of ["TOF-min", "Dtt1", "2ThetaBank", "alph0", "Sig-2", "Back-to-back"]) {
      expect(pcr).toContain(marker);
    }
    // Phase profile number is 9, not the CW 7.
    const natIdx = lines.findIndex((l) => l.includes("!Nat Dis Ang"));
    const phaseFlags = lines[natIdx + 1]!.trim().split(/\s+/).map(Number);
    expect(phaseFlags[phaseFlags.length - 2]).toBe(9);
    expect(pcr).not.toContain("Lambda1  Lambda2"); // no CW wavelength block
  });

  it("maps difC/difA/difB/Zero onto Dtt1/Dtt2/Dtt_1overd/Zero", () => {
    const hdr = lines.findIndex((l) => l.includes("Zero") && l.includes("Dtt1") && l.includes("2ThetaBank"));
    const vals = lines[hdr + 1]!.trim().split(/\s+/).map(Number);
    // Zero Code Dtt1 Code Dtt2 Code Dtt_1overd Code 2ThetaBank
    expect(vals[0]).toBeCloseTo(-15.13, 2);
    expect(vals[2]).toBeCloseTo(22585.8, 1);
    expect(vals[4]).toBeCloseTo(-3.55, 2);
    expect(vals[6]).toBeCloseTo(0.24, 2);
  });

  it("uses the TOF data range for the plot range", () => {
    const plotIdx = lines.findIndex((l) => l.includes("2Th1/TOF1"));
    const vals = lines[plotIdx + 1]!.trim().split(/\s+/).map(Number);
    expect(vals[0]).toBeCloseTo(14300, 0);
    expect(vals[1]).toBeCloseTo(282000, 0);
  });
});
