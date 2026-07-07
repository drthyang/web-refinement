import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { parseCif } from "@/parsers/cif";
import { buildPowderProblem, powderCurves } from "@/core/workflow/powder";
import { buildStructureRefinement, refinePowderStructure } from "@/core/workflow/structureRefinement";
import { allowedAnisotropicAdpModes } from "@/core/crystal/adpConstraints";
import { refine } from "@/core/refinement/engine";
import { computeAgreementFactors, weightsFromSigma, excludedPointMask, applyExclusionMask } from "@/core/refinement/factors";
import { parseInstrumentParameters } from "@/parsers/instrument";
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

const DIR = "GaNb4Se8_XRD_28ID";
const CIF = `${DIR}/GaNb4Se8_100K.cif`;
const DAT = `${DIR}/GaNb4Se8_799_T_298.8K_gsas.dat`;
const INSTPRM = `${DIR}/xrd_instrum.instprm`;
const has = dataExists(CIF) && dataExists(DAT);
const requiresGaNb4Se8 = process.env.GANB4SE8_REQUIRED === "1";
if (requiresGaNb4Se8 && !has) {
  throw new Error(
    `GaNb4Se8 regression data is required. Expected data/${CIF} and data/${DAT}.`,
  );
}

/** Instrument parameters from the GSAS-II `.instprm` (wavelength, zero, U,V,W). */
function loadInstrument(): Extract<ReturnType<typeof parseInstrumentParameters>, { kind: "constantWavelength" }> {
  const inst = parseInstrumentParameters(readData(INSTPRM));
  if (inst.kind !== "constantWavelength") throw new Error("expected CW instrument");
  return inst;
}

function loadPattern(): { structure: ReturnType<typeof parseCif>; pattern: PowderPattern } {
  const structure = parseCif(readData(CIF), "gns");
  const wl = dataExists(INSTPRM) ? loadInstrument().wavelength : 0.1665;
  const rows = readData(DAT).trim().split(/\r?\n/).map((l) => l.split(",").map(Number));
  const points = rows
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]))
    .map(([x, i]) => ({ x: x!, yObs: i!, sigma: i! > 0 ? Math.sqrt(i!) + 1 : 1 }));
  // The GSAS .dat abscissa is 2θ in degrees (short synchrotron wavelength ≈
  // 0.1665 Å): the observed peaks index on F-4̄3m a≈10.4 as (111) at 1.585°,
  // (400) at 3.662°, etc. — NOT Q. Treating it as Q collapses the scale to 0.
  const pattern: PowderPattern = {
    id: "gns-powder", name: "GaNb4Se8", xUnit: "twoTheta",
    radiation: { kind: "xray", wavelength: wl }, wavelength: wl, points,
  };
  return { structure, pattern };
}

