import { describe, it, expect } from "vitest";
import { buildPowderSpec } from "@/app/powderSpec";
import { parse_structure, parse_instrument, parse_powder_data, check_cell_symmetry } from "@/mcp/tools";
import { buildPeaks, powderCurves } from "@/core/workflow/powder";
import { applyParameters } from "@/core/workflow/apply";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";
import { dataExists, readData } from "@/testSupport/data";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { PowderPattern } from "@/core/diffraction/types";

/**
 * A lab tube's Kα₂. Each reflection is drawn at both wavelengths, Kα₂ at the
 * intensity ratio, as GSAS-II and FullProf draw it; without it, every
 * high-angle Kα₂ peak of lab data is a misfit, and the cell check read them as
 * unindexed peaks (fluorapatite, the GSAS-II lab-data tutorial).
 */

/** The GSAS-II tutorials' lab data (LabData), in the git-ignored data folder. */
const REAL = { data: "GSAS-II-tutorials/FAP.XRA", instrument: "GSAS-II-tutorials/INST_XRY.PRM" };

/** Fluorapatite Ca₅(PO₄)₃F, P6₃/m: the tutorial's sites, rounded, with a uniform U. */
const FAP = `data_fap
_cell_length_a 9.3684
_cell_length_b 9.3684
_cell_length_c 6.8841
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 120
_symmetry_space_group_name_H-M "P 63/m"
loop_
_symmetry_equiv_pos_as_xyz
x,y,z
-y,x-y,z
-x+y,-x,z
-x,-y,z+1/2
y,-x+y,z+1/2
x-y,x,z+1/2
-x,-y,-z
y,-x+y,-z
x-y,x,-z
x,y,-z+1/2
-y,x-y,-z+1/2
-x+y,-x,-z+1/2
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
_atom_site_occupancy
_atom_site_U_iso_or_equiv
Ca1 Ca 0.33333 0.66667 0.0019 1 0.010
Ca2 Ca 0.2420 0.9926 0.25 1 0.010
P P 0.3974 0.3677 0.25 1 0.010
O1 O 0.3251 0.4848 0.25 1 0.010
O2 O 0.5915 0.4700 0.25 1 0.010
O3 O 0.3395 0.2581 0.0706 1 0.010
F F 0 0 0.25 1 0.010
`;

/** Cu Kα₁/Kα₂ on a Bragg–Brentano diffractometer, as INST_XRY.PRM (U, V, W σ² → FWHM²). */
const CU: InstrumentParameters = {
  kind: "constantWavelength", radiationKind: "xray", wavelength: 1.5405, polarization: 0.7,
  u: 2 * 8 * Math.LN2, v: -2 * 8 * Math.LN2, w: 5 * 8 * Math.LN2, x: 0, y: 0,
  kAlpha2: { wavelength: 1.5443, ratio: 0.5 },
};
const DOUBLET = { kind: "xray" as const, wavelength: 1.5405, polarization: 0.7, kAlpha2: { wavelength: 1.5443, ratio: 0.5 } };
const grid = (radiation: PowderPattern["radiation"]): PowderPattern => ({
  id: "p", name: "sim", xUnit: "twoTheta", radiation, wavelength: 1.5405,
  points: Array.from({ length: 5751 }, (_, i) => ({ x: 15 + i * 0.02, yObs: 0 })),
});

