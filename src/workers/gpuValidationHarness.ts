/**
 * Dev-only WebGPU validation harness. Runs the GPU structure-factor kernel
 * against the CPU f64 truth on real structures and reports the max relative
 * |F|² deviation — the "measured on hardware" evidence the precision contract
 * demands before any refinement path trusts a GPU |F|². Attached to
 * `window.__gpuValidate` in dev builds only (see main.tsx); tree-shaken out of
 * production. Drive it from the browser console:  await window.__gpuValidate().
 */

import { GpuStructureFactor, structureFactorInputs, gpuStructureFactorValidation } from "@/workers/gpuStructureFactor";
import { gpuMagneticValidation } from "@/workers/gpuMagneticStructureFactor";
import { expandStructureAtoms, nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { generateReflections } from "@/core/diffraction/reflections";
import { exampleStructure } from "@/examples/mn3ga";
import type { Radiation } from "@/core/diffraction/types";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";

function reflectionsOf(model: StructureModel, dMin: number, dMax: number) {
  return generateReflections(model.cell, model.spaceGroup, dMin, dMax).map((r) => ({ h: r.h, k: r.k, l: r.l }));
}

async function validateSingle(name: string, model: StructureModel, radiation: Radiation) {
  const hkls = reflectionsOf(model, 0.7, 8);
  const report = await gpuStructureFactorValidation(model, radiation, hkls, (h, k, l) =>
    nuclearStructureFactorSquared(model, radiation, h, k, l),
  );
  return { name, radiation: radiation.kind, ...report };
}

/** Make every site anisotropic so the aniso Debye-Waller path is exercised. */
function toAnisotropic(model: StructureModel): StructureModel {
  return {
    ...model,
    sites: model.sites.map((s, i) => ({
      ...s,
      adp: { kind: "anisotropic" as const, uAniso: [0.01 + 0.002 * i, 0.008, 0.012, 0.001, 0.0, 0.002] as const },
    })),
  };
}

/** Validate a BATCH of perturbed models (the Jacobian-column use case). */
async function validateBatch(model: StructureModel, radiation: Radiation) {
  const gpu = await GpuStructureFactor.create();
  if (!gpu) return { name: "batch", error: "no gpu" };
  try {
    const hkls = reflectionsOf(model, 0.7, 8);
    const { reflections, reciprocal } = structureFactorInputs(model, hkls);
    // 8 perturbed models: nudge site 0's x by a small amount per column.
    const models: StructureModel[] = Array.from({ length: 8 }, (_, c) => ({
      ...model,
      sites: model.sites.map((s, i) =>
        i === 0 ? { ...s, position: [s.position[0] + c * 1e-3, s.position[1], s.position[2]] as const } : s,
      ),
    }));
    const atomLists = models.map(expandStructureAtoms);
    const gpuOut = await gpu.computeIntensities(atomLists, reflections, radiation, reciprocal);
    let maxRel = 0;
    for (let m = 0; m < models.length; m++) {
      const cpu = hkls.map(({ h, k, l }) => nuclearStructureFactorSquared(models[m]!, radiation, h, k, l));
      const scale = Math.max(...cpu.map(Math.abs), 1e-30);
      for (let i = 0; i < hkls.length; i++) {
        const rel = Math.abs(gpuOut[m]![i]! - cpu[i]!) / scale;
        if (rel > maxRel) maxRel = rel;
      }
    }
    return { name: "batch (8 perturbed models)", radiation: radiation.kind, nModels: models.length, nRefl: hkls.length, maxRelError: maxRel };
  } finally {
    gpu.dispose();
  }
}

/** Validate the magnetic |F_M|² kernel on a genuine AFM (Mn₃Ga, k=(½,0,0)). */
async function validateMagnetic() {
  const structure = exampleStructure();
  const k: Vec3 = [0.5, 0, 0];
  let build: ReturnType<typeof buildMagneticModel> | null = null;
  for (const sub of generateMagneticCandidatesForK(structure.spaceGroup.operations, k)) {
    if (!sub.operations.some((op) => op.timeReversal === -1)) continue;
    const b = buildMagneticModel(structure, k, ["Mn1"], sub.operations, { moment: 3, tieSameSite: true });
    if (b.params.length > 0) { build = b; break; }
  }
  if (!build) return { name: "Mn3Ga AFM (magnetic |F_M|²)", error: "no subgroup" };
  const amps: Record<string, number> = {};
  for (const p of build.params) amps[p.id] = p.value;
  const magnetic = applyMagneticMoments(build.magnetic, build.bindings, amps);
  // (½,0,0)-type satellites over a small G range.
  const hkls: { h: number; k: number; l: number }[] = [];
  for (let H = -3; H <= 3; H++) for (let K = -2; K <= 2; K++) for (let L = -2; L <= 2; L++) {
    hkls.push({ h: H + 0.5, k: K, l: L });
  }
  const report = await gpuMagneticValidation(structure, magnetic, hkls, (h, kk, l) =>
    magneticStructureFactor(structure, magnetic, h, kk, l).squared,
  );
  return { name: "Mn3Ga AFM (magnetic |F_M|²)", ...report };
}

export function installGpuValidationHarness(): void {
  (window as unknown as { __gpuBench: () => Promise<unknown> }).__gpuBench = async () => {
    const model = exampleStructure();
    const radiation: Radiation = { kind: "neutron", wavelength: 1.54 };
    const hkls = reflectionsOf(model, 0.25, 20); // thousands of reflections
    const { reflections, reciprocal } = structureFactorInputs(model, hkls);
    const nModels = 24;
    const atomLists = Array.from({ length: nModels }, () => expandStructureAtoms(model));
    const gpu = await GpuStructureFactor.create();
    if (!gpu) return { error: "no gpu" };
    await gpu.computeIntensities(atomLists, reflections, radiation, reciprocal); // warm up
    const t0 = performance.now();
    await gpu.computeIntensities(atomLists, reflections, radiation, reciprocal);
    const gpuMs = performance.now() - t0;
    gpu.dispose();
    const t1 = performance.now();
    for (let m = 0; m < nModels; m++) hkls.forEach(({ h, k, l }) => nuclearStructureFactorSquared(model, radiation, h, k, l));
    const cpuMs = performance.now() - t1;
    return { nRefl: hkls.length, nModels, gpuMs: +gpuMs.toFixed(1), cpuMs: +cpuMs.toFixed(1), speedup: +(cpuMs / gpuMs).toFixed(1) };
  };
  (window as unknown as { __gpuValidate: () => Promise<unknown> }).__gpuValidate = async () => {
    const mn3ga = exampleStructure();
    const results = [
      await validateSingle("Mn3Ga (neutron, isotropic)", mn3ga, { kind: "neutron", wavelength: 1.54 }),
      await validateSingle("Mn3Ga (X-ray, isotropic)", mn3ga, { kind: "xray", wavelength: 1.5406 }),
      await validateSingle("Mn3Ga (neutron, anisotropic ADP)", toAnisotropic(mn3ga), { kind: "neutron", wavelength: 1.54 }),
      await validateBatch(mn3ga, { kind: "neutron", wavelength: 1.54 }),
      await validateMagnetic(),
    ];
    // eslint-disable-next-line no-console
    console.table(results);
    return results;
  };
}
