import { describe, it, expect } from "vitest";
import { extractSizeStrain, williamsonHall, type PeakBreadth } from "@/core/diffraction/microstructure";

describe("extractSizeStrain", () => {
  it("matches the GSAS-II Scherrer constant D = 18000·K·λ/(π·X)", () => {
    const r = extractSizeStrain({ x: 10, y: 0, wavelength: 1.5406, scherrerK: 0.9 });
    const expected = (18000 * 0.9 * 1.5406) / (Math.PI * 10); // Å
    expect(r.sizeAngstrom.value).toBeCloseTo(expected, 6);
    expect(r.sizeNm.value).toBeCloseTo(expected / 10, 6);
    // Pure size term ⇒ no strain.
    expect(r.strain.value).toBe(0);
  });

  it("matches the GSAS-II microstrain constant ε = π·Y/72000 and reports ppm/%", () => {
    const r = extractSizeStrain({ x: 5, y: 20, wavelength: 1.5406 });
    const eps = (Math.PI * 20) / 72000;
    expect(r.strain.value).toBeCloseTo(eps, 10);
    expect(r.strainPpm.value).toBeCloseTo(eps * 1e6, 6);
    expect(r.strainPercent.value).toBeCloseTo(eps * 100, 10);
  });

  it("deconvolutes an instrument standard (breadths subtract; errors add in quadrature)", () => {
    const r = extractSizeStrain({
      x: 12, y: 30, wavelength: 1.0,
      xEsd: 0.5, yEsd: 1.0,
      instrument: { x: 2, y: 5, xEsd: 0.3, yEsd: 0.4 },
    });
    expect(r.deconvoluted).toBe(true);
    expect(r.sampleX).toBeCloseTo(10, 10);
    expect(r.sampleY).toBeCloseTo(25, 10);
    // Size from sample X=10; relative esd = √(0.5²+0.3²)/10.
    const sizeA = (18000 * 0.9 * 1.0) / (Math.PI * 10);
    expect(r.sizeAngstrom.value).toBeCloseTo(sizeA, 6);
    const relX = Math.sqrt(0.5 ** 2 + 0.3 ** 2) / 10;
    expect(r.sizeAngstrom.esd!).toBeCloseTo(sizeA * relX, 6);
  });

  it("flags crystallites larger than the resolution limit", () => {
    const r = extractSizeStrain({ x: 3, y: 10, wavelength: 1.0, instrument: { x: 3.0 } });
    expect(r.sizeAngstrom.value).toBe(Infinity);
    expect(r.notes.join(" ")).toMatch(/larger than the resolution/);
  });

  it("clamps negative deconvoluted strain to ~0 with a note", () => {
    const r = extractSizeStrain({ x: 10, y: 4, wavelength: 1.0, instrument: { y: 6 } });
    expect(r.strain.value).toBe(0);
    expect(r.notes.join(" ")).toMatch(/below the resolution/);
  });
});

describe("williamsonHall", () => {
  it("recovers a known size and strain from synthetic β·cosθ = Kλ/D + 4ε·sinθ", () => {
    const wavelength = 1.5406;
    const K = 0.9;
    const D = 500; // Å (50 nm)
    const eps = 0.002; // 0.2%
    const DEG = Math.PI / 180;
    const peaks: PeakBreadth[] = [10, 20, 35, 50, 65, 80].map((twoTheta) => {
      const th = (twoTheta / 2) * DEG;
      // β(2θ, rad) = Kλ/(D cosθ) + 4ε tanθ; convert to degrees for the input.
      const betaRad = (K * wavelength) / (D * Math.cos(th)) + 4 * eps * Math.tan(th);
      return { thetaDeg: twoTheta / 2, breadthDeg: betaRad / DEG };
    });
    const r = williamsonHall(peaks, wavelength, K);
    expect(r.sizeNm).toBeCloseTo(D / 10, 4);
    expect(r.strain).toBeCloseTo(eps, 6);
    expect(r.rSquared).toBeGreaterThan(0.999);
  });
});
