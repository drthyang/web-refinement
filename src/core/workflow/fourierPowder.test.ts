import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { Vec3 } from "@/core/math/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticPowderComponents, buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { buildMagneticSingleCrystalProblem, magneticComparison, isSatelliteIndex } from "@/core/workflow/magnetic";
import { refine } from "@/core/refinement/engine";

/**
 * Two-arm (Fourier) magnetic refinement through the powder and single-crystal
 * workflows: a helical modulation — cosine amplitude along a, sine (quadrature)
 * amplitude along b — for k = (0, 0, ¼), recovered from a wrong start, and a
 * pure-cosine (SDW) model shown NOT to fit it. The cell is orthorhombic (a ≠ b)
 * on purpose: with a = b the (h0l) and (0kl) satellites overlap and a powder
 * cannot tell the a- from the b-amplitude.
 */
const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "helix", name: "helix test",
  cell: { a: 4, b: 4.6, c: 5, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: iso }],
};
const k: Vec3 = [0, 0, 0.25];
const build = buildMagneticModel(structure, k, ["Fe1"], structure.spaceGroup.operations, { moment: 2 });

const nucParams = [
  { id: "scale", label: "s", kind: "scale" as const, value: 20, initialValue: 20, fixed: true, min: 0 },
  { id: "width", label: "w", kind: "peakWidth" as const, value: 0.5, initialValue: 0.5, fixed: true, min: 1e-3 },
];
const nucBindings = [
  { parameterId: "scale", kind: "scale" as const, targetId: structure.id },
  { parameterId: "width", kind: "peakWidth" as const, targetId: "pat" },
];

const grid = Array.from({ length: 1200 }, (_, i) => 8 + (i * (120 - 8)) / 1199);
const empty: PowderPattern = {
  id: "pat", name: "p", xUnit: "twoTheta",
  radiation: { kind: "neutron", wavelength: 1.8 }, wavelength: 1.8,
  points: grid.map((x) => ({ x, yObs: 0 })),
};

/** Parameters with the given values; everything else fixed at 0 / its seed. */
function withValues(values: Record<string, number>, free: string[]) {
  return build.params.map((p) => {
    const v = values[p.id] ?? (p.id in values ? 0 : 0);
    return { ...p, value: v, initialValue: v, fixed: !free.includes(p.id) };
  });
}

describe("Fourier (two-arm) magnetic model — parameter set", () => {
  it("emits cosine + sine amplitudes per mode, one sine held as the phase gauge", () => {
    expect(build.fourier).toBe(true);
    expect(build.propagation.kind).toBe("commensurate");
    expect(build.propagation.twoArms).toBe(true);
    const ids = build.params.map((p) => p.id);
    expect(ids).toEqual(["mom_Fe1_0", "mom_Fe1_0q", "mom_Fe1_1", "mom_Fe1_1q", "mom_Fe1_2", "mom_Fe1_2q"]);
    expect(build.phaseGauge?.parameterId).toBe("mom_Fe1_0q");
    const gauge = build.params.find((p) => p.id === "mom_Fe1_0q")!;
    expect(gauge.fixed).toBe(true);
    expect(gauge.label).toContain("[phase gauge]");
    expect(build.params.find((p) => p.id === "mom_Fe1_0")!.label).toContain("cos (Mx)");
    expect(build.params.find((p) => p.id === "mom_Fe1_1q")!.label).toContain("sin (My)");
    // Bindings route the sine amplitudes onto sinComponents.
    const sinBind = build.bindings.filter((b) => b.momentPart === "sin");
    expect(sinBind.map((b) => b.parameterId)).toEqual(["mom_Fe1_0q", "mom_Fe1_1q", "mom_Fe1_2q"]);
    expect(build.magnetic.moments[0]!.sinComponents).toEqual([0, 0, 0]);
  });
});

