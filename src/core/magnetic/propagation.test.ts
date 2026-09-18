import { describe, expect, it } from "vitest";
import type { Vec3 } from "@/core/math/types";
import {
  classifyPropagation,
  componentDenominator,
  jointDenominators,
  kDenominators,
} from "@/core/magnetic/propagation";

describe("componentDenominator", () => {
  it("returns 1 for zero and integers", () => {
    expect(componentDenominator(0)).toBe(1);
    expect(componentDenominator(1)).toBe(1);
    expect(componentDenominator(-2)).toBe(1);
  });

  it("finds the smallest denominator of a simple fraction", () => {
    expect(componentDenominator(0.5)).toBe(2);
    expect(componentDenominator(1 / 3)).toBe(3);
    expect(componentDenominator(0.25)).toBe(4);
    expect(componentDenominator(2 / 3)).toBe(3);
    expect(componentDenominator(-0.25)).toBe(4);
  });

  it("returns null for an incommensurate component", () => {
    expect(componentDenominator(0.137)).toBeNull();
    expect(componentDenominator(0.3334)).toBeNull();
  });

  it("respects maxDenominator", () => {
    // 1/7 is rational but outside a search capped at 6.
    expect(componentDenominator(1 / 7, { maxDenominator: 12 })).toBe(7);
    expect(componentDenominator(1 / 7, { maxDenominator: 6 })).toBeNull();
  });
});

describe("kDenominators", () => {
  it("resolves the supercell of a commensurate k", () => {
    const res = kDenominators([0, 0, 0.5]);
    expect(res).not.toBeNull();
    expect(res!.denominators).toEqual([1, 1, 2]);
    expect(res!.kInteger).toEqual([0, 0, 1]);
    expect(res!.cellCount).toBe(2);
  });

  it("handles a multi-axis k", () => {
    const res = kDenominators([0.25, 0, 0.25]);
    expect(res!.denominators).toEqual([4, 1, 4]);
    expect(res!.kInteger).toEqual([1, 0, 1]);
    expect(res!.cellCount).toBe(16);
  });

  it("k = 0 is commensurate with a 1×1×1 cell", () => {
    const res = kDenominators([0, 0, 0]);
    expect(res!.denominators).toEqual([1, 1, 1]);
    expect(res!.cellCount).toBe(1);
  });

  it("returns null — not a silent 1 — for an incommensurate component", () => {
    expect(kDenominators([0.137, 0, 0])).toBeNull();
  });

  it("is the supercell classifyPropagation reports", () => {
    for (const k of [[0, 0, 0], [0, 0, 0.5], [0.25, 0, 0.25], [1 / 3, 1 / 3, 0], [0.137, 0, 0]] as Vec3[]) {
      expect(classifyPropagation(k).supercell).toEqual(kDenominators(k)?.denominators ?? null);
    }
  });
});

describe("jointDenominators (multi-k)", () => {
  it("takes the componentwise LCM", () => {
    // 1/2 and 1/3 along the same axis repeat together only every 6 cells.
    const res = jointDenominators([[0.5, 0, 0], [1 / 3, 0, 0]]);
    expect(res!.denominators).toEqual([6, 1, 1]);
    expect(res!.cellCount).toBe(6);
  });

  it("multiplies the joint cell of arms on different axes", () => {
    const res = jointDenominators([[0.5, 0, 0], [0, 1 / 3, 0]]);
    expect(res!.denominators).toEqual([2, 3, 1]);
    expect(res!.cellCount).toBe(6);
  });

  it("refuses a jointly enormous cell rather than expanding it", () => {
    // Individually fine (5 and 7), jointly 35 cells along one axis.
    expect(jointDenominators([[0.2, 0, 0], [1 / 7, 0, 0]], { maxCells: 16 })).toBeNull();
    expect(jointDenominators([[0.2, 0, 0], [1 / 7, 0, 0]], { maxCells: 64 })!.cellCount).toBe(35);
  });

  it("returns null when any arm is incommensurate", () => {
    expect(jointDenominators([[0.5, 0, 0], [0.137, 0, 0]])).toBeNull();
  });

  it("returns null for an empty arm list", () => {
    expect(jointDenominators([])).toBeNull();
  });
});

describe("agreement with the shipped supercell consumers", () => {
  it("the .int transform and the 3D/mCIF box resolve k identically", async () => {
    const { magneticSupercell: intSupercell } = await import("@/core/magnetic/magneticSupercell");
    const { magneticSupercell: displaySupercell } = await import("@/core/crystal/cellExpansion");
    for (const k of [[0, 0, 0.5], [0.25, 0, 0.25], [1 / 3, 1 / 3, 0]] as Vec3[]) {
      const mine = kDenominators(k)!;
      const theirs = intSupercell(k);
      expect(mine.denominators).toEqual(theirs.multiplicity);
      expect(mine.kInteger).toEqual(theirs.kInteger);
      expect(displaySupercell(k)).toEqual(mine.denominators);
    }
    // Incommensurate: the .int path refuses, the display path keeps the parent
    // cell along that axis (its documented policy) and the other axes' cells.
    expect(() => intSupercell([0.5, 0, 0.137])).toThrow(/not commensurate/);
    expect(displaySupercell([0.5, 0, 0.137])).toEqual([2, 1, 1]);
  });
});
