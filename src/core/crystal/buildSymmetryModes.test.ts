/**
 * Gates for `buildSymmetryModes` — symmetry-adapted displacement modes derived
 * from the structure's OWN space group (no parent/child CIF pair):
 *  - DOF accounting: emitted modes + excluded acoustic (rigid-translation)
 *    combinations = Σ per-site `allowedPositionShifts` dimensions;
 *  - every mode axis lies in its site's allowed span; every mode is orthogonal
 *    to the in-span uniform translations (the scattering gauge directions);
 *  - orthonormality in the multiplicity-weighted whole-cell Cartesian metric;
 *  - zero-amplitude identity (activating modes never changes the curve);
 *  - same-minimum: refining mode amplitudes ≡ refining coordinates (gauge
 *    fixed) on a synthetic G(r) truth displaced within the allowed space;
 *  - `withDistortionModes` honors the explicit `active` flag and keeps the
 *    legacy frozen-label fallback for child-decomposed sets.
 */
import { describe, it, expect } from "vitest";
import type { StructureModel, AtomSite, UnitCell, SymmetryOperation } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { refine } from "@/core/refinement/engine";
import { applyParameters } from "@/core/workflow/apply";
import { buildSymmetryModes, withDistortionModes, positionShiftValuesFor } from "@/core/crystal/distortionModes";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { buildPdfSpec, buildPdfProblem } from "@/core/workflow/pdf";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };
/** Mirror z → −z. */
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

function site(label: string, element: string, position: readonly [number, number, number]): AtomSite {
  return { label, element, position, occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } };
}

/**
 * Mirror-symmetric structure: A1 ON the mirror (allowed shifts x,y — dim 2,
 * multiplicity 1), B1 OFF it (general — dim 3, multiplicity 2). Raw DOF 5, of
 * which the uniform x and y translations are unobservable gauge directions
 * (z translation is NOT in-span — the mirror pins A1's z), so 3 modes emit.
 */
function mirrorStructure(): StructureModel {
  return {
    id: "m", name: "mirror", cell: CELL,
    spaceGroup: { operations: [IDENTITY_OP, MIRROR_Z] },
    sites: [site("A1", "Ni", [0, 0, 0]), site("B1", "O", [0.3, 0, 0.2])],
  };
}

const M_DIAG: readonly [number, number, number] = [CELL.a, CELL.b, CELL.c]; // orthorhombic metric

/** Multiplicity-weighted Cartesian dot of two mode-style axis lists. */
function weightedDot(
  a: readonly { readonly siteLabel: string; readonly axis: readonly [number, number, number] }[],
  b: readonly { readonly siteLabel: string; readonly axis: readonly [number, number, number] }[],
  mult: ReadonlyMap<string, number>,
): number {
  let s = 0;
  for (const ai of a) {
    const bi = b.find((q) => q.siteLabel === ai.siteLabel);
    if (!bi) continue;
    for (let i = 0; i < 3; i++) s += mult.get(ai.siteLabel)! * ai.axis[i]! * M_DIAG[i]! * bi.axis[i]! * M_DIAG[i]!;
  }
  return s;
}

