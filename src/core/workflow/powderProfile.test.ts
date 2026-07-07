import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding } from "@/core/refinement/types";
import { exampleStructure } from "@/examples/mn3ga";
import { applyParameters } from "@/core/workflow/apply";
import { buildPeaks } from "@/core/workflow/powder";

const pattern: PowderPattern = {
  id: "p", name: "p", xUnit: "twoTheta",
  radiation: { kind: "xray", wavelength: 1.54 }, wavelength: 1.54,
  points: Array.from({ length: 400 }, (_, i) => ({ x: 10 + (i * 100) / 400, yObs: 0 })),
};

function applied(values: Record<string, number>, bindings: ParameterBinding[]) {
  return applyParameters(exampleStructure(), bindings, values);
}

describe("Caglioti profile + zero shift in buildPeaks", () => {
  it("gives an angle-dependent FWHM when U,V,W are supplied", () => {
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
      { parameterId: "u", kind: "profileU", targetId: pattern.id },
      { parameterId: "v", kind: "profileV", targetId: pattern.id },
      { parameterId: "w", kind: "profileW", targetId: pattern.id },
    ];
    // Positive U,V so FWHM grows with 2θ (avoids the negative-U low-angle case).
    const a = applied({ scale: 1, u: 20, v: 5, w: 4 }, bindings);
    expect(a.caglioti).toEqual({ u: 20, v: 5, w: 4 });
    const peaks = buildPeaks(pattern, a, false).slice().sort((p, q) => p.center - q.center);
    const low = peaks[0]!;
    const high = peaks[peaks.length - 1]!;
    // Widths differ across the pattern (not a single constant FWHM).
    expect(high.fwhm).toBeGreaterThan(low.fwhm);
  });

  it("uses a single constant width when no Caglioti terms are present", () => {
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
      { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
    ];
    const a = applied({ scale: 1, width: 0.3 }, bindings);
    expect(a.caglioti).toBeUndefined();
    const peaks = buildPeaks(pattern, a, false);
    expect(peaks.every((p) => Math.abs(p.fwhm - 0.3) < 1e-9)).toBe(true);
  });

  it("shifts every peak center by the zero-shift parameter", () => {
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
      { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
      { parameterId: "z", kind: "zeroShift", targetId: pattern.id },
    ];
    const base = buildPeaks(pattern, applied({ scale: 1, width: 0.3, z: 0 }, bindings), false);
    const shifted = buildPeaks(pattern, applied({ scale: 1, width: 0.3, z: 0.05 }, bindings), false);
    expect(shifted.length).toBe(base.length);
    for (let i = 0; i < base.length; i++) {
      expect(shifted[i]!.center - base[i]!.center).toBeCloseTo(0.05, 9);
    }
  });
});
