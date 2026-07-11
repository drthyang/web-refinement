import { describe, it, expect } from "vitest";
import { gaussLegendre } from "@/core/math/quadrature";

/** ∫_{−1}^{1} f via an n-point rule. */
function integrate(n: number, f: (x: number) => number): number {
  const { nodes, weights } = gaussLegendre(n);
  return nodes.reduce((s, x, i) => s + weights[i]! * f(x), 0);
}

describe("gaussLegendre", () => {
  it("handles the 1-point rule", () => {
    const { nodes, weights } = gaussLegendre(1);
    expect(nodes).toEqual([0]);
    expect(weights[0]).toBeCloseTo(2, 12);
  });

  it("weights sum to the interval length and nodes are symmetric", () => {
    const { nodes, weights } = gaussLegendre(8);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 12);
    for (let i = 0; i < nodes.length; i++) {
      expect(nodes[i]!).toBeCloseTo(-nodes[nodes.length - 1 - i]!, 12);
    }
  });

  it("integrates polynomials up to degree 2n−1 exactly", () => {
    // n = 3 integrates degree ≤ 5 exactly. ∫x²=2/3, ∫x⁴=2/5, ∫x⁵=0.
    expect(integrate(3, (x) => x * x)).toBeCloseTo(2 / 3, 12);
    expect(integrate(3, (x) => x ** 4)).toBeCloseTo(2 / 5, 12);
    expect(integrate(3, (x) => x ** 5)).toBeCloseTo(0, 12);
  });

  it("converges spectrally for a smooth integrand (∫eˣ = e − 1/e)", () => {
    expect(integrate(12, Math.exp)).toBeCloseTo(Math.E - 1 / Math.E, 12);
  });

  it("rejects a non-positive or non-integer point count", () => {
    expect(() => gaussLegendre(0)).toThrow();
    expect(() => gaussLegendre(2.5)).toThrow();
  });
});
