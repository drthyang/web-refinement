import { describe, it, expect } from "vitest";
import {
  boxShape,
  octahedronShape,
  shapeFromFaces,
  isInside,
  exitDistance,
} from "@/core/absorption/shape";

describe("boxShape", () => {
  const cube = boxShape([2, 2, 2]); // interior |x|,|y|,|z| ≤ 1

  it("classifies inside / outside points", () => {
    expect(isInside(cube, [0, 0, 0])).toBe(true);
    expect(isInside(cube, [0.99, -0.5, 0.2])).toBe(true);
    expect(isInside(cube, [1.5, 0, 0])).toBe(false);
  });

  it("measures the exit distance along a direction", () => {
    // From the centre, the boundary is 1 away along +x.
    expect(exitDistance(cube, [0, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12);
    // From x = 0.5 toward +x it is 0.5; back toward −x it is 1.5.
    expect(exitDistance(cube, [0.5, 0, 0], [1, 0, 0])).toBeCloseTo(0.5, 12);
    expect(exitDistance(cube, [0.5, 0, 0], [-1, 0, 0])).toBeCloseTo(1.5, 12);
  });
});

describe("octahedronShape", () => {
  const oct = octahedronShape(1); // |x| + |y| + |z| ≤ 1

  it("uses the |x|+|y|+|z| ≤ r body, not its bounding box", () => {
    expect(isInside(oct, [0.9, 0, 0])).toBe(true);
    // Inside the [−1,1]³ box but outside the octahedron (sum = 1.5).
    expect(isInside(oct, [0.5, 0.5, 0.5])).toBe(false);
  });
});

describe("shapeFromFaces", () => {
  it("normalises non-unit face normals so offset is a true distance", () => {
    // A plane x ≤ 1 written with a length-2 normal (2·x ≤ 2).
    const s = shapeFromFaces([{ normal: [2, 0, 0], offset: 2 }], [-1, -1, -1], [1, 1, 1]);
    expect(s.faces[0]!.normal).toEqual([1, 0, 0]);
    expect(s.faces[0]!.offset).toBeCloseTo(1, 12);
  });
});
