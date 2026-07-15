import { describe, it, expect } from "vitest";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { loadedSession } from "@/app/powderSession";
import { multiPhaseCurves } from "@/core/workflow/multiPhase";
import {
  buildMagneticPowderProblem,
  magneticPowderComponents,
  magneticComponentCurve,
  magneticPhaseBindings,
} from "@/core/workflow/magneticPowder";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";
import { applyParameters } from "@/core/workflow/apply";
import { computeAgreementFactors, weightsFromSigma } from "@/core/refinement/factors";
import { detectExtraPeaks } from "@/core/magnetic/extraPeaks";
import type { RefinementParameter, ParameterBinding } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";

/**
 * Regression: on a multi-phase session, every magnetic code path must route
 * bindings per phase. The bundled Mn₃Ga + MnO demo is the canonical trap: the
 * MnO bindings come after the primary's, so an unrouted apply grafts MnO's
 * cubic cell (p1_cell_a → a, b AND c), scale, and same-labelled "Mn1" B/occ
 * onto the primary — the magnetic page then fits moments against a nuclear
 * pattern indexed on the impurity's lattice ("the MnO index is wrong").
 */
describe("magnetic powder problem — multi-phase routing (Mn₃Ga + MnO demo)", () => {
  const ex = mn3gaPowgenExample();
  const s = loadedSession(ex.structure, ex.pattern, ex.instrument, ex.extraPhases, ex.refinedParams);
  const extra = s.extraPhases.map((ph) => ({ structure: ph, id: ph.id }));
  const phases = [{ structure: s.structure, id: s.structure.id }, ...extra];
  const values: Record<string, number> = Object.fromEntries(s.powderParams.map((p) => [p.id, p.value]));
  const profile = {
    shape: s.powderProfile.shape,
    ...(s.powderProfile.eta !== undefined ? { eta: s.powderProfile.eta } : {}),
  };
  // A zero-moment magnetic model on the primary: the magnetic component is
  // exactly zero, so the combined problem must reproduce the plain two-phase
  // nuclear pattern point for point.
  const magnetic: MagneticModel = {
    id: "mn3ga-mag",
    structureId: s.structure.id,
    propagation: [[0, 0, 0]],
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: [0, 0, 0], formFactorId: "Mn2" }],
  };

  it("magneticPhaseBindings keeps the primary's own cell/scale, not MnO's", () => {
    const applied = applyParameters(s.structure, magneticPhaseBindings(s.powderBindings, s.structure.id), values);
    // Refined hexagonal Mn₃Ga cell — an unrouted apply would leave a = b = c =
    // 4.4561 (MnO's cubic constraint written across all three lengths).
    expect(applied.model.cell.a).toBeCloseTo(5.41964, 4);
    expect(applied.model.cell.c).toBeCloseTo(4.37366, 4);
    expect(applied.scale).toBeCloseTo(1.35813, 4);
    // MnO's own B/occ for the colliding "Mn1" label must not leak in.
    const mn1 = applied.model.sites.find((site) => site.label === "Mn1")!;
    expect(mn1.adp.kind === "isotropic" ? mn1.adp.bIso : NaN).toBeCloseTo(1.13887, 4);
  });

  it("the magnetic problem reproduces the two-phase nuclear pattern (zero moments)", () => {
    const problem = buildMagneticPowderProblem(
      s.structure, magnetic, s.pattern, s.powderParams, s.powderBindings, profile, undefined, extra,
    );
    const yCalc = problem.calculate(values);
    const expected = multiPhaseCurves(phases, s.pattern, s.powderParams, s.powderBindings, s.powderProfile).yCalc;
    const top = Math.max(...expected);
    let worst = 0;
    for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(yCalc[i]! - expected[i]!));
    expect(worst).toBeLessThan(1e-6 * top);
  });

  it("wR of the magnetic problem sits at the converged two-phase level", () => {
    const problem = buildMagneticPowderProblem(
      s.structure, magnetic, s.pattern, s.powderParams, s.powderBindings, profile, undefined, extra,
    );
    const yCalc = problem.calculate(values);
    const yObs = Float64Array.from(s.pattern.points.map((p) => p.yObs));
    const weights = weightsFromSigma(s.pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1)));
    const a = computeAgreementFactors(yObs, yCalc, weights, s.powderParams.length);
    // Converged demo ≈ 3.9 %; the corrupted (unrouted) model gave ≈ 17 %.
    expect(100 * (a.rWeighted ?? 1)).toBeLessThan(5);
  });

  it("magneticPowderComponents includes the impurity peaks in yNuclear", () => {
    const comp = magneticPowderComponents(
      s.structure, magnetic, s.pattern, s.powderParams, s.powderBindings, profile, extra,
    );
    const expected = multiPhaseCurves(phases, s.pattern, s.powderParams, s.powderBindings, s.powderProfile).yCalc;
    const top = Math.max(...expected);
    let worst = 0;
    for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(comp.yCalc[i]! - expected[i]!));
    expect(worst).toBeLessThan(1e-6 * top);
    expect(Math.max(...comp.yMagnetic.map(Math.abs))).toBe(0);
  });

  it("magneticComponentCurve matches the components' yMagnetic (multi-phase routing)", () => {
    const ordered: MagneticModel = { ...magnetic, moments: [{ ...magnetic.moments[0]!, components: [0, 0, 2] }] };
    const curve = magneticComponentCurve(s.structure, ordered, s.pattern, s.powderParams, s.powderBindings, profile, extra);
    const comp = magneticPowderComponents(s.structure, ordered, s.pattern, s.powderParams, s.powderBindings, profile, extra);
    expect(Math.max(...curve)).toBeGreaterThan(0);
    let worst = 0;
    for (let i = 0; i < curve.length; i++) worst = Math.max(worst, Math.abs(curve[i]! - comp.yMagnetic[i]!));
    expect(worst).toBeLessThan(1e-9 * Math.max(...curve));
  });

  it("obsCalc applies live moment parameters in multi-phase mode", () => {
    // A momentMode binding targets the derived "<id>-mag" model id — plain
    // per-phase routing would drop it and freeze the decomposition at the
    // baked moments.
    const momParam: RefinementParameter = { id: "momM", label: "M", kind: "momentMode", value: 2, initialValue: 2, min: -12, max: 12, fixed: false };
    const momBinding: ParameterBinding = { parameterId: "momM", kind: "momentMode", targetId: `${s.structure.id}-mag`, targetKey: "Mn1", momentBasis: [0, 0, 1] };
    const magneticIntensity = (value: number): number => {
      const rows = powderReflectionObsCalc(
        s.structure, s.pattern, [...s.powderParams, { ...momParam, value }], [...s.powderBindings, momBinding],
        s.powderProfile, magnetic, null, s.extraPhases,
      );
      return rows.filter((r) => r.kind === "magnetic").reduce((sum, r) => sum + r.iCalc, 0);
    };
    const at2 = magneticIntensity(2);
    const at1 = magneticIntensity(1);
    expect(at2).toBeGreaterThan(0);
    // |F_M|² scales as the moment squared: doubling the amplitude ≈ ×4.
    expect(at2 / at1).toBeGreaterThan(3.5);
    expect(at2 / at1).toBeLessThan(4.5);
  });

  it("σ-aware residual peak detection stays quiet on the converged fit", () => {
    const curves = multiPhaseCurves(phases, s.pattern, s.powderParams, s.powderBindings, s.powderProfile);
    // TOF → d via the demo's difC (zero offset is negligible for this check).
    const dArr = curves.x.map((x) => x / 22585.8);
    const pointSigma = s.pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1));
    const loose = detectExtraPeaks(dArr, curves.yObs, curves.yCalc);
    const strict = detectExtraPeaks(dArr, curves.yObs, curves.yCalc, { pointSigma });
    expect(strict.length).toBeLessThanOrEqual(loose.length);
    // The converged two-phase fit has no magnetic satellites: the detector
    // should report at most a handful of profile-misfit shoulders, not a
    // pattern-wide spray of counting-noise "peaks".
    expect(strict.length).toBeLessThanOrEqual(8);
  });
});
