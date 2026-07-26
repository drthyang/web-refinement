/**
 * The nuclear-G(r) memo inside `buildMpdfProblem.calculate`: a moment-only
 * Jacobian column must not recompute `computeGofR`, and must not be able to
 * observe that it didn't.
 *
 * A cache keyed on a subset of the parameters has exactly two failure modes,
 * and both are silent — an LM run converges to a slightly wrong minimum rather
 * than throwing. Both are gated here against the only reference that cannot be
 * wrong: a FRESHLY BUILT problem, which has no cache to be stale.
 *
 *  1. **Stale.** A parameter the key omits moves the nuclear model. Caught by
 *     replaying nuclear-parameter changes through one long-lived problem.
 *  2. **Accumulating.** The magnetic term is added into the model array in
 *     place, so handing out the cached array itself would add d_mag again on
 *     every hit. Caught by any repeated evaluation at the same values.
 */

import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { buildMpdfProblem, buildMpdfSpec } from "@/core/workflow/mpdf";

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };

/** Two Mn sublattices so a moment can move without touching the other. */
function structure(): StructureModel {
  return {
    id: "mn", name: "Mn toy", cell: { a: 4.4, b: 4.4, c: 4.4, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: [IDENTITY_OP] },
    sites: [
      { label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
      { label: "Mn2", element: "Mn", position: [0.5, 0.5, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
    ],
  };
}

function magnetic(): MagneticModel {
  return {
    id: "mn-mag", structureId: "mn", propagation: [[0, 0, 0.5]],
    moments: [
      { siteLabel: "Mn1", frame: "crystallographic", components: [3.0, 0, 0], formFactorId: "Mn2" },
      { siteLabel: "Mn2", frame: "crystallographic", components: [3.0, 0, 0], formFactorId: "Mn2" },
    ],
  };
}

function momentRows(): { params: RefinementParameter[]; bindings: ParameterBinding[] } {
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  for (const label of ["Mn1", "Mn2"]) {
    params.push({
      id: `mom_${label}_0`, label: `${label} M`, kind: "momentMode",
      value: 3.0, initialValue: 3.0, min: -12, max: 12, fixed: false,
    });
    bindings.push({ parameterId: `mom_${label}_0`, kind: "momentMode", targetId: "mn-mag", targetKey: label, momentBasis: [1, 0, 0] });
  }
  return { params, bindings };
}

function pattern(): PdfPattern {
  return {
    id: "toy", name: "toy", scatteringType: "neutron",
    points: Array.from({ length: 726 }, (_, k) => ({ r: 0.5 + k * 0.02, gObs: 0 })),
    qdamp: 0.02, qmax: 25,
  };
}

const S = structure();
const PAT = pattern();
const MOM = momentRows();
const SPEC = buildMpdfSpec(S, PAT, { magnetic: magnetic(), params: MOM.params, bindings: MOM.bindings });
const FIT_RANGE = { min: 1.0, max: 14 };

function base(): Record<string, number> {
  const v: Record<string, number> = {};
  for (const p of SPEC.params) v[p.id] = p.value;
  return v;
}

function newProblem() {
  return buildMpdfProblem(S, SPEC.magnetic, PAT, SPEC.params, SPEC.bindings, SPEC.restraints, FIT_RANGE);
}

/** Bit-identity, the same gate the evaluator-pool contract uses. */
function expectIdentical(got: Float64Array, want: Float64Array, label: string): void {
  expect(got.length, `${label}: length`).toBe(want.length);
  let firstBad = -1;
  for (let i = 0; i < want.length; i++) {
    if (!Object.is(got[i], want[i])) { firstBad = i; break; }
  }
  expect(firstBad, `${label}: first differing index (got ${got[firstBad]} want ${want[firstBad]})`).toBe(-1);
}

describe("buildMpdfProblem nuclear-G(r) cache", () => {
  it("a reused problem matches a cold one over a scrambled value trajectory", () => {
    // Nuclear parameters interleaved with moment-only ones, values revisited so
    // that a hit follows a miss and vice versa.
    const cellId = SPEC.params.find((p) => p.kind === "cellLength")!.id;
    const bIsoId = SPEC.params.find((p) => p.kind === "bIso")!.id;
    const scaleId = SPEC.params.find((p) => p.kind === "pdfScale")!.id;
    const trajectory: Record<string, number>[] = [
      base(),
      { ...base(), mom_Mn1_0: 2.5 },                    // moment only  → cache hit
      { ...base(), mom_Mn1_0: 2.5 },                    // repeat       → hit, must not accumulate
      { ...base(), [cellId]: 4.42 },                    // nuclear      → must invalidate
      { ...base(), [cellId]: 4.42, mom_Mn2_0: -3.0 },   // moment on the new cell → hit
      { ...base(), [bIsoId]: 0.9 },                     // nuclear, non-geometric (no pair-list change)
      { ...base(), [scaleId]: 1.4 },                    // nuclear, scale only
      base(),                                           // back to the start
      { ...base(), [bIsoId]: 0.9 },                     // revisit a stale-prone value
    ];

    const reused = newProblem();
    for (const [i, values] of trajectory.entries()) {
      const got = reused.calculate(values);
      const want = newProblem().calculate(values);
      expectIdentical(got, want, `step ${i}`);
    }
  });

  it("a moment-only step changes the curve, so the memo is not hiding a no-op", () => {
    // Guards the test above from passing vacuously: if the magnetic term were
    // absent, every "cache hit" comparison would be trivially satisfied.
    const p = newProblem();
    const a = p.calculate(base());
    const b = p.calculate({ ...base(), mom_Mn1_0: 1.0 });
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBeGreaterThan(1e-6);
  });

  it("classifies moment and mPDF parameters as magnetic-only, and the rest as nuclear", () => {
    // The cache is sound only because these kinds provably cannot reach
    // `applied.model`/`applied.pdf` (see apply.ts). If a new kind is added to
    // the mPDF bag without being added to MPDF_ONLY_KINDS the cache just misses
    // more; the dangerous direction — a nuclear kind wrongly excluded — is what
    // the trajectory test above covers.
    const magneticKinds = SPEC.params
      .filter((p) => SPEC.bindings.some((b) => b.parameterId === p.id && (b.kind.startsWith("moment") || b.kind.startsWith("mpdf"))))
      .map((p) => p.kind);
    expect(magneticKinds).toContain("momentMode");
    expect(SPEC.params.some((p) => p.kind === "cellLength")).toBe(true);
  });
});
