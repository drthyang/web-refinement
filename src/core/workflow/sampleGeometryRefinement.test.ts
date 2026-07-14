import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { refine } from "@/core/refinement/engine";

/**
 * Sample-geometry corrections (specimen displacement ∝cosθ, transparency ∝sin2θ):
 * emission gating and a synthetic round-trip proving the displacement is
 * recoverable by the refiner, not merely applied to the forward model.
 */

const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "ni",
  name: "Ni",
  cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: buildSpaceGroup(225), // cubic Fm-3m
  sites: [{ label: "Ni1", element: "Ni", oxidationState: 2, position: [0, 0, 0], occupancy: 1, adp: iso }],
};

const grid = Array.from({ length: 1400 }, (_, i) => 15 + (i * (120 - 15)) / 1399);
const pattern: PowderPattern = {
  id: "ni",
  name: "p",
  xUnit: "twoTheta",
  radiation: { kind: "neutron", wavelength: 1.5 },
  wavelength: 1.5,
  points: grid.map((x) => ({ x, yObs: 0 })),
};
const profile = { shape: "gaussian" as const };

describe("sample-geometry parameter emission", () => {
  it("emits displacement + transparency for a CW 2θ pattern, free by default", () => {
    const spec = buildStructureRefinement(structure, pattern, {
      corrections: [{ id: "displacement" }, { id: "transparency" }],
      refineAdp: false,
      refinePositions: false,
    });
    const displ = spec.params.find((p) => p.kind === "sampleDisplacement");
    const transp = spec.params.find((p) => p.kind === "sampleTransparency");
    expect(displ?.fixed).toBe(false);
    expect(transp?.fixed).toBe(false);
  });

  it("does NOT emit them for a non-2θ (d-spacing) pattern", () => {
    const dPattern: PowderPattern = { ...pattern, xUnit: "dSpacing" };
    const spec = buildStructureRefinement(structure, dPattern, {
      corrections: [{ id: "displacement" }, { id: "transparency" }],
      refineAdp: false,
      refinePositions: false,
    });
    expect(spec.params.some((p) => p.kind === "sampleDisplacement")).toBe(false);
    expect(spec.params.some((p) => p.kind === "sampleTransparency")).toBe(false);
  });
});

describe("specimen-displacement round-trip", () => {
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: pattern.id },
    { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
    // A flat background term. Real powder data always has a background/counting
    // floor; without one, the noise-free Gaussian tails of a purely synthetic
    // pattern underflow toward ~0, and the engine's σ=√yObs weighting then puts
    // ~1/yObs → enormous weight on those tail points, making the synthetic χ²
    // landscape numerically degenerate. The floor keeps the weights physical.
    { parameterId: "bkg0", kind: "background", targetId: pattern.id, targetKey: "0" },
    { parameterId: "sampleDispl", kind: "sampleDisplacement", targetId: pattern.id },
  ];
  const mk = (displ: number, freeDispl: boolean): RefinementParameter[] => [
    { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, min: 0, fixed: true },
    { id: "width", label: "width", kind: "peakWidth", value: 0.3, initialValue: 0.3, fixed: true },
    { id: "bkg0", label: "bkg", kind: "background", value: 500, initialValue: 500, fixed: true },
    { id: "sampleDispl", label: "displ", kind: "sampleDisplacement", value: displ, initialValue: displ, min: -2, max: 2, fixed: !freeDispl },
  ];

  it("recovers an injected D·cosθ shift from zero", () => {
    const trueD = 0.08;
    // Synthetic "observed" pattern generated with the displacement present.
    const truth = powderCurves(structure, pattern, mk(trueD, false), bindings, profile);
    const observed: PowderPattern = {
      ...pattern,
      points: grid.map((x, i) => ({ x, yObs: truth.yCalc[i]! })),
    };
    // Refine the displacement (only) starting from 0 against that pattern.
    const problem = buildPowderProblem(structure, observed, mk(0, true), bindings, profile);
    const result = refine(problem, { maxIterations: 40 });
    expect(result.status).toBe("converged");
    expect(result.parameters["sampleDispl"]).toBeCloseTo(trueD, 3);
  });
});

