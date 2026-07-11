import { describe, it, expect } from "vitest";
import { boxShape, octahedronShape } from "@/core/absorption/shape";
import { transmissionFactor } from "@/core/absorption/transmission";

describe("transmissionFactor — analytic anchors", () => {
  it("is 1 when there is no absorption", () => {
    expect(transmissionFactor(boxShape([1, 1, 1]), 0, [1, 0, 0], [0, 1, 0])).toBe(1);
  });

  it("gives exp(−μa) for a straight-through cube (ŝ_in = ŝ_out)", () => {
    // Every ray crosses the full edge a, so the path is constant = a and the
    // volume average is exactly exp(−μa), independent of the grid.
    const a = 0.5;
    const mu = 2;
    const A = transmissionFactor(boxShape([a, a, a]), mu, [1, 0, 0], [1, 0, 0]);
    expect(A).toBeCloseTo(Math.exp(-mu * a), 8);
  });

  it("matches the closed form for a 90°-scattering cube", () => {
    // ŝ_in = +x, ŝ_out = +y over a cube of edge a (half-edge h): the path is
    // a + x − y, giving A = exp(−μa)·(sinh(μh)/(μh))². Axis-aligned + smooth, so
    // Gauss–Legendre nails it.
    const a = 0.4;
    const h = a / 2;
    const mu = 3;
    const s = Math.sinh(mu * h) / (mu * h);
    const expected = Math.exp(-mu * a) * s * s;
    const A = transmissionFactor(boxShape([a, a, a]), mu, [1, 0, 0], [0, 1, 0]);
    expect(A).toBeCloseTo(expected, 8);
  });

  it("normalises beam directions (non-unit input gives the same result)", () => {
    const box = boxShape([0.6, 0.6, 0.6]);
    const unit = transmissionFactor(box, 1.5, [1, 0, 0], [0, 1, 0]);
    const scaled = transmissionFactor(box, 1.5, [5, 0, 0], [0, 3, 0]);
    expect(scaled).toBeCloseTo(unit, 10);
  });
});

describe("transmissionFactor — physical behaviour", () => {
  it("decreases with absorption and stays in (0, 1]", () => {
    const box = boxShape([0.5, 0.5, 0.5]);
    const weak = transmissionFactor(box, 1, [1, 0, 0], [0, 1, 0]);
    const strong = transmissionFactor(box, 4, [1, 0, 0], [0, 1, 0]);
    expect(weak).toBeGreaterThan(strong);
    expect(strong).toBeGreaterThan(0);
    expect(weak).toBeLessThan(1);
  });

  it("converges on a non-axis-aligned habit (octahedron) as the grid refines", () => {
    const oct = octahedronShape(0.5);
    const coarse = transmissionFactor(oct, 2, [1, 0, 0], [0, 1, 0], { gaussPoints: 24 });
    const fine = transmissionFactor(oct, 2, [1, 0, 0], [0, 1, 0], { gaussPoints: 48 });
    expect(coarse).toBeGreaterThan(0);
    expect(coarse).toBeLessThan(1);
    expect(Math.abs(coarse - fine)).toBeLessThan(5e-3);
  });
});
