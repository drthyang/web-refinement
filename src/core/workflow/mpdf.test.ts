/**
 * mPDF co-refinement workflow (roadmap P4): one residual carrying the nuclear
 * G(r) plus the unnormalized magnetic d_mag(r), moments driven by the ordinary
 * momentMode parameters — round-tripped on synthetic data.
 */

import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { Vec3 } from "@/core/math/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { refine } from "@/core/refinement/engine";
import { buildMpdfProblem, buildMpdfSpec, mpdfComponents, MPDF_STAGE_KINDS } from "@/core/workflow/mpdf";

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };

/** P1 Mn cell, k = (0,0,½): AFM stacking along c in the 1×1×2 magnetic box. */
function structure(): StructureModel {
  return {
    id: "mn", name: "Mn toy", cell: { a: 4.4, b: 4.4, c: 4.4, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: [IDENTITY_OP] },
    sites: [{ label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } }],
  };
}

const MOMENT = 3.0;

function magnetic(structureId: string): MagneticModel {
  return {
    id: `${structureId}-mag`,
    structureId,
    propagation: [[0, 0, 0.5]],
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [MOMENT, 0, 0], formFactorId: "Mn2" }],
  };
}

const MOMENT_PARAM: RefinementParameter = {
  id: "mom_Mn1_0", label: "Mn1 M (Mx)", kind: "momentMode", value: MOMENT, initialValue: MOMENT, min: -12, max: 12, fixed: true,
};
const MOMENT_BINDING: ParameterBinding = {
  parameterId: "mom_Mn1_0", kind: "momentMode", targetId: "mn-mag", targetKey: "Mn1", momentBasis: [1, 0, 0],
};

/** Synthetic neutron G(r): the truth model evaluated on a uniform grid. */
function truthPattern(): { pattern: PdfPattern; params: RefinementParameter[]; bindings: ParameterBinding[] } {
  const s = structure();
  const shell: PdfPattern = {
    id: "toy", name: "toy", scatteringType: "neutron",
    points: Array.from({ length: 726 }, (_, k) => ({ r: 0.5 + k * 0.02, gObs: 0 })),
    qdamp: 0.02,
  };
  const spec = buildMpdfSpec(s, shell, { magnetic: magnetic(s.id), params: [MOMENT_PARAM], bindings: [MOMENT_BINDING] });
  const values: Record<string, number> = {};
  for (const p of spec.params) values[p.id] = p.value;
  const truth = buildMpdfProblem(s, spec.magnetic, shell, spec.params, spec.bindings).calculate(values);
  return {
    pattern: { ...shell, points: shell.points.map((p, i) => ({ r: p.r, gObs: truth[i]! })) },
    params: spec.params,
    bindings: spec.bindings,
  };
}

describe("buildMpdfSpec", () => {
  it("carries the nuclear PDF rows, the mPDF rows, and the moment rows", () => {
    const s = structure();
    const { pattern } = truthPattern();
    const spec = buildMpdfSpec(s, pattern, { magnetic: magnetic(s.id), params: [MOMENT_PARAM], bindings: [MOMENT_BINDING] });
    const kinds = new Set(spec.params.map((p) => p.kind));
    for (const k of ["pdfScale", "qdamp", "mpdfOrdScale", "mpdfParaScale", "mpdfPsigma", "corrLength", "momentMode"]) {
      expect(kinds.has(k as never), k).toBe(true);
    }
    expect(MPDF_STAGE_KINDS.some((s2) => s2.kinds.includes("momentMode"))).toBe(true);
  });
});

describe("mpdfComponents", () => {
  const s = structure();
  const { pattern, params, bindings } = truthPattern();
  const comps = mpdfComponents(s, magnetic(s.id), pattern, params, bindings);

  it("separates a nonzero magnetic component and sums exactly to the total", () => {
    const magPeak = Math.max(...comps.yMagnetic.map(Math.abs));
    const nucPeak = Math.max(...comps.yNuclear.map(Math.abs));
    expect(magPeak).toBeGreaterThan(0);
    expect(nucPeak).toBeGreaterThan(0);
    for (let i = 0; i < comps.x.length; i += 61) {
      expect(comps.yNuclear[i]! + comps.yMagnetic[i]!).toBeCloseTo(comps.yCalc[i]!, 10);
    }
    // Truth data ⇒ zero residual.
    expect(Math.max(...comps.diff.map(Math.abs))).toBeLessThan(1e-9);
  });

  it("an X-ray pattern gets no magnetic component", () => {
    const xray = { ...pattern, scatteringType: "xray" as const };
    const c = mpdfComponents(s, magnetic(s.id), xray, params, bindings);
    expect(Math.max(...c.yMagnetic.map(Math.abs))).toBe(0);
  });
});

