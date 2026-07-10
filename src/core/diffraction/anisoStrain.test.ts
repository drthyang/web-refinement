import { describe, it, expect } from "vitest";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import type { SymmetryOperation, UnitCell } from "@/core/crystal/types";
import {
  quarticStrainInvariants,
  strainVarianceM,
  stephensStrainFwhmDeg,
  uniaxialStrainFwhmDeg,
} from "@/core/diffraction/anisoStrain";
import { reciprocalTensorA } from "@/core/crystal/unitCell";

/** Build an operation list from xyz strings. */
const ops = (xyz: string[]): SymmetryOperation[] => xyz.map(parseSymmetryOperation);

describe("quarticStrainInvariants — Stephens S_HKL counts by Laue class", () => {
  it("triclinic P-1 → all 15 quartic terms", () => {
    expect(quarticStrainInvariants(buildSpaceGroup(2).operations)).toHaveLength(15);
  });

  it("monoclinic P2₁/c → 9 terms", () => {
    expect(quarticStrainInvariants(buildSpaceGroup(14).operations)).toHaveLength(9);
  });

  it("orthorhombic mmm → 6 terms (the even-exponent quartics)", () => {
    const mmm = ops(["x,y,z", "-x,-y,z", "-x,y,-z", "x,-y,-z", "-x,-y,-z", "x,y,-z", "x,-y,z", "-x,y,z"]);
    const inv = quarticStrainInvariants(mmm);
    expect(inv).toHaveLength(6);
    // Each is a single even monomial (h⁴, k⁴, l⁴, h²k², h²l², k²l²).
    expect(inv.map((i) => i.label).sort()).toEqual(["S004", "S022", "S040", "S202", "S220", "S400"]);
  });

  it("cubic Fm-3m → 2 terms (Σh⁴ and Σh²k²)", () => {
    const inv = quarticStrainInvariants(buildSpaceGroup(225).operations);
    expect(inv).toHaveLength(2);
    // First invariant symmetrises h⁴+k⁴+l⁴ (equal coeffs on the three pure powers).
    const sumPow = inv[0]!.coeffs.slice(0, 3);
    expect(sumPow.every((c) => Math.abs(c - 1) < 1e-9)).toBe(true);
  });

  it("cubic variance is symmetric under index permutation", () => {
    const inv = quarticStrainInvariants(buildSpaceGroup(225).operations);
    const s = [1, 0.5];
    const a = strainVarianceM(2, 1, 0, s, inv);
    const b = strainVarianceM(0, 2, 1, s, inv); // a cyclic permutation
    const c = strainVarianceM(1, 0, 2, s, inv);
    expect(a).toBeCloseTo(b, 10);
    expect(b).toBeCloseTo(c, 10);
  });
});

