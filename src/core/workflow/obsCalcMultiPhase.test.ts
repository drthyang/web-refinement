import { describe, it, expect } from "vitest";
import type { PowderPattern } from "@/core/diffraction/types";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { buildMultiPhaseSpec } from "@/app/multiPhaseSpec";
import { multiPhaseCurves } from "@/core/workflow/multiPhase";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";

/**
 * The F_obs/F_calc decomposition must be multi-phase aware: on the two-phase
 * Mn₃Ga + MnO POWGEN pattern the impurity peaks overlap the main phase, and if
 * only the primary phase is decomposed the shared observed intensity is credited
 * wholesale to Mn₃Ga, inflating its F_obs. Passing both phases splits the
 * intensity correctly, so a self-consistent (perfect-fit) pattern lands on the
 * F_obs = F_calc line for BOTH phases.
 */
describe("powderReflectionObsCalc — multi-phase decomposition", () => {
  const { structure, extraPhases, pattern, instrument } = mn3gaPowgenExample();
  const spec = buildMultiPhaseSpec([structure, ...extraPhases], pattern, instrument, 6, {}, "isotropic");
  const phases = [{ structure, id: structure.id }, ...extraPhases.map((s) => ({ structure: s, id: s.id }))];

  // Self-consistent pattern: observed = the real two-phase calculated pattern.
  const curves = multiPhaseCurves(phases, pattern, spec.params, spec.bindings, spec.profile);
  const selfPat: PowderPattern = { ...pattern, points: pattern.points.map((p, i) => ({ ...p, yObs: curves.yCalc[i] ?? 0 })) };

  it("returns reflections tagged for every phase", () => {
    const rows = powderReflectionObsCalc(structure, selfPat, spec.params, spec.bindings, spec.profile, null, null, extraPhases);
    const idx = new Set(rows.map((r) => r.phaseIndex));
    expect(idx.has(0)).toBe(true); // Mn₃Ga
    expect(idx.has(1)).toBe(true); // MnO
    expect(rows.every((r) => r.phaseId !== undefined && r.phaseLabel !== undefined)).toBe(true);
  });

  it("keeps both phases on the F_obs = F_calc line for a perfect fit", () => {
    const rows = powderReflectionObsCalc(structure, selfPat, spec.params, spec.bindings, spec.profile, null, null, extraPhases);
    for (const idx of [0, 1]) {
      const phase = rows.filter((r) => r.phaseIndex === idx);
      const maxCalc = Math.max(...phase.map((r) => r.iCalc));
      const strong = phase.filter((r) => r.iCalc > 0.05 * maxCalc);
      expect(strong.length).toBeGreaterThan(0);
      const worst = strong.reduce((m, r) => Math.max(m, Math.abs(r.iObs / r.iCalc - 1)), 0);
      expect(worst).toBeLessThan(0.1);
    }
  });

  it("single-phase decomposition inflates the primary phase where the impurity overlaps", () => {
    // Same self-consistent (perfect two-phase) pattern, but decomposed against the
    // primary phase only: reflections that overlap an MnO peak absorb its counts,
    // so their F_obs reads high. The multi-phase result must be strictly better.
    const multi = powderReflectionObsCalc(structure, selfPat, spec.params, spec.bindings, spec.profile, null, null, extraPhases)
      .filter((r) => r.phaseIndex === 0);
    const single = powderReflectionObsCalc(structure, selfPat, spec.params, spec.bindings, spec.profile)
      .filter((r) => r.phaseIndex === 0);

    const rms = (rows: typeof multi): number => {
      const strong = rows.filter((r) => r.iCalc > 0.05 * Math.max(...rows.map((q) => q.iCalc)));
      return Math.sqrt(strong.reduce((a, r) => a + (r.iObs / r.iCalc - 1) ** 2, 0) / strong.length);
    };
    const rmsMulti = rms(multi);
    const rmsSingle = rms(single);
    // eslint-disable-next-line no-console
    console.log(`[multiphase] primary-phase RMS |Iobs/Icalc-1| — single=${(rmsSingle * 100).toFixed(1)}%  multi=${(rmsMulti * 100).toFixed(1)}%`);
    expect(rmsMulti).toBeLessThan(rmsSingle);
    expect(rmsMulti).toBeLessThan(0.05);
  });
});
