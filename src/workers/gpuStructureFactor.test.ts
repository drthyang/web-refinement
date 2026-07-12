import { describe, it, expect } from "vitest";
import { ATOM_STRIDE, ELEM_STRIDE, STRUCTURE_FACTOR_WGSL, structureFactorInputs } from "@/workers/gpuStructureFactor";
import { expandStructureAtoms, nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { generateReflections } from "@/core/diffraction/reflections";
import { neutronScatteringLength } from "@/core/scattering/neutron";
import { xrayFormFactor } from "@/core/scattering/xray";
import { exampleStructure } from "@/examples/mn3ga";
import type { Radiation } from "@/core/diffraction/types";
import type { StructureModel } from "@/core/crystal/types";

/**
 * GPU structure-factor kernel — the parts validatable WITHOUT a GPU (node/CI).
 * The kernel numerics themselves are validated on hardware via
 * gpuValidationHarness.ts (WebGPU is browser-only); here we lock the two
 * failure modes CI can catch:
 *   1. struct/stride mismatch — the WGSL Atom/Elem field counts must equal the
 *      JS marshaling strides (a 15-vs-16 Elem mismatch once zeroed the second
 *      element's scattering, visible only in-browser);
 *   2. marshaling/formula drift — the atom list, s, reciprocal metric and
 *      element tables the kernel is fed, summed with the kernel's own formula in
 *      f64, must reproduce the CPU structure factor.
 */

/** Count `name: f32|u32` field declarations inside a named WGSL struct. */
function wgslFieldCount(name: string): number {
  const m = STRUCTURE_FACTOR_WGSL.match(new RegExp(`struct ${name}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`struct ${name} not found in WGSL`);
  return (m[1]!.match(/\b\w+\s*:\s*(f32|u32)\b/g) ?? []).length;
}

/**
 * f64 reference of the WGSL kernel's per-atom sum, over the SAME inputs the GPU
 * path marshals. If this matches the CPU structure factor, the CPU-side contract
 * (atom list, s, reciprocal, element tables) is intact.
 */
function kernelReference(model: StructureModel, radiation: Radiation, h: number, k: number, l: number): number {
  const atoms = expandStructureAtoms(model);
  const { reflections, reciprocal } = structureFactorInputs(model, [{ h, k, l }]);
  const s = reflections[0]!.s;
  const { as, bs, cs } = reciprocal;
  let fr = 0;
  let fi = 0;
  for (const a of atoms) {
    const b = radiation.kind === "xray" ? xrayFormFactor(a.element, s) : neutronScatteringLength(a.element, a.isotope);
    let dw: number;
    if (a.adp.kind === "isotropic") {
      dw = Math.exp(-a.adp.bIso * s * s);
    } else {
      const [u11, u22, u33, u12, u13, u23] = a.adp.uAniso;
      const expo = u11 * h * h * as * as + u22 * k * k * bs * bs + u33 * l * l * cs * cs
        + 2 * u12 * h * k * as * bs + 2 * u13 * h * l * as * cs + 2 * u23 * k * l * bs * cs;
      dw = Math.exp(-2 * Math.PI * Math.PI * expo);
    }
    const w = a.occupancy * b * dw;
    const arg = h * a.position[0]! + k * a.position[1]! + l * a.position[2]!;
    const frac = arg - Math.floor(arg);
    const phase = 2 * Math.PI * frac;
    fr += w * Math.cos(phase);
    fi += w * Math.sin(phase);
  }
  return fr * fr + fi * fi;
}

describe("GPU structure-factor kernel — CI-checkable contract", () => {
  it("WGSL struct field counts match the marshaling strides", () => {
    expect(wgslFieldCount("Atom")).toBe(ATOM_STRIDE);
    expect(wgslFieldCount("Elem")).toBe(ELEM_STRIDE);
  });

  const structure = exampleStructure();
  const anisotropic: StructureModel = {
    ...structure,
    sites: structure.sites.map((sit, i) => ({
      ...sit,
      adp: { kind: "anisotropic" as const, uAniso: [0.01 + 0.002 * i, 0.008, 0.012, 0.001, 0.0, 0.002] as const },
    })),
  };

  const cases: { name: string; model: StructureModel; radiation: Radiation }[] = [
    { name: "neutron isotropic", model: structure, radiation: { kind: "neutron", wavelength: 1.54 } },
    { name: "X-ray isotropic", model: structure, radiation: { kind: "xray", wavelength: 1.5406 } },
    { name: "neutron anisotropic ADP", model: anisotropic, radiation: { kind: "neutron", wavelength: 1.54 } },
  ];

  for (const { name, model, radiation } of cases) {
    it(`kernel formula reproduces the CPU structure factor (${name})`, () => {
      const hkls = generateReflections(model.cell, model.spaceGroup, 0.7, 8);
      let maxRel = 0;
      let scale = 1e-30;
      for (const r of hkls) scale = Math.max(scale, nuclearStructureFactorSquared(model, radiation, r.h, r.k, r.l));
      for (const r of hkls) {
        const cpu = nuclearStructureFactorSquared(model, radiation, r.h, r.k, r.l);
        const ref = kernelReference(model, radiation, r.h, r.k, r.l);
        maxRel = Math.max(maxRel, Math.abs(ref - cpu) / scale);
      }
      // Same math in f64 → agreement at roundoff, not the GPU's f32 contract.
      expect(maxRel).toBeLessThan(1e-9);
    });
  }
});
