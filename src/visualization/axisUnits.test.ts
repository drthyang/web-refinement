import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import {
  axisContext,
  availableDisplayUnits,
  convertAxisValue,
  convertInterval,
} from "@/visualization/axisUnits";

function pattern(xUnit: PowderPattern["xUnit"], extra: Partial<PowderPattern> = {}): PowderPattern {
  return {
    id: "p", name: "p", xUnit,
    radiation: xUnit === "tof" ? { kind: "neutron-tof" } : { kind: "neutron", wavelength: 1.54 },
    points: [{ x: 1, yObs: 0 }],
    ...extra,
  } as PowderPattern;
}

describe("availableDisplayUnits", () => {
  it("offers TOF only for TOF data, never for constant-wavelength", () => {
    const tof: InstrumentParameters = { kind: "tof", difC: 22585.8 };
    const cw: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };
    expect(availableDisplayUnits(axisContext(pattern("tof"), tof))).toEqual(["tof", "dSpacing", "q"]);
    const cwUnits = availableDisplayUnits(axisContext(pattern("twoTheta"), cw));
    expect(cwUnits).toContain("twoTheta");
    expect(cwUnits).toContain("dSpacing");
    expect(cwUnits).toContain("q");
    expect(cwUnits).not.toContain("tof");
  });

  it("omits 2θ for TOF data (no fixed wavelength)", () => {
    const units = availableDisplayUnits(axisContext(pattern("tof"), { kind: "tof", difC: 22585.8 }));
    expect(units).not.toContain("twoTheta");
  });
});

describe("convertAxisValue", () => {
  const cwCtx = axisContext(pattern("twoTheta"), { kind: "constantWavelength", wavelength: 1.54 });
  const tofCtx = axisContext(pattern("tof"), { kind: "tof", difC: 22585.8 });

  it("d ↔ Q is 2π/d", () => {
    expect(convertAxisValue(2, "dSpacing", "q", cwCtx)).toBeCloseTo(Math.PI, 6);
    expect(convertAxisValue(Math.PI, "q", "dSpacing", cwCtx)).toBeCloseTo(2, 6);
  });

  it("2θ → d → 2θ round-trips (constant wavelength)", () => {
    const d = convertAxisValue(40, "twoTheta", "dSpacing", cwCtx);
    expect(d).toBeCloseTo(1.54 / (2 * Math.sin(20 * Math.PI / 180)), 6);
    expect(convertAxisValue(d, "dSpacing", "twoTheta", cwCtx)).toBeCloseTo(40, 6);
  });

  it("TOF → d uses difC (TOF = difC·d)", () => {
    expect(convertAxisValue(45171.6, "tof", "dSpacing", tofCtx)).toBeCloseTo(2, 4);
    expect(convertAxisValue(2, "dSpacing", "tof", tofCtx)).toBeCloseTo(45171.6, 1);
  });
});

describe("convertInterval", () => {
  it("re-sorts endpoints when the conversion reverses ordering (2θ→d)", () => {
    const ctx = axisContext(pattern("twoTheta"), { kind: "constantWavelength", wavelength: 1.54 });
    const iv = convertInterval({ min: 20, max: 60 }, "twoTheta", "dSpacing", ctx);
    // Larger 2θ ⇒ smaller d, so min/max swap but stay ordered min < max.
    expect(iv.min).toBeLessThan(iv.max);
    expect(iv.max).toBeCloseTo(convertAxisValue(20, "twoTheta", "dSpacing", ctx), 6);
    expect(iv.min).toBeCloseTo(convertAxisValue(60, "twoTheta", "dSpacing", ctx), 6);
  });
});
