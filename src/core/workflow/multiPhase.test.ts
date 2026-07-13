import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { refine } from "@/core/refinement/engine";
import { buildMultiPhasePowderProblem, multiPhaseCurves, type PowderPhase } from "@/core/workflow/multiPhase";
import { exampleStructure } from "@/examples/mn3ga";

// Second phase: rock-salt MnO (F-centred cubic, reduced op set for the test).
const mno: StructureModel = {
  id: "mno", name: "MnO",
  cell: { a: 4.450147, b: 4.450147, c: 4.450147, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: {
    operations: ["x,y,z", "x,1/2+y,1/2+z", "1/2+x,y,1/2+z", "1/2+x,1/2+y,z"].map(parseSymmetryOperation),
  },
  sites: [
    { label: "Mn", element: "Mn", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
    { label: "O", element: "O", position: [0.5, 0.5, 0.5], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } },
  ],
};

const neutron = { kind: "neutron" as const, wavelength: 1.54 };
const phases: PowderPhase[] = [{ structure: exampleStructure(), id: "mn3ga" }, { structure: mno, id: "mno" }];

const bindings: ParameterBinding[] = [
  { parameterId: "scale1", kind: "scale", targetId: "mn3ga" },
  { parameterId: "scale2", kind: "scale", targetId: "mno" },
  { parameterId: "width", kind: "peakWidth", targetId: "pat" },
];

const grid = Array.from({ length: 400 }, (_, i) => 15 + (i * 90) / 400);
function pattern(points: { x: number; yObs: number }[]): PowderPattern {
  return { id: "pat", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points };
}

describe("multi-phase powder", () => {
  const truthParams: RefinementParameter[] = [
    { id: "scale1", label: "s1", kind: "scale", value: 60, initialValue: 60, fixed: false },
    { id: "scale2", label: "s2", kind: "scale", value: 25, initialValue: 25, fixed: false },
    { id: "width", label: "w", kind: "peakWidth", value: 0.5, initialValue: 0.5, fixed: true },
  ];
  const empty = pattern(grid.map((x) => ({ x, yObs: 0 })));
  const truth = multiPhaseCurves(phases, empty, truthParams, bindings);
  const obs = pattern(grid.map((x, i) => ({ x, yObs: truth.yCalc[i]! })));

  it("sums the two phases into one pattern with structure", () => {
    expect(Math.max(...truth.yCalc)).toBeGreaterThan(0);
  });

  it("recovers both phase scales from a wrong start", () => {
    const params: RefinementParameter[] = [
      { id: "scale1", label: "s1", kind: "scale", value: 20, initialValue: 20, fixed: false },
      { id: "scale2", label: "s2", kind: "scale", value: 60, initialValue: 60, fixed: false },
      { id: "width", label: "w", kind: "peakWidth", value: 0.5, initialValue: 0.5, fixed: true },
    ];
    const problem = buildMultiPhasePowderProblem(phases, obs, params, bindings);
    const result = refine(problem, { maxIterations: 30 });
    expect(result.parameters.scale1).toBeCloseTo(60, 0);
    expect(result.parameters.scale2).toBeCloseTo(25, 0);
    expect(result.agreement.rFactor).toBeLessThan(0.02);
  });
});

// Regression: the fit-range knobs were only honored for single-phase nuclear
// refinement; a multi-phase (or magnetic) refine silently ignored them.
describe("multi-phase powder — fit range restricts the refinement", () => {
  const truthParams: RefinementParameter[] = [
    { id: "scale1", label: "s1", kind: "scale", value: 60, initialValue: 60, fixed: false },
    { id: "scale2", label: "s2", kind: "scale", value: 25, initialValue: 25, fixed: false },
    { id: "width", label: "w", kind: "peakWidth", value: 0.5, initialValue: 0.5, fixed: true },
  ];
  const truth = multiPhaseCurves(phases, pattern(grid.map((x) => ({ x, yObs: 0 }))), truthParams, bindings);
  const range = { min: 20, max: 60 };
  const start = (): RefinementParameter[] => [
    { id: "scale1", label: "s1", kind: "scale", value: 40, initialValue: 40, fixed: false },
    { id: "scale2", label: "s2", kind: "scale", value: 40, initialValue: 40, fixed: false },
    { id: "width", label: "w", kind: "peakWidth", value: 0.5, initialValue: 0.5, fixed: true },
  ];

  it("zeroes the weight of every point outside the fit range", () => {
    const obs = pattern(grid.map((x, i) => ({ x, yObs: truth.yCalc[i]! })));
    const problem = buildMultiPhasePowderProblem(phases, obs, truthParams, bindings, { shape: "gaussian" }, range);
    grid.forEach((x, i) => {
      if (x < range.min || x > range.max) expect(problem.weights[i]).toBe(0);
      else expect(problem.weights[i]).toBeGreaterThan(0);
    });
  });

  it("optimizes only the windowed data: junk outside the window can't bias the fit", () => {
    // Corrupt observed intensities OUTSIDE the window (×3). A full-pattern fit
    // chases that junk (scales biased high); the windowed fit ignores it and
    // recovers the truth (60, 25).
    const obs = pattern(grid.map((x, i) => ({ x, yObs: truth.yCalc[i]! * (x < range.min || x > range.max ? 3 : 1) })));
    const full = refine(buildMultiPhasePowderProblem(phases, obs, start(), bindings), { maxIterations: 40 });
    const windowed = refine(
      buildMultiPhasePowderProblem(phases, obs, start(), bindings, { shape: "gaussian" }, range),
      { maxIterations: 40 },
    );
    expect(windowed.parameters.scale1).toBeCloseTo(60, 0);
    expect(windowed.parameters.scale2).toBeCloseTo(25, 0);
    // The full-pattern fit is pulled distinctly higher by the ×3 out-of-window junk.
    expect(full.parameters.scale1!).toBeGreaterThan(windowed.parameters.scale1! + 2);
  });
});