describe("surface-roughness emission + wiring", () => {
  it("emits SRA/SRB for a CW 2θ pattern, seeded off the identity, and not for d-spacing", () => {
    const spec = buildStructureRefinement(structure, pattern, { corrections: [{ id: "roughness" }], refineAdp: false, refinePositions: false });
    const sra = spec.params.find((p) => p.kind === "surfaceRoughA");
    const srb = spec.params.find((p) => p.kind === "surfaceRoughB");
    expect(sra?.value).toBeLessThan(1); // not the degenerate SRA=1
    expect(srb?.value).toBeGreaterThan(0); // not the degenerate SRB=0
    const dSpec = buildStructureRefinement(structure, { ...pattern, xUnit: "dSpacing" }, { corrections: [{ id: "roughness" }], refineAdp: false, refinePositions: false });
    expect(dSpec.params.some((p) => p.kind === "surfaceRoughA")).toBe(false);
  });

  it("suppresses low-angle intensity relative to high-angle when roughness is on", () => {
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
      { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
      { parameterId: "sra", kind: "surfaceRoughA", targetId: pattern.id },
      { parameterId: "srb", kind: "surfaceRoughB", targetId: pattern.id },
    ];
    const mk = (sra: number, srb: number): RefinementParameter[] => [
      { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, min: 0, fixed: true },
      { id: "width", label: "w", kind: "peakWidth", value: 0.3, initialValue: 0.3, fixed: true },
      { id: "sra", label: "SRA", kind: "surfaceRoughA", value: sra, initialValue: sra, min: 0, max: 1, fixed: true },
      { id: "srb", label: "SRB", kind: "surfaceRoughB", value: srb, initialValue: srb, min: 0, max: 5, fixed: true },
    ];
    const peakMaxNear = (yc: readonly number[], twoTheta: number): number => {
      let m = 0;
      for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i]! - twoTheta) < 5) m = Math.max(m, yc[i]!);
      return m;
    };
    const off = powderCurves(structure, pattern, mk(1, 0), bindings, profile).yCalc; // identity
    const on = powderCurves(structure, pattern, mk(0.6, 0.3), bindings, profile).yCalc;
    // (111) of a=4 sits near 2θ≈33°, a high-angle line near ≈100°+. Use the lowest
    // and a high line: roughness cuts the low-angle peak more than the high-angle one.
    const lowRatio = peakMaxNear(on, 33) / peakMaxNear(off, 33);
    const highRatio = peakMaxNear(on, 109) / peakMaxNear(off, 109);
    expect(lowRatio).toBeLessThan(highRatio); // low angle suppressed more
    expect(highRatio).toBeCloseTo(1, 1); // high angle nearly unchanged
  });

  it("recovers an injected SRB (with SRA fixed) — avoiding the SRA/SRB degeneracy", () => {
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
      { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
      { parameterId: "bkg0", kind: "background", targetId: pattern.id, targetKey: "0" },
      { parameterId: "sra", kind: "surfaceRoughA", targetId: pattern.id },
      { parameterId: "srb", kind: "surfaceRoughB", targetId: pattern.id },
    ];
    const mk = (srb: number, freeB: boolean): RefinementParameter[] => [
      { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, min: 0, fixed: true },
      { id: "width", label: "w", kind: "peakWidth", value: 0.3, initialValue: 0.3, fixed: true },
      { id: "bkg0", label: "bkg", kind: "background", value: 500, initialValue: 500, fixed: true },
      { id: "sra", label: "SRA", kind: "surfaceRoughA", value: 0.6, initialValue: 0.6, min: 0, max: 1, fixed: true },
      { id: "srb", label: "SRB", kind: "surfaceRoughB", value: srb, initialValue: srb, min: 0, max: 5, fixed: !freeB },
    ];
    const trueB = 0.3;
    const truth = powderCurves(structure, pattern, mk(trueB, false), bindings, profile);
    const observed: PowderPattern = { ...pattern, points: grid.map((x, i) => ({ x, yObs: truth.yCalc[i]! })) };
    const problem = buildPowderProblem(structure, observed, mk(0.1, true), bindings, profile);
    const result = refine(problem, { maxIterations: 60 });
    expect(result.status).toBe("converged");
    expect(result.parameters["srb"]).toBeCloseTo(trueB, 2);
  });
});