/**
 * Regression: the spin field must be a pure function of the GEOMETRY, never of
 * the moment values. `buildSpinField` used to drop spins whose |m| fell below
 * 1e-9, so N (and the pair indices, ρ₀, ⟨m²⟩ and the spins-per-atom scale)
 * jumped as a refined moment crossed zero — while the spin-PAIR cache is keyed
 * on the geometry alone. Reusing one problem across such a step gave a magnetic
 * curve 22 % off in one direction and read out of bounds in the other, which
 * would also break the pooled ≡ serial contract (pool members prime their
 * caches from different value-sets) and poison every FD Jacobian column of a
 * moment mode seeded at zero — which is the default seed.
 *
 * The rule binds EVERY refined value, not just the magnitude — see the nested
 * POSITION block below, where a whole split-orbit sublattice used to vanish
 * once an atom moved off the coordinate the magnetic model was built at.
 */
describe("spin-field cache is value-independent", () => {
  const twoSublattices: StructureModel = {
    id: "mn", name: "Mn2", cell: { a: 4.4, b: 4.4, c: 4.4, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { operations: [IDENTITY_OP] },
    sites: [
      { label: "Mn1", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } },
      { label: "Mn2", element: "Mn", position: [0.5, 0.5, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } },
    ],
  };
  const twoSublatticeMagnetic: MagneticModel = {
    id: "mn-mag", structureId: "mn", propagation: [[0, 0, 0]],
    moments: [
      { siteLabel: "Mn1", frame: "crystallographic", components: [3, 0, 0], formFactorId: "Mn2" },
      { siteLabel: "Mn2", frame: "crystallographic", components: [0, 0, 0], formFactorId: "Mn2" },
    ],
  };
  const momentParams: RefinementParameter[] = [
    { id: "m1", label: "Mn1", kind: "momentMode", value: 3, initialValue: 3, min: -12, max: 12, fixed: false },
    { id: "m2", label: "Mn2", kind: "momentMode", value: 0, initialValue: 0, min: -12, max: 12, fixed: false },
  ];
  const momentBindings: ParameterBinding[] = [
    { parameterId: "m1", kind: "momentMode", targetId: "mn-mag", targetKey: "Mn1", momentBasis: [1, 0, 0] },
    { parameterId: "m2", kind: "momentMode", targetId: "mn-mag", targetKey: "Mn2", momentBasis: [1, 0, 0] },
  ];
  const shell: PdfPattern = {
    id: "p", name: "p", scatteringType: "neutron",
    points: Array.from({ length: 300 }, (_, k) => ({ r: 0.5 + k * 0.02, gObs: 0 })), qdamp: 0.02,
  };
  const spec = buildMpdfSpec(twoSublattices, shell, {
    magnetic: twoSublatticeMagnetic, params: momentParams, bindings: momentBindings,
  });
  const base: Record<string, number> = {};
  for (const p of spec.params) base[p.id] = p.value;
  const fresh = (): ReturnType<typeof buildMpdfProblem> =>
    buildMpdfProblem(twoSublattices, twoSublatticeMagnetic, shell, spec.params, spec.bindings);

  // Each direction crosses the old magnitude threshold the other way: 0 → 1
  // grew the spin list under a stale pair cache, 1 → 0 shrank it (out of bounds).
  for (const [first, second] of [[0, 1], [1, 0]] as const) {
    it(`a reused problem matches a fresh one across m2 ${first} → ${second}`, () => {
      const reusedProblem = fresh();
      reusedProblem.calculate({ ...base, m1: 3, m2: first }); // prime the caches
      const reused = Array.from(reusedProblem.calculate({ ...base, m1: 3, m2: second }));
      const clean = Array.from(fresh().calculate({ ...base, m1: 3, m2: second }));
      expect(Math.max(...clean.map(Math.abs))).toBeGreaterThan(0);
      for (let i = 0; i < clean.length; i++) {
        expect(Object.is(reused[i], clean[i]), `point ${i}`).toBe(true);
      }
    });
  }

  it("a sublattice refining through zero moves the magnetic curve continuously", () => {
    const problem = fresh();
    const peakAt = (m2: number): number =>
      Math.max(...Array.from(problem.calculate({ ...base, m1: 3, m2 })).map(Math.abs));
    // A discontinuous N would make these three differ in steps, not smoothly.
    const below = peakAt(-1e-7);
    const zero = peakAt(0);
    const above = peakAt(1e-7);
    expect(Math.abs(below - zero)).toBeLessThan(1e-6 * zero);
    expect(Math.abs(above - zero)).toBeLessThan(1e-6 * zero);
  });

  /**
   * The POSITION axis of the same rule, and the sharper one: a split-orbit
   * sublattice used to be anchored at the coordinate frozen into the magnetic
   * model at build time, so once a refined atom drifted past the 1e-3
   * coincidence tolerance the entire sublattice dropped out of the spin field —
   * silently, and invisibly to the optimizer. The engine's FD step
   * (h = max(1e-6, |p|·1e-5)) is three orders below the cliff, so the Jacobian
   * column never sees it while an LM trial step sails straight over; and
   * MPDF_STAGE_KINDS frees the moments in the stage immediately before the
   * positions, walking the guided sequence right into it.
   */
  describe("across refined POSITIONS", () => {
    // P2₁/c with k = (0,0,⅓): the little group is index 2, so Fe1's general
    // orbit splits into two independent sublattices — where a frozen anchor bites.
    const sg = buildSpaceGroup(14);
    const split: StructureModel = {
      id: "fe", name: "split", cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 100, gamma: 90 },
      spaceGroup: sg,
      sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } }],
    };
    const kVec: Vec3 = [0, 0, 1 / 3];
    const typeI = generateMagneticCandidatesForK(sg.operations, kVec).find((c) => c.isTypeI)!;
    const magBuild = buildMagneticModel(split, kVec, ["Fe1"], typeI.operations, { moment: 2 });

    const splitShell: PdfPattern = {
      id: "fe-pdf", name: "fe-pdf", scatteringType: "neutron",
      points: Array.from({ length: 200 }, (_, i) => ({ r: 1 + i * 0.03, gObs: 0 })),
      qdamp: 0.02,
    };
    const splitSpec = buildMpdfSpec(split, splitShell, magBuild);
    // The symmetry-adapted position mode along a — the row the guided sequence frees.
    const posRow = splitSpec.params.find((p) => p.kind === "positionShift" && p.id === "pos_Fe1_0")!;

    /** Σ|d_mag(r)| with the moments driven and the position mode set to `shift`. */
    const magnitudeAt = (shift: number): number => {
      const params = splitSpec.params.map((p) =>
        p.kind === "momentMode" ? { ...p, value: 1.5 }
        : p.id === posRow.id ? { ...p, value: shift }
        : p,
      );
      const c = mpdfComponents(split, splitSpec.magnetic, splitShell, params, splitSpec.bindings);
      return c.yMagnetic.reduce((a, b) => a + Math.abs(b), 0);
    };

    it("exposes the split orbit and the position row the moments stage runs into", () => {
      expect(posRow).toBeDefined();
      expect(magBuild.magnetic.moments.length).toBeGreaterThan(1); // really split
      expect(MPDF_STAGE_KINDS.some((s) => s.kinds.includes("positionShift"))).toBe(true);
    });

    it("keeps the magnetic component continuous across the 1e-3 anchor tolerance", () => {
      const base0 = magnitudeAt(0);
      expect(base0).toBeGreaterThan(0);
      // Straddle the old cliff. The magnetic signal genuinely varies with
      // position, so require continuity rather than equality: losing a
      // sublattice halves it.
      expect(Math.abs(magnitudeAt(1.1e-3) - magnitudeAt(9e-4)) / base0).toBeLessThan(1e-2);
    });

    it("never loses a sublattice, however far the position is driven", () => {
      // Far past the tolerance the old code flat-lined at the orbit-1-only value.
      const far = [0.02, 0.05].map(magnitudeAt);
      for (const v of far) expect(v).toBeGreaterThan(0.5 * magnitudeAt(0));
      // …and it is still a live function of position out there, not pinned.
      expect(Math.abs(far[0]! - far[1]!)).toBeGreaterThan(1e-9);
    });
  });
});

describe("mPDF co-refinement round trip", () => {
  it("recovers a perturbed moment amplitude against synthetic G(r)", () => {
    const s = structure();
    const { pattern, params, bindings } = truthPattern();
    const start = params.map((p) =>
      p.id === "mom_Mn1_0"
        ? { ...p, value: 1.8, initialValue: 1.8, fixed: false }
        : { ...p, fixed: p.kind === "pdfScale" ? false : true },
    );
    const problem = buildMpdfProblem(s, magnetic(s.id), pattern, start, bindings);
    const result = refine(problem, { maxIterations: 40, convergenceTolerance: 1e-12 });
    expect(["converged", "stalled"]).toContain(result.status);
    expect(Math.abs(result.parameters["mom_Mn1_0"]!)).toBeCloseTo(MOMENT, 3);
    expect(result.parameters["pdfScale"]!).toBeCloseTo(1, 4);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(1e-4);
  });
});
