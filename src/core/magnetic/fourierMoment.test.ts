import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { RefinementParameter } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import { MAGNETIC_PREFACTOR } from "@/core/magnetic/structureFactor";
import {
  momentInCell,
  fourierMagneticStructureFactor,
  buildFourierSatelliteProblem,
  type FourierSite,
  type FourierMode,
} from "@/core/magnetic/fourierMoment";

const cubic: UnitCell = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };
const p = MAGNETIC_PREFACTOR;

describe("momentInCell — real-space moment from a Fourier coefficient", () => {
  it("gives a collinear reversing sinusoid for a real coefficient (k = (0,0,½))", () => {
    const sReal: Vec3 = [2, 0, 0];
    const sImag: Vec3 = [0, 0, 0];
    const k: Vec3 = [0, 0, 0.5];
    // m = 2·sReal·cos(π·n_z): (4,0,0) at n_z=0, (−4,0,0) at n_z=1.
    expect(momentInCell(sReal, sImag, k, [0, 0, 0])).toEqual([4, 0, 0]);
    expect(momentInCell(sReal, sImag, k, [0, 0, 1])[0]).toBeCloseTo(-4, 10);
    expect(momentInCell(sReal, sImag, k, [0, 0, 1])[1]).toBeCloseTo(0, 10);
  });

  it("gives a constant-magnitude circular helix for S^Re ⊥ S^Im, |S^Re| = |S^Im|", () => {
    const sReal: Vec3 = [1, 0, 0];
    const sImag: Vec3 = [0, 1, 0];
    const k: Vec3 = [0, 0, 0.25]; // rotates in the a–b plane once per 4 cells
    const dirs = [0, 1, 2, 3].map((nz) => momentInCell(sReal, sImag, k, [0, 0, nz]));
    // Magnitude is constant (= 2) — the signature of a circular helix.
    for (const m of dirs) {
      expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(2, 10);
    }
    // Successive cells advance by 90° in the a–b plane.
    expect(dirs[0]![0]).toBeCloseTo(2, 10); // (2,0,0)
    expect(dirs[1]![1]).toBeCloseTo(2, 10); // (0,2,0)
    expect(dirs[2]![0]).toBeCloseTo(-2, 10); // (−2,0,0)
    expect(dirs[3]![1]).toBeCloseTo(-2, 10); // (0,−2,0)
  });
});

describe("fourierMagneticStructureFactor — hand-computable single-atom cases", () => {
  // One magnetic atom at the origin, cubic cell (Cartesian ≡ crystal axes), no
  // form factor (f = 1). Satellite (0,0,½): Q ∥ c, so ĥ = (0,0,1).
  const at = (sReal: Vec3, sImag: Vec3): FourierSite[] => [{ position: [0, 0, 0], sReal, sImag }];
  const sat: Vec3 = [0, 0, 0.5];

  it("returns |M_⊥|² = (p·|S|)² when the moment is fully perpendicular to Q", () => {
    const { squared } = fourierMagneticStructureFactor(cubic, at([2, 0, 0], [0, 0, 0]), sat);
    expect(squared).toBeCloseTo((2 * p) ** 2, 10);
  });

  it("scatters nothing when the moment is parallel to Q", () => {
    const { squared } = fourierMagneticStructureFactor(cubic, at([0, 0, 2], [0, 0, 0]), sat);
    expect(squared).toBeCloseTo(0, 12);
  });

  it("projects out only the component of the moment parallel to Q", () => {
    // S = (2 ⊥, 0, 3 ∥): the c-component is removed, leaving the a-component.
    const { squared } = fourierMagneticStructureFactor(cubic, at([2, 0, 3], [0, 0, 0]), sat);
    expect(squared).toBeCloseTo((2 * p) ** 2, 10);
  });

  it("adds the real and imaginary coefficient parts in quadrature (helix)", () => {
    // S = (1,0,0) + i(0,1,0): both parts ⊥ Q ⇒ |M_⊥|² = p²(|1|² + |1|²) = 2p².
    const { squared } = fourierMagneticStructureFactor(cubic, at([1, 0, 0], [0, 1, 0]), sat);
    expect(squared).toBeCloseTo(2 * p * p, 10);
  });

  it("returns M_⊥ genuinely perpendicular to the scattering vector", () => {
    // A general oblique index; both Re and Im parts of M_⊥ must be ⊥ Q.
    const idx: Vec3 = [1, 0, 0.5];
    const { vector } = fourierMagneticStructureFactor(cubic, at([1, 2, 3], [0.5, -1, 2]), idx);
    // Q ∥ (1,0,0.5) in this cubic cell → the reciprocal direction is (1,0,0.5).
    const qhat: Vec3 = [1, 0, 0.5];
    const re = [vector[0].re, vector[1].re, vector[2].re];
    const im = [vector[0].im, vector[1].im, vector[2].im];
    const dot = (v: number[]) => v[0]! * qhat[0] + v[1]! * qhat[1] + v[2]! * qhat[2];
    expect(dot(re)).toBeCloseTo(0, 10);
    expect(dot(im)).toBeCloseTo(0, 10);
  });
});

