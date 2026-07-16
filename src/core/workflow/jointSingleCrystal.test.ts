import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { applyMagneticMoments, magneticComparison } from "@/core/workflow/magnetic";
import { applyParameters } from "@/core/workflow/apply";
import { singleCrystalLorentz, polarizationFactor } from "@/core/diffraction/singleCrystalFactors";
import { dSpacing } from "@/core/crystal/unitCell";
import {
  buildJointSingleCrystalProblem,
  jointSingleCrystalComparison,
  type HklTransform,
} from "@/core/workflow/jointSingleCrystal";

/**
 * Phase 2 (Improvement Plan) — the joint nuclear + magnetic single-crystal
 * co-refinement builder. A synthetic P1 ferromagnet (k = 0, moment along x) with
 * both reflection sets generated from the SAME model, so the block forward models
 * and the χ²_total = w_N·χ²_N + w_M·χ²_M assembly are checked against a known
 * truth. CI-runnable (no git-ignored data).
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
// moment along x: mode 0 of a P1 site is the x Cartesian direction.
const build = buildMagneticModel(structure, k, ["Fe1"], structure.spaceGroup.operations, { moment: TRUE_MOMENT });
const MOMENT_ID = build.params[0]!.id; // "mom_Fe1_0"

// Reflections chosen so |F_M⊥|² ≠ 0 for an x-moment (q not along x).
const hklList: readonly [number, number, number][] = [
  [0, 0, 1], [0, 1, 0], [0, 0, 2], [0, 1, 1], [0, 2, 0], [0, 1, 2], [0, 2, 1],
];

function dataset(id: string, iObs: number[], sigma?: number[]): SingleCrystalDataset {
  return {
    id, name: id, radiation: { kind: "neutron", wavelength: 1.8 },
    reflections: hklList.map(([h, kk, l], i) => ({
      h, k: kk, l, iObs: iObs[i] ?? 0, ...(sigma ? { sigma: sigma[i]! } : {}),
    })),
  };
}

/** scale (nuclear) + magneticScale + one moment mode, plus their bindings. */
function scene(scale: number, magScale: number, moment: number, momentFree = true): {
  params: RefinementParameter[]; bindings: ParameterBinding[];
} {
  const params: RefinementParameter[] = [
    { id: "scale", label: "s", kind: "scale", value: scale, initialValue: scale, fixed: false, min: 0 },
    { id: "mscale", label: "ms", kind: "magneticScale", value: magScale, initialValue: magScale, fixed: false, min: 0 },
    ...build.params.map((p) => (p.id === MOMENT_ID
      ? { ...p, value: moment, initialValue: moment, fixed: !momentFree }
      : { ...p, fixed: true })),
  ];
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: "nuc" },
    { parameterId: "mscale", kind: "magneticScale", targetId: "mag" },
    ...build.bindings,
  ];
  return { params, bindings };
}

const TRUTH = scene(5, 2, TRUE_MOMENT);
// Generate both blocks' iObs from the production forward model at truth.
const truthCalc = buildJointSingleCrystalProblem(
  structure, build.magnetic, dataset("nuc", []), dataset("mag", []), TRUTH.params, TRUTH.bindings,
).calculate(Object.fromEntries(TRUTH.params.map((p) => [p.id, p.value])));
const nN = hklList.length;
const nucObs = Array.from(truthCalc.subarray(0, nN));
const magObs = Array.from(truthCalc.subarray(nN));

