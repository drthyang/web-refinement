import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import { leBailExtract } from "@/core/workflow/leBail";
import { exampleStructure } from "@/examples/mn3ga";
import { powderCurves } from "@/core/workflow/powder";
import { powderParameters, powderBindings } from "@/examples/synthetic";

const neutron = { kind: "neutron" as const, wavelength: 1.54 };

describe("Le Bail intensity extraction", () => {
  const structure = exampleStructure();
  // Synthesize an observed pattern from the real structure (known peaks).
  const grid = Array.from({ length: 600 }, (_, i) => 15 + (i * 90) / 600);
  const empty: PowderPattern = { id: "p", name: "p", xUnit: "twoTheta", radiation: neutron, wavelength: 1.54, points: grid.map((x) => ({ x, yObs: 0 })) };
  const curves = powderCurves(structure, empty, powderParameters(structure, 80), powderBindings(structure, "p"));
  const obs: PowderPattern = { ...empty, points: grid.map((x, i) => ({ x, yObs: curves.yCalc[i]! })) };

  const result = leBailExtract(obs, structure.cell, structure.spaceGroup, { fwhm: 0.5, cycles: 12 });

  it("extracts a non-empty set of reflection intensities", () => {
    expect(result.reflections.length).toBeGreaterThan(5);
    expect(result.reflections.every((r) => r.intensity >= 0)).toBe(true);
  });

  it("reproduces the observed pattern (fit reconstructs the data)", () => {
    let num = 0, den = 0;
    for (let i = 0; i < result.yObs.length; i++) {
      num += Math.abs(result.yObs[i]! - result.yCalc[i]!);
      den += Math.abs(result.yObs[i]!);
    }
    expect(num / den).toBeLessThan(0.05);
  });

  it("gives the strongest extracted reflection substantial intensity", () => {
    const maxI = Math.max(...result.reflections.map((r) => r.intensity));
    expect(maxI).toBeGreaterThan(0);
  });
});
