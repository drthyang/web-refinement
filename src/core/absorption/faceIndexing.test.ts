import { describe, it, expect } from "vitest";
import type { Mat3, Vec3 } from "@/core/math/types";
import { mulVec } from "@/core/math/mat3";
import type { UnitCell } from "@/core/crystal/types";
import { faceNormalCartesian } from "@/core/absorption/habit";
import { quaternionToMatrix } from "@/core/absorption/orientation";
import { crystallographicNormalCatalog, indexFaces } from "@/core/absorption/faceIndexing";

const cubic = (a: number): UnitCell => ({ a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 });

// True crystal-frame faces and a generic (non-symmetry) orientation.
const trueHkl: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [0, 1, 1],
  [1, 1, 1],
];
// A generic (non-symmetry) orientation from a unit quaternion.
const qn = Math.hypot(0.1, 0.2, 0.3, 0.9);
const Rtrue: Mat3 = quaternionToMatrix([0.1 / qn, 0.2 / qn, 0.3 / qn, 0.9 / qn]);

function observedFrom(cell: UnitCell, noise = 0): Vec3[] {
  return trueHkl.map((hkl, i) => {
    const o = mulVec(Rtrue, faceNormalCartesian(cell, hkl));
    return noise ? [o[0] + noise * ((i % 3) - 1), o[1] + noise, o[2] - noise * (i % 2)] : o;
  });
}

describe("crystallographicNormalCatalog", () => {
  it("reduces to lowest terms and deduplicates by direction", () => {
    const cat = crystallographicNormalCatalog(cubic(4), 2);
    // No non-primitive index survives (e.g. no (200); it collapses to (100)).
    expect(cat.every((e) => gcd3(e.hkl))).toBe(true);
    // The +x direction appears exactly once, as (100).
    const alongX = cat.filter((e) => e.normal[0]! > 0.999);
    expect(alongX).toHaveLength(1);
    expect(alongX[0]!.hkl).toEqual([1, 0, 0]);
  });
});

describe("indexFaces", () => {
  it("indexes faces and recovers the orientation from exact normals", () => {
    const result = indexFaces(cubic(4), observedFrom(cubic(4)));
    expect(result.matches).toHaveLength(6);
    expect(result.rmsAngleDeg).toBeLessThan(0.01);
    // The recovered orientation maps every assigned hkl back onto its observed face.
    for (const m of result.matches) expect(m.angleDeg).toBeLessThan(0.01);
  });

  it("assigns self-consistent indices (orientation·hkl-normal ≈ observed)", () => {
    const cell = cubic(4);
    const observed = observedFrom(cell);
    const result = indexFaces(cell, observed);
    for (const m of result.matches) {
      const reproduced = mulVec(result.orientation, faceNormalCartesian(cell, m.hkl));
      const o = observed[m.observedIndex]!;
      const cos = reproduced[0]! * normO(o)[0]! + reproduced[1]! * normO(o)[1]! + reproduced[2]! * normO(o)[2]!;
      expect(cos).toBeGreaterThan(0.9999);
    }
  });

  it("stays robust under noisy observations", () => {
    const result = indexFaces(cubic(4), observedFrom(cubic(4), 0.02));
    expect(result.matches).toHaveLength(6);
    expect(result.rmsAngleDeg).toBeLessThan(3);
  });

  it("requires at least two faces", () => {
    expect(() => indexFaces(cubic(4), [[1, 0, 0]])).toThrow(/at least two/);
  });
});

function gcd3(hkl: Vec3): boolean {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(g(Math.abs(hkl[0]), Math.abs(hkl[1])), Math.abs(hkl[2]));
  return d === 1;
}

function normO(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