describe("buildFourierSatelliteProblem — recover a known basis-mode amplitude (k ≠ 0)", () => {
  // A synthetic set of magnetic satellites for a known structure; refine the mode
  // amplitude back from a wrong start (the M4 validation gate).
  const k: Vec3 = [0, 0, 0.25];
  const nuclearHkl: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
  ];
  const satellites = nuclearHkl.map((H) => [H[0] + k[0], H[1] + k[1], H[2] + k[2]] as Vec3);

  it("recovers a single helix amplitude on one site", () => {
    const site: FourierSite = { position: [0, 0, 0], sReal: [0, 0, 0], sImag: [0, 0, 0], formFactorId: "Mn2" };
    // Unit circular helix in the a–b plane, scaled by one amplitude.
    const mode: FourierMode = {
      parameterId: "amp",
      terms: [{ site: 0, sReal: [1, 0, 0], sImag: [0, 1, 0] }],
    };
    const truthAmp = 2.4;
    const truthValues = { amp: truthAmp };
    const truthProblem = buildFourierSatelliteProblem(cubic, [site], [mode], satellites.map((index) => ({ index, iObs: 0 })), [
      { id: "amp", label: "amp", kind: "momentMode", value: truthAmp, initialValue: truthAmp, fixed: false },
    ]);
    const iCalc = truthProblem.calculate(truthValues);
    const obs = satellites.map((index, i) => ({ index, iObs: iCalc[i]!, sigma: Math.sqrt(Math.max(iCalc[i]!, 1e-6)) }));

    const params: RefinementParameter[] = [
      { id: "amp", label: "amp", kind: "momentMode", value: 0.7, initialValue: 0.7, fixed: false },
    ];
    const problem = buildFourierSatelliteProblem(cubic, [site], [mode], obs, params);
    const result = refine(problem, { maxIterations: 40 });
    // |M_⊥|² ∝ amplitude² ⇒ sign is undetermined; recover the magnitude.
    expect(Math.abs(result.parameters.amp ?? 0)).toBeCloseTo(truthAmp, 3);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(1e-3);
  });

  it("recovers a collinear SDW amplitude across two inequivalent sites", () => {
    // Two atoms, antiphase along a, refined through one shared amplitude.
    const sites: FourierSite[] = [
      { position: [0, 0, 0], sReal: [0, 0, 0], sImag: [0, 0, 0], formFactorId: "Mn2" },
      { position: [0.5, 0.5, 0], sReal: [0, 0, 0], sImag: [0, 0, 0], formFactorId: "Mn2" },
    ];
    const mode: FourierMode = {
      parameterId: "amp",
      terms: [
        { site: 0, sReal: [1, 0, 0], sImag: [0, 0, 0] },
        { site: 1, sReal: [-1, 0, 0], sImag: [0, 0, 0] },
      ],
    };
    const truthAmp = 3.1;
    const truthProblem = buildFourierSatelliteProblem(cubic, sites, [mode], satellites.map((index) => ({ index, iObs: 0 })), [
      { id: "amp", label: "amp", kind: "momentMode", value: truthAmp, initialValue: truthAmp, fixed: false },
    ]);
    const iCalc = truthProblem.calculate({ amp: truthAmp });
    const obs = satellites.map((index, i) => ({ index, iObs: iCalc[i]!, sigma: Math.sqrt(Math.max(iCalc[i]!, 1e-6)) }));

    const params: RefinementParameter[] = [
      { id: "amp", label: "amp", kind: "momentMode", value: 1.0, initialValue: 1.0, fixed: false },
    ];
    const problem = buildFourierSatelliteProblem(cubic, sites, [mode], obs, params);
    const result = refine(problem, { maxIterations: 40 });
    expect(Math.abs(result.parameters.amp ?? 0)).toBeCloseTo(truthAmp, 3);
    expect(result.agreement.rWeighted ?? 1).toBeLessThan(1e-3);
  });
});
