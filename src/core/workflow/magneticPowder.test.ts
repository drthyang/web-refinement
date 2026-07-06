import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import { buildMagneticPowderProblem, magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { exampleMagnetic, magneticParameters, magneticBindings } from "@/examples/mn3gaMagnetic";

const neutron = { kind: "neutron" as const, wavelength: 1.54 };

describe("magnetic powder refinement (Phase 7)", () => {
  const { structure, magnetic } = exampleMagnetic();
  const grid = Array.from({ length: 500 }, (_, i) => 10 + (i * 100) / 500);

  // Parameters: moments (from example) + scales + width, all bound to the pattern/model.
  const baseParams = magneticParameters(magnetic);
  const bindings: ParameterBinding[] = [
    ...magneticBindings(magnetic).filter((b) => b.kind !== "scale" && b.kind !== "magneticScale"),
    { parameterId: "scaleN", kind: "scale", targetId: structure.id },
    { parameterId: "scaleM", kind: "magneticScale", targetId: magnetic.id },
    { parameterId: "width", kind: "peakWidth", targetId: "pat" },
  ];
  const withScales = (scaleM: number): RefinementParameter[] => [
    ...baseParams.filter((p) => p.id !== "scaleN" && p.id !== "scaleM").map((p) => ({ ...p, fixed: true })),
    { id: "scaleN", label: "sN", kind: "scale", value: 1, initialValue: 1, fixed: true },
    { id: "scaleM", label: "sM", kind: "magneticScale", value: scaleM, initialValue: scaleM, fixed: false },
    { id: "width", label: "w", kind: "peakWidth", value: 0.6, initialValue: 0.6, fixed: true },
  ];

  const empty: PowderPattern = { id: "pat", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points: grid.map((x) => ({ x, yObs: 0 })) };
  const truth = magneticPowderComponents(structure, magnetic, empty, withScales(1), bindings);
  const obs: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: truth.yCalc[i]! })) };

  it("produces separable nuclear and magnetic pattern components", () => {
    expect(Math.max(...truth.yNuclear)).toBeGreaterThan(0);
    expect(Math.max(...truth.yMagnetic)).toBeGreaterThan(0);
    // Total is the sum of the two components.
    for (let i = 0; i < truth.yCalc.length; i++) {
      expect(truth.yCalc[i]!).toBeCloseTo(truth.yNuclear[i]! + truth.yMagnetic[i]!, 6);
    }
  });

  it("recovers the magnetic scale from a wrong start", () => {
    const problem = buildMagneticPowderProblem(structure, magnetic, obs, withScales(0.3), bindings);
    const result = refine(problem, { maxIterations: 25 });
    expect(result.parameters.scaleM).toBeCloseTo(1, 1);
  });
});