describe("buildJointSingleCrystalProblem — block assembly", () => {
  const nuc = dataset("nuc", nucObs, nucObs.map((v) => Math.sqrt(v) + 1));
  const mag = dataset("mag", magObs, magObs.map((v) => Math.sqrt(v) + 1));

  it("concatenates observations nuclear-then-magnetic in a fixed order", () => {
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const p = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings);
    expect(p.observations.length).toBe(2 * nN);
    for (let i = 0; i < nN; i++) expect(p.observations[i]).toBe(nucObs[i]);
    for (let i = 0; i < nN; i++) expect(p.observations[nN + i]).toBe(magObs[i]);
  });

  it("folds w_N / w_M onto the per-block 1/σ² weights", () => {
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const wN = 3, wM = 0.5;
    const p = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings, { weightNuclear: wN, weightMagnetic: wM });
    for (let i = 0; i < nN; i++) expect(p.weights[i]).toBeCloseTo(wN / ((Math.sqrt(nucObs[i]!) + 1) ** 2), 10);
    for (let i = 0; i < nN; i++) expect(p.weights[nN + i]).toBeCloseTo(wM / ((Math.sqrt(magObs[i]!) + 1) ** 2), 10);
  });

  it("realizes χ²_total = w_N·χ²_N + w_M·χ²_M (weighted-χ² identity)", () => {
    const { params, bindings } = scene(4, 1.5, 2.4); // off-truth so residuals ≠ 0
    const wN = 2, wM = 0.75;
    const values = Object.fromEntries(params.map((p) => [p.id, p.value]));
    const joint = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings, { weightNuclear: wN, weightMagnetic: wM });
    const calc = joint.calculate(values);
    // Reference: separate per-block χ² with the unweighted 1/σ² weights.
    const unit = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings);
    let chiN = 0, chiM = 0;
    for (let i = 0; i < nN; i++) { const r = joint.observations[i]! - calc[i]!; chiN += unit.weights[i]! * r * r; }
    for (let i = 0; i < nN; i++) { const r = joint.observations[nN + i]! - calc[nN + i]!; chiM += unit.weights[nN + i]! * r * r; }
    let chiJoint = 0;
    for (let i = 0; i < 2 * nN; i++) { const r = joint.observations[i]! - calc[i]!; chiJoint += joint.weights[i]! * r * r; }
    expect(chiJoint).toBeCloseTo(wN * chiN + wM * chiM, 8);
  });

  it("zero magnetic weight drops the whole magnetic block (per-dataset weight regression)", () => {
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const p = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings, { weightMagnetic: 0 });
    for (let i = 0; i < nN; i++) expect(p.weights[i]).toBeGreaterThan(0);
    for (let i = 0; i < nN; i++) expect(p.weights[nN + i]).toBe(0);
    // Symmetric: zero nuclear weight drops the nuclear block.
    const q = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings, { weightNuclear: 0 });
    for (let i = 0; i < nN; i++) expect(q.weights[i]).toBe(0);
    for (let i = 0; i < nN; i++) expect(q.weights[nN + i]).toBeGreaterThan(0);
  });

  it("routes scale by KIND — a tie k_M = k_N spans both blocks", () => {
    // k_M tied to the nuclear scale via an expression; the magnetic block must
    // scale by the resolved nuclear value, not the (stale) magneticScale start.
    const base = scene(5, 999, TRUE_MOMENT); // magScale start deliberately wrong
    const params = base.params.map((p) => (p.id === "mscale"
      ? { ...p, expression: "= scale", fixed: true } : p));
    const values = Object.fromEntries(params.map((p) => [p.id, p.value]));
    const calc = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, base.bindings).calculate(values);
    // With k_M resolved to k_N = 5 (not 999), the magnetic block equals the
    // reference where magneticScale is literally 5.
    const ref = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, scene(5, 5, TRUE_MOMENT).params, base.bindings)
      .calculate(Object.fromEntries(scene(5, 5, TRUE_MOMENT).params.map((p) => [p.id, p.value])));
    for (let i = 0; i < nN; i++) expect(calc[nN + i]).toBeCloseTo(ref[nN + i]!, 8);
  });
});

describe("jointSingleCrystalComparison — per-block agreement + σ coverage", () => {
  it("reports R≈0 for both blocks at truth and full σ coverage", () => {
    const nuc = dataset("nuc", nucObs, nucObs.map((v) => Math.sqrt(v) + 1));
    const mag = dataset("mag", magObs, magObs.map((v) => Math.sqrt(v) + 1));
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const cmp = jointSingleCrystalComparison(structure, build.magnetic, nuc, mag, params, bindings);
    expect(cmp.nuclear.agreement.wr2).toBeLessThan(1e-6);
    expect(cmp.magnetic.agreement.wr2).toBeLessThan(1e-6);
    expect(cmp.nuclear.agreement.total).toBe(nN);
    expect(cmp.magnetic.agreement.total).toBe(nN);
    expect(cmp.nuclear.sigmaCoverage).toBe(1);
    expect(cmp.magnetic.sigmaCoverage).toBe(1);
  });

  it("flags partial σ coverage when a block lacks σ", () => {
    const nuc = dataset("nuc", nucObs); // no σ at all
    const mag = dataset("mag", magObs, magObs.map((v) => Math.sqrt(v) + 1));
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const cmp = jointSingleCrystalComparison(structure, build.magnetic, nuc, mag, params, bindings);
    expect(cmp.nuclear.sigmaCoverage).toBe(0);
    expect(cmp.magnetic.sigmaCoverage).toBe(1);
  });

  it("charges each block's GooF only with its OWN free parameters", () => {
    // Regression: the per-block GooF dof (N_block − P_block) must count only the
    // parameters that fit that block. A freed NUCLEAR parameter (held at its
    // current value, so the calc is unchanged) must not shift the MAGNETIC block's
    // GooF — only the nuclear block's.
    const nuc = dataset("nuc", nucObs, nucObs.map((v) => Math.sqrt(v) + 1));
    const mag = dataset("mag", magObs, magObs.map((v) => Math.sqrt(v) + 1));
    const base = scene(4, 1.6, 2.7); // off-truth so GooF > 0 and finite
    const before = jointSingleCrystalComparison(structure, build.magnetic, nuc, mag, base.params, base.bindings);
    // Add a freed nuclear parameter (B_iso) at the structure's current value → the
    // calc is byte-identical, only nFree(nuclear) increases by one.
    const params = [...base.params, { id: "bFe", label: "B", kind: "bIso" as const, value: 0.3, initialValue: 0.3, fixed: false, min: 0 }];
    const bindings = [...base.bindings, { parameterId: "bFe", kind: "bIso" as const, targetId: structure.id, targetKey: "Fe1" }];
    const after = jointSingleCrystalComparison(structure, build.magnetic, nuc, mag, params, bindings);
    // Magnetic block GooF unchanged (the new param is nuclear); nuclear block GooF
    // rises as its dof drops by one.
    expect(after.magnetic.agreement.goof).toBeCloseTo(before.magnetic.agreement.goof, 12);
    expect(after.nuclear.agreement.goof).toBeGreaterThan(before.nuclear.agreement.goof);
  });
});

