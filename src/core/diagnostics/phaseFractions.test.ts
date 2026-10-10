import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse_structure, simulate_pattern } from "@/mcp/tools";
import { cellContentsMass, atomicWeight } from "@/core/crystal/atomicMass";
import { cellVolume } from "@/core/crystal/unitCell";
import { formatWt, fractionsOf, phaseWeightFractions } from "@/core/diagnostics/phaseFractions";

const read = (f: string): string => readFileSync(`examples/mcp/${f}`, "utf8");
const mno = parse_structure({ cif: read("mno.cif") }).structure;
const mn3ga = parse_structure({ cif: read("mn3ga.cif") }).structure;

describe("quantitative phase analysis", () => {
  it("weighs a cell's contents: MnO is four formula units", () => {
    expect(atomicWeight("Mn")).toBe(54.938);
    expect(cellContentsMass(mno)).toBeCloseTo(4 * (54.938 + 15.999), 6);
  });

  it("returns the weight fractions a mixture was made with (Hill & Howard)", () => {
    // Build the pattern a 90/10 wt% mixture gives under this engine's intensity
    // convention (S · m · Lp · |F|², no 1/V²): S_p ∝ W_p / (ZMV)_p.
    const inst = { kind: "constantWavelength" as const, radiationKind: "xray" as const, wavelength: 1.5406, u: 20, v: -12, w: 30 };
    const a = simulate_pattern({ structure: mn3ga, instrument: inst, xMin: 15, xMax: 110, points: 3000 }).curves.yCalc;
    const b = simulate_pattern({ structure: mno, instrument: inst, xMin: 15, xMax: 110, points: 3000 }).curves.yCalc;
    const zmv = [mn3ga, mno].map((s) => cellContentsMass(s) * cellVolume(s.cell));
    const s1 = (0.9 / zmv[0]!) * 1e4;
    const s2 = (0.1 / zmv[1]!) * 1e4;
    const y = a.map((v, i) => s1 * v + s2 * b[i]!);
    // Refit the two scales (linear least squares on the noise-free sum).
    let aa = 0, ab = 0, bb = 0, ay = 0, by = 0;
    a.forEach((v, i) => { aa += v * v; ab += v * b[i]!; bb += b[i]! * b[i]!; ay += v * y[i]!; by += b[i]! * y[i]!; });
    const det = aa * bb - ab * ab;
    const fit1 = (ay * bb - by * ab) / det;
    const fit2 = (by * aa - ay * ab) / det;
    const w = phaseWeightFractions([
      { id: "a", name: "Mn3Ga", structure: mn3ga, scale: fit1, scaleEsd: fit1 * 0.01 },
      { id: "b", name: "MnO", structure: mno, scale: fit2, scaleEsd: fit2 * 0.01 },
    ]);
    expect(w[0]!.weightPercent).toBeCloseTo(90, 6);
    expect(w[1]!.weightPercent).toBeCloseTo(10, 6);
    // 1% scale esds on 90/10 give about 0.13 wt% on each.
    expect(w[1]!.esd!).toBeCloseTo(w[0]!.esd!, 9);
    expect(w[1]!.esd!).toBeGreaterThan(0.1);
    expect(w[1]!.esd!).toBeLessThan(0.2);
  });

  it("needs two phases", () => {
    expect(() => phaseWeightFractions([{ id: "a", name: "MnO", structure: mno, scale: 1 }])).toThrow(/at least two phases/);
  });
});

describe("fractions from a refinement", () => {
  it("reads each phase's scale by its id and writes the esd in the last digit", () => {
    const param = (id: string, value: number) => ({ id, label: id, kind: "scale" as const, value, initialValue: value, fixed: false });
    const result = { status: "converged" as const, parameters: {}, esd: { p0_scale: 1e-5, p1_scale: 4e-6 }, agreement: { rFactor: 0.05 }, history: [] };
    const f = fractionsOf([mn3ga, mno], [param("p0_scale", 0.00248), param("p1_scale", 0.000193)], result)!;
    expect(f.map((x) => x.name)).toEqual(["Mn3Ga", "MnO"]);
    expect(f[0]!.weightPercent + f[1]!.weightPercent).toBeCloseTo(100, 9);
    expect(formatWt({ id: "x", name: "MnO", weightPercent: 3.8213, esd: 0.0862 })).toBe("3.82(9) wt%");
    expect(formatWt({ id: "x", name: "MnO", weightPercent: 3.8213, esd: 0.12 })).toBe("3.8(1) wt%");
    expect(formatWt({ id: "x", name: "MnO", weightPercent: 3.8213 })).toBe("3.8 wt%");
    // A phase without a scale gives nothing rather than a wrong split.
    expect(fractionsOf([mn3ga, mno], [param("p0_scale", 1)], result)).toBeNull();
  });
});
