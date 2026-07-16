import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { buildJointSingleCrystalProblem } from "@/core/workflow/jointSingleCrystal";
import { writeFullProfInt, parseFullProfInt } from "@/parsers/fullprofInt";
import { ComputeClient } from "@/workers/computeClient";

/**
 * Phase 2 (Improvement Plan) — the joint single-crystal multi-start / escape path.
 * A synthetic P1 ferromagnet whose nuclear AND magnetic reflection sets are
 * generated from a KNOWN model (moment along x, known scales), so recovery is
 * measured against ground truth. Moment parameters come from buildMagneticModel
 * (kind momentMode) — the ONLY kind isMomentParameterKind recognises, which the
 * multi-start's shouldPerturb needs. CI-runnable (no git-ignored data); worker
 * pooling is inactive under vitest, so ComputeClient runs fully in-thread.
 */
const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "fm",
  name: "synthetic FM",
  cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
};
const k: Vec3 = [0, 0, 0];
const TRUE_MOMENT = 3;
const build = buildMagneticModel(structure, k, ["Fe1"], structure.spaceGroup.operations, { moment: TRUE_MOMENT });
const MOMENT_ID = build.params[0]!.id;

const hklList: readonly [number, number, number][] = [
  [0, 0, 1], [0, 1, 0], [0, 0, 2], [0, 1, 1], [0, 2, 0], [0, 1, 2], [0, 2, 1], [0, 2, 2],
];
function dataset(id: string, iObs: number[], sigma?: number[]): SingleCrystalDataset {
  return {
    id, name: id, radiation: { kind: "neutron", wavelength: 1.8 },
    reflections: hklList.map(([h, kk, l], i) => ({ h, k: kk, l, iObs: iObs[i] ?? 0, ...(sigma ? { sigma: sigma[i]! } : {}) })),
  };
}

/**
 * scale (nuclear) + magneticScale TIED to it + one moment mode (free at `moment`).
 * The magnetic intensity ∝ magScale·|F_M⊥|² ∝ magScale·moment², so a free magnetic
 * scale and a free moment magnitude are perfectly degenerate. Sharing the scale
 * (one crystal / one beam ⇒ magScale = scale, the standard FullProf/GSAS choice)
 * lets the nuclear block pin the scale and the magnetic block pin the moment.
 */
function scene(scale: number, moment: number): { params: RefinementParameter[]; bindings: ParameterBinding[] } {
  const params: RefinementParameter[] = [
    { id: "scale", label: "s", kind: "scale", value: scale, initialValue: scale, fixed: false, min: 0 },
    { id: "mscale", label: "ms", kind: "magneticScale", value: scale, initialValue: scale, fixed: true, expression: "= scale" },
    ...build.params.map((p) => (p.id === MOMENT_ID
      ? { ...p, value: moment, initialValue: moment, fixed: false }
      : { ...p, fixed: true })),
  ];
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: "nuc" },
    { parameterId: "mscale", kind: "magneticScale", targetId: "mag" },
    ...build.bindings,
  ];
  return { params, bindings };
}

const TRUTH = scene(5, TRUE_MOMENT);
const nN = hklList.length;
const truthCalc = buildJointSingleCrystalProblem(
  structure, build.magnetic, dataset("nuc", []), dataset("mag", []), TRUTH.params, TRUTH.bindings,
).calculate(Object.fromEntries(TRUTH.params.map((p) => [p.id, p.value])));
const nucObs = Array.from(truthCalc.subarray(0, nN));
const magObs = Array.from(truthCalc.subarray(nN));
const nuc = dataset("nuc", nucObs, nucObs.map((v) => Math.sqrt(Math.max(v, 1)) + 1));
const mag = dataset("mag", magObs, magObs.map((v) => Math.sqrt(Math.max(v, 1)) + 1));

const momentOf = (values: Record<string, number>): number => {
  const m = applyMagneticMoments(build.magnetic, build.bindings, values).moments[0]!.components as Vec3;
  return Math.hypot(...m);
};

