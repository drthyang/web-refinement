import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { structureToPcr } from "@/core/export/fullprof";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";

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

  it("writes a lab tube's Kα₂ as Lambda2 and Ratio, and a neutron beam as one line", () => {
    const tube = structureToPcr(structure, { instrument: { kind: "constantWavelength", radiationKind: "xray", wavelength: 1.5405, kAlpha2: { wavelength: 1.5443, ratio: 0.5 } } });
    expect(tube).toMatch(/1\.540500\s+1\.544300\s+0\.50000/);
    expect(pcr).toMatch(/1\.900000\s+1\.900000\s+0\.00000/);
  });

  it("writes the wavelength and the refined cell", () => {
    expect(pcr).toContain("1.900000 1.900000");
    expect(pcr).toMatch(/4\.445000\s+4\.445000\s+4\.445000\s+90\.000000\s+90\.000000\s+90\.000000/);
  });

  it("writes an anisotropic ADP as FullProf betas (N_t = 2, Biso 0)", () => {
    const aniso = structureToPcr({
      ...structure,
      sites: [{ label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "anisotropic", uAniso: [0.01, 0.01, 0.01, 0, 0, 0] } }],
    });
    expect(aniso).toMatch(/Fe1\s+Fe\s+0\.00000\s+0\.00000\s+0\.00000\s+0\.00000\s+1\.00000\s+0\s+0\s+2/);
    // β11 = 2π²·a*²·U11 = 2π²·0.01/4.445² ≈ 0.009990.
    const rows = aniso.split("\n");
    const betas = rows[rows.findIndex((l) => l.startsWith("Fe1")) + 2]!.trim().split(/\s+/).map(Number);
    expect(betas[0]).toBeCloseTo((2 * Math.PI ** 2 * 0.01) / 4.445 ** 2, 5);
    expect(betas[3]).toBe(0);
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

  // Regression: a TOF .pcr with every Sig/alph/beta coefficient at 0 and no
  // resolution file makes FullProf refuse to load it ("Zero half-width
  // parameters ... and NO resolution-file provided"). With no shape info, the
  // export must fall back to loadable, non-zero seeds instead of zeros.
  it("never emits all-zero half-widths when no shape is known", () => {
    const sigIdx = lines.findIndex((l) => l.includes("sigma^2 = Sig-2"));
    const sig = lines[sigIdx + 1]!.trim().split(/\s+/).map(Number);
    // Sig-1 (index 1) is seeded from (difC·Δd/d)² — must be > 0.
    expect(sig[1]).toBeGreaterThan(0);
    const bbIdx = lines.findIndex((l) => l.includes("alpha = alph0 + alph1/d"));
    const bb = lines[bbIdx + 1]!.trim().split(/\s+/).map(Number);
    // Row is Pref1 Pref2 alph0 beta0 alph1 beta1 alphQ betaQ — beta0 (index 3)
    // and alph1 (index 4) are seeded to moderator-scale defaults.
    expect(bb[3]).toBeGreaterThan(0);
    expect(bb[4]).toBeGreaterThan(0);
  });

  it("writes the refined TOF shape coefficients when supplied", () => {
    const withShape = structureToPcr(structure, {
      title: "MnO_TOF",
      instrument: { kind: "tof", difC: 22585.8 },
      dataRange: [14300, 282000],
      tofShape: { sig0: 12.5, sig1: 340.2, sig2: 1.1, alpha0: 0.3, alpha1: 2.1, beta0: 0.031, beta1: 5.5 },
    }).split("\n");
    const sigIdx = withShape.findIndex((l) => l.includes("sigma^2 = Sig-2"));
    const sig = withShape[sigIdx + 1]!.trim().split(/\s+/).map(Number);
    expect(sig[0]).toBeCloseTo(1.1, 4); // Sig-2
    expect(sig[1]).toBeCloseTo(340.2, 4); // Sig-1
    expect(sig[2]).toBeCloseTo(12.5, 4); // Sig-0
    const bbIdx = withShape.findIndex((l) => l.includes("alpha = alph0 + alph1/d"));
    const bb = withShape[bbIdx + 1]!.trim().split(/\s+/).map(Number);
    // Pref1 Pref2 alph0 beta0 alph1 beta1 alphQ betaQ
    expect(bb[2]).toBeCloseTo(0.3, 4); // alph0
    expect(bb[3]).toBeCloseTo(0.031, 4); // beta0
    expect(bb[4]).toBeCloseTo(2.1, 4); // alph1
    expect(bb[5]).toBeCloseTo(5.5, 4); // beta1
  });
});

describe("structureToPcr — space-group symbol of a phase read without one", () => {
  const symbolLine = (pcr: string): string => pcr.split("\n").find((l) => l.includes("<--Space group symbol"))!.trim();

  it("names the setting its operations are (it was written as P 1)", () => {
    const ops = buildSpaceGroup("P 1 21/n 1").operations;
    const pcr = structureToPcr({ ...structure, spaceGroup: { operations: ops } });
    expect(symbolLine(pcr)).toMatch(/^P 1 21\/n 1\s+<--Space group symbol$/);
  });

  it("refuses operations that no symbol reproduces", () => {
    const shifted = ["x,y,z", "-x+1/2,-y,-z"].map(parseSymmetryOperation);
    expect(() => structureToPcr({ ...structure, spaceGroup: { operations: shifted } })).toThrow(
      /FullProf export: phase "MnO" has 2 symmetry operations, no space-group symbol/,
    );
  });
});