describe("buildSymmetryModes — enumeration from the structure's own group", () => {
  const structure = mirrorStructure();
  const set = buildSymmetryModes(structure);
  const mult = new Map(
    structure.sites.map((q) => [q.label, siteMultiplicity(structure.spaceGroup.operations, q.position)]),
  );

  it("emitted modes + acoustic exclusions = Σ per-site DOF; Γ star; inactive", () => {
    const dofWant = structure.sites.reduce(
      (s, q) => s + allowedPositionShifts(structure.spaceGroup.operations, q.position).dimension,
      0,
    );
    expect(dofWant).toBe(5); // A1: 2 (on the mirror), B1: 3 (general)
    expect(set.acousticExcluded).toBe(2); // uniform x and y translations
    expect(set.parameters).toHaveLength(3);
    expect(set.modes).toHaveLength(3);
    for (const m of set.modes) {
      expect(m.star).toBe("Γ");
      expect(m.active).toBe(false);
      expect(m.observedAmplitude).toBe(0);
    }
  });

  it("every mode is orthogonal to the uniform (gauge) translations", () => {
    const both = structure.sites.map((q) => q.label);
    const tx = both.map((l) => ({ siteLabel: l, axis: [1, 0, 0] as [number, number, number] }));
    const ty = both.map((l) => ({ siteLabel: l, axis: [0, 1, 0] as [number, number, number] }));
    for (const m of set.modes) {
      expect(Math.abs(weightedDot(m.axes, tx, mult))).toBeLessThan(1e-9);
      expect(Math.abs(weightedDot(m.axes, ty, mult))).toBeLessThan(1e-9);
    }
  });

  it("every mode axis lies in its site's allowedPositionShifts span", () => {
    for (const q of structure.sites) {
      const { basis } = allowedPositionShifts(structure.spaceGroup.operations, q.position);
      const bCart = basis.map((b) => [b[0] * M_DIAG[0], b[1] * M_DIAG[1], b[2] * M_DIAG[2]]);
      for (const m of set.modes) {
        for (const ax of m.axes) {
          if (ax.siteLabel !== q.label) continue;
          const v = [ax.axis[0] * M_DIAG[0], ax.axis[1] * M_DIAG[1], ax.axis[2] * M_DIAG[2]];
          // Project v onto span(bCart) via a tiny Gram solve (n ≤ 3).
          const n = bCart.length;
          const G = bCart.map((bi) => bCart.map((bj) => bi[0]! * bj[0]! + bi[1]! * bj[1]! + bi[2]! * bj[2]!));
          const rhs = bCart.map((bi) => bi[0]! * v[0]! + bi[1]! * v[1]! + bi[2]! * v[2]!);
          const A = G.map((row, i) => [...row, rhs[i]!]);
          for (let col = 0; col < n; col++) {
            let piv = col;
            for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
            if (Math.abs(A[piv]![col]!) < 1e-12) continue;
            [A[col], A[piv]] = [A[piv]!, A[col]!];
            for (let r = 0; r < n; r++) {
              if (r === col) continue;
              const f = A[r]![col]! / A[col]![col]!;
              for (let k = col; k <= n; k++) A[r]![k] = A[r]![k]! - f * A[col]![k]!;
            }
          }
          const res = [v[0]!, v[1]!, v[2]!];
          for (let k = 0; k < n; k++) {
            const c = Math.abs(A[k]![k]!) > 1e-12 ? A[k]![n]! / A[k]![k]! : 0;
            for (let i = 0; i < 3; i++) res[i] = res[i]! - c * bCart[k]![i]!;
          }
          expect(Math.hypot(res[0]!, res[1]!, res[2]!)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it("modes are orthonormal in the multiplicity-weighted whole-cell Cartesian metric", () => {
    expect(mult.get("A1")).toBe(1);
    expect(mult.get("B1")).toBe(2);
    for (let i = 0; i < set.modes.length; i++) {
      for (let j = i; j < set.modes.length; j++) {
        const d = weightedDot(set.modes[i]!.axes, set.modes[j]!.axes, mult);
        expect(d).toBeCloseTo(i === j ? 1 : 0, 8);
      }
    }
  });

  it("zero amplitudes are the identity: parentized === structure, positions unchanged", () => {
    expect(set.parentized).toBe(structure); // the anchor IS the input
    expect(set.totalAmplitude).toBe(0);
    expect(set.unpaired).toEqual([]);
    const zero: Record<string, number> = {};
    for (const p of set.parameters) zero[p.id] = 0;
    const applied = applyParameters(set.parentized, set.bindings, zero).model;
    for (const s of applied.sites) {
      const ref = structure.sites.find((q) => q.label === s.label)!;
      for (let i = 0; i < 3; i++) expect(s.position[i]).toBeCloseTo(ref.position[i]!, 12);
    }
  });

  it("an OBLIQUE common direction is excluded too: all sites on a [111] 3-fold (GeTe motif)", () => {
    // C3 about [111]: (x,y,z) → (z,x,y). Both sites sit on the axis at (t,t,t),
    // so each allowed span is the single oblique direction [1,1,1] — no
    // coordinate axis is in-span, but the uniform [111] shift IS a rigid
    // translation (the ferroelectric GeTe/Bi/Sb motif). It must be excluded
    // and the one surviving mode must be the RELATIVE [111] motion.
    const C3: SymmetryOperation = {
      rotation: [
        [0, 0, 1],
        [1, 0, 0],
        [0, 1, 0],
      ],
      translation: [0, 0, 0],
      xyz: "z,x,y",
    };
    const C3sq: SymmetryOperation = {
      rotation: [
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0],
      ],
      translation: [0, 0, 0],
      xyz: "y,z,x",
    };
    const cubic: UnitCell = { a: 6, b: 6, c: 6, alpha: 90, beta: 90, gamma: 90 };
    const geTe: StructureModel = {
      id: "gete", name: "GeTe-like", cell: cubic,
      spaceGroup: { operations: [IDENTITY_OP, C3, C3sq] },
      sites: [site("Ge1", "Ge", [0.1, 0.1, 0.1]), site("Te1", "Te", [0.4, 0.4, 0.4])],
    };
    const s = buildSymmetryModes(geTe);
    expect(s.acousticExcluded).toBe(1); // the uniform [111] translation
    expect(s.modes).toHaveLength(1); // relative Ge–Te [111] motion
    // The surviving mode is orthogonal to the uniform [111] translation.
    const m = s.modes[0]!;
    let dotT = 0;
    for (const ax of m.axes) {
      // cubic cell: Cartesian = 6·fractional per component; multiplicity 1.
      dotT += (ax.axis[0] + ax.axis[1] + ax.axis[2]) * 6 * 6;
    }
    expect(Math.abs(dotT)).toBeLessThan(1e-9);
    // And it moves the two sites in OPPOSITE [111] senses (relative motion).
    const ge = m.axes.find((a) => a.siteLabel === "Ge1")!;
    const te = m.axes.find((a) => a.siteLabel === "Te1")!;
    expect(Math.sign(ge.axis[0])).not.toBe(Math.sign(te.axis[0]));
  });

  it("a symmetry-pinned site anchors the origin: no acoustic exclusion, single-site modes", () => {
    const INV: SymmetryOperation = {
      rotation: [
        [-1, 0, 0],
        [0, -1, 0],
        [0, 0, -1],
      ],
      translation: [0, 0, 0],
      xyz: "-x,-y,-z",
    };
    const pinned: StructureModel = {
      id: "pin", name: "pinned", cell: CELL,
      spaceGroup: { operations: [IDENTITY_OP, INV] },
      sites: [site("C1", "Ti", [0, 0, 0]), site("B1", "O", [0.3, 0.1, 0.2])],
    };
    const s = buildSymmetryModes(pinned);
    // C1 at the inversion center: dimension 0 → pinned → the origin is anchored
    // and NO translation is a null direction; B1 keeps its full 3 modes.
    expect(s.acousticExcluded).toBe(0);
    expect(s.modes).toHaveLength(3);
    for (const m of s.modes) {
      expect(new Set(m.axes.map((a) => a.siteLabel)).size).toBe(1);
      expect(m.axes[0]!.siteLabel).toBe("B1");
    }
  });
});

describe("withDistortionModes — the active flag", () => {
  it("symmetry sets enter all-fixed; flipping active frees exactly that mode", () => {
    const set = buildSymmetryModes(mirrorStructure());
    const swapped = withDistortionModes({ params: [], bindings: [] }, set);
    expect(swapped.params.length).toBeGreaterThan(0);
    expect(swapped.params.every((p) => p.fixed)).toBe(true);

    const oneActive = {
      ...set,
      modes: set.modes.map((m, i) => (i === 0 ? { ...m, active: true } : m)),
    };
    const swapped2 = withDistortionModes({ params: [], bindings: [] }, oneActive);
    const free = swapped2.params.filter((p) => !p.fixed).map((p) => p.id);
    expect(free).toEqual([set.modes[0]!.id]);
  });

  it("legacy fallback: modes without `active` still key off the frozen label", () => {
    const set = buildSymmetryModes(mirrorStructure());
    const legacy = {
      ...set,
      modes: set.modes.map((m, i) => {
        const { active: _drop, ...rest } = m;
        return i === 0 ? { ...rest, label: `A1 frozen distortion @ Γ (X…)` } : rest;
      }),
    };
    const swapped = withDistortionModes({ params: [], bindings: [] }, legacy);
    const free = swapped.params.filter((p) => !p.fixed).map((p) => p.id);
    expect(free).toEqual([set.modes[0]!.id]);
  });
});

describe("positionShiftValuesFor — fit-preserving re-seeding across parameterizations", () => {
  /** Hand-built per-coordinate (atomic) bindings from the allowed bases. */
  function atomicBindings(structure: StructureModel) {
    const bindings: { parameterId: string; kind: "positionShift"; targetId: string; targetKey: string; axis: [number, number, number] }[] = [];
    for (const q of structure.sites) {
      const { basis } = allowedPositionShifts(structure.spaceGroup.operations, q.position);
      basis.forEach((b, i) => {
        bindings.push({
          parameterId: `pos_${q.label}_${i}`,
          kind: "positionShift",
          targetId: structure.id,
          targetKey: q.label,
          axis: [...b] as [number, number, number],
        });
      });
    }
    return bindings;
  }

  it("atomic → irreps: projected amplitudes reproduce the relative geometry (gauge dropped)", () => {
    const structure = mirrorStructure();
    const atomic = atomicBindings(structure);
    // Displacements INCLUDING a gauge (uniform x-translation) component.
    const atomicValues: Record<string, number> = {
      pos_A1_0: 0.004, pos_A1_1: 0,
      pos_B1_0: 0.016, pos_B1_1: 0, pos_B1_2: 0.009,
    };
    const realized = applyParameters(structure, atomic, atomicValues).model;

    const set = buildSymmetryModes(structure);
    const ampl = positionShiftValuesFor(structure, set.bindings, realized);
    const realized2 = applyParameters(structure, set.bindings, ampl).model;

    // Relative geometry (the observable content) must match; absolute may
    // differ by the dropped translation.
    const rel = (m: StructureModel): number[] => {
      const a = m.sites.find((q) => q.label === "A1")!;
      const b = m.sites.find((q) => q.label === "B1")!;
      return [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
    };
    const want = rel(realized);
    const got = rel(realized2);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i]!, 10);
  });

  it("irreps → atomic: solved shifts reproduce the geometry exactly", () => {
    const structure = mirrorStructure();
    const set = buildSymmetryModes(structure);
    const modeValues: Record<string, number> = {};
    set.parameters.forEach((p, i) => {
      modeValues[p.id] = i === 0 ? 0.05 : i === 2 ? -0.03 : 0;
    });
    const realized = applyParameters(structure, set.bindings, modeValues).model;

    const atomic = atomicBindings(structure);
    const shifts = positionShiftValuesFor(structure, atomic, realized);
    const realized2 = applyParameters(structure, atomic, shifts).model;

    for (const s of realized.sites) {
      const t = realized2.sites.find((q) => q.label === s.label)!;
      for (let i = 0; i < 3; i++) expect(t.position[i]).toBeCloseTo(s.position[i]!, 10);
    }
  });
});

describe("mode-amplitude refinement ≡ coordinate refinement (from the group alone)", () => {
  /**
   * Truth: B1 displaced within its symmetry-allowed space — but ONLY along x
   * and z. At the anchor B1 sits at y = 0, where every pair distance depends
   * on Δy quadratically: the χ² landscape is exactly stationary along y (a
   * pseudo-symmetry DEAD direction — zero Jacobian column), so a y component
   * of the truth would be invisible to any first-order method. We still FREE
   * the y direction in both arms below: the engine's dead-column guard must
   * drop it cleanly (flagged in `singularParameterIds`) instead of letting its
   * finite-difference noise poison the step — the regression this fixture
   * originally exposed.
   */
  const D: readonly [number, number, number] = [0.012, 0, 0.009];
  function truth(): StructureModel {
    const s = mirrorStructure();
    return {
      ...s,
      sites: s.sites.map((q) =>
        q.label === "B1"
          ? { ...q, position: [0.3 + D[0], 0 + D[1], 0.2 + D[2]] as [number, number, number] }
          : q,
      ),
    };
  }

  function truthPattern(): PdfPattern {
    const t = truth();
    const rGrid = makeRGrid(0.5, 12, 0.02);
    const g = computeGofR(t.cell, expandStructureAtoms(t), rGrid, {
      scatteringType: "neutron", scale: 1, qdamp: 0.03, qbroad: 0, delta1: 0, delta2: 0,
    });
    return {
      id: "t", name: "t", scatteringType: "neutron",
      points: Array.from(rGrid, (r, i) => ({ r, gObs: g[i]! })), qdamp: 0.03,
    };
  }

  /** Relative B1−A1 fractional vector of a realized model. */
  function relative(model: StructureModel): [number, number, number] {
    const a = model.sites.find((q) => q.label === "A1")!;
    const b = model.sites.find((q) => q.label === "B1")!;
    return [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
  }

  it("both parameterizations reach the same minimum and the same relative structure", () => {
    const pattern = truthPattern();
    const structure = mirrorStructure();

    // A: per-coordinate refinement, gauge fixed the classical way — pin A1 and
    // free only B1's shifts (standard origin-fixing practice; freeing all five
    // coordinates makes the LS matrix exactly singular along the translations).
    const specA = buildPdfSpec(structure, pattern);
    const paramsA = specA.params.map((p) =>
      p.kind === "positionShift"
        ? { ...p, fixed: !p.id.includes("B1") }
        : p.kind === "cellLength" || p.kind === "cellAngle"
          ? { ...p, fixed: true }
          : p,
    );
    const resA = refine(buildPdfProblem(structure, pattern, paramsA, specA.bindings, specA.restraints), {
      maxIterations: 40, convergenceTolerance: 1e-10,
    });

    // B: mode-amplitude refinement — activate ALL modes. The acoustic gauge is
    // excluded by construction, so no manual pinning is needed: this is the
    // mode basis doing the origin-fixing automatically.
    const set = buildSymmetryModes(structure);
    const activeSet = { ...set, modes: set.modes.map((m) => ({ ...m, active: true })) };
    const specB = buildPdfSpec(structure, pattern);
    const swapped = withDistortionModes({ params: specB.params, bindings: specB.bindings }, activeSet);
    const paramsB = swapped.params.map((p) =>
      p.kind === "cellLength" || p.kind === "cellAngle" ? { ...p, fixed: true } : p,
    );
    const resB = refine(buildPdfProblem(structure, pattern, paramsB, swapped.bindings, specB.restraints), {
      maxIterations: 40, convergenceTolerance: 1e-10,
    });

    expect(["converged", "stalled"]).toContain(resA.status);
    expect(["converged", "stalled"]).toContain(resB.status);
    expect(resA.agreement.rWeighted ?? 1).toBeLessThan(0.005);
    expect(resB.agreement.rWeighted ?? 1).toBeLessThan(0.005);
    // The dead y direction was freed on purpose: the engine must flag it as
    // singular (dropped), not stall on it.
    expect(resA.diagnostics?.singularParameterIds ?? []).toContain("pos_B1_1");

    // Both recover the SAME relative structure (positions agree up to the
    // unobservable translation gauge).
    const wantRel = relative(truth());
    const relA = relative(applyParameters(structure, specA.bindings, { ...resA.parameters }).model);
    const relB = relative(applyParameters(structure, swapped.bindings, { ...resB.parameters }).model);
    for (let i = 0; i < 3; i++) {
      expect(relA[i]).toBeCloseTo(wantRel[i]!, 3);
      expect(relB[i]).toBeCloseTo(wantRel[i]!, 3);
    }
  });

  it("zero-amplitude modes leave the calculated G(r) byte-identical to the plain spec", () => {
    const pattern = truthPattern();
    const structure = mirrorStructure();
    const spec = buildPdfSpec(structure, pattern);
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.id] = p.value;
    const gPlain = buildPdfProblem(structure, pattern, spec.params, spec.bindings).calculate(values);

    const set = buildSymmetryModes(structure);
    const swapped = withDistortionModes({ params: spec.params, bindings: spec.bindings }, set);
    const valuesB: Record<string, number> = {};
    for (const p of swapped.params) valuesB[p.id] = p.value;
    const gModes = buildPdfProblem(structure, pattern, swapped.params, swapped.bindings).calculate(valuesB);

    for (let i = 0; i < gPlain.length; i++) {
      expect(gModes[i]).toBe(gPlain[i]);
    }
  });
});
