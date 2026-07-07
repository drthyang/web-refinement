import { describe, it, expect } from "vitest";
import {
  solveLinearSystem,
  invertMatrix,
  pseudoInverseSymmetric,
  solveSymmetricPseudoInverse,
} from "@/core/math/linalg";

describe("linalg", () => {
  it("solves a linear system", () => {
    // 2x + y = 5 ; x + 3y = 10  → x = 1, y = 3
    const x = solveLinearSystem([[2, 1], [1, 3]], [5, 10]);
    expect(x[0]).toBeCloseTo(1, 10);
    expect(x[1]).toBeCloseTo(3, 10);
  });

  it("inverts a matrix (A·A⁻¹ = I)", () => {
    const a = [[4, 3], [6, 3]];
    const inv = invertMatrix(a);
    // Product should be identity.
    const p00 = a[0]![0]! * inv[0]![0]! + a[0]![1]! * inv[1]![0]!;
    const p01 = a[0]![0]! * inv[0]![1]! + a[0]![1]! * inv[1]![1]!;
    expect(p00).toBeCloseTo(1, 10);
    expect(p01).toBeCloseTo(0, 10);
  });

  it("throws on a singular matrix", () => {
    expect(() => solveLinearSystem([[1, 2], [2, 4]], [1, 2])).toThrow();
  });

  it("pseudo-inverts a singular symmetric matrix with diagnostics", () => {
    const result = pseudoInverseSymmetric([[1, 2], [2, 4]], 1e-8);

    expect(result.zeroCount).toBe(1);
    expect(result.droppedIndices).toEqual(expect.arrayContaining([0, 1]));
    expect(result.singularValues[0]).toBeCloseTo(5, 10);
    expect(result.singularValues[1]).toBeCloseTo(0, 10);

    // A·A⁺·A = A for the Moore-Penrose pseudo-inverse.
    const inv = result.inverse;
    const a00 = 1 * inv[0]![0]! + 2 * inv[1]![0]!;
    const a01 = 1 * inv[0]![1]! + 2 * inv[1]![1]!;
    const p00 = a00 * 1 + a01 * 2;
    const p01 = a00 * 2 + a01 * 4;
    expect(p00).toBeCloseTo(1, 10);
    expect(p01).toBeCloseTo(2, 10);
  });

  it("solves singular systems with the least-norm pseudo-inverse solution", () => {
    const { x, diagnostics } = solveSymmetricPseudoInverse([[1, 2], [2, 4]], [1, 2], 1e-8);

    expect(diagnostics.zeroCount).toBe(1);
    expect(x[0]).toBeCloseTo(0.2, 10);
    expect(x[1]).toBeCloseTo(0.4, 10);
  });
});
