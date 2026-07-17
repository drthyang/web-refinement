import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine } from "@/core/refinement/engine";
import { applyParameters } from "@/core/workflow/apply";
import { buildDistortionModes, withDistortionModes } from "@/core/crystal/distortionModes";
import { buildPdfSpec, buildPdfProblem } from "@/core/workflow/pdf";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };
/** Mirror z → −z: the parent symmetry the child breaks. */
const MIRROR_Z: SymmetryOperation = {
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ],
  translation: [0, 0, 0],
  xyz: "x,y,-z",
};

const CELL: UnitCell = { a: 5, b: 5, c: 8, alpha: 90, beta: 90, gamma: 90 };
const DZ = 0.04; // fractional z displacement breaking the mirror

function site(label: string, element: string, position: readonly [number, number, number]): AtomSite {
  return { label, element, position, occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } };
}

/** Parent: A on the mirror, B's orbit = {(0.3,0,0.2), (0.3,0,−0.2)}. */
function parent(): StructureModel {
  return {
    id: "p", name: "parent", cell: CELL,
    spaceGroup: { operations: [IDENTITY_OP, MIRROR_Z] },
    sites: [site("A1", "Ni", [0, 0, 0]), site("B1", "O", [0.3, 0, 0.2])],
  };
}

/** Child (P1): B1 displaced by +DZ along z — one broken-mirror distortion. */
function child(dz = DZ): StructureModel {
  return {
    id: "c", name: "child", cell: CELL,
    spaceGroup: { operations: [IDENTITY_OP] },
    sites: [site("A1", "Ni", [0, 0, 0]), site("B1", "O", [0.3, 0, 0.2 + dz]), site("B2", "O", [0.3, 0, 0.8])],
  };
}

describe("buildDistortionModes — decomposition", () => {
  const set = buildDistortionModes(parent(), child());

  it("pairs every child site to a parent orbit member and spans the full shift space", () => {
    expect(set.unpaired).toEqual([]);
    expect(set.parameters).toHaveLength(9); // 3 P1 sites × 3 directions
    // The parentized anchor restores the mirror-symmetric position.
    const b1 = set.parentized.sites.find((s) => s.label === "B1")!;
    expect(b1.position[2]).toBeCloseTo(0.2, 10);
  });

  it("the frozen mode carries the whole observed distortion: A = |dz|·c in Å", () => {
    expect(set.totalAmplitude).toBeCloseTo(DZ * CELL.c, 8);
    expect(set.modes[0]!.observedAmplitude).toBeCloseTo(DZ * CELL.c, 8);
    for (const m of set.modes.slice(1)) expect(Math.abs(m.observedAmplitude)).toBeLessThan(1e-8);
    expect(set.modes[0]!.label).toContain("frozen");
  });

  it("parentized + seeded amplitudes reproduce the child positions exactly", () => {
    const values: Record<string, number> = {};
    for (const p of set.parameters) values[p.id] = p.value;
    const applied = applyParameters(set.parentized, set.bindings, values).model;
    const want = child();
    for (const s of applied.sites) {
      const ref = want.sites.find((q) => q.label === s.label)!;
      for (let i = 0; i < 3; i++) expect(s.position[i]).toBeCloseTo(ref.position[i]!, 9);
    }
  });

  it("modes are orthonormal in whole-cell Cartesian Å", () => {
    // Reconstruct the norm of each mode from its axes: Σ mult·|M·axis|² = 1.
    // (All child sites here have multiplicity 1 — P1.)
    const M = [
      [CELL.a, 0, 0],
      [0, CELL.b, 0],
      [0, 0, CELL.c],
    ];
    for (const m of set.modes) {
      let norm = 0;
      for (const ax of m.axes) {
        const c = [M[0]![0]! * ax.axis[0], M[1]![1]! * ax.axis[1], M[2]![2]! * ax.axis[2]];
        norm += c[0]! * c[0]! + c[1]! * c[1]! + c[2]! * c[2]!;
      }
      expect(norm).toBeCloseTo(1, 8);
    }
  });
});

describe("mode-amplitude refinement ≡ coordinate refinement", () => {
  /** Synthetic G(r) from the true (distorted) child. */
  function truthPattern(): PdfPattern {
    const truth = child();
    const rGrid = makeRGrid(0.5, 12, 0.02);
    const g = computeGofR(truth.cell, expandStructureAtoms(truth), rGrid, {
      scatteringType: "neutron", scale: 1, qdamp: 0.03, qbroad: 0, delta1: 0, delta2: 0,
    });
    return {
      id: "t", name: "t", scatteringType: "neutron",
      points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })), qdamp: 0.03,
    };
  }

  it("refining ONLY the frozen amplitude from the parent recovers A = dz·c", () => {
    const pattern = truthPattern();
    const set = buildDistortionModes(parent(), child());
    const spec = buildPdfSpec(set.parentized, pattern);
    const swapped = withDistortionModes({ params: spec.params, bindings: spec.bindings }, set);
    // Start at the PARENT (amplitude 0), free only mode_1 (+ scale stays free).
    const params = swapped.params.map((p) =>
      p.id.startsWith("mode_")
        ? { ...p, value: 0, initialValue: 0, fixed: p.id !== "mode_1" }
        : p.kind === "cellLength" || p.kind === "cellAngle"
          ? { ...p, fixed: true }
          : p,
    );
    const problem = buildPdfProblem(set.parentized, pattern, params, swapped.bindings, spec.restraints);
    const result = refine(problem, { maxIterations: 40, convergenceTolerance: 1e-10 });
    expect(["converged", "stalled"]).toContain(result.status);
    expect(result.parameters["mode_1"]!).toBeCloseTo(DZ * CELL.c, 3);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.005);
  });

  it("modes and coordinates are the SAME model: identical curves at equivalent values", () => {
    // Function-value equivalence (deterministic — no optimizer race): for any
    // physical structure, the coordinate parameterization anchored on it and
    // the mode parameterization that decomposes it must produce the identical
    // calculated G(r).
    const pattern = truthPattern();
    const probe = child(DZ * 0.5); // an arbitrary intermediate structure
    // A: coordinate spec anchored AT the probe (all shifts 0 = the probe itself).
    const specA = buildPdfSpec(probe, pattern);
    const valuesA: Record<string, number> = {};
    for (const p of specA.params) valuesA[p.id] = p.value;
    const gA = buildPdfProblem(probe, pattern, specA.params, specA.bindings).calculate(valuesA);
    // B: mode spec anchored at the PARENT with the probe's observed amplitudes.
    const set = buildDistortionModes(parent(), probe);
    const specB = buildPdfSpec(set.parentized, pattern);
    const swapped = withDistortionModes({ params: specB.params, bindings: specB.bindings }, set);
    const valuesB: Record<string, number> = {};
    for (const p of swapped.params) valuesB[p.id] = p.value;
    const gB = buildPdfProblem(set.parentized, pattern, swapped.params, swapped.bindings).calculate(valuesB);

    let maxDiff = 0;
    let peak = 0;
    for (let i = 0; i < gA.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(gA[i]! - gB[i]!));
      peak = Math.max(peak, Math.abs(gA[i]!));
    }
    expect(maxDiff).toBeLessThan(1e-9 * peak);
  });
});
