import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { UnitCell } from "@/core/crystal/types";
import { exampleStructure } from "@/examples/mn3ga";
import { magneticSubgroupLattice, latticeRepresentatives } from "@/core/magnetic/subgroupLattice";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { crystalComponentsToCartesian } from "@/core/magnetic/moment";
import { momentBindingKey } from "@/core/magnetic/types";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { magneticPowderComponents, buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { refine } from "@/core/refinement/engine";

/**
 * The Mn₃Ga / Cm'cm' regression: under the orthorhombic magnetic subgroup the
 * Mn 6h orbit splits into two sublattices (4 atoms with a 2-D allowed moment
 * space, 2 atoms with a 1-D space along (−1,1,0)). Physically all six Mn carry
 * the same |m| (the 120° triangular antiferromagnet). Previously:
 *  - mode amplitudes were raw crystal-axis coefficients, so the same amplitude
 *    meant √3× larger |m| on the (−1,1,0) sublattice (hexagonal metric), and
 *  - nothing constrained the sublattice sizes, so a refinement against a weak
 *    magnetic signal could silently zero one sublattice ("one Mn has no
 *    moment").
 * Modes are now unit-µ_B normalized, and `equalAmplitude` shares ONE |M|
 * across every sublattice with per-orbit direction angles.
 */

const cartMag = (cell: UnitCell, comps: Vec3): number => {
  const c = crystalComponentsToCartesian(cell, comps);
  return Math.hypot(c[0]!, c[1]!, c[2]!);
};

function cmcmCandidate() {
  const structure = exampleStructure(); // Mn₃Ga, P6₃/mmc
  const k: Vec3 = [0, 0, 0];
  const reps = latticeRepresentatives(magneticSubgroupLattice(structure.spaceGroup.operations, k, { maxIndex: 6 }));
  const cand = reps.find((r) => {
    const bns = r.candidate.standard?.bnsSymbol ?? r.settingMatch?.identity.bnsSymbol ?? "";
    return bns.replace(/\s/g, "") === "Cm'cm'";
  });
  expect(cand).toBeDefined();
  return { structure, k, ops: [...cand!.candidate.operations] };
}

describe("moment-mode normalization (unit µ_B modes)", () => {
  it("seeds every split orbit of Mn₃Ga/Cm'cm' at the same Cartesian |m|", () => {
    const { structure, k, ops } = cmcmCandidate();
    const build = buildMagneticModel(structure, k, ["Mn1"], ops, { moment: 2 });
    expect(build.magnetic.moments).toHaveLength(2); // two sublattices
    for (const m of build.magnetic.moments) {
      expect(cartMag(structure.cell, m.components)).toBeCloseTo(2, 6);
    }
  });

  it("a mode amplitude is the moment size in µ_B along that mode", () => {
    const { structure, k, ops } = cmcmCandidate();
    const build = buildMagneticModel(structure, k, ["Mn1"], ops, { moment: 0 });
    // Drive only the 1-D orbit's (−1,1,0)-type mode with amplitude 1.7.
    const orbit2 = build.params.find((p) => p.id.includes("_o2_"))!;
    const values: Record<string, number> = {};
    for (const p of build.params) values[p.id] = 0;
    values[orbit2.id] = 1.7;
    const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
    const m2 = applied.moments.find((m) => momentBindingKey(m) === "Mn1#2")!;
    expect(cartMag(structure.cell, m2.components)).toBeCloseTo(1.7, 6);
  });
});

describe("equalAmplitude: one shared |M| across all sublattices", () => {
  it("emits one magnitude parameter plus one angle for the 2-D orbit only", () => {
    const { structure, k, ops } = cmcmCandidate();
    const build = buildMagneticModel(structure, k, ["Mn1"], ops, { moment: 2, equalAmplitude: true });
    const mags = build.params.filter((p) => p.kind === "momentMagnitude");
    const angles = build.params.filter((p) => p.kind === "momentAngle");
    expect(mags).toHaveLength(1); // ONE |M| for both sublattices
    expect(angles).toHaveLength(1); // only the 2-D orbit has a direction angle
    // No zero-valued moment rows: the magnitude is the seed on every orbit.
    expect(mags[0]!.value).toBe(2);
    for (const m of build.magnetic.moments) {
      expect(cartMag(structure.cell, m.components)).toBeCloseTo(2, 6);
    }
  });

  it("|m| equals the shared |M| on every sublattice, for any direction angle", () => {
    const { structure, k, ops } = cmcmCandidate();
    const build = buildMagneticModel(structure, k, ["Mn1"], ops, { moment: 2, equalAmplitude: true });
    const magParam = build.params.find((p) => p.kind === "momentMagnitude")!;
    const angParam = build.params.find((p) => p.kind === "momentAngle")!;
    for (const phi of [0, 33, 120, -75, 210]) {
      const applied = applyMagneticMoments(build.magnetic, build.bindings, {
        [magParam.id]: 3.1,
        [angParam.id]: phi,
      });
      for (const m of applied.moments) {
        expect(cartMag(structure.cell, m.components)).toBeCloseTo(3.1, 6);
      }
    }
  });

  it("the direction angle rotates the 2-D orbit without touching the 1-D orbit", () => {
    const { structure, k, ops } = cmcmCandidate();
    const build = buildMagneticModel(structure, k, ["Mn1"], ops, { moment: 2, equalAmplitude: true });
    const magParam = build.params.find((p) => p.kind === "momentMagnitude")!;
    const angParam = build.params.find((p) => p.kind === "momentAngle")!;
    const at = (phi: number) => applyMagneticMoments(build.magnetic, build.bindings, { [magParam.id]: 2, [angParam.id]: phi });
    const a = at(0);
    const b = at(90);
    const m1a = a.moments.find((m) => momentBindingKey(m) === "Mn1")!;
    const m1b = b.moments.find((m) => momentBindingKey(m) === "Mn1")!;
    const m2a = a.moments.find((m) => momentBindingKey(m) === "Mn1#2")!;
    const m2b = b.moments.find((m) => momentBindingKey(m) === "Mn1#2")!;
    // 2-D orbit: 90° rotation is orthogonal to the start.
    const ca = crystalComponentsToCartesian(structure.cell, m1a.components);
    const cb = crystalComponentsToCartesian(structure.cell, m1b.components);
    expect(Math.abs(ca[0]! * cb[0]! + ca[1]! * cb[1]! + ca[2]! * cb[2]!)).toBeLessThan(1e-6);
    // 1-D orbit: direction is symmetry-fixed, unchanged by the angle.
    expect(m2a.components).toEqual(m2b.components);
  });

  it("a P1-type (3-D) site gets |M| plus two angles spanning all directions", () => {
    const identity = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], xyz: "x,y,z" } as const;
    const structure = {
      id: "p1",
      name: "p1",
      cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 100, gamma: 90 },
      spaceGroup: { number: 1, hermannMauguin: "P 1", crystalSystem: "triclinic", operations: [identity] },
      sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3] as Vec3, occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } as const }],
    };
    const build = buildMagneticModel(structure, [0, 0, 0], ["Fe1"], [identity], { moment: 1.5, equalAmplitude: true });
    expect(build.params.filter((p) => p.kind === "momentMagnitude")).toHaveLength(1);
    expect(build.params.filter((p) => p.kind === "momentAngle")).toHaveLength(2);
    const [magP] = build.params.filter((p) => p.kind === "momentMagnitude");
    const [phiP, thetaP] = build.params.filter((p) => p.kind === "momentAngle");
    // |m| = |M| for arbitrary (φ, θ), even in this oblique cell.
    for (const [phi, theta] of [[0, 0], [40, 25], [200, -60], [-90, 90]]) {
      const applied = applyMagneticMoments(build.magnetic, build.bindings, {
        [magP!.id]: 2.4,
        [phiP!.id]: phi!,
        [thetaP!.id]: theta!,
      });
      expect(cartMag(structure.cell, applied.moments[0]!.components)).toBeCloseTo(2.4, 6);
    }
    // θ = 90° reaches the third frame axis regardless of φ.
    const up = applyMagneticMoments(build.magnetic, build.bindings, { [magP!.id]: 1, [phiP!.id]: 123, [thetaP!.id]: 90 });
    const flat = applyMagneticMoments(build.magnetic, build.bindings, { [magP!.id]: 1, [phiP!.id]: 0, [thetaP!.id]: 0 });
    const cu = crystalComponentsToCartesian(structure.cell, up.moments[0]!.components);
    const cf = crystalComponentsToCartesian(structure.cell, flat.moments[0]!.components);
    expect(Math.abs(cu[0]! * cf[0]! + cu[1]! * cf[1]! + cu[2]! * cf[2]!)).toBeLessThan(1e-6);
  });

  it("a powder refinement recovers the shared |M| and direction angle", () => {
    const { structure, k, ops } = cmcmCandidate();
    const build = buildMagneticModel(structure, k, ["Mn1"], ops, { moment: 2, equalAmplitude: true });
    const magP = build.params.find((p) => p.kind === "momentMagnitude")!;
    const angP = build.params.find((p) => p.kind === "momentAngle")!;

    const nucParams = [
      { id: "scale", label: "s", kind: "scale" as const, value: 15, initialValue: 15, fixed: true, min: 0 },
      { id: "width", label: "w", kind: "peakWidth" as const, value: 0.4, initialValue: 0.4, fixed: true, min: 1e-3 },
    ];
    const nucBindings = [
      { parameterId: "scale", kind: "scale" as const, targetId: structure.id },
      { parameterId: "width", kind: "peakWidth" as const, targetId: "pat" },
    ];
    const grid = Array.from({ length: 1200 }, (_, i) => 10 + (i * (120 - 10)) / 1199);
    const empty: PowderPattern = {
      id: "pat", name: "p", xUnit: "twoTheta",
      radiation: { kind: "neutron", wavelength: 2.4 }, wavelength: 2.4,
      points: grid.map((x) => ({ x, yObs: 0 })),
    };
    const bindings = [...nucBindings, ...build.bindings];
    const truthValues = { [magP.id]: 2.5, [angP.id]: 35 };
    const truthParams = [
      ...nucParams,
      ...build.params.map((p) => ({ ...p, value: truthValues[p.id] ?? p.value, initialValue: truthValues[p.id] ?? p.value })),
    ];
    const truth = magneticPowderComponents(structure, build.magnetic, empty, truthParams, bindings, { shape: "gaussian" });
    expect(Math.max(...truth.yMagnetic)).toBeGreaterThan(0);

    const pat: PowderPattern = {
      ...empty,
      points: grid.map((x, i) => ({ x, yObs: truth.yCalc[i] ?? 0, sigma: Math.sqrt(Math.max(truth.yCalc[i] ?? 0, 1)) + 1 })),
    };
    // Start away from the truth: |M| = 1.2 µ_B, angle 0°; both freed.
    const start = [
      ...nucParams,
      ...build.params.map((p) => {
        const v = p.id === magP.id ? 1.2 : 0;
        return { ...p, value: v, initialValue: v, fixed: false };
      }),
    ];
    const problem = buildMagneticPowderProblem(structure, build.magnetic, pat, start, bindings, { shape: "gaussian" });
    const result = refine(problem, { maxIterations: 60 });
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.03);
    expect(result.parameters[magP.id] ?? 0).toBeCloseTo(2.5, 1);
    // Intensities are invariant under global time reversal (angle + 180°) and
    // the mirror-related domain — compare the angle modulo those equivalences.
    const angDist = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);
    const phi = result.parameters[angP.id] ?? 0;
    const folded = Math.min(...[35, -35, 145, -145].map((t) => angDist(phi, t)));
    expect(folded).toBeLessThan(2);
  });
});
