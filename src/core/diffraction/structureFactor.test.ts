import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { Radiation } from "@/core/diffraction/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import {
  expandStructureAtoms,
  nuclearStructureFactor,
  nuclearStructureFactorPartials,
  nuclearStructureFactorSquared,
} from "@/core/diffraction/structureFactor";
import { boundCoherentLength, NEUTRON_B, NEUTRON_B_ISOTOPES, neutronAmplitude } from "@/core/scattering/neutron";
import { xrayTable } from "@/core/scattering/xray";

// Body-centred cell, one atom at the origin: identity + (½,½,½).
const bccFe: StructureModel = {
  id: "fe",
  name: "bcc Fe",
  cell: { a: 2.8665, b: 2.8665, c: 2.8665, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: {
    operations: [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("1/2+x,1/2+y,1/2+z")],
  },
  sites: [
    { label: "Fe1", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0 } },
  ],
};
const neutron: Radiation = { kind: "neutron", wavelength: 1.54 };

describe("nuclear structure factor — analytic golden (I-centring)", () => {
  const b = boundCoherentLength("Fe").re;

  it("F = 2b when h+k+l is even", () => {
    // (110): F = b[1 + e^{2πi·1}] = 2b.
    const f = nuclearStructureFactor(bccFe, neutron, 1, 1, 0);
    expect(f.re).toBeCloseTo(2 * b, 6);
    expect(f.im).toBeCloseTo(0, 6);
    expect(nuclearStructureFactorSquared(bccFe, neutron, 1, 1, 0)).toBeCloseTo((2 * b) ** 2, 5);
  });

  it("F = 0 when h+k+l is odd (body-centring absence)", () => {
    // (100): F = b[1 + e^{iπ}] = 0.
    expect(nuclearStructureFactorSquared(bccFe, neutron, 1, 0, 0)).toBeCloseTo(0, 8);
  });

  it("Debye-Waller factor reduces |F| at higher angle", () => {
    const hot: StructureModel = {
      ...bccFe,
      sites: [{ ...bccFe.sites[0]!, adp: { kind: "isotropic", bIso: 1.0 } }],
    };
    const f2cold = nuclearStructureFactorSquared(bccFe, neutron, 2, 2, 0);
    const f2hot = nuclearStructureFactorSquared(hot, neutron, 2, 2, 0);
    expect(f2hot).toBeLessThan(f2cold);
  });
});

// Non-centrosymmetric (P1) with absorbing nuclei: Gd 6.5 − 13.82i, B 5.30 − 0.213i.
const gdBorate: StructureModel = {
  id: "gd",
  name: "Gd absorber",
  cell: { a: 5.1, b: 6.3, c: 7.2, alpha: 90, beta: 101, gamma: 90 },
  spaceGroup: { operations: [parseSymmetryOperation("x,y,z")] },
  sites: [
    { label: "Gd1", element: "Gd", position: [0.11, 0.23, 0.31], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } },
    { label: "B1", element: "B", position: [0.62, 0.17, 0.74], occupancy: 0.8, adp: { kind: "isotropic", bIso: 0.6 } },
    { label: "O1", element: "O", position: [0.37, 0.71, 0.08], occupancy: 1, adp: { kind: "isotropic", bIso: 0.7 } },
  ],
};

/**
 * |A|² in the PHYSICS convention, independent of the code under test: Sears' b
 * as printed (b′ − i·b″), scattered amplitude ∝ Σ b·exp(−iQ·r) with
 * Q·r = 2π h·x, and the same occupancy and Debye–Waller weights.
 */
function physicsIntensity(model: StructureModel, h: number, k: number, l: number, sign: 1 | -1 = -1): number {
  const s = 1 / (2 * dOf(model, h, k, l));
  let re = 0;
  let im = 0;
  for (const a of expandStructureAtoms(model)) {
    const b = boundCoherentLength(a.element, a.isotope);
    const w = a.occupancy * Math.exp(-(a.adp.kind === "isotropic" ? a.adp.bIso : 0) * s * s);
    const ph = sign * 2 * Math.PI * (h * a.position[0] + k * a.position[1] + l * a.position[2]);
    re += w * (b.re * Math.cos(ph) - b.im * Math.sin(ph));
    im += w * (b.re * Math.sin(ph) + b.im * Math.cos(ph));
  }
  return re * re + im * im;
}
function dOf(model: StructureModel, h: number, k: number, l: number): number {
  // Monoclinic (unique b) 1/d²; enough for the test cell above.
  const { a, b, c, beta } = model.cell;
  const sb = Math.sin((beta * Math.PI) / 180);
  const cb = Math.cos((beta * Math.PI) / 180);
  const inv = (h * h) / (a * a * sb * sb) + (k * k) / (b * b) + (l * l) / (c * c * sb * sb) - (2 * h * l * cb) / (a * c * sb * sb);
  return 1 / Math.sqrt(inv);
}