describe("helix recovery — powder (k = (0,0,¼), Mcos ∥ a, Msin ∥ b)", () => {
  const truthValues = { mom_Fe1_0: 2, mom_Fe1_1q: 2 };
  const truthParams = [...nucParams, ...withValues(truthValues, [])];
  const bindings = [...nucBindings, ...build.bindings];
  const truth = magneticPowderComponents(structure, build.magnetic, empty, truthParams, bindings, { shape: "gaussian" });
  const pattern: PowderPattern = {
    ...empty,
    points: empty.points.map((p, i) => ({ x: p.x, yObs: truth.yCalc[i]!, sigma: Math.sqrt(Math.max(truth.yCalc[i]!, 1)) })),
  };

  it("the helix produces magnetic satellites", () => {
    expect(Math.max(...truth.yMagnetic)).toBeGreaterThan(0);
  });

  it("recovers both the cosine and the quadrature amplitude from a wrong start", () => {
    const params = [...nucParams, ...withValues({ mom_Fe1_0: 1.2, mom_Fe1_1q: 0.5 }, ["mom_Fe1_0", "mom_Fe1_1q"])];
    const problem = buildMagneticPowderProblem(structure, build.magnetic, pattern, params, bindings, { shape: "gaussian" });
    const result = refine(problem, { maxIterations: 60 });
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(0.02);
    // Global sign (time reversal) and chirality (sign of the quadrature part)
    // are invisible to a powder: recover the magnitudes.
    expect(Math.abs(result.parameters.mom_Fe1_0 ?? 0)).toBeCloseTo(2, 1);
    expect(Math.abs(result.parameters.mom_Fe1_1q ?? 0)).toBeCloseTo(2, 1);
  });

  it("a pure-cosine (SDW) model fits the helix data measurably worse", () => {
    // A powder cannot fully separate a helix from a collinear modulation (the
    // classic ambiguity), but with a ≠ b the (h0l)/(0kl) satellites split and
    // the pure-cosine model is left with a clear residual.
    const params = [...nucParams, ...withValues({ mom_Fe1_0: 1.2 }, ["mom_Fe1_0"])];
    const problem = buildMagneticPowderProblem(structure, build.magnetic, pattern, params, bindings, { shape: "gaussian" });
    const result = refine(problem, { maxIterations: 60 });
    expect(result.agreement.rWeighted ?? 0).toBeGreaterThan(0.05);
  });
});

describe("single-crystal satellites (fractional indices)", () => {
  it("a satellite row carries no nuclear term; the −k arm scatters like its Friedel mate", () => {
    const params = withValues({ mom_Fe1_0: 2, mom_Fe1_1q: 1 }, []);
    const scale = { id: "scale", label: "s", kind: "scale" as const, value: 1, initialValue: 1, fixed: true };
    const magScale = { id: "ms", label: "m", kind: "magneticScale" as const, value: 1, initialValue: 1, fixed: true };
    const bindings = [
      { parameterId: "scale", kind: "scale" as const, targetId: structure.id },
      { parameterId: "ms", kind: "magneticScale" as const, targetId: build.magnetic.id },
      ...build.bindings,
    ];
    const dataset: SingleCrystalDataset = {
      id: "sc", name: "sc", radiation: { kind: "neutron", wavelength: 1.8 },
      reflections: [
        { h: 1, k: 0, l: 0, iObs: 1 },
        { h: 1, k: 0, l: 0.25, iObs: 1 },
        { h: 1, k: 0, l: -0.25, iObs: 1 },
        { h: -1, k: 0, l: -0.25, iObs: 1 },
      ],
    };
    expect(isSatelliteIndex(1, 0, 0.25)).toBe(true);
    expect(isSatelliteIndex(1, 0, 0)).toBe(false);
    const rows = magneticComparison(structure, build.magnetic, dataset, [scale, magScale, ...params], bindings);
    expect(rows[0]!.iNuclear).toBeGreaterThan(0);
    expect(rows[0]!.iMagnetic).toBe(0); // k ≠ 0: a single-k modulation puts nothing on the nuclear node
    expect(rows[1]!.iNuclear).toBe(0);
    expect(rows[1]!.iMagnetic).toBeGreaterThan(0);
    expect(rows[2]!.iNuclear).toBe(0);
    // (1,0,−¼) is the −k arm; (−1,0,−¼) is the Friedel mate of (1,0,¼): equal.
    expect(rows[3]!.iMagnetic).toBeCloseTo(rows[1]!.iMagnetic, 9);
    const problem = buildMagneticSingleCrystalProblem(structure, build.magnetic, dataset, [scale, magScale, ...params], bindings);
    const calc = problem.calculate(Object.fromEntries([scale, magScale, ...params].map((p) => [p.id, p.value])));
    expect(calc[1]).toBeCloseTo(rows[1]!.iTotal, 9);
  });
});
