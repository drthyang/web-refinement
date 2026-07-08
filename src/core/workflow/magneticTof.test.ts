import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import { buildStructureRefinement, type TofSeed } from "@/core/workflow/structureRefinement";
import { magneticPowderComponents } from "@/core/workflow/magneticPowder";
import { exampleMagnetic, magneticParameters, magneticBindings } from "@/examples/mn3gaMagnetic";

/**
 * The magnetic powder path must handle time-of-flight data (POWGEN-type), not
 * just constant-wavelength: nuclear AND magnetic peaks are placed with the same
 * back-to-back-exponential TOF profile, on one shared (GSAS-II) scale.
 */
const TRUTH: TofSeed = {
  difC: 22585.8,
  alpha0: 0, alpha1: 1.5,
  beta0: 0.02, beta1: 0,
  sig0: 0, sig1: (22585.8 * 0.0015) ** 2, sig2: 0,
};

describe("magnetic powder refinement — TOF", () => {
  const { structure, magnetic } = exampleMagnetic();
  const grid = Array.from({ length: 700 }, (_, i) => 13000 + (i * (90000 - 13000)) / 699);
  const pat: PowderPattern = {
    id: "pat", name: "p", xUnit: "tof", radiation: { kind: "neutron-tof" },
    points: grid.map((x) => ({ x, yObs: 0 })),
  };

  const componentsAt = (scale: number) => {
    const spec = buildStructureRefinement(structure, pat, {
      scale, backgroundTerms: 2, tof: TRUTH, refineAdp: false, refinePositions: false,
    });
    const momentParams = magneticParameters(magnetic).filter((p) => p.kind.startsWith("moment")).map((p) => ({ ...p, fixed: true }));
    const momentBindings = magneticBindings(magnetic).filter((b) => b.kind === "momentX" || b.kind === "momentY" || b.kind === "momentZ");
    return magneticPowderComponents(
      structure, magnetic, pat,
      [...spec.params, ...momentParams],
      [...spec.bindings, ...momentBindings],
      { shape: "tof" },
    );
  };

  it("places both nuclear and magnetic peaks with the TOF profile", () => {
    const c = componentsAt(40);
    expect(Math.max(...c.yNuclear)).toBeGreaterThan(0);
    expect(Math.max(...c.yMagnetic)).toBeGreaterThan(0);
    // yCalc is the sum of the two components.
    for (let i = 0; i < c.yCalc.length; i++) {
      expect(c.yCalc[i]!).toBeCloseTo(c.yNuclear[i]! + c.yMagnetic[i]!, 6);
    }
  });

  it("scales the magnetic component by the shared nuclear scale", () => {
    const magMax1 = Math.max(...componentsAt(40).yMagnetic);
    const magMax2 = Math.max(...componentsAt(80).yMagnetic);
    expect(magMax1).toBeGreaterThan(0);
    expect(magMax2 / magMax1).toBeCloseTo(2, 5);
  });
});
