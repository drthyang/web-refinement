import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import {
  cellVolume,
  reciprocalTensorA,
  dSpacing,
  qMagnitude,
  orthogonalizationMatrix,
} from "@/core/crystal/unitCell";

/**
 * Golden values taken directly from the GSAS-II refinement output
 * (data/isothermal_hex/Untitled.lst): the refined Mn₃Ga hexagonal phase and the
 * MnO cubic impurity phase. These pin the metric-tensor and volume math to an
 * established tool.
 */
const mn3gaHex: UnitCell = { a: 5.413171, b: 5.413171, c: 4.364621, alpha: 90, beta: 90, gamma: 120 };
const mnoCubic: UnitCell = { a: 4.450147, b: 4.450147, c: 4.450147, alpha: 90, beta: 90, gamma: 90 };

describe("unitCell — validated against GSAS-II .lst", () => {
  it("reproduces the Mn₃Ga hexagonal cell volume (GSAS: 110.759 Å³)", () => {
    expect(cellVolume(mn3gaHex)).toBeCloseTo(110.759, 2);
  });

  it("reproduces the MnO cubic cell volume (GSAS: 88.130 Å³)", () => {
    expect(cellVolume(mnoCubic)).toBeCloseTo(88.13, 2);
  });

  it("reproduces the Mn₃Ga reciprocal metric tensor A (GSAS values)", () => {
    // GSAS: A11=A22=A12=0.045502499, A33=0.052493673, A13=A23=0.
    const A = reciprocalTensorA(mn3gaHex);
    expect(A.a11).toBeCloseTo(0.045502499, 6);
    expect(A.a22).toBeCloseTo(0.045502499, 6);
    expect(A.a33).toBeCloseTo(0.052493673, 6);
    expect(A.a12).toBeCloseTo(0.045502499, 6);
    expect(A.a13).toBeCloseTo(0, 8);
    expect(A.a23).toBeCloseTo(0, 8);
  });

  it("reproduces the MnO cubic reciprocal metric tensor A (GSAS: 0.050495334)", () => {
    const A = reciprocalTensorA(mnoCubic);
    expect(A.a11).toBeCloseTo(0.050495334, 6);
    expect(A.a12).toBeCloseTo(0, 8);
  });
});

describe("unitCell — internal consistency", () => {
  it("computes d-spacing consistent with 1/d² from the tensor", () => {
    const d = dSpacing(mn3gaHex, 1, 0, 0);
    // For hexagonal (100): 1/d² = A11 → d = 1/√A11.
    expect(d).toBeCloseTo(1 / Math.sqrt(0.045502499), 4);
  });

  it("relates |Q| and d by |Q| = 2π/d", () => {
    const q = qMagnitude(mn3gaHex, 1, 1, 0);
    const d = dSpacing(mn3gaHex, 1, 1, 0);
    expect(q).toBeCloseTo((2 * Math.PI) / d, 8);
  });

  it("orthogonalization matrix preserves the a-axis length", () => {
    const m = orthogonalizationMatrix(mnoCubic);
    // For a cubic cell M is diagonal with a on the diagonal.
    expect(m[0][0]).toBeCloseTo(4.450147, 5);
    expect(m[1][1]).toBeCloseTo(4.450147, 5);
    expect(m[2][2]).toBeCloseTo(4.450147, 5);
  });
});