describe("jointSingleCrystal — physics wiring", () => {
  const nuc = dataset("nuc", nucObs);
  const mag = dataset("mag", magObs);

  it("magnetic block equals hand-assembled k_M·L·P·|F_M⊥|² per reflection", () => {
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const values = Object.fromEntries(params.map((p) => [p.id, p.value]));
    const calc = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings).calculate(values);
    const applied = applyParameters(structure, bindings, values);
    const appliedMag = applyMagneticMoments(build.magnetic, bindings, values);
    hklList.forEach(([h, kk, l], i) => {
      const d = dSpacing(structure.cell, h, kk, l);
      const lp = singleCrystalLorentz(mag.radiation, d) * polarizationFactor(mag.radiation, d);
      const expected = applied.magneticScale * lp * magneticStructureFactor(applied.model, appliedMag, h, kk, l).squared;
      expect(calc[nN + i]).toBeCloseTo(expected, 8);
    });
  });

  it("lorentz:false + original structure matches the legacy magneticComparison iMagnetic", () => {
    // Cross-consistency with the single-dataset magnetic path (no L·P, no
    // applyParameters position update): the joint magnetic block must reduce to
    // the legacy iMagnetic when L·P is off and no structural params move.
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const values = Object.fromEntries(params.map((p) => [p.id, p.value]));
    const calc = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings, { lorentz: false }).calculate(values);
    const legacy = magneticComparison(structure, build.magnetic, mag, params, bindings);
    for (let i = 0; i < nN; i++) expect(calc[nN + i]).toBeCloseTo(legacy[i]!.iMagnetic, 8);
  });

  it("threads freed structural parameters into BOTH blocks", () => {
    // A freed structural parameter must feed |F_M⊥|² (legacy computeRows used the
    // un-applied structure). B_iso enters the magnetic structure factor via the
    // shared Debye–Waller damping, so changing it must move the magnetic block.
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const withB: ParameterBinding[] = [...bindings, { parameterId: "bFe", kind: "bIso", targetId: structure.id, targetKey: "Fe1" }];
    const p0 = [...params, { id: "bFe", label: "B", kind: "bIso" as const, value: 0.3, initialValue: 0.3, fixed: false, min: 0 }];
    const build0 = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, p0, withB);
    const at0 = build0.calculate(Object.fromEntries(p0.map((p) => [p.id, p.value])));
    const at1 = build0.calculate({ ...Object.fromEntries(p0.map((p) => [p.id, p.value])), bFe: 2.5 });
    // Every non-zero magnetic reflection at d < ∞ must respond to the changed B.
    const moved = hklList.some((_, i) => Math.abs((at0[nN + i] ?? 0) - (at1[nN + i] ?? 0)) > 1e-9);
    expect(moved).toBe(true);
    // And the nuclear block must respond too (same Debye–Waller).
    const movedN = hklList.some((_, i) => Math.abs((at0[i] ?? 0) - (at1[i] ?? 0)) > 1e-9);
    expect(movedN).toBe(true);
  });

  it("applies the integer hkl transform into the model setting", () => {
    // A transform that maps every magnetic index (h,k,l) → (h,k,2l) picks a
    // different model reflection, changing the magnetic block calc.
    const doubleL: HklTransform = [[1, 0, 0], [0, 1, 0], [0, 0, 2]];
    const { params, bindings } = scene(5, 2, TRUE_MOMENT);
    const values = Object.fromEntries(params.map((p) => [p.id, p.value]));
    const plain = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings).calculate(values);
    const mapped = buildJointSingleCrystalProblem(structure, build.magnetic, nuc, mag, params, bindings, { magneticHklTransform: doubleL }).calculate(values);
    // The transform must reproduce the calc at doubled l per reflection.
    const applied = applyParameters(structure, bindings, values);
    const appliedMag = applyMagneticMoments(build.magnetic, bindings, values);
    hklList.forEach(([h, kk, l], i) => {
      const d = dSpacing(structure.cell, h, kk, 2 * l);
      const lp = singleCrystalLorentz(mag.radiation, d) * polarizationFactor(mag.radiation, d);
      const expected = applied.magneticScale * lp * magneticStructureFactor(applied.model, appliedMag, h, kk, 2 * l).squared;
      expect(mapped[nN + i]).toBeCloseTo(expected, 8);
    });
    // Identity transform (nuclear here) leaves the nuclear block unchanged.
    for (let i = 0; i < nN; i++) expect(mapped[i]).toBeCloseTo(plain[i]!, 10);
  });
});
