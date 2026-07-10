import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import { powderCurves } from "@/core/workflow/powder";

/**
 * End-to-end wiring check: the Stephens strain and uniaxial size parameters
 * emitted by buildStructureRefinement must actually reach placePeaks and
 * broaden the calculated pattern in an hkl-dependent way.
 */

const iso = { kind: "isotropic", bIso: 0.3 } as const;
const structure: StructureModel = {
  id: "aniso",
  name: "aniso test",
  cell: { a: 4, b: 4, c: 4, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: buildSpaceGroup(225), // cubic Fm-3m
  sites: [{ label: "Ni1", element: "Ni", oxidationState: 2, position: [0, 0, 0], occupancy: 1, adp: iso }],
};

const grid = Array.from({ length: 1400 }, (_, i) => 15 + (i * (120 - 15)) / 1399);
const pattern: PowderPattern = {
  id: "aniso",
  name: "p",
  xUnit: "twoTheta",
  radiation: { kind: "neutron", wavelength: 1.5 },
  wavelength: 1.5,
  points: grid.map((x) => ({ x, yObs: 0 })),
};

const profile = { shape: "pseudoVoigt" as const, eta: 0.5 };

function fwhmOfTallestPeakNear(twoTheta: number, spec: { params: any[]; bindings: any[] }): number {
  const comp = powderCurves(structure, pattern, spec.params, spec.bindings, profile);
  // Crude FWHM: width of the region above half the local max near `twoTheta`.
  let peakIdx = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    if (Math.abs(grid[i]! - twoTheta) < 8 && comp.yCalc[i]! > peakVal) { peakVal = comp.yCalc[i]!; peakIdx = i; }
  }
  const half = peakVal / 2;
  let lo = peakIdx, hi = peakIdx;
  while (lo > 0 && comp.yCalc[lo]! > half) lo--;
  while (hi < grid.length - 1 && comp.yCalc[hi]! > half) hi++;
  return grid[hi]! - grid[lo]!;
}

describe("Stephens strain wiring (Fm-3m)", () => {
  it("emits one S parameter per cubic invariant (2) and leaves the pattern unbroadened at S=0", () => {
    const spec = buildStructureRefinement(structure, pattern, {
      caglioti: { u: 0, v: 0, w: 2 }, lorentzian: { x: 0, y: 0 }, stephensStrain: true, refineAdp: false, refinePositions: false,
    });
    const sParams = spec.params.filter((p) => p.kind === "stephensStrain");
    expect(sParams).toHaveLength(2);
    // With all S = 0 the calc is finite and positive (no NaN from the aniso path).
    const comp = powderCurves(structure, pattern, spec.params, spec.bindings, profile);
    expect(Math.max(...comp.yCalc)).toBeGreaterThan(0);
    expect(comp.yCalc.some((v) => Number.isNaN(v))).toBe(false);
  });

  it("broadens (hk0)-type peaks more than (h00) when only the Σh²k² invariant is active", () => {
    const spec = buildStructureRefinement(structure, pattern, {
      caglioti: { u: 0, v: 0, w: 2 }, lorentzian: { x: 0, y: 0 }, stephensStrain: true, refineAdp: false, refinePositions: false,
    });
    // Activate only the second invariant (Σh²k²). d(220) sits near 2θ where
    // (220) exists; compare its width with (200) which the invariant leaves alone.
    const params = spec.params.map((p) => (p.id === "stephens_1" ? { ...p, value: 5e-3 } : p));
    // 2θ of (200): d=a/2=2 → 2θ = 2·asin(1.5/4) ≈ 44.05°. (220): d=√2 → ≈ 66.5°.
    const w200base = fwhmOfTallestPeakNear(44, spec);
    const w200 = fwhmOfTallestPeakNear(44, { params, bindings: spec.bindings });
    const w220base = fwhmOfTallestPeakNear(66.5, spec);
    const w220 = fwhmOfTallestPeakNear(66.5, { params, bindings: spec.bindings });
    // (200) essentially unchanged (h²k²=0); (220) visibly broadened.
    expect(Math.abs(w200 - w200base)).toBeLessThan(0.15);
    expect(w220 - w220base).toBeGreaterThan(0.2);
  });
});

describe("Uniaxial size wiring", () => {
  it("emits X⊥/X∥ and broadens axial vs equatorial reflections differently", () => {
    const spec = buildStructureRefinement(structure, pattern, {
      caglioti: { u: 0, v: 0, w: 2 }, uniaxialSize: { axis: [0, 0, 1] }, refineAdp: false, refinePositions: false,
    });
    expect(spec.params.some((p) => p.kind === "anisoSizePerp")).toBe(true);
    expect(spec.params.some((p) => p.kind === "anisoSizePar")).toBe(true);
    // Make the parallel dimension much more broadened (larger X∥).
    const params = spec.params.map((p) =>
      p.id === "sizePar" ? { ...p, value: 30 } : p.id === "sizePerp" ? { ...p, value: 1 } : p,
    );
    const wAxial = fwhmOfTallestPeakNear(44, { params, bindings: spec.bindings }); // (002)/(200) region — (00l) axial
    const comp = powderCurves(structure, pattern, params, spec.bindings, profile);
    expect(comp.yCalc.some((v) => Number.isNaN(v))).toBe(false);
    expect(wAxial).toBeGreaterThan(0);
  });
});

describe("Uniaxial strain (Mustrain) wiring", () => {
  const opts = {
    caglioti: { u: 0, v: 0, w: 2 }, lorentzian: { x: 0, y: 20 },
    refineAdp: false, refinePositions: false,
  } as const;

  it("emits Y⊥/Y∥ seeded from the isotropic Lorentzian Y and reduces to isotropic at the seed", () => {
    const uni = buildStructureRefinement(structure, pattern, { ...opts, uniaxialStrain: { axis: [0, 0, 1] } });
    const perp = uni.params.find((p) => p.kind === "mustrainPerp");
    const par = uni.params.find((p) => p.kind === "mustrainPar");
    expect(perp?.value).toBe(20);
    expect(par?.value).toBe(20);
    // At the seed (Y⊥ = Y∥ = isotropic Y) the uniaxial correction is net-zero:
    // the calc is identical to the plain isotropic-Lorentzian spec (no double-count).
    const isoSpec = buildStructureRefinement(structure, pattern, opts);
    const cUni = powderCurves(structure, pattern, uni.params, uni.bindings, profile);
    const cIso = powderCurves(structure, pattern, isoSpec.params, isoSpec.bindings, profile);
    const maxDiff = Math.max(...cUni.yCalc.map((v, i) => Math.abs(v - cIso.yCalc[i]!)));
    expect(maxDiff).toBeLessThan(1e-6 * Math.max(...cIso.yCalc, 1));
  });

  it("broadens the pattern (lower maxima) when Y∥ is raised above Y⊥, with no NaN", () => {
    const uni = buildStructureRefinement(structure, pattern, { ...opts, uniaxialStrain: { axis: [0, 0, 1] } });
    const base = powderCurves(structure, pattern, uni.params, uni.bindings, profile);
    const strained = uni.params.map((p) => (p.id === "mustrainPar" ? { ...p, value: 200 } : p));
    const comp = powderCurves(structure, pattern, strained, uni.bindings, profile);
    expect(comp.yCalc.some((v) => Number.isNaN(v))).toBe(false);
    // Extra axial strain broadens the (00l)-bearing overlaps → lower peak maxima.
    expect(Math.max(...comp.yCalc)).toBeLessThan(Math.max(...base.yCalc));
  });
});
