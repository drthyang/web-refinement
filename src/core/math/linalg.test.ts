import { describe, it, expect } from "vitest";
import { solveLinearSystem, invertMatrix } from "@/core/math/linalg";

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
});
