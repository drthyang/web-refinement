import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { allowedKShiftDirections, componentBounds, propagationKParameters, K_MAX_SHIFT } from "@/core/magnetic/refinableK";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { littleGroup } from "@/core/magnetic/magneticGroups";
import { parseTie } from "@/core/refinement/constraints";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { buildMagneticPowderProblem, magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { resolveTies } from "@/core/refinement/constraints";
import { refine } from "@/core/refinement/engine";

const ops = (xs: string[]) => xs.map(parseSymmetryOperation);
const MMM = ops(["x,y,z", "-x,y,z", "x,-y,z", "x,y,-z", "-x,-y,z", "-x,y,-z", "x,-y,-z", "-x,-y,-z"]);
/** P4/mmm-like point group 4/mmm acting on (x,y,z): enough to put (α,α,0) on a line. */
const P4MMM = ops([
  "x,y,z", "-x,-y,z", "-y,x,z", "y,-x,z", "-x,y,-z", "x,-y,-z", "y,x,-z", "-y,-x,-z",
  "-x,-y,-z", "x,y,-z", "y,-x,-z", "-y,x,-z", "x,-y,z", "-x,y,z", "-y,-x,z", "y,x,z",
]);

const iso = { kind: "isotropic", bIso: 0.3 } as const;
function p1(k: Vec3) {
  const structure: StructureModel = {
    id: "helix", name: "helix",
    cell: { a: 4, b: 4.6, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { hermannMauguin: "P 1", operations: ops(["x,y,z"]) },
    sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
  };
  return { structure, build: buildMagneticModel(structure, k, ["Fe1"], structure.spaceGroup.operations, { moment: 2 }) };
}

describe("symmetry-allowed shift directions of k", () => {
  it("a general k in P1 moves freely along all three axes", () => {
    expect(allowedKShiftDirections(ops(["x,y,z"]), [0.1, 0.2, 0.3])).toHaveLength(3);
  });

  it("k = (α,0,0) in mmm moves only along a*", () => {
    expect(allowedKShiftDirections(MMM, [0.23, 0, 0])).toEqual([[1, 0, 0]]);
  });

  it("a zone-boundary point is pinned", () => {
    expect(allowedKShiftDirections(MMM, [0.5, 0, 0])).toEqual([]);
    expect(allowedKShiftDirections(MMM, [0.5, 0.5, 0.5])).toEqual([]);
  });

  it("k on the (α,α,0) line of 4/mmm moves only along the line", () => {
    const dirs = allowedKShiftDirections(P4MMM, [0.2, 0.2, 0]);
    expect(dirs).toHaveLength(1);
    const d = dirs[0]!;
    expect(d[0]).toBeCloseTo(d[1]!, 12);
    expect(d[2]).toBeCloseTo(0, 12);
  });
});

describe("propagationKParameters", () => {
  it("refuses a self-conjugate k", () => {
    const { structure, build } = p1([0, 0, 0.5]);
    const r = propagationKParameters(structure, build.magnetic);
    expect(r.params).toEqual([]);
    expect(r.notes[0]).toMatch(/self-conjugate/);
  });

  it("emits one fixed row per free component, bounded between half-integers, with an absolute step cap", () => {
    const { structure, build } = p1([0.1, 0.2, 0.3]);
    const r = propagationKParameters(structure, build.magnetic);
    expect(r.params.map((p) => p.id)).toEqual(["prop_k1", "prop_k2", "prop_k3"]);
    expect(r.params.every((p) => p.fixed && p.kind === "propagationK" && p.maxShift === K_MAX_SHIFT)).toBe(true);
    const k3 = r.params[2]!;
    expect(k3.value).toBe(0.3);
    expect(k3.min).toBeCloseTo(0.001, 12);
    expect(k3.max).toBeCloseTo(0.499, 12);
    expect(r.bindings.map((b) => b.targetKey)).toEqual(["k1", "k2", "k3"]);
  });

  it("ties the dependent component of a symmetry line", () => {
    const structure: StructureModel = {
      id: "t", name: "t",
      cell: { a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: { hermannMauguin: "P 4/m m m", operations: P4MMM },
      sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
    };
    const k: Vec3 = [0.2, 0.2, 0];
    const build = buildMagneticModel(structure, k, ["Fe1"], P4MMM.filter((op) => {
      // little group of (α,α,0): the ops that fix the line
      const R = op.rotation;
      const t = [R[0]![0]! * k[0] + R[1]![0]! * k[1], R[0]![1]! * k[0] + R[1]![1]! * k[1]];
      return Math.abs(t[0]! - k[0]) < 1e-9 && Math.abs(t[1]! - k[1]) < 1e-9;
    }), { moment: 2 });
    const r = propagationKParameters(structure, build.magnetic);
    const free = r.params.filter((p) => !p.expression);
    const tied = r.params.filter((p) => p.expression);
    expect(free).toHaveLength(1);
    expect(tied).toHaveLength(1);
    // Moving the free component drags the tied one along the line.
    const values = Object.fromEntries(r.params.map((p) => [p.id, p.value]));
    values[free[0]!.id] = 0.21;
    const resolved = resolveTies(r.params, values);
    const applied = applyMagneticMoments(build.magnetic, r.bindings, resolved);
    expect(applied.propagation[0]![0]).toBeCloseTo(0.21, 12);
    expect(applied.propagation[0]![1]).toBeCloseTo(0.21, 12);
    expect(applied.propagation[0]![2]).toBe(0);
  });
});

describe("ties and bounds off the canonical zone (review regressions)", () => {
  // A k written with negative components puts whole-number constants in the
  // ties ("= prop_k1-1"), which the tie grammar used to read as a reference to
  // a parameter named "prop_k1-1" — every evaluation then threw.
  const cases: { sg: number; k: Vec3; move: string; to: number }[] = [
    { sg: 221, k: [0.3, -0.7, 0.1], move: "prop_k1", to: 0.31 }, // Pm-3m (α, α−1, γ) plane
    { sg: 191, k: [-0.2, -0.4, 0.1], move: "prop_k2", to: -0.41 }, // P6/mmm mirror plane
  ];
  for (const c of cases) {
    it(`space group ${c.sg}, k = (${c.k.join(", ")}): every tie parses and follows its free component`, () => {
      const sg = buildSpaceGroup(c.sg);
      const structure: StructureModel = {
        id: "g", name: "g", cell: c.sg === 191
          ? { a: 5, b: 5, c: 8, alpha: 90, beta: 90, gamma: 120 }
          : { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 },
        spaceGroup: sg,
        sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.11, 0.23, 0.37], occupancy: 1, adp: iso }],
      };
      const build = buildMagneticModel(structure, c.k, ["Fe1"], littleGroup(sg.operations, c.k), { moment: 2 });
      const r = propagationKParameters(structure, build.magnetic);
      const tied = r.params.filter((p) => p.expression);
      expect(tied.length).toBeGreaterThan(0);
      for (const p of tied) expect(parseTie(p.expression!)).toMatchObject({ kind: "linear", refId: expect.stringMatching(/^prop_k[123]$/) });
      // Unmoved: the ties reproduce k₀ exactly.
      const values = Object.fromEntries(r.params.map((p) => [p.id, p.value]));
      const k0 = applyMagneticMoments(build.magnetic, r.bindings, resolveTies(r.params, values)).propagation[0]!;
      for (let i = 0; i < 3; i++) expect(k0[i]).toBeCloseTo(c.k[i]!, 10);
      // Moved: k stays on the symmetry element (the moved k keeps the same little group).
      const moved = applyMagneticMoments(build.magnetic, r.bindings, resolveTies(r.params, { ...values, [c.move]: c.to })).propagation[0]!;
      expect(littleGroup(sg.operations, moved)).toHaveLength(littleGroup(sg.operations, c.k).length);
      for (const p of r.params) expect(p.min === undefined || (p.min < p.value && p.value < p.max!)).toBe(true);
    });
  }

  it("bounds always contain the starting value, even within the margin of a half-integer", () => {
    for (const v of [0.4995, 0.0004, -0.0004, 0.5, 0, 0.25, -0.3, 0.7, 1.2]) {
      const { min, max } = componentBounds(v);
      expect(min).toBeLessThan(v);
      expect(max).toBeGreaterThan(v);
    }
    expect(componentBounds(0.25)).toEqual({ min: 0.001, max: 0.499 });
    const neg = componentBounds(-0.3);
    expect(neg.min).toBeCloseTo(-0.499, 12);
    expect(neg.max).toBeCloseTo(-0.001, 12);
  });
});