describe("refineJointSingleCrystalMultiStart — synthetic FM", () => {
  const specOf = (params: RefinementParameter[]) => ({ structure, magnetic: build.magnetic, nuclearDataset: nuc, magneticDataset: mag, parameters: params, bindings: TRUTH.bindings });

  it("recovers the true moment and both scales from a bad cold start", async () => {
    const client = new ComputeClient();
    const ms = await client.refineJointSingleCrystalMultiStart(
      specOf(scene(1, 0.3).params), // scale + moment both wrong
      { restarts: 8, seed: 1 },
      { maxIterations: 40 },
    );
    expect(momentOf(ms.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    // The nuclear block pins the shared scale; the magnetic block (magScale tied
    // to it) then pins the moment. (The tied mscale param keeps its literal
    // placeholder in the value record — resolveTies drives it at calc time; the
    // tie itself is covered by the core builder test.)
    expect(ms.final.parameters["scale"]).toBeCloseTo(5, 1);
    expect(ms.final.agreement.rWeighted ?? 1).toBeLessThan(0.02);
    client.dispose();
  });

  it("is deterministic — same seed ⇒ identical converged parameters and costs", async () => {
    const client = new ComputeClient();
    const args = [specOf(scene(1, 0.5).params), { restarts: 6, seed: 42 }, { maxIterations: 40 }] as const;
    const a = await client.refineJointSingleCrystalMultiStart(...args);
    const b = await client.refineJointSingleCrystalMultiStart(...args);
    expect(b.final.parameters).toEqual(a.final.parameters);
    expect(b.costByStart).toEqual(a.costByStart);
    client.dispose();
  });

  it("canonicalizes the global ±m sign — negative and positive starts agree in sign", async () => {
    const client = new ComputeClient();
    const pos = await client.refineJointSingleCrystalMultiStart(specOf(scene(5, 2).params), { restarts: 4, seed: 3 }, { maxIterations: 40 });
    const neg = await client.refineJointSingleCrystalMultiStart(specOf(scene(5, -2).params), { restarts: 4, seed: 3 }, { maxIterations: 40 });
    expect(momentOf(pos.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    expect(momentOf(neg.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    expect(Math.sign(neg.final.parameters[MOMENT_ID]!)).toBe(Math.sign(pos.final.parameters[MOMENT_ID]!));
    client.dispose();
  });

  // Phase 3 acceptance: a nuc + mag .int PAIR, written and read back through the
  // FullProf reader/writer, reproduces the Phase-2 joint result — ties the I/O
  // round-trip to the co-refinement objective.
  it("a written-then-parsed .int pair reproduces the joint refinement", async () => {
    const nucInt = writeFullProfInt(nuc.reflections, { title: "nuc", wavelength: 1.8, format: "(3i4,2f10.2,i4)" });
    const magInt = writeFullProfInt(mag.reflections, { title: "mag", wavelength: 1.8, format: "(3i4,2f10.2,i4)" });
    const nucBack = parseFullProfInt(nucInt, { strict: true });
    const magBack = parseFullProfInt(magInt, { strict: true });
    const nucDs = { ...nuc, reflections: nucBack.reflections };
    const magDs = { ...mag, reflections: magBack.reflections };

    const client = new ComputeClient();
    const ms = await client.refineJointSingleCrystalMultiStart(
      { structure, magnetic: build.magnetic, nuclearDataset: nucDs, magneticDataset: magDs, parameters: scene(1, 0.3).params, bindings: TRUTH.bindings },
      { restarts: 8, seed: 1 }, { maxIterations: 40 },
    );
    expect(momentOf(ms.final.parameters)).toBeCloseTo(TRUE_MOMENT, 1);
    expect(ms.final.parameters["scale"]).toBeCloseTo(5, 1);
    expect(ms.final.agreement.rWeighted ?? 1).toBeLessThan(0.03);
    client.dispose();
  });
});
