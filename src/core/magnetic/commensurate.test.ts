import { describe, expect, it } from "vitest";
import type { Vec3 } from "@/core/math/types";
import {
  allCommensurate,
  componentDenominator,
  isCommensurate,
  isZeroK,
  jointDenominators,
  kDenominators,
} from "@/core/magnetic/commensurate";

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

  it("returns 0 for an incommensurate component", () => {
    expect(componentDenominator(0.137)).toBe(0);
    expect(componentDenominator(0.3334)).toBe(0);
  });

  it("respects maxDenominator", () => {
    // 1/7 is rational but outside a search capped at 6.
    expect(componentDenominator(1 / 7, 12)).toBe(7);
    expect(componentDenominator(1 / 7, 6)).toBe(0);
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
    // This is the case cellExpansion.ts used to answer with denominator 1,
    // silently drawing/exporting a single cell for a structure that has none.
    expect(kDenominators([0.137, 0, 0])).toBeNull();
    expect(isCommensurate([0.137, 0, 0])).toBe(false);
  });
});

describe("isZeroK", () => {
  it("distinguishes k = 0 from a small but nonzero k", () => {
    expect(isZeroK([0, 0, 0])).toBe(true);
    expect(isZeroK([0, 0, 1e-12])).toBe(true);
    expect(isZeroK([0, 0, 0.001])).toBe(false);
  });
});

describe("multi-arm commensurability", () => {
  it("allCommensurate requires every arm", () => {
    const arms: Vec3[] = [[0.5, 0, 0], [0, 0.5, 0]];
    expect(allCommensurate(arms)).toBe(true);
    expect(allCommensurate([...arms, [0.137, 0, 0]])).toBe(false);
  });

  it("jointDenominators takes the componentwise LCM", () => {
    // 1/2 and 1/3 along the same axis repeat together only every 6 cells.
    const res = jointDenominators([[0.5, 0, 0], [1 / 3, 0, 0]]);
    expect(res!.denominators).toEqual([6, 1, 1]);
    expect(res!.cellCount).toBe(6);
  });

  it("joint cell of arms on different axes multiplies", () => {
    const res = jointDenominators([[0.5, 0, 0], [0, 1 / 3, 0]]);
    expect(res!.denominators).toEqual([2, 3, 1]);
    expect(res!.cellCount).toBe(6);
  });

  it("refuses a jointly enormous cell rather than expanding it", () => {
    // Individually fine (5 and 7), jointly 35 cells along one axis.
    expect(jointDenominators([[0.2, 0, 0], [1 / 7, 0, 0]], 12, 1e-4, 16)).toBeNull();
    expect(jointDenominators([[0.2, 0, 0], [1 / 7, 0, 0]], 12, 1e-4, 64)!.cellCount).toBe(35);
  });

  it("returns null when any arm is incommensurate", () => {
    expect(jointDenominators([[0.5, 0, 0], [0.137, 0, 0]])).toBeNull();
  });

  it("returns null for an empty arm list", () => {
    expect(jointDenominators([])).toBeNull();
  });
});

describe("agreement with the shipped supercell resolvers", () => {
  it("matches magneticSupercell's denominators for commensurate k", async () => {
    const { magneticSupercell } = await import("@/core/magnetic/magneticSupercell");
    for (const k of [[0, 0, 0.5], [0.25, 0, 0.25], [1 / 3, 1 / 3, 0]] as Vec3[]) {
      const mine = kDenominators(k)!;
      const theirs = magneticSupercell(k);
      expect(mine.denominators).toEqual(theirs.multiplicity);
      expect(mine.kInteger).toEqual(theirs.kInteger);
    }
  });
});