// This is a raw 2θ histogram (GSAS applies Lorentz-polarization), so Lorentz is
// ON. The earlier "Lorentz-off is better" was an artifact of a structure-factor
// bug (special positions over-counted); with |F|² correct, Lorentz-on is right.
const PROFILE = { shape: "pseudoVoigt" as const, eta: 0.5, lorentz: true };

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
    if (site.adp.kind === "isotropic") {
      params.push({ id: `B_${site.label}`, label: `${site.label} B`, kind: "bIso", value: 0.3, initialValue: 0.3, min: 0, max: 8, fixed: false });
      bindings.push({ parameterId: `B_${site.label}`, kind: "bIso", targetId: structure.id, targetKey: site.label });
    } else {
      const modes = allowedAnisotropicAdpModes(structure.spaceGroup.operations, site.position, site.adp.uAniso);
      modes.modes.forEach((mode, i) => {
        const id = `U_${site.label}_${i}`;
        params.push({ id, label: `${site.label} ${mode.label}`, kind: "uAniso", value: mode.coefficient, initialValue: mode.coefficient, min: mode.diagonal ? 0 : -0.02, max: mode.diagonal ? 0.2 : 0.02, fixed: false });
        bindings.push({ parameterId: id, kind: "uAniso", targetId: structure.id, targetKey: site.label, uBasis: mode.basis });
      });
    }
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
    const nb = structure.sites.find((s) => s.label === "Nb1")!;
    expect(nb.adp.kind).toBe("anisotropic");
    if (nb.adp.kind === "anisotropic") {
      expect(nb.adp.uAniso[0]).toBeCloseTo(0.00226, 5);
      expect(nb.adp.uAniso[3]).toBeCloseTo(0.00037, 5);
    }
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

  it("staged structure refinement: instrument profile, ADPs, and symmetry positions", () => {
    const { structure, pattern } = loadPattern();
    const inst = loadInstrument();

    // Full structure refinement seeded from the real .instprm: the Caglioti
    // profile (U fixed, V/W refined to absorb sample broadening), zero shift,
    // per-site B, and symmetry-adapted positions — unlocked by the staged driver
    // (scale → background → cell → profile → ADP → positions). Raw 2θ histogram ⇒
    // Lorentz on (correct once the structure-factor special-position fix landed).
    const CWPROFILE = { shape: "pseudoVoigt" as const, eta: 0.5, lorentz: true };
    const spec = buildStructureRefinement(structure, pattern, {
      scale: 1, backgroundTerms: 10, startB: 0.3, refineAdp: true, refinePositions: true,
      caglioti: { u: inst.u ?? 0, v: inst.v ?? 0, w: inst.w ?? 1 }, zero: inst.zero ?? 0,
    });
    const agree = (params: typeof spec.params) => {
      const curves = powderCurves(structure, pattern, params, spec.bindings, CWPROFILE);
      const yObs = pattern.points.map((p) => p.yObs);
      const w = applyExclusionMask(weightsFromSigma(pattern.points.map((p) => p.sigma)), excludedPointMask(yObs));
      return computeAgreementFactors(Float64Array.from(yObs), Float64Array.from(curves.yCalc), w, params.length);
    };

    const wRstart = 100 * (agree(spec.params).rWeighted ?? 0);
    const t0 = Date.now();
    const out = refinePowderStructure(structure, pattern, spec, CWPROFILE, { maxIterations: 30 });
    const elapsed = Date.now() - t0;
    const af = agree(out.parameters);
    const wRend = 100 * (af.rWeighted ?? 0);

    const get = (id: string) => out.parameters.find((p) => p.id === id)!;
    // Robustness: everything finite, scale did not collapse, cell physical.
    expect(out.parameters.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(get("scale").value).toBeGreaterThan(0);
    const cellA = out.parameters.find((p) => p.kind === "cellLength")!;
    expect(cellA.value).toBeGreaterThan(10.2);
    expect(cellA.value).toBeLessThan(10.6);

    // Instrument profile refined: V/W move to absorb sample broadening; U stayed
    // fixed at the instrument value (degenerate over this narrow 2θ range).
    expect(get("profU").value).toBeCloseTo(inst.u ?? 0, 6);
    expect(get("profW").value).not.toBeCloseTo(inst.w ?? 1, 3);

    // Per-site ADPs refined to finite values: isotropic B for Uiso sites and
    // symmetry-adapted U tensor modes for the Nb Uani site.
    const bs = out.parameters.filter((p) => p.kind === "bIso");
    expect(bs.length).toBe(structure.sites.filter((s) => s.adp.kind === "isotropic").length);
    expect(bs.every((p) => p.value >= 0 && Number.isFinite(p.value))).toBe(true);
    const us = out.parameters.filter((p) => p.kind === "uAniso");
    expect(us.length).toBe(2);
    expect(us.every((p) => Number.isFinite(p.value))).toBe(true);

    // All three general (x,x,x) sites contribute a positional mode; the fixed
    // (3/4,3/4,3/4) site contributes none. (Regression on the coord>0.5 bug that
    // over-fixed Se17 at (0.8845,0.8845,0.8845).)
    const posModes = out.parameters.filter((p) => p.kind === "positionShift");
    expect(posModes.length).toBe(3);

    // Quality: big drop from the seed; genuinely fitted. The residual floor here
    // is a specific-hkl intensity deficit (the strongest low-angle reflection is
    // under-predicted ~3× — preferred orientation / absorption), not the profile
    // or ADPs; the high-angle region already fits ~14%.
    expect(wRend).toBeLessThan(wRstart);
    expect(wRend).toBeLessThan(40);
    expect(elapsed).toBeLessThan(15000);
    console.log(`GaNb4Se8 staged: wR ${wRstart.toFixed(1)}%→${wRend.toFixed(1)}% · Rp=${(100 * af.rFactor).toFixed(1)}% Rexp=${(100 * (af.rExpected ?? 0)).toFixed(1)}% GoF=${af.goodnessOfFit?.toFixed(1)} · ${posModes.length} pos modes · ${us.length} Uani modes · W ${(inst.w ?? 0).toFixed(2)}→${get("profW").value.toFixed(2)} · ${elapsed}ms`);
  });

  it("restrained occupancy refinement stays chemically plausible on real data", () => {
    const { structure, pattern } = loadPattern();
    const inst = loadInstrument();
    const CWPROFILE = { shape: "pseudoVoigt" as const, eta: 0.5, lorentz: false };
    const spec = buildStructureRefinement(structure, pattern, {
      scale: 1,
      backgroundTerms: 10,
      startB: 0.3,
      refineAdp: true,
      refinePositions: true,
      refineOccupancy: true,
      occupancyRestraints: structure.sites.map((s) => ({
        id: `occ_${s.label}_prior`,
        sites: [{ label: s.label, coefficient: 1 }],
        target: 1,
        sigma: 0.001,
      })),
      caglioti: { u: inst.u ?? 0, v: inst.v ?? 0, w: inst.w ?? 1 },
      zero: inst.zero ?? 0,
    });
    const t0 = Date.now();
    const out = refinePowderStructure(structure, pattern, spec, CWPROFILE, { maxIterations: 30 });
    const elapsed = Date.now() - t0;
    const occ = out.parameters.filter((p) => p.kind === "occupancy");

    expect(occ.length).toBe(structure.sites.length);
    expect(occ.every((p) => p.value > 0.85 && p.value <= 1)).toBe(true);
    expect(out.parameters.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(elapsed).toBeLessThan(20000);
    console.log(`GaNb4Se8 restrained occupancy: ${occ.map((p) => `${p.id}=${p.value.toFixed(3)}`).join(" ")} · ${elapsed}ms`);
  });
});
