/**
 * The TOF Gaussian variance follows GSAS-II exactly (GSASIImath.getTOFsig):
 *   σ² = sig-0 + sig-1·d² + sig-2·d⁴ + sig-q·d
 * sig-q is LINEAR in d. It was once evaluated as sig-q/d², which mis-widened
 * every peak of a loaded POWGEN .instprm (sig-q ≈ 100–800 µs²) away from d = 1 Å.
 */
import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { applyParameters } from "@/core/workflow/apply";
import { placePeaks } from "@/core/workflow/powder";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { parseInstrumentParameters } from "@/parsers/instrument";

const structure: StructureModel = {
  id: "s", name: "s",
  cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { operations: [parseSymmetryOperation("x,y,z")] },
  sites: [],
};
const pattern: PowderPattern = {
  id: "p", name: "p", xUnit: "tof", radiation: { kind: "neutron-tof" },
  points: [{ x: 10000, yObs: 1 }, { x: 60000, yObs: 1 }],
};

describe("TOF σ² sig-q term (GSAS-II convention)", () => {
  it("adds sig-q·d to the Gaussian variance", () => {
    const sig = { sig0: 3, sig1: 20, sig2: 1.5, sigQ: 300 };
    const bindings = [
      { parameterId: "difC", kind: "tofCalibration" as const, targetId: "p", targetKey: "difC" },
      ...Object.keys(sig).map((k) => ({ parameterId: k, kind: "tofProfile" as const, targetId: "p", targetKey: k })),
      { parameterId: "beta0", kind: "tofProfile" as const, targetId: "p", targetKey: "beta0" },
      { parameterId: "alpha1", kind: "tofProfile" as const, targetId: "p", targetKey: "alpha1" },
    ];
    const applied = applyParameters(structure, bindings, { difC: 22585, beta0: 0.03, alpha1: 1, ...sig });
    for (const d of [0.5, 1, 2.5]) {
      const [peak] = placePeaks(pattern, applied, [{ d, intensity: 1 }]);
      const expected = sig.sig0 + sig.sig1 * d ** 2 + sig.sig2 * d ** 4 + sig.sigQ * d;
      expect(peak!.tof!.sigma ** 2).toBeCloseTo(expected, 9);
    }
  });

  it("the .instprm loader carries sig-q through unchanged", () => {
    const inst = parseInstrumentParameters("#GSAS-II instrument parameter file\nType:PNT\ndifC:22585\nsig-q:312.5\n");
    expect(inst.kind === "tof" && inst.sigQ).toBe(312.5);
  });
});
