import { describe, it, expect } from "vitest";
import { tofFromD, dFromTof, twoThetaFromD, dFromTwoTheta } from "@/core/diffraction/instrument";
import { parseInstrumentParameters } from "@/parsers/instrument";

// POWGEN 30 K bank calibration from the GSAS-II .lst.
const tofParams = { kind: "tof" as const, difC: 22579.737079, difA: -2.39, difB: -0.097, zero: -0.316 };

describe("TOF instrument conversion (POWGEN 30 K calibration)", () => {
  it("reproduces GSAS-II TOF for d = 4.72638 Å (≈ 106672 μs)", () => {
    // GSAS-II reflection list: d = 4.72638 → TOF = 106671.82 μs.
    const tof = tofFromD(tofParams, 4.72638);
    expect(Math.abs(tof - 106671.82)).toBeLessThan(15);
  });

  it("round-trips d → TOF → d to high precision", () => {
    for (const d of [1.0, 2.31, 3.16, 4.72638]) {
      expect(dFromTof(tofParams, tofFromD(tofParams, d))).toBeCloseTo(d, 8);
    }
  });

  it("TOF increases monotonically with d", () => {
    expect(tofFromD(tofParams, 2)).toBeLessThan(tofFromD(tofParams, 3));
  });
});

describe("constant-wavelength conversion", () => {
  const cw = { kind: "constantWavelength" as const, wavelength: 1.54 };
  it("round-trips d → 2θ → d", () => {
    expect(dFromTwoTheta(cw, twoThetaFromD(cw, 2.5))).toBeCloseTo(2.5, 8);
  });
});

describe("parseInstrumentParameters", () => {
  it("parses a GSAS-II-style TOF instprm", () => {
    const p = parseInstrumentParameters("#GSAS-II\nType:PNT\ndifC:22579.737\ndifA:-2.39\nZero:-0.316\n");
    expect(p.kind).toBe("tof");
    if (p.kind === "tof") {
      expect(p.difC).toBeCloseTo(22579.737, 3);
      expect(p.zero).toBeCloseTo(-0.316, 3);
    }
  });
  it("parses a constant-wavelength instprm", () => {
    const p = parseInstrumentParameters("Lam:1.5406\nZero:0.01\n");
    expect(p.kind).toBe("constantWavelength");
    if (p.kind === "constantWavelength") expect(p.wavelength).toBeCloseTo(1.5406, 4);
  });
});
