import { describe, it, expect } from "vitest";
import { linearScale, extent, polylinePoints } from "@/visualization/scale";

describe("plotting scale math", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = linearScale(0, 10, 0, 100);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(5)).toBe(50);
  });

  it("computes an extent, padding a degenerate range", () => {
    expect(extent([3, 1, 4, 1, 5])).toEqual([1, 5]);
    expect(extent([2, 2, 2])).toEqual([1, 3]);
  });

  it("inverts a pixel coordinate back to a data value", () => {
    const s = linearScale(0, 10, 40, 140);
    expect(s.invert(40)).toBeCloseTo(0);
    expect(s.invert(140)).toBeCloseTo(10);
    expect(s.invert(90)).toBeCloseTo(5);
  });

  it("builds a polyline string", () => {
    const sx = linearScale(0, 2, 0, 20);
    const sy = linearScale(0, 2, 0, 20);
    expect(polylinePoints([0, 1, 2], [0, 1, 2], sx, sy)).toBe("0.00,0.00 10.00,10.00 20.00,20.00");
  });
});
