import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments, magneticComparison } from "@/core/workflow/magnetic";
import { ComputeClient } from "@/workers/computeClient";

/**
 * Phase 3 — refining the merged magnetic SUPERCELL dataset. The merge convention
 * puts nuclear reflections and magnetic satellites in ONE dataset (in the
 * supercell); this proves that single dataset refines and recovers the moments.
 *
 * Synthetic supercell: a cell doubled along a (8×4×5) with two Fe at (0,0,0) and
 * (½,0,0) carrying antiparallel moments — a k = (½,0,0) antiferromagnet folded
 * into the supercell (k = 0 there). By the AFM structure factor, EVEN-h
 * reflections are purely nuclear (|F_M|² = 0) and ODD-h reflections are purely
 * magnetic (|F_N|² = 0), so one dataset holds both classes, exactly like a merged
 * `_ALL_magcell.int`. CI-runnable; ComputeClient runs in-thread under vitest.
 */
const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "afm-super",
  name: "AFM supercell",
  cell: { a: 8, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [
    { label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso },
    { label: "Fe2", element: "Fe", oxidationState: 3, position: [0.5, 0, 0], occupancy: 1, adp: iso },
  ],
};
const build = buildMagneticModel(structure, [0, 0, 0] as Vec3, ["Fe1", "Fe2"], structure.spaceGroup.operations, { tieSameSite: false });
// First mode of each site (the x Cartesian direction for a P1 site).
const MODE1 = build.params.find((p) => p.id.includes("Fe1"))!.id;
const MODE2 = build.params.find((p) => p.id.includes("Fe2"))!.id;
const TRUE_M = 3;

// Reflections with odd h AND non-zero k/l (so the magnetic interaction vector
// M⊥Q is non-zero for the x-moment), plus even-h nuclear reflections.
const hklList: readonly [number, number, number][] = [
  [2, 0, 0], [2, 1, 0], [4, 0, 1], [2, 2, 0], [4, 1, 1], // nuclear (even h)
  [1, 1, 0], [1, 0, 1], [3, 1, 0], [1, 1, 1], [3, 0, 1], [1, 2, 0], [3, 1, 1], // magnetic (odd h)
];
function dataset(iObs: number[], sigma?: number[]): SingleCrystalDataset {
  return {
    id: "merged", name: "merged supercell", radiation: { kind: "neutron", wavelength: 1.4 },
    reflections: hklList.map(([h, k, l], i) => ({ h, k, l, iObs: iObs[i] ?? 0, ...(sigma ? { sigma: sigma[i]! } : {}) })),
  };
}

/** nuclear scale + magneticScale (tied to it) + the two AFM moment modes free. */
function scene(scale: number, m1: number, m2: number): { params: RefinementParameter[]; bindings: ParameterBinding[] } {
  const params: RefinementParameter[] = [
    { id: "scale", label: "s", kind: "scale", value: scale, initialValue: scale, fixed: false, min: 0 },
    { id: "mscale", label: "ms", kind: "magneticScale", value: scale, initialValue: scale, fixed: true, expression: "= scale" },
    ...build.params.map((p) => {
      if (p.id === MODE1) return { ...p, value: m1, initialValue: m1, fixed: false };
      if (p.id === MODE2) return { ...p, value: m2, initialValue: m2, fixed: false };
      return { ...p, value: 0, initialValue: 0, fixed: true };
    }),
  ];
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: "merged" },
    { parameterId: "mscale", kind: "magneticScale", targetId: "merged" },
    ...build.bindings,
  ];
  return { params, bindings };
}

const TRUTH = scene(4, TRUE_M, -TRUE_M);
// Generate the merged dataset's iObs = scale·|F_N|² + scale·|F_M⊥|² at truth.
const truthRows = magneticComparison(structure, build.magnetic, dataset([]), TRUTH.params, TRUTH.bindings);
const obs = truthRows.map((r) => r.iTotal);
const merged = dataset(obs, obs.map((v) => Math.sqrt(Math.max(v, 1)) + 1));

const momentMag = (values: Record<string, number>, mode: string): number => {
  const mm = applyMagneticMoments(build.magnetic, build.bindings, values).moments;
  // Which moment entry the mode drives is identified by its binding targetKey.
  const key = build.bindings.find((b) => b.parameterId === mode)?.targetKey;
  const mo = mm.find((m) => `${m.siteLabel}` === (key ?? "").split("#")[0]);
  return mo ? Math.hypot(...(mo.components as Vec3)) : 0;
};

describe("refineMagneticSingleCrystalMultiStart — merged supercell AFM", () => {
  it("separates nuclear (even h) and magnetic (odd h) intensity", () => {
    // Sanity on the synthetic construction: even-h rows carry nuclear-only
    // intensity, odd-h rows magnetic-only — the two classes a merged file holds.
    truthRows.forEach((r, i) => {
      const oddH = hklList[i]![0] % 2 !== 0;
      if (oddH) { expect(r.iMagnetic).toBeGreaterThan(0); expect(r.iNuclear).toBeCloseTo(0, 6); }
      else { expect(r.iNuclear).toBeGreaterThan(0); expect(r.iMagnetic).toBeCloseTo(0, 6); }
    });
  });

  it("recovers the AFM moments from a bad cold start", async () => {
    const client = new ComputeClient();
    const ms = await client.refineMagneticSingleCrystalMultiStart(
      { structure, magnetic: build.magnetic, dataset: merged, parameters: scene(1, 0.3, -0.3).params, bindings: TRUTH.bindings },
      { restarts: 10, seed: 7 }, { maxIterations: 40 },
    );
    expect(momentMag(ms.final.parameters, MODE1)).toBeCloseTo(TRUE_M, 1);
    expect(momentMag(ms.final.parameters, MODE2)).toBeCloseTo(TRUE_M, 1);
    // The two sites stay antiparallel (opposite signs on the mode amplitudes).
    expect(Math.sign(ms.final.parameters[MODE1]!)).toBe(-Math.sign(ms.final.parameters[MODE2]!));
    expect(ms.final.agreement.rWeighted ?? 1).toBeLessThan(0.03);
    client.dispose();
  });

  it("is deterministic — same seed ⇒ identical parameters and costs", async () => {
    const client = new ComputeClient();
    const args = [
      { structure, magnetic: build.magnetic, dataset: merged, parameters: scene(1, 0.5, -0.4).params, bindings: TRUTH.bindings },
      { restarts: 6, seed: 11 }, { maxIterations: 40 },
    ] as const;
    const a = await client.refineMagneticSingleCrystalMultiStart(...args);
    const b = await client.refineMagneticSingleCrystalMultiStart(...args);
    expect(b.final.parameters).toEqual(a.final.parameters);
    expect(b.costByStart).toEqual(a.costByStart);
    client.dispose();
  });
});
