import { describe, it, expect } from "vitest";
import { exampleStructure } from "@/examples/mn3ga";
import { buildPowderSpec } from "@/app/powderSpec";
import { powderCurves } from "@/core/workflow/powder";
import { stephensStrainSigmaTof, quarticStrainInvariants } from "@/core/diffraction/anisoStrain";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";

const structure = exampleStructure();
const inst: InstrumentParameters = { kind: "tof", difC: 22585.8 };
// A TOF grid covering the Mn₃Ga d-range (T = difC·d, difC ≈ 22586 → d ≈ 0.9–4.6 Å).
const points = Array.from({ length: 3000 }, (_, i) => ({ x: 20000 + i * 30, yObs: 0, sigma: 1 }));
const pattern: PowderPattern = { id: "p", name: "p", xUnit: "tof", radiation: { kind: "neutron-tof" }, wavelength: 0, points };

describe("TOF anisotropic microstrain (Stephens)", () => {
  it("stephensStrainSigmaTof: zero for no strain, positive and difC-scaled otherwise", () => {
    const inv = quarticStrainInvariants(structure.spaceGroup.operations);
    const zeros = inv.map(() => 0);
    expect(stephensStrainSigmaTof(1, 1, 0, structure.cell, inst, zeros, inv)).toBe(0);
    const s = inv.map((_, i) => (i === 0 ? 1e-4 : 0));
    const sig = stephensStrainSigmaTof(1, 1, 0, structure.cell, inst, s, inv);
    expect(sig).toBeGreaterThan(0);
    // Linear in difC (broadening maps through dT/dd ≈ difC).
    const sig2x = stephensStrainSigmaTof(1, 1, 0, structure.cell, { difC: 2 * inst.difC }, s, inv);
    expect(sig2x).toBeCloseTo(2 * sig, 6);
  });

  it("buildPowderSpec emits Stephens params for TOF only when microstrain is on", () => {
    expect(buildPowderSpec(structure, pattern, inst, true, 4, {}, "isotropic").params.some((p) => p.kind === "stephensStrain")).toBe(false);
    const on = buildPowderSpec(structure, pattern, inst, true, 4, {}, "generalized");
    expect(on.params.filter((p) => p.kind === "stephensStrain").length).toBeGreaterThan(0);
  });

  it("isotropic Mustrain emits a µstrain sample parameter and drops the degenerate σ₁²", () => {
    const iso = buildPowderSpec(structure, pattern, inst, true, 4, {}, "isotropic");
    // The isotropic Mustrain carries the ∝d² strain term as a physical µstrain…
    const mu = iso.params.find((p) => p.kind === "mustrainIso");
    expect(mu).toBeDefined();
    expect(mu!.value).toBeCloseTo(0.0015 * 1e6, 6); // seeded from the resolution
    expect(mu!.fixed).toBe(true); // fixed on load; freed in the profile stage (it carries the σ₁² width term)
    // …so the redundant σ₁² tofProfile row is not emitted (avoids exact degeneracy).
    expect(iso.params.some((p) => p.id === "tof_sig1")).toBe(false);
    // Generalized keeps σ₁² (the isotropic base) + Stephens, and has no mustrainIso.
    const gen = buildPowderSpec(structure, pattern, inst, true, 4, {}, "generalized");
    expect(gen.params.some((p) => p.id === "tof_sig1")).toBe(true);
    expect(gen.params.some((p) => p.kind === "mustrainIso")).toBe(false);
  });

  it("raising the isotropic Mustrain above its seed broadens the TOF peaks (lower maxima)", () => {
    const iso = buildPowderSpec(structure, pattern, inst, true, 4, {}, "isotropic");
    const withScale = (ps: typeof iso.params) => ps.map((p) => (p.kind === "scale" ? { ...p, value: 1 } : p));
    const base = powderCurves(structure, pattern, withScale(iso.params), iso.bindings, iso.profile);
    const broadened = withScale(iso.params).map((p) => (p.kind === "mustrainIso" ? { ...p, value: 6000 } : p));
    const cBroad = powderCurves(structure, pattern, broadened, iso.bindings, iso.profile);
    expect(cBroad.yCalc.some((v) => Number.isNaN(v))).toBe(false);
    expect(Math.max(...cBroad.yCalc)).toBeLessThan(0.95 * Math.max(...base.yCalc)); // broadened
    expect(Math.max(...cBroad.yCalc)).toBeGreaterThan(0.05 * Math.max(...base.yCalc)); // still peaked
  });

  it("S=0 is identical to no-microstrain; S>0 broadens the TOF peaks (lower maxima)", () => {
    const setScale = (ps: typeof off.params) => ps.map((p) => (p.kind === "scale" ? { ...p, value: 1 } : p));
    const off = buildPowderSpec(structure, pattern, inst, true, 4, {}, "isotropic");
    const on = buildPowderSpec(structure, pattern, inst, true, 4, {}, "generalized");
    const cOff = powderCurves(structure, pattern, setScale(off.params), off.bindings, off.profile);
    const cOnS0 = powderCurves(structure, pattern, setScale(on.params), on.bindings, on.profile);
    // Seeded at zero → identical calc.
    const maxDiff = Math.max(...cOff.yCalc.map((v, i) => Math.abs(v - cOnS0.yCalc[i]!)));
    expect(maxDiff).toBeLessThan(1e-6 * Math.max(...cOff.yCalc, 1));

    // A real strain spreads each peak, so the tallest drops while total area holds.
    const strained = setScale(on.params).map((p) => (p.kind === "stephensStrain" ? { ...p, value: 1e-5 } : p));
    const cStrain = powderCurves(structure, pattern, strained, on.bindings, on.profile);
    const peakMax = Math.max(...cOnS0.yCalc);
    expect(Math.max(...cStrain.yCalc)).toBeLessThan(0.95 * peakMax); // broadened
    expect(Math.max(...cStrain.yCalc)).toBeGreaterThan(0.05 * peakMax); // still peaked
  });
});