describe("a lab tube's Kα₂", () => {
  const structure = parse_structure({ cif: FAP }).structure;

  it("draws every reflection again at λ₂, at the intensity ratio, and ticks it at Kα₁", () => {
    const pattern = grid(DOUBLET);
    const spec = buildPowderSpec(structure, pattern, CU, true, 4, {});
    const values: Record<string, number> = Object.fromEntries(spec.params.map((p) => [p.id, p.value]));
    const applied = applyParameters(structure, spec.bindings, { ...values, scale: 1, zero: 0.03 });
    const peaks = buildPeaks(pattern, applied);
    const first = peaks.filter((p) => !p.secondLine);
    const second = peaks.filter((p) => p.secondLine);
    expect(second.length).toBeGreaterThan(0.9 * first.length);
    // A strong reflection near 2θ 120°: its Kα₂ copy at 2·asin(λ₂/2d) + zero, half as strong.
    const high = first.filter((p) => p.center > 110 && p.center < 125).sort((a, b) => b.intensity - a.intensity)[0]!;
    const theta1 = ((high.center - 0.03) * Math.PI) / 360;
    const d = 1.5405 / (2 * Math.sin(theta1));
    const expected = (2 * Math.asin(1.5443 / (2 * d)) * 180) / Math.PI + 0.03;
    const copy = second.find((p) => Math.abs(p.center - expected) < 1e-9);
    expect(copy, `no Kα₂ line at ${expected}`).toBeDefined();
    expect(copy!.intensity).toBeCloseTo(0.5 * high.intensity, 10);
    expect(expected - high.center).toBeGreaterThan(0.4); // the split near 120°
    // The reflection list (F_obs, the fit-range filter) places each reflection
    // at its Kα₁ line, not between the lines: a window just around Kα₁ keeps it.
    const params = spec.params.map((p) => (p.id === "zero" ? { ...p, value: 0.03 } : p.id === "scale" ? { ...p, value: 1 } : p));
    const window = { min: high.center - 0.02, max: high.center + 0.02 };
    const refl = powderReflectionObsCalc(structure, pattern, params, spec.bindings, spec.profile, null, window);
    expect(refl.some((r) => Math.abs(r.d - d) < 1e-6)).toBe(true);
  });

  it("lets the cell check pass a doublet pattern, and shows the Kα₂ peaks when it is ignored", () => {
    const sim = grid(DOUBLET);
    const spec = buildPowderSpec(structure, sim, CU, true, 4, {});
    const truth = spec.params.map((p) => (p.id === "scale" ? { ...p, value: 1 } : p.kind === "background" ? { ...p, value: 0 } : p));
    const yCalc = powderCurves(structure, sim, truth, spec.bindings, spec.profile).yCalc;
    const top = Math.max(...yCalc);
    let seed = 3;
    const u = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const points = sim.points.map((p, i) => {
      const v = (6000 * yCalc[i]!) / top + 300;
      const s = Math.sqrt(v);
      return { ...p, yObs: v + s * Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()), sigma: s };
    });
    const withK2 = check_cell_symmetry({ structure, pattern: { ...sim, points }, instrument: CU });
    expect(withK2.unindexedPeaks).toEqual([]);
    expect(withK2.passed).toBe(true);
    const { kAlpha2: _k2, ...mono } = DOUBLET;
    const without = check_cell_symmetry({ structure, pattern: { ...sim, radiation: mono, points }, instrument: CU });
    expect(without.unindexedPeaks.length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!dataExists(REAL.data))("reads the tutorial's Cu tube and passes its fluorapatite pattern", () => {
    const instrument = parse_instrument({ text: readData(REAL.instrument) });
    expect(instrument.kind === "constantWavelength" && instrument.kAlpha2).toEqual({ wavelength: 1.5443, ratio: 0.5 });
    const parsed = parse_powder_data({ text: readData(REAL.data), filename: "FAP.XRA", instrument });
    expect(parsed.pattern.radiation).toMatchObject({ kind: "xray", kAlpha2: { wavelength: 1.5443, ratio: 0.5 } });
    const r = check_cell_symmetry({ structure, pattern: parsed.pattern, instrument });
    expect(r.unindexedPeaks).toEqual([]);
    expect(r.passed).toBe(true);
    // With the zero and the asymmetry refined, the Le Bail cell is GSAS-II's
    // refined one (FAP.EXP: a 9.371724, c 6.885867 Å) to 1 part in 10⁴.
    expect(r.cell.a).toBeCloseTo(9.3717, 3);
    expect(r.cell.c).toBeCloseTo(6.8859, 3);
    // Two 1 % bumps 0.27° below the strongest lines: shoulders, not peaks.
    for (const sh of r.shoulders) {
      expect(sh.relativeHeight).toBeLessThan(0.03);
      expect(sh.offset).toBeCloseTo(-0.27, 1);
    }
  }, 120_000);
});