describe("applying a refined k", () => {
  it("is idempotent: re-applying onto the refined model gives the same k", () => {
    const { structure, build } = p1([0, 0, 0.25]);
    const r = propagationKParameters(structure, build.magnetic);
    const values = { ...Object.fromEntries(build.params.map((p) => [p.id, p.value])), prop_k1: 0, prop_k2: 0, prop_k3: 0.2317 };
    const bindings = [...build.bindings, ...r.bindings];
    const once = applyMagneticMoments(build.magnetic, bindings, values);
    const twice = applyMagneticMoments(once, bindings, values);
    expect(once.propagation[0]).toEqual([0, 0, 0.2317]);
    expect(twice.propagation[0]).toEqual([0, 0, 0.2317]);
    expect(twice.moments).toEqual(once.moments);
  });

  it("single crystal refuses a free k (satellite indices come from the file)", () => {
    const { structure, build } = p1([0, 0, 0.25]);
    const r = propagationKParameters(structure, build.magnetic);
    const params = [...build.params, ...r.params.map((p) => (p.id === "prop_k3" ? { ...p, fixed: false } : p))];
    const dataset = { id: "sc", name: "sc", radiation: { kind: "neutron" as const, wavelength: 1.8 }, reflections: [{ h: 1, k: 0, l: 0.25, iObs: 1 }] };
    expect(() => buildMagneticSingleCrystalProblem(structure, build.magnetic, dataset, params, [...build.bindings, ...r.bindings]))
      .toThrow(/keeps k fixed/);
  });
});

