import { describe, it, expect } from "vitest";
import { parseInstrumentParameters } from "@/parsers/instrument";

describe("parseInstrumentParameters", () => {
  it("reads a GSAS-II constant-wavelength .instprm incl. Caglioti U,V,W and polarization", () => {
    const text = [
      "#GSAS-II instrument parameter file; do not add/delete items!",
      "Type:PXC",
      "Lam:0.1665",
      "Zero:0.0",
      "Polariz.:0.8442443204963332",
      "U:-46.05407875520966",
      "V:0.0",
      "W:1.208754241879003",
      "X:0.0",
      "SH/L:0.002711817508568138",
      "Bank:1.0",
    ].join("\n");
    const p = parseInstrumentParameters(text);
    expect(p.kind).toBe("constantWavelength");
    if (p.kind !== "constantWavelength") throw new Error("wrong kind");
    expect(p.radiationKind).toBe("xray");
    expect(p.wavelength).toBeCloseTo(0.1665, 6);
    expect(p.zero).toBe(0);
    expect(p.u).toBeCloseTo(-46.054, 3);
    expect(p.v).toBe(0);
    expect(p.w).toBeCloseTo(1.2088, 4);
    expect(p.polarization).toBeCloseTo(0.8442, 4);
  });

  it("still parses a TOF file (difC) without profile terms", () => {
    const p = parseInstrumentParameters("difC: 5000\nZero: -1.2\n");
    expect(p.kind).toBe("tof");
    if (p.kind === "tof") expect(p.difC).toBe(5000);
  });

  it("reads a FullProf constant-wavelength .irf (D1B), converting U,V,W deg²→centideg²", () => {
    const irf = [
      "! Resolution Function of D1B-ILL",
      "JOBT NEUT",
      "PROF     7         0.0354      0.0000      0.0000",
      "WAVE       2.5240      2.5240      1.0000",
      "GEOM DEBY",
      "THRG      10.0000      0.2000     90.0000",
      "!    U-inst      V-inst      W-inst      X-inst     Y-inst     Z-inst",
      "     1.61421    -1.07738     0.36345     0.00000     0.00000     0.00000",
    ].join("\n");
    const p = parseInstrumentParameters(irf);
    expect(p.kind).toBe("constantWavelength");
    if (p.kind !== "constantWavelength") throw new Error("wrong kind");
    expect(p.radiationKind).toBe("neutron");
    expect(p.wavelength).toBeCloseTo(2.524, 4);
    // FullProf degrees² × 10⁴ → GSAS-II centidegrees².
    expect(p.u).toBeCloseTo(16142.1, 1);
    expect(p.v).toBeCloseTo(-10773.8, 1);
    expect(p.w).toBeCloseTo(3634.5, 1);
  });

  it("reads a FullProf TOF .irf (D2TOF) as a difC/difA/difB/Zero calibration", () => {
    const irf = [
      "! POWGEN back-to-back exponential * pseudo-Voigt",
      "NPROF   9",
      "TOFRG    3614.44336      17.74374  175992.84375",
      "D2TOF     22585.74023         3.91547        -0.69671         1.31354",
      "TWOTH      90.000",
    ].join("\n");
    const p = parseInstrumentParameters(irf);
    expect(p.kind).toBe("tof");
    if (p.kind !== "tof") throw new Error("wrong kind");
    expect(p.difC).toBeCloseTo(22585.74, 2);
    expect(p.difA).toBeCloseTo(3.91547, 4);
    expect(p.difB).toBeCloseTo(-0.69671, 4);
    expect(p.zero).toBeCloseTo(1.31354, 4);
  });
});

describe("instrument recognition (facilities registry)", () => {
  it("recognises the beamline named in a FullProf .irf header (D1B → ILL)", () => {
    const irf = "! Resolution Function of D1B-ILL\nJOBT NEUT\nWAVE 2.524 2.524 1.0\nGEOM DEBY\n! U V W\n 1.6 -1.1 0.36 0 0 0\n";
    const p = parseInstrumentParameters(irf);
    expect(p.name).toBe("D1B");
    expect(p.facility).toContain("ILL");
    expect(p.facility).toContain("France");
  });

  it("recognises POWGEN in a header and tags the SNS facility", () => {
    const instprm = "#JANA IRP for POWGEN 2026-A cycle\nType:PNT\ndifC:22586\nZero:0\n";
    const p = parseInstrumentParameters(instprm);
    expect(p.name).toBe("POWGEN");
    expect(p.facility).toContain("SNS");
  });

  it("leaves name/facility unset when no known instrument is named", () => {
    const p = parseInstrumentParameters("Type:PXC\nLam:0.4\n");
    expect(p.name).toBeUndefined();
    expect(p.facility).toBeUndefined();
  });
});
