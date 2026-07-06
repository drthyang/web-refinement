import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseCif } from "@/parsers/cif";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { refine } from "@/core/refinement/engine";
import { computeAgreementFactors, weightsFromSigma, excludedPointMask, applyExclusionMask } from "@/core/refinement/factors";
import { optimalScale } from "@/app/loadData";
import { dataExists, readData } from "@/testSupport/data";

/**
 * Real synchrotron XRD from NSLS-II 28ID: GaNb4Se8, F-4̄3m, a≈10.4 Å, 96 ops,
 * a Q-axis pattern (0.009–16.3 Å⁻¹) with 227 masked points, and a 100 K model
 * refined against 298.8 K data (so the cell is genuinely wrong at the start).
 *
 * Unlike the self-consistent synthetic demo, this cannot converge to wR≈0 — it's
 * a real regression harness for engine robustness (no divergence), the reflection
 * caching (speed), X-ray form factors, Q handling, masking, and the Chebyshev
 * background. Skips when the git-ignored data/ folder is absent.
 */

const CIF = "GaNb4Se8_XRD_28ID/GaNb4Se8_100K.cif";
const DAT = "GaNb4Se8_XRD_28ID/GaNb4Se8_799_T_298.8K_gsas.dat";
const has = dataExists(CIF) && dataExists(DAT);

function loadPattern(): { structure: ReturnType<typeof parseCif>; pattern: PowderPattern } {
  const structure = parseCif(readData(CIF), "gns");
  const rows = readData(DAT).trim().split(/\r?\n/).map((l) => l.split(",").map(Number));
  const points = rows
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]))
    .map(([x, i]) => ({ x: x!, yObs: i!, sigma: i! > 0 ? Math.sqrt(i!) + 1 : 1 }));
  // The GSAS .dat abscissa is 2θ in degrees (short synchrotron wavelength ≈
  // 0.166 Å): the observed peaks index on F-4̄3m a≈10.4 as (111) at 1.585°,
  // (400) at 3.662°, etc. — NOT Q. Treating it as Q collapses the scale to 0.
  const pattern: PowderPattern = {
    id: "gns-powder", name: "GaNb4Se8", xUnit: "twoTheta",
    radiation: { kind: "xray", wavelength: 0.166 }, wavelength: 0.166, points,
  };
  return { structure, pattern };
}

// Pre-reduced synchrotron I(Q) is already Lorentz-corrected; sharper peaks fit a
// pseudo-Voigt. (Confirmed: Lorentz-on wR≈53%, Lorentz-off wR≈40%.)
const PROFILE = { shape: "pseudoVoigt" as const, eta: 0.5, lorentz: false };

// scale (auto) + cubic a (a=b=c) + Chebyshev background + width + per-site B.
function buildParamsAndBindings(structure: ReturnType<typeof parseCif>, pattern: PowderPattern) {
  const bindings: ParameterBinding[] = [
    { parameterId: "scale", kind: "scale", targetId: pattern.id },
    { parameterId: "width", kind: "peakWidth", targetId: pattern.id },
    { parameterId: "acubic", kind: "cellLength", targetId: structure.id, targetKey: "a" },
    { parameterId: "acubic", kind: "cellLength", targetId: structure.id, targetKey: "b" },
    { parameterId: "acubic", kind: "cellLength", targetId: structure.id, targetKey: "c" },
    { parameterId: "bkg0", kind: "background", targetId: pattern.id, targetKey: "0" },
    { parameterId: "bkg1", kind: "background", targetId: pattern.id, targetKey: "1" },
    { parameterId: "bkg2", kind: "background", targetId: pattern.id, targetKey: "2" },
    { parameterId: "bkg3", kind: "background", targetId: pattern.id, targetKey: "3" },
  ];
  const a0 = structure.cell.a;
  const unit = powderCurves(structure, pattern, [
    { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false },
    { id: "width", label: "w", kind: "peakWidth", value: 0.03, initialValue: 0.03, fixed: false },
  ], bindings, PROFILE).yCalc;
  const s0 = optimalScale(pattern.points.map((p) => (p.yObs > 0 ? p.yObs : 0)), unit);
  const params: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: s0, initialValue: s0, min: 0, fixed: false },
    { id: "width", label: "width", kind: "peakWidth", value: 0.03, initialValue: 0.03, min: 0.005, fixed: false },
    { id: "acubic", label: "a", kind: "cellLength", value: a0, initialValue: a0, min: a0 * 0.95, max: a0 * 1.05, fixed: false },
    { id: "bkg0", label: "bkg0", kind: "background", value: 5, initialValue: 5, fixed: false },
    { id: "bkg1", label: "bkg1", kind: "background", value: 0, initialValue: 0, fixed: false },
    { id: "bkg2", label: "bkg2", kind: "background", value: 0, initialValue: 0, fixed: false },
    { id: "bkg3", label: "bkg3", kind: "background", value: 0, initialValue: 0, fixed: false },
  ];
  for (const site of structure.sites) {
    params.push({ id: `B_${site.label}`, label: `${site.label} B`, kind: "bIso", value: 0.3, initialValue: 0.3, min: 0, max: 8, fixed: false });
    bindings.push({ parameterId: `B_${site.label}`, kind: "bIso", targetId: structure.id, targetKey: site.label });
  }
  return { params, bindings };
}

