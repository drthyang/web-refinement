import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import {
  PEAK_CORRECTIONS,
  CORRECTION_KINDS,
  SHARED_CORRECTION_KINDS,
  correctionsForPattern,
  correctionById,
  correctionCorrelation,
  isCorrectionKind,
} from "@/core/diffraction/corrections";

const cw = (xUnit: PowderPattern["xUnit"], kind: PowderPattern["radiation"]["kind"] = "xray"): PowderPattern => ({
  id: "p", name: "p", xUnit,
  radiation: kind === "neutron-tof" ? { kind } : { kind, wavelength: 1.54 } as PowderPattern["radiation"],
  points: [],
});

describe("correction registry — self-consistency", () => {
  it("CORRECTION_KINDS is exactly the params' kinds, and each id is unique", () => {
    const kinds = PEAK_CORRECTIONS.flatMap((c) => c.params.map((p) => p.kind));
    expect([...CORRECTION_KINDS].sort()).toEqual([...kinds].sort());
    for (const k of CORRECTION_KINDS) expect(isCorrectionKind(k)).toBe(true);
    const ids = PEAK_CORRECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shared kinds are those of shared corrections (absorption is per-phase)", () => {
    expect([...SHARED_CORRECTION_KINDS].sort()).toEqual(
      ["sampleDisplacement", "sampleTransparency", "surfaceRoughA", "surfaceRoughB"].sort(),
    );
    expect(SHARED_CORRECTION_KINDS).not.toContain("absorption");
  });

  it("every param seed is a non-identity starting value within its bounds", () => {
    for (const c of PEAK_CORRECTIONS) {
      for (const p of c.params) {
        if (p.min !== undefined) expect(p.seed).toBeGreaterThanOrEqual(p.min);
        if (p.max !== undefined) expect(p.seed).toBeLessThanOrEqual(p.max);
      }
    }
  });
});

describe("correctionsForPattern — geometry gating", () => {
  it("CW 2θ: displacement/transparency are positional, absorption/roughness are intensity", () => {
    const c = correctionsForPattern(cw("twoTheta"), {});
    expect(c.positional.map((x) => x.id)).toEqual(["displacement", "transparency"]);
    expect(c.intensity.map((x) => x.id)).toEqual(["absorption", "roughness"]);
    expect(c.anyPositional).toBe(false); // identity values ⇒ nothing active
  });

  it("d-spacing and TOF patterns get no peak corrections", () => {
    for (const p of [cw("dSpacing"), cw("tof", "neutron-tof")]) {
      const c = correctionsForPattern(p, { sampleDisplacement: 0.1, absorption: 0.5 });
      expect(c.positional).toHaveLength(0);
      expect(c.intensity).toHaveLength(0);
      expect(c.anyPositional).toBe(false);
    }
  });

  it("anyPositional flips true once a position correction is non-identity", () => {
    expect(correctionsForPattern(cw("twoTheta"), { sampleDisplacement: 0.05 }).anyPositional).toBe(true);
    expect(correctionsForPattern(cw("twoTheta"), { sampleTransparency: -0.02 }).anyPositional).toBe(true);
  });
});

describe("correction hooks — identity is a no-op", () => {
  it("position shifts are 0 and intensity factors are 1 at identity values", () => {
    for (const c of PEAK_CORRECTIONS) {
      if (c.positionShift) expect(c.positionShift({}, 30)).toBe(0);
      if (c.intensityFactor) expect(c.intensityFactor({}, 30)).toBe(1);
    }
  });

  it("displacement is D·cosθ and transparency is T·sin2θ at the Bragg angle", () => {
    const twoTheta = 40;
    const theta = (twoTheta / 2) * (Math.PI / 180);
    expect(correctionById("displacement")!.positionShift!({ sampleDisplacement: 0.1 }, twoTheta)).toBeCloseTo(0.1 * Math.cos(theta), 12);
    expect(correctionById("transparency")!.positionShift!({ sampleTransparency: 0.1 }, twoTheta)).toBeCloseTo(0.1 * Math.sin(2 * theta), 12);
  });
});

describe("correctionCorrelation", () => {
  it("returns a message for a correction-owned pair, order-independent", () => {
    const m = correctionCorrelation("surfaceRoughA", "surfaceRoughB");
    expect(m).toBeTruthy();
    expect(correctionCorrelation("surfaceRoughB", "surfaceRoughA")).toBe(m);
  });

  it("returns undefined for an unrelated pair", () => {
    expect(correctionCorrelation("scale", "cellAngle")).toBeUndefined();
  });
});