describe("complex neutron amplitudes (absorbing nuclei) and their sign", () => {
  const hkls: [number, number, number][] = [[1, 0, 0], [1, 1, 0], [0, 1, 1], [1, 2, 3], [2, -1, 1], [3, 1, -2]];

  it("|F(h)|² equals the physics-convention |Σ b·exp(−2πi h·x)|² with b as Sears prints it", () => {
    for (const [h, k, l] of hkls) {
      const ours = nuclearStructureFactorSquared(gdBorate, neutron, h, k, l);
      expect(ours / physicsIntensity(gdBorate, h, k, l), `${h}${k}${l}`).toBeCloseTo(1, 12);
    }
  });

  it("putting the printed b straight into F = Σ b·exp(+2πi h·x) would give I(−h) — Bijvoet pairs differ", () => {
    let maxBijvoet = 0;
    for (const [h, k, l] of hkls) {
      const plus = nuclearStructureFactorSquared(gdBorate, neutron, h, k, l);
      const minus = nuclearStructureFactorSquared(gdBorate, neutron, -h, -k, -l);
      // The wrong-sign construction (printed b, +2πi phase) is the physics sum at −h.
      const wrong = physicsIntensity(gdBorate, h, k, l, 1);
      expect(wrong / minus, `${h}${k}${l}`).toBeCloseTo(1, 12);
      maxBijvoet = Math.max(maxBijvoet, Math.abs(plus - minus) / (plus + minus));
    }
    // With absorption in a non-centrosymmetric cell, I(h) ≠ I(−h): the test above is not vacuous.
    expect(maxBijvoet).toBeGreaterThan(0.05);
  });

  it("every absorbing nucleus gets a positive imaginary amplitude, like X-ray f″", () => {
    let absorbers = 0;
    for (const key of Object.keys(NEUTRON_B)) {
      const a = neutronAmplitude(key);
      expect(a.im, key).toBeGreaterThanOrEqual(0);
      if (a.im > 0) absorbers++;
    }
    for (const key of Object.keys(NEUTRON_B_ISOTOPES)) {
      const m = /^(\d+)([A-Z][a-z]?)$/.exec(key)!;
      expect(neutronAmplitude(m[2]!, Number(m[1])).im, key).toBeGreaterThanOrEqual(0);
    }
    expect(absorbers).toBe(7); // B, Cd, In, Sm, Eu, Gd, Dy
    expect(neutronAmplitude("Gd")).toEqual({ re: 6.5, im: 13.82 });
  });

  it("a lone Gd scatters with |b|² = 6.5² + 13.82², not 6.5² (≈5.5× more)", () => {
    const gd: StructureModel = {
      ...bccFe,
      spaceGroup: { operations: [parseSymmetryOperation("x,y,z")] },
      sites: [{ label: "Gd1", element: "Gd", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0 } }],
    };
    expect(nuclearStructureFactorSquared(gd, neutron, 1, 1, 0)).toBeCloseTo(6.5 ** 2 + 13.82 ** 2, 9);
  });

  it("the per-site partials carry the complex amplitude (∂F/∂occ matches a finite difference)", () => {
    const [h, k, l] = [1, 2, 3];
    const { f, perSite } = nuclearStructureFactorPartials(gdBorate, neutron, h, k, l);
    const direct = nuclearStructureFactor(gdBorate, neutron, h, k, l);
    expect(f.re).toBeCloseTo(direct.re, 12);
    expect(f.im).toBeCloseTo(direct.im, 12);
    const eps = 1e-6;
    gdBorate.sites.forEach((site, i) => {
      const bumped: StructureModel = {
        ...gdBorate,
        sites: gdBorate.sites.map((st, j) => (j === i ? { ...st, occupancy: st.occupancy + eps } : st)),
      };
      const fb = nuclearStructureFactor(bumped, neutron, h, k, l);
      expect(perSite[i]!.unitSite.re, site.label).toBeCloseTo((fb.re - direct.re) / eps, 5);
      expect(perSite[i]!.unitSite.im, site.label).toBeCloseTo((fb.im - direct.im) / eps, 5);
    });
  });

  it("X-ray amplitudes stay real", () => {
    expect(xrayTable.amplitude("Gd", 0.3).im).toBe(0);
  });
});