describe("stephensStrainFwhmDeg — physical broadening", () => {
  const cubic: UnitCell = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };
  const wavelength = 1.5406;
  const DEG = Math.PI / 180;
  const tanThetaOf = (h: number, k: number, l: number): number => {
    const d = 5 / Math.sqrt(h * h + k * k + l * l);
    const theta = Math.asin(wavelength / (2 * d));
    return Math.tan(theta);
  };

  it("reproduces isotropic Γ = 4√(2ln2)·ε·tanθ when S encodes σ²(M) = (2ε·M)²", () => {
    const inv = quarticStrainInvariants(buildSpaceGroup(225).operations); // cubic m-3m
    const A = reciprocalTensorA(cubic).a11; // = 1/a² for cubic
    const eps = 0.0015;
    // (h²+k²+l²)² = Σh⁴ + 2Σh²k². invariant0 = Σh⁴, invariant1 = Σh²k².
    // σ²(M) = 4ε²A²(h²+k²+l²)² ⇒ s = [4ε²A², 2·4ε²A²].
    const target = 4 * eps * eps * A * A;
    const s = [target, 2 * target];

    const expectedDeg = (h: number, k: number, l: number) =>
      (Math.sqrt(8 * Math.log(2)) * 2 * eps * tanThetaOf(h, k, l) * 180) / Math.PI;

    for (const [h, k, l] of [[1, 0, 0], [1, 1, 0], [1, 1, 1], [2, 1, 0], [2, 2, 1]] as const) {
      const got = stephensStrainFwhmDeg(h, k, l, cubic, wavelength, s, inv);
      expect(got).toBeCloseTo(expectedDeg(h, k, l), 8);
      // And Γ/tanθ is constant (angle-independent), the isotropic signature.
      expect(got / tanThetaOf(h, k, l)).toBeCloseTo(
        (Math.sqrt(8 * Math.log(2)) * 2 * eps * 180) / Math.PI,
        8,
      );
    }
  });

  it("is genuinely anisotropic: Σh²k²-only strain broadens (hk0) but not (h00)", () => {
    const inv = quarticStrainInvariants(buildSpaceGroup(225).operations);
    // Only the Σh²k² invariant active: vanishes when any two indices are 0.
    const s = [0, 1e-4];
    const along = stephensStrainFwhmDeg(2, 0, 0, cubic, wavelength, s, inv); // h00 → 0
    const diag = stephensStrainFwhmDeg(2, 2, 0, cubic, wavelength, s, inv); // hh0 → >0
    expect(along).toBeCloseTo(0, 12);
    expect(diag).toBeGreaterThan(0);
  });

  it("returns 0 for a non-positive (over-fit) variance", () => {
    const inv = quarticStrainInvariants(buildSpaceGroup(225).operations);
    expect(stephensStrainFwhmDeg(1, 1, 1, cubic, wavelength, [-1, 0], inv)).toBe(0);
    void DEG;
  });
});

describe("uniaxialStrainFwhmDeg (GSAS-II uniaxial Mustrain)", () => {
  // Tetragonal cell, unique c-axis → (00l) is ‖ axis (cos²ψ=1), (hk0) is ⊥ (cos²ψ=0).
  const tet: UnitCell = { a: 5, b: 5, c: 8, alpha: 90, beta: 90, gamma: 90 };
  const lam = 1.5;
  const axis: [number, number, number] = [0, 0, 1];

  it("reduces to the isotropic Lorentzian Y (Γ = Y·tanθ/100) when Y⊥ = Y∥", () => {
    const y = 12;
    const iso = uniaxialStrainFwhmDeg(1, 1, 0, tet, lam, { yPerp: y, yPar: y, axis });
    // Direct isotropic: Γ = Y·tanθ/100.
    const dHK0 = 5 / Math.sqrt(2); // d(110) for a=5
    const theta = Math.asin(lam / (2 * dHK0));
    expect(iso).toBeCloseTo((y * Math.tan(theta)) / 100, 8);
  });

  it("is direction-dependent: (00l) picks Y∥, (hk0) picks Y⊥", () => {
    const s = { yPerp: 4, yPar: 40, axis };
    const along = uniaxialStrainFwhmDeg(0, 0, 2, tet, lam, s); // ‖ axis → uses Y∥=40
    const perp = uniaxialStrainFwhmDeg(2, 2, 0, tet, lam, s); // ⊥ axis → uses Y⊥=4
    // Same tanθ family aside, the ‖ coefficient is 10× the ⊥ one, so ‖ is broader
    // per unit tanθ. Check the effective Y each picks up.
    const yAlong = (along * 100) / Math.tan(Math.asin(lam / (2 * (8 / 2)))); // d(002)=c/2=4
    const yPerp = (perp * 100) / Math.tan(Math.asin(lam / (2 * (5 / (2 * Math.SQRT2))))); // d(220)=a/(2√2)
    expect(yAlong).toBeCloseTo(40, 4);
    expect(yPerp).toBeCloseTo(4, 4);
  });

  it("returns 0 for a non-positive coefficient", () => {
    expect(uniaxialStrainFwhmDeg(1, 0, 0, tet, lam, { yPerp: -5, yPar: -5, axis })).toBe(0);
  });
});
