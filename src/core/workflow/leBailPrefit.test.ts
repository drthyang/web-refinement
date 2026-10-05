import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { generateReflections } from "@/core/diffraction/reflections";
import { gaussian } from "@/core/diffraction/profile";
import { leBailCellPrefit } from "@/core/workflow/leBailPrefit";
import { parse_structure, simulate_pattern } from "@/mcp/tools";

const WL = 1.54;
const twoTheta = (d: number): number => (2 * Math.asin(WL / (2 * d)) * 180) / Math.PI;

// Orthorhombic P1 truth cell — the pattern is generated from its peak positions.
const TRUTH = { a: 5.0, b: 6.0, c: 7.0, alpha: 90, beta: 90, gamma: 90 };
const spaceGroup = { operations: [parseSymmetryOperation("x,y,z")] };

function structureWith(a: number): StructureModel {
  return {
    id: "s", name: "orthoP1",
    cell: { ...TRUTH, a },
    spaceGroup,
    sites: [{ label: "A", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } }],
  };
}

// Synthetic pattern: unit-intensity Gaussians at every reflection of the truth
// cell — exactly what a Le Bail free-intensity fit reconstructs, so χ² is zero
// only when the refined cell reproduces those peak positions.
const FWHM = 0.5;
const grid = Array.from({ length: 500 }, (_, i) => 12 + (i * 58) / 500); // 12–70° 2θ
const refls = generateReflections(TRUTH, spaceGroup, 1.3, 9);
const centers = refls.map((r) => twoTheta(r.d)).filter((t) => Number.isFinite(t));
const pattern: PowderPattern = {
  id: "p", name: "p", xUnit: "twoTheta", radiation: { kind: "xray", wavelength: WL }, wavelength: WL,
  points: grid.map((x) => ({ x, yObs: centers.reduce((s, c) => s + gaussian(x, c, FWHM), 0) })),
};

const cellBinding: ParameterBinding = { parameterId: "cell_a", kind: "cellLength", targetId: "s", targetKey: "a" };

