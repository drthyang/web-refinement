import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { powderCurves, buildPowderProblem } from "@/core/workflow/powder";
import { refine } from "@/core/refinement/engine";
import { computeAgreementFactors, weightsFromSigma } from "@/core/refinement/factors";
import { optimalScale } from "@/app/loadData";
import { dataExists, readData } from "@/testSupport/data";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";

/**
 * Benchmark against a GSAS-II "good fit" of the *same* GaNb4Se8 298.8 K
 * synchrotron pattern. GSAS-II reaches wR ≈ 7.34% (from GaNb4Se8_goodfit.gpx,
 * extracted to GaNb4Se8_goodfit_298K.csv: x, yobs, ycalc, ybkg, sigma) by fixing
 * the structure and using a Thompson-Cox-Hastings pseudo-Voigt — a Gaussian
 * Caglioti part (U/V/W) PLUS an independent Lorentzian size-strain part (X/Y) and
 * axial-divergence asymmetry (SH/L) — refining only scale + Chebyshev background.
 *
 * Our engine currently has a single pseudo-Voigt width (Gaussian Caglioti only;
 * no independent Lorentzian X/Y, no SH/L asymmetry). This test quantifies the
 * resulting gap on identical data and will tighten as the TCH profile lands
 * (roadmap M1). Skips when the git-ignored data/ folder is absent.
 */

const DIR = "GaNb4Se8_XRD_28ID";
const CIF = `${DIR}/GaNb4Se8_100K.cif`;
const REF = `${DIR}/GaNb4Se8_goodfit_298K.csv`;
const has = dataExists(CIF) && dataExists(REF);

interface Row { x: number; yobs: number; yc: number; yb: number; sig: number }
function loadRef(): Row[] {
  return readData(REF)
    .trim()
    .split(/\r?\n/)
    .slice(1) // header
    .map((l) => l.split(",").map(Number))
    .map(([x, yobs, yc, yb, sig]) => ({ x: x!, yobs: yobs!, yc: yc!, yb: yb!, sig: sig! }));
}

/** Weighted profile R over rows with positive weight. */
function wR(rows: { yobs: number; yc: number; sig: number }[]): number {
  let num = 0, den = 0;
  for (const r of rows) {
    const w = r.sig > 0 ? 1 / (r.sig * r.sig) : 0;
    num += w * (r.yobs - r.yc) ** 2;
    den += w * r.yobs ** 2;
  }
  return 100 * Math.sqrt(num / den);
}

describe.skipIf(!has)("benchmark vs GSAS-II good fit — GaNb4Se8 298.8 K", () => {
  it("confirms GSAS-II reaches wR ≈ 7.34% on this data", () => {
    const fit = loadRef().filter((r) => r.yc > 0); // GSAS fit region (0.354–15.86°)
    const gsasWR = wR(fit);
    expect(gsasWR).toBeGreaterThan(6);
    expect(gsasWR).toBeLessThan(9);
    expect(gsasWR).toBeCloseTo(7.34, 1);
  });

  it("measures OUR best wR on identical data with a fixed structure", () => {
    const ref = loadRef();
    const fit = ref.filter((r) => r.yc > 0); // same fit range GSAS used
    const structure = parseCif(readData(CIF), "gns");
    const pattern: PowderPattern = {
      id: "gns",
      name: "GaNb4Se8 298.8K",
      xUnit: "twoTheta",
      radiation: { kind: "xray", wavelength: 0.1665 },
      wavelength: 0.1665,
      points: fit.map((r) => ({ x: r.x, yObs: r.yobs, sigma: r.sig })),
    };
    // Atom positions & ADP FIXED (as GSAS did). Refine scale + cubic cell a
    // (the 100 K model is thermally contracted vs 298.8 K, so the cell must relax
    // for peaks to align) + one pseudo-Voigt width + 7 Chebyshev background terms.
    // This isolates our peak-shape model on a fixed structure — no ADP/position
    // freedom to absorb profile error.
    const a0 = structure.cell.a;
    const profile = { shape: "pseudoVoigt" as const, eta: 0.5, lorentz: false };
    const bindings: ParameterBinding[] = [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
      { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
      { parameterId: "acubic", kind: "cellLength", targetId: structure.id, targetKey: "a" },
      { parameterId: "acubic", kind: "cellLength", targetId: structure.id, targetKey: "b" },
      { parameterId: "acubic", kind: "cellLength", targetId: structure.id, targetKey: "c" },
      ...Array.from({ length: 7 }, (_, k) => ({ parameterId: `bkg${k}`, kind: "background" as const, targetId: pattern.id, targetKey: String(k) })),
    ];
    const unit = powderCurves(structure, pattern, [
      { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false },
      { id: "width", label: "w", kind: "peakWidth", value: 0.02, initialValue: 0.02, fixed: false },
    ], bindings, profile).yCalc;
    const s0 = optimalScale(pattern.points.map((p) => (p.yObs > 0 ? p.yObs : 0)), unit);
    const params: RefinementParameter[] = [
      { id: "scale", label: "scale", kind: "scale", value: s0, initialValue: s0, min: 0, fixed: false },
      { id: "width", label: "width", kind: "peakWidth", value: 0.02, initialValue: 0.02, min: 0.003, max: 0.2, fixed: false },
      { id: "acubic", label: "a", kind: "cellLength", value: a0, initialValue: a0, min: a0 * 0.98, max: a0 * 1.02, fixed: false },
      ...Array.from({ length: 7 }, (_, k) => ({ id: `bkg${k}`, label: `bkg${k}`, kind: "background" as const, value: k === 0 ? 5 : 0, initialValue: k === 0 ? 5 : 0, fixed: false })),
    ];
    const result = refine(buildPowderProblem(structure, pattern, params, bindings, profile), { maxIterations: 40 });
    const refined = params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
    const curves = powderCurves(structure, pattern, refined, bindings, profile);
    const weights = weightsFromSigma(pattern.points.map((p) => p.sigma));
    const agree = computeAgreementFactors(
      Float64Array.from(pattern.points.map((p) => p.yObs)),
      Float64Array.from(curves.yCalc),
      weights,
      params.length,
    );
    const ourWR = 100 * (agree.rWeighted ?? 0);
    // eslint-disable-next-line no-console
    console.log(`BENCHMARK GaNb4Se8 298.8K — GSAS-II wR = 7.34% (TCH pseudo-Voigt) | OUR wR (fixed atoms, single pseudo-Voigt) = ${ourWR.toFixed(2)}%`);
    expect(Number.isFinite(ourWR)).toBe(true);
    // We are worse than GSAS-II: the gap is the peak-shape model (TCH: Gaussian
    // U/V/W + Lorentzian X/Y + SH/L asymmetry), not the structure or background.
    expect(ourWR).toBeGreaterThan(7.34);
  });
});
