import { describe, it, expect } from "vitest";
import type { Mat3, Vec3 } from "@/core/math/types";
import { mulVec, mulMat, transpose, determinant } from "@/core/math/mat3";
import { normalize } from "@/core/math/vec3";
import { fitOrientation, quaternionToMatrix, type NormalPair } from "@/core/absorption/orientation";

/** Reference (crystal-frame) normals used across the tests. */
const refs: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  normalize([1, 1, 0]),
];

/** Build matched pairs by rotating the reference normals by `R`. */
function pairsFrom(R: Mat3, noise = 0): NormalPair[] {
  return refs.map((r, i) => {
    const o = mulVec(R, r);
    // Deterministic small perturbation so the test stays reproducible.
    const n: Vec3 = noise ? normalize([o[0] + noise * ((i % 3) - 1), o[1] + noise, o[2] - noise * (i % 2)]) : o;
    return { observed: n, reference: r };
  });
}

const Rz90: Mat3 = [
  [0, -1, 0],
  [1, 0, 0],
  [0, 0, 1],
];
// A compound orientation: Rz(90)·Rx(90).
const Rx90: Mat3 = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];
const compound = mulMat(Rz90, Rx90);

describe("quaternionToMatrix", () => {
  it("maps the identity quaternion to the identity matrix", () => {
    const I = quaternionToMatrix([0, 0, 0, 1]);
    expect(I[0]).toEqual([1, 0, 0]);
    expect(I[1]).toEqual([0, 1, 0]);
    expect(I[2]).toEqual([0, 0, 1]);
  });
});

describe("fitOrientation", () => {
  it("recovers a known rotation from exact correspondences", () => {
    const fit = fitOrientation(pairsFrom(Rz90));
    expect(fit.rmsAngleDeg).toBeCloseTo(0, 5); // sub-microdegree = exact recovery
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(fit.rotation[i]![j]!).toBeCloseTo(Rz90[i]![j]!, 8);
    }
  });

  it("recovers a compound rotation (maps every reference onto its observed)", () => {
    const fit = fitOrientation(pairsFrom(compound));
    expect(fit.rmsAngleDeg).toBeCloseTo(0, 5);
    for (const r of refs) {
      const mapped = mulVec(fit.rotation, r);
      const truth = mulVec(compound, r);
      mapped.forEach((v, k) => expect(v).toBeCloseTo(truth[k]!, 8));
    }
  });

  it("returns a proper rotation (orthonormal, det = +1)", () => {
    const R = fitOrientation(pairsFrom(compound)).rotation;
    const RtR = mulMat(transpose(R), R);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(RtR[i]![j]!).toBeCloseTo(i === j ? 1 : 0, 8);
    }
    expect(determinant(R)).toBeCloseTo(1, 8);
  });

  it("stays close under noisy observations", () => {
    const fit = fitOrientation(pairsFrom(Rz90, 0.02));
    expect(fit.rmsAngleDeg).toBeGreaterThan(0);
    expect(fit.rmsAngleDeg).toBeLessThan(3);
  });

  it("requires at least two pairs", () => {
    expect(() => fitOrientation([{ observed: [1, 0, 0], reference: [1, 0, 0] }])).toThrow(/at least two/);
  });
});