describe("leBailCellPrefit", () => {
  it("recovers the unit cell from peak positions with no structural model", () => {
    // Start 2% off (a = 5.1): peaks are misplaced but still overlap the truth,
    // so the free-intensity fit can walk the cell back to a = 5.0.
    const cellParam: RefinementParameter = {
      id: "cell_a", label: "a", kind: "cellLength", value: 5.1, initialValue: 5.1, min: 4.7, max: 5.3, fixed: false,
    };
    const res = leBailCellPrefit(structureWith(5.1), pattern, [cellParam], [cellBinding], {
      shape: "gaussian", fwhm0: FWHM, maxIterations: 25,
    });
    expect(res.refined).toBe(true);
    expect(res.cellValues["cell_a"]).toBeCloseTo(5.0, 2);
    expect(res.cell.a).toBeCloseTo(5.0, 2);
    expect(res.cell.b).toBe(6.0); // untouched dimensions preserved
    // The free-intensity fit at the recovered cell is essentially perfect.
    expect(res.rWeighted).toBeLessThan(0.05);
  });

  it("recovers a TOF unit cell using the diffractometer calibration", () => {
    // TOF = difC·d (difA = difB = Zero = 0). A cubic cell gives a few well-
    // separated peaks; counts + Poisson σ keep the fit well-conditioned.
    const difC = 3000; // µs/Å
    const tof = { difC, difA: 0, difB: 0, zero: 0 };
    const structureTof = (a: number): StructureModel => ({
      id: "s", name: "tof", cell: { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 }, spaceGroup,
      sites: [{ label: "A", element: "Fe", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } }],
    });
    const cubicBindings: ParameterBinding[] = (["a", "b", "c"] as const).map((k) => ({
      parameterId: "cell_a", kind: "cellLength", targetId: "s", targetKey: k,
    }));
    const tofRefls = generateReflections({ a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 }, spaceGroup, 2, 6);
    const tofCenters = tofRefls.map((r) => difC * r.d);
    const fwhmTof = 30; // µs
    const gridTof = Array.from({ length: 700 }, (_, i) => 5500 + (i * 13000) / 700);
    const patternTof: PowderPattern = {
      id: "ptof", name: "tof", xUnit: "tof", radiation: { kind: "neutron-tof" },
      points: gridTof.map((x) => {
        const y = 1000 * tofCenters.reduce((s, c) => s + gaussian(x, c, fwhmTof), 0) + 5;
        return { x, yObs: y, sigma: Math.sqrt(y) };
      }),
    };
    const start = 5.01; // ~1 FWHM shift on the leading reflection
    const cellParam: RefinementParameter = {
      id: "cell_a", label: "a", kind: "cellLength", value: start, initialValue: start, min: 4.8, max: 5.2, fixed: false,
    };
    const res = leBailCellPrefit(structureTof(start), patternTof, [cellParam], cubicBindings, {
      fwhm0: fwhmTof, maxIterations: 30, tof,
    });
    expect(res.refined).toBe(true);
    expect(res.cellValues["cell_a"]).toBeCloseTo(5.0, 2);
    expect(res.rWeighted).toBeLessThan(0.05);

    // Without the calibration the same fit is degenerate (every reflection maps
    // to a NaN position): the cell cannot move off its wrong start.
    const noCal = leBailCellPrefit(structureTof(start), patternTof, [cellParam], cubicBindings, { fwhm0: fwhmTof, maxIterations: 30 });
    expect(noCal.cellValues["cell_a"]).toBeCloseTo(start, 3);
  });

  it("is a no-op when no cell parameter is free", () => {
    const fixed: RefinementParameter = {
      id: "cell_a", label: "a", kind: "cellLength", value: 5.0, initialValue: 5.0, fixed: true,
    };
    const res = leBailCellPrefit(structureWith(5.0), pattern, [fixed], [cellBinding], { fwhm0: FWHM });
    expect(res.refined).toBe(false);
    expect(res.cell.a).toBe(5.0);
    expect(res.cellValues).toEqual({});
  });

  it("TOF: recovers the back-to-back-exponential widths of an engine-simulated pattern", () => {
    // A CsCl pattern from the engine's own TOF profile, whose widths grow ~30×
    // across d = 0.7–6 Å. Started from the data alone (no instrument shape), the
    // Le Bail peaks must land on the same α, β₀ and σ₂².
    const cscl = parse_structure({ cif: `data_t
_cell_length_a 4.12
_cell_length_b 4.12
_cell_length_c 4.12
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M 'P m -3 m'
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_U_iso_or_equiv
Cs1 Cs 0 0 0 1 0.01
Cl1 Cl 0.5 0.5 0.5 1 0.01
` }).structure;
    const truth = { alpha: 0.1, beta0: 0.013, sig2: 100 };
    const sim = simulate_pattern({ structure: cscl, instrument: { kind: "tof", difC: 22585.8, sig1: 300, ...truth }, xMin: 15000, xMax: 135000, points: 12000 });
    const top = Math.max(...sim.curves.yCalc);
    const tofPattern: PowderPattern = {
      id: "t", name: "tof", xUnit: "tof", radiation: { kind: "neutron-tof" },
      points: sim.curves.x.map((x, i) => {
        const y = (20000 * sim.curves.yCalc[i]!) / top + 300;
        return { x, yObs: y, sigma: Math.sqrt(y) };
      }),
    };
    const cubic: ParameterBinding[] = (["a", "b", "c"] as const).map((k) => ({ parameterId: "cell_a", kind: "cellLength", targetId: cscl.id, targetKey: k }));
    const a: RefinementParameter = { id: "cell_a", label: "a", kind: "cellLength", value: 4.12, initialValue: 4.12, fixed: false };
    const res = leBailCellPrefit(cscl, tofPattern, [a], cubic, { shape: "tof", tof: { difC: 22585.8, difA: 0, difB: 0, zero: 0 } });
    expect(res.rWeighted).toBeLessThan(0.01);
    expect(res.cellValues["cell_a"]).toBeCloseTo(4.12, 4);
    expect(res.tofProfile!.alpha).toBeCloseTo(truth.alpha, 2);
    expect(res.tofProfile!.beta0).toBeCloseTo(truth.beta0, 3);
    expect(res.tofProfile!.sig2! / truth.sig2).toBeCloseTo(1, 1);
  });
});
