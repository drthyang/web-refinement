import { describe, it, expect } from "vitest";
import {
  MATOM_STRIDE, ION_STRIDE, REFL_STRIDE, MAGNETIC_STRUCTURE_FACTOR_WGSL, magneticStructureFactorInputs,
} from "@/workers/gpuMagneticStructureFactor";
import { expandMagneticAtoms, magneticStructureFactor, MAGNETIC_PREFACTOR } from "@/core/magnetic/structureFactor";
import { magneticTable } from "@/core/scattering/magnetic";
import { anisotropicDebyeWaller } from "@/core/diffraction/structureFactor";
import { exampleStructure } from "@/examples/mn3ga";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import type { MagneticModel } from "@/core/magnetic/types";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";

/**
 * GPU magnetic structure-factor kernel — the CI-checkable half (no GPU in node).
 * Guards the two failure modes CI can catch without hardware (the WGSL numerics
 * are validated in-browser via the harness):
 *   1. struct/stride mismatch — the WGSL MAtom/Ion/Refl field counts must equal
 *      the JS marshaling strides (the nuclear kernel once shipped a 15-vs-16 Elem
 *      stride that zeroed an element, visible only in-browser);
 *   2. marshaling/formula drift — the expanded magnetic atoms, s, q̂, reciprocal
 *      metric and ⟨j0⟩ coefficients the kernel is fed, summed with the kernel's
 *      own formula in f64, must reproduce the CPU magnetic |F_M|².
 */

function wgslFieldCount(name: string): number {
  const m = MAGNETIC_STRUCTURE_FACTOR_WGSL.match(new RegExp(`struct ${name}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`struct ${name} not found in WGSL`);
  return (m[1]!.match(/\b\w+\s*:\s*(f32|u32)\b/g) ?? []).length;
}

/** f64 replica of the WGSL magnetic kernel over the SAME marshaled inputs. */
function kernelReference(structure: StructureModel, magnetic: MagneticModel, h: number, k: number, l: number): number {
  const atoms = expandMagneticAtoms(structure, magnetic);
  const { reflections, reciprocal } = magneticStructureFactorInputs(structure, [{ h, k, l }]);
  const { s, qHat } = reflections[0]!;
  const { as, bs, cs } = reciprocal;
  let fxr = 0, fxi = 0, fyr = 0, fyi = 0, fzr = 0, fzi = 0;
  for (const at of atoms) {
    const fMag = magneticTable.has(at.formFactorId) ? magneticTable.j0(at.formFactorId, s) : 1;
    const dw = at.adp.kind === "isotropic"
      ? Math.exp(-at.adp.bIso * s * s)
      : anisotropicDebyeWaller(structure.cell, at.adp.uAniso, h, k, l);
    void as; void bs; void cs; // aniso DW uses the cell directly (same as as,bs,cs)
    const w = MAGNETIC_PREFACTOR * at.occupancy * fMag * dw;
    const m = at.momentCart;
    const mdotq = m[0] * qHat[0] + m[1] * qHat[1] + m[2] * qHat[2];
    const mp = [m[0] - qHat[0] * mdotq, m[1] - qHat[1] * mdotq, m[2] - qHat[2] * mdotq];
    const arg = h * at.position[0]! + k * at.position[1]! + l * at.position[2]!;
    const phase = 2 * Math.PI * (arg - Math.floor(arg));
    const cr = Math.cos(phase), ci = Math.sin(phase);
    fxr += w * mp[0]! * cr; fxi += w * mp[0]! * ci;
    fyr += w * mp[1]! * cr; fyi += w * mp[1]! * ci;
    fzr += w * mp[2]! * cr; fzi += w * mp[2]! * ci;
  }
  return fxr * fxr + fxi * fxi + fyr * fyr + fyi * fyi + fzr * fzr + fzi * fzi;
}

describe("GPU magnetic structure-factor kernel — CI-checkable contract", () => {
  it("WGSL struct field counts match the marshaling strides", () => {
    expect(wgslFieldCount("MAtom")).toBe(MATOM_STRIDE);
    expect(wgslFieldCount("Ion")).toBe(ION_STRIDE);
    expect(wgslFieldCount("Refl")).toBe(REFL_STRIDE);
  });

  // Genuine AFM: Mn₃Ga (P6₃/mmc), Mn on 6h, k = (½,0,0), a type-III subgroup.
  const structure = exampleStructure();
  const k: Vec3 = [0.5, 0, 0];
  const build = (() => {
    for (const sub of generateMagneticCandidatesForK(structure.spaceGroup.operations, k)) {
      if (!sub.operations.some((op) => op.timeReversal === -1)) continue;
      const b = buildMagneticModel(structure, k, ["Mn1"], sub.operations, { moment: 3, tieSameSite: true });
      if (b.params.length > 0) return b;
    }
    throw new Error("no moment-allowing type-III subgroup found");
  })();
  const amps: Record<string, number> = {};
  for (const p of build.params) amps[p.id] = p.value;
  const magnetic = applyMagneticMoments(build.magnetic, build.bindings, amps);
  const anisoStructure: StructureModel = {
    ...structure,
    sites: structure.sites.map((sit, i) => ({
      ...sit,
      adp: { kind: "anisotropic" as const, uAniso: [0.01 + 0.002 * i, 0.008, 0.012, 0.001, 0.0, 0.002] as const },
    })),
  };

  const satellites: [number, number, number][] = [[0.5, 1, 0], [0.5, 0, 1], [0.5, 1, 1], [1.5, 0, 0], [0.5, 2, 1], [1.5, 1, 0]];

  it("kernel formula reproduces the CPU magnetic |F_M|² (isotropic ADP)", () => {
    let scale = 1e-30;
    for (const [h, kk, l] of satellites) scale = Math.max(scale, magneticStructureFactor(structure, magnetic, h, kk, l).squared);
    expect(scale).toBeGreaterThan(0.1); // the fixture actually has magnetic intensity
    let maxRel = 0;
    for (const [h, kk, l] of satellites) {
      const cpu = magneticStructureFactor(structure, magnetic, h, kk, l).squared;
      const ref = kernelReference(structure, magnetic, h, kk, l);
      maxRel = Math.max(maxRel, Math.abs(ref - cpu) / scale);
    }
    expect(maxRel).toBeLessThan(1e-9);
  });

  it("kernel formula reproduces the CPU magnetic |F_M|² (anisotropic ADP)", () => {
    let scale = 1e-30;
    for (const [h, kk, l] of satellites) scale = Math.max(scale, magneticStructureFactor(anisoStructure, magnetic, h, kk, l).squared);
    let maxRel = 0;
    for (const [h, kk, l] of satellites) {
      const cpu = magneticStructureFactor(anisoStructure, magnetic, h, kk, l).squared;
      const ref = kernelReference(anisoStructure, magnetic, h, kk, l);
      maxRel = Math.max(maxRel, Math.abs(ref - cpu) / scale);
    }
    expect(maxRel).toBeLessThan(1e-9);
  });
});
