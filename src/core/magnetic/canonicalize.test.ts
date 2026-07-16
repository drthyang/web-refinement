import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { RefinementDiagnostics, RefinementParameter } from "@/core/refinement/types";
import { globalMomentSign, canonicalizeMomentValues, momentDegeneracies } from "@/core/magnetic/canonicalize";

const cubic: UnitCell = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };

/** Two-site magnetic model with the given crystal-axis moment vectors. */
function model(m0: [number, number, number], m1: [number, number, number]): MagneticModel {
  return {
    id: "mag",
    structureId: "s",
    propagation: [[0, 0, 0]],
    moments: [
      { siteLabel: "A", frame: "crystallographic", components: m0 },
      { siteLabel: "B", frame: "crystallographic", components: m1 },
    ],
  };
}

const modeParams: RefinementParameter[] = [
  { id: "mom_A_0", label: "A Mx", kind: "momentMode", value: 0, initialValue: 0, fixed: false },
  { id: "mom_B_0", label: "B My", kind: "momentMode", value: 0, initialValue: 0, fixed: false },
  { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, fixed: false },
];

describe("globalMomentSign", () => {
  it("is +1 when the leading significant component is positive", () => {
    expect(globalMomentSign(model([1.5, 0, 0], [0, -2, 0]), cubic)).toBe(1);
  });

  it("is -1 when the leading significant component is negative", () => {
    expect(globalMomentSign(model([-1.5, 0, 0], [0, 2, 0]), cubic)).toBe(-1);
  });

  it("orders by binding key, not array order, and skips ~zero moments", () => {
    // First site (A) has a negligible moment; the decision falls to B's My<0.
    expect(globalMomentSign(model([0, 0, 0], [0, -0.8, 0]), cubic)).toBe(-1);
  });

  it("prefers x over y over z within the first significant moment", () => {
    // A's x is significant and positive → +1 regardless of a negative y.
    expect(globalMomentSign(model([0.4, -3, 0], [0, 0, 0]), cubic)).toBe(1);
  });

  it("returns +1 for an all-zero (paramagnetic) model", () => {
    expect(globalMomentSign(model([0, 0, 0], [0, 0, 0]), cubic)).toBe(1);
  });
});

describe("canonicalizeMomentValues", () => {
  it("negates only moment amplitudes when the sign is -1", () => {
    // Model's canonical sign is -1 (A Mx < 0); values should flip sign on moments
    // but leave the nuclear scale untouched.
    const values = { mom_A_0: -1.5, mom_B_0: 2, scale: 3.2 };
    const out = canonicalizeMomentValues(values, model([-1.5, 0, 0], [0, 2, 0]), cubic, modeParams);
    expect(out.mom_A_0).toBe(1.5);
    expect(out.mom_B_0).toBe(-2);
    expect(out.scale).toBe(3.2);
  });

  it("is a no-op (copy) when the sign is already +1", () => {
    const values = { mom_A_0: 1.5, mom_B_0: -2, scale: 3.2 };
    const out = canonicalizeMomentValues(values, model([1.5, 0, 0], [0, -2, 0]), cubic, modeParams);
    expect(out).toEqual(values);
    expect(out).not.toBe(values); // fresh object
  });

  it("is idempotent — canonicalizing twice equals once", () => {
    const values = { mom_A_0: -1.5, mom_B_0: 2, scale: 3.2 };
    const m = model([-1.5, 0, 0], [0, 2, 0]);
    const once = canonicalizeMomentValues(values, m, cubic, modeParams);
    // Rebuild the model from the flipped values' sign convention: the flipped
    // moment set now has A Mx > 0, so a second pass is a no-op.
    const twice = canonicalizeMomentValues(once, model([1.5, 0, 0], [0, -2, 0]), cubic, modeParams);
    expect(twice).toEqual(once);
  });
});

describe("momentDegeneracies", () => {
  const diag = (over: Partial<RefinementDiagnostics>): RefinementDiagnostics => ({
    svdZeroCount: 0,
    singularParameterIds: [],
    conditionNumber: 1,
    highCorrelations: [],
    maxLambda: 1e-3,
    atBounds: [],
    maxParameterShift: 0,
    ...over,
  });

  it("returns [] when diagnostics are absent", () => {
    expect(momentDegeneracies(undefined, modeParams)).toEqual([]);
  });

  it("flags a soft (near-null) moment direction from singularParameterIds", () => {
    const out = momentDegeneracies(diag({ singularParameterIds: ["mom_B_0"], svdZeroCount: 1 }), modeParams);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("soft");
    expect(out[0]!.parameterIds).toEqual(["mom_B_0"]);
    expect(out[0]!.message).toContain("B My");
  });

  it("flags a strong moment↔moment correlation (the partition flat direction)", () => {
    const out = momentDegeneracies(
      diag({ highCorrelations: [{ parameterIdA: "mom_A_0", parameterIdB: "mom_B_0", coefficient: -0.99 }] }),
      modeParams,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("correlated");
    expect(out[0]!.coefficient).toBe(-0.99);
    expect(out[0]!.message).toContain("near-degenerate");
  });

  it("ignores nuclear-only correlations and sub-threshold ones", () => {
    const out = momentDegeneracies(
      diag({
        highCorrelations: [
          { parameterIdA: "scale", parameterIdB: "bIso_A", coefficient: -0.97 }, // no moment side
          { parameterIdA: "mom_A_0", parameterIdB: "scale", coefficient: -0.5 }, // below threshold
        ],
      }),
      modeParams,
    );
    expect(out).toEqual([]);
  });

  it("keeps a moment↔nuclear coupling above threshold (e.g. moment↔scale)", () => {
    const out = momentDegeneracies(
      diag({ highCorrelations: [{ parameterIdA: "mom_A_0", parameterIdB: "scale", coefficient: 0.95 }] }),
      modeParams,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.parameterIds).toEqual(["mom_A_0", "scale"]);
  });

  it("returns [] when there are no moment parameters at all", () => {
    const nuclearOnly: RefinementParameter[] = [{ id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, fixed: false }];
    const out = momentDegeneracies(diag({ singularParameterIds: ["scale"] }), nuclearOnly);
    expect(out).toEqual([]);
  });
});