function wRof(structure: ReturnType<typeof parseCif>, pattern: PowderPattern, params: RefinementParameter[], bindings: ParameterBinding[]): number {
  const curves = powderCurves(structure, pattern, params, bindings, PROFILE);
  const yObs = pattern.points.map((p) => p.yObs);
  const weights = applyExclusionMask(
    weightsFromSigma(pattern.points.map((p) => p.sigma)),
    excludedPointMask(yObs),
  );
  const a = computeAgreementFactors(Float64Array.from(yObs), Float64Array.from(curves.yCalc), weights, params.length);
  return 100 * (a.rWeighted ?? 0);
}

describe.skipIf(!has)("real powder XRD — GaNb4Se8 (NSLS-II 28ID synchrotron)", () => {
  it("loads as X-ray 2θ-data on a large F-4̄3m cell with masked points", () => {
    const { structure, pattern } = loadPattern();
    expect(structure.spaceGroup.operations.length).toBe(96);
    expect(structure.cell.a).toBeCloseTo(10.3951, 3);
    expect(pattern.points.length).toBeGreaterThan(3000);
    expect(excludedPointMask(pattern.points.map((p) => p.yObs)).filter(Boolean).length).toBeGreaterThan(100);
  });

  it("achieves a successful Rietveld refinement: peaks participate, wR drops to a good value", () => {
    const { structure, pattern } = loadPattern();
    const { params, bindings } = buildParamsAndBindings(structure, pattern);

    const wRstart = wRof(structure, pattern, params, bindings);
    const t0 = Date.now();
    const result = refine(buildPowderProblem(structure, pattern, params, bindings, PROFILE), { maxIterations: 60 });
    const elapsed = Date.now() - t0;
    const refined = params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
    const wRend = wRof(structure, pattern, refined, bindings);

    // Robustness: no divergence; every refined parameter finite.
    expect(["converged", "stalled", "maxIterations"]).toContain(result.status);
    expect(params.every((p) => Number.isFinite(result.parameters[p.id]!))).toBe(true);
    // Success: the Bragg peaks are actually fit — the scale does NOT collapse to
    // zero (the failure mode when the abscissa is mis-identified as Q), and the
    // weighted profile R reaches a genuinely fitted level.
    expect(result.parameters.scale!).toBeGreaterThan(0);
    expect(wRend).toBeLessThan(50);
    expect(wRend).toBeLessThan(wRstart - 20);
    // Refined cubic cell stays physical and near the reported value.
    expect(result.parameters.acubic!).toBeGreaterThan(10.2);
    expect(result.parameters.acubic!).toBeLessThan(10.6);
    // Speed guard (reflection caching): dense big-cell refinement in seconds.
    expect(elapsed).toBeLessThan(8000);
    // Remaining gap to <15% is profile (Caglioti U,V,W), zero-shift, and
    // anisotropic ADP — the roadmap's next items.
    console.log(`GaNb4Se8: wR ${wRstart.toFixed(1)}% → ${wRend.toFixed(1)}% · a=${result.parameters.acubic!.toFixed(4)} · scale=${result.parameters.scale!.toExponential(2)} · ${result.status} · ${elapsed} ms`);
  });
});
