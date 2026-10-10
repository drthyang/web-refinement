import { describe, it, expect } from "vitest";
import { buildPowderSpec } from "@/app/powderSpec";
import { parse_structure } from "@/mcp/tools";
import { powderCurves } from "@/core/workflow/powder";
import { check_cell_symmetry } from "@/mcp/tools";

/** The D1A PbSO₄ data of the GSAS-II tutorials (CWCombined), in the git-ignored data folder. */
const REAL = { data: "GSAS-II-tutorials/PBSO4.CWN", instrument: "GSAS-II-tutorials/inst_d1a.prm" };

/** PbSO₄, Pnma (the Rietveld round-robin sample; coordinates as published). */
const PBSO4 = `data_pbso4
_cell_length_a 8.480
_cell_length_b 5.398
_cell_length_c 6.958
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
_symmetry_space_group_name_H-M "P n m a"
loop_
_symmetry_equiv_pos_as_xyz
x,y,z
1/2-x,1/2+y,1/2+z
x,1/2-y,z
1/2-x,-y,1/2+z
-x,-y,-z
1/2+x,1/2-y,1/2-z
-x,1/2+y,-z
1/2+x,y,1/2-z
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_U_iso_or_equiv
Pb Pb 0.1879 0.25 0.1671 1 0.018
S S 0.0654 0.25 0.6838 1 0.009
O1 O 0.9082 0.25 0.5954 1 0.026
O2 O 0.1937 0.25 0.5433 1 0.021
O3 O 0.0810 0.0272 0.8086 1 0.017
`;
import { cagliotiOf, cwWidth } from "@/core/workflow/leBail";
import { parse_instrument, parse_powder_data } from "@/mcp/tools";
import { dataExists, readData } from "@/testSupport/data";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * The cell check on a constant-wavelength neutron instrument whose resolution
 * falls then rises with angle (D1A: V < 0). Two width terms cannot follow that
 * curve; with only them, the high-angle flanks of a correct, single-phase
 * pattern read as unindexed peaks (PbSO₄ on D1A did). The check takes the
 * curve's shape from the instrument file.
 */

const D1A: InstrumentParameters = { kind: "constantWavelength", radiationKind: "neutron", wavelength: 1.909, zero: 0, u: 1963, v: -4217, w: 3613, x: 0, y: 0 };

describe("the cell check follows the instrument's resolution curve", () => {
  it("reads the curve from the instrument's U, V, W (FWHM², centidegrees²)", () => {
    expect(cagliotiOf(D1A)).toEqual({ u: 0.1963, v: -0.4217, w: 0.3613 });
    expect(cagliotiOf({ kind: "constantWavelength" })).toBeUndefined();
    const pattern = { xUnit: "twoTheta", points: [10, 80, 150].map((x) => ({ x, yObs: 0 })) } as unknown as PowderPattern;
    // Scaled to 0.4° at the middle angle (80°), the D1A shape: wide low, narrow mid, ~1° at 145°.
    const w = cwWidth(pattern, 0.4, 0, cagliotiOf(D1A));
    expect(w(80)).toBeCloseTo(0.4, 6);
    expect(w(15)).toBeGreaterThan(w(80));
    expect(w(145)).toBeGreaterThan(2 * w(80));
  });

  it("passes a correct single-phase pattern measured on that instrument (PbSO₄)", () => {
    const structure = parse_structure({ cif: PBSO4 }).structure;
    const grid: PowderPattern = { id: "p", name: "sim", xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.909 }, wavelength: 1.909, points: Array.from({ length: 2919 }, (_, i) => ({ x: 10 + i * 0.05, yObs: 0 })) };
    // As the real D1A data refine: a Lorentzian size term and axial asymmetry
    // on top of the instrument's Gaussian curve, at its counting level.
    const spec = buildPowderSpec(structure, grid, D1A, true, 4, {}, "isotropic", { asymmetry: true });
    const truth: Record<string, number> = { scale: 1, bkg0: 0, bkg1: 0, bkg2: 0, bkg3: 0, profX: 10, asymSL: 0.056 };
    const params = spec.params.map((p) => (p.id in truth ? { ...p, value: truth[p.id]! } : p));
    const peaks = powderCurves(structure, grid, params, spec.bindings, spec.profile).yCalc;
    const top = Math.max(...peaks);
    const y = peaks.map((v) => (2300 * v) / top + 210);
    const k = 1;
    let seed = 5;
    const u = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pattern: PowderPattern = { ...grid, points: grid.points.map((p, i) => {
      const v = k * y[i]!;
      const s = Math.sqrt(Math.max(v, 1));
      return { ...p, yObs: v + s * Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()), sigma: s };
    }) };
    const r = check_cell_symmetry({ structure, pattern, instrument: D1A });
    expect(r.unindexedPeaks).toEqual([]);
    expect(r.passed).toBe(true);
  }, 60_000);

  // The case found by the Agent: four "unindexed" peaks at 2θ 138–152°.
  it.skipIf(!dataExists(REAL.data))("passes the real D1A PbSO₄ pattern, which two width terms failed", () => {
    const structure = parse_structure({ cif: PBSO4 }).structure;
    const instrument = parse_instrument({ text: readData(REAL.instrument) });
    const parsed = parse_powder_data({ text: readData(REAL.data), filename: "PBSO4.CWN" });
    const pattern = { ...parsed.pattern, radiation: { kind: "neutron" as const, wavelength: 1.909 }, wavelength: 1.909 };
    expect(parsed.summary).toMatchObject({ points: 2919, xMin: 10 });
    const r = check_cell_symmetry({ structure, pattern, instrument });
    expect(r.unindexedPeaks).toEqual([]);
    expect(r.passed).toBe(true);
  }, 60_000);
});