describe("k recovery on a synthetic powder pattern (plan §B1 validation a)", () => {
  // Truth: a helix at an incommensurate k = (0, 0, 0.2317). The model starts
  // 0.03 r.l.u. away (≈ one satellite width here) with k₃ and the helix
  // amplitudes free; the fit must walk the satellites back into place.
  const kTrue: Vec3 = [0, 0, 0.2317];
  const { structure, build } = p1(kTrue);
  const nucParams = [
    { id: "scale", label: "s", kind: "scale" as const, value: 20, initialValue: 20, fixed: true, min: 0 },
    { id: "width", label: "w", kind: "peakWidth" as const, value: 0.5, initialValue: 0.5, fixed: true, min: 1e-3 },
  ];
  const nucBindings = [
    { parameterId: "scale", kind: "scale" as const, targetId: structure.id },
    { parameterId: "width", kind: "peakWidth" as const, targetId: "pat" },
  ];
  const grid = Array.from({ length: 1400 }, (_, i) => 8 + (i * (120 - 8)) / 1399);
  const empty: PowderPattern = {
    id: "pat", name: "p", xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: 1.8 }, wavelength: 1.8,
    points: grid.map((x) => ({ x, yObs: 0 })),
  };
  const kRows = propagationKParameters(structure, build.magnetic);
  const bindings = [...nucBindings, ...build.bindings, ...kRows.bindings];
  const moments = (vals: Record<string, number>, free: string[]) =>
    build.params.map((p) => ({ ...p, value: vals[p.id] ?? 0, initialValue: vals[p.id] ?? 0, fixed: !free.includes(p.id) }));
  const truthParams = [...nucParams, ...moments({ mom_Fe1_0: 2, mom_Fe1_1q: 2 }, []), ...kRows.params];
  const truth = magneticPowderComponents(structure, build.magnetic, empty, truthParams, bindings);
  const pattern: PowderPattern = {
    ...empty,
    points: empty.points.map((p, i) => ({ x: p.x, yObs: truth.yCalc[i]!, sigma: Math.sqrt(Math.max(truth.yCalc[i]!, 1)) })),
  };

  for (const offset of [0.02, -0.03, 0.05]) {
    it(`recovers k₃ from a start ${offset > 0 ? "+" : ""}${offset} r.l.u. away`, () => {
      const start = kTrue[2] + offset;
      const kParams = kRows.params.map((p) => (p.id === "prop_k3" ? { ...p, value: start, initialValue: start, fixed: false } : p));
      const params = [...nucParams, ...moments({ mom_Fe1_0: 1.5, mom_Fe1_1q: 1.5 }, ["mom_Fe1_0", "mom_Fe1_1q"]), ...kParams];
      const problem = buildMagneticPowderProblem(structure, build.magnetic, pattern, params, bindings);
      const result = refine(problem, { maxIterations: 80 });
      expect(result.parameters.prop_k3).toBeCloseTo(kTrue[2], 4);
      expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.01);
      const esd = result.esd.prop_k3;
      expect(esd).toBeGreaterThan(0);
      expect(esd).toBeLessThan(1e-3);
    });
  }
});
