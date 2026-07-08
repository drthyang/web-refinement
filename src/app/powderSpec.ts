/**
 * Build the full symmetry-allowed powder refinement parameter set for the UI.
 *
 * Wraps `buildStructureRefinement` (scale, Chebyshev background, symmetry-reduced
 * cell, instrument profile, per-site ADP, symmetry-adapted atomic positions) and
 * seeds the scale from the observed data. Structural parameters (positions, ADP,
 * occupancy, corrections) start *fixed* so the first click of "Refine" does a
 * safe scale/background/cell/profile fit; the user frees them per row or runs the
 * guided (staged) sequence, which unlocks them in the expert order.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import { buildStructureRefinement } from "@/core/workflow/structureRefinement";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { optimalScale } from "@/app/loadData";

/** Kinds held fixed on first load; freed via the table or the guided sequence. */
const STRUCTURAL_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "positionShift", "bIso", "uAniso", "occupancy", "poRatio", "absorption",
]);

/**
 * Occupancies are *shown* (fixed on load) but never freed automatically — not on
 * first load and not by the guided sequence. They correlate strongly with scale
 * and ADP, and a meaningful refinement usually needs a chemically-motivated
 * occupancy-sum restraint the app cannot infer, so the user frees them per row
 * (and adds restraints) deliberately. `guidedPowderParams` unlocks every other
 * structural kind but leaves these alone.
 */
const GUIDED_UNLOCK_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>(
  [...STRUCTURAL_KINDS].filter((k) => k !== "occupancy"),
);

export interface PowderSpec {
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly profile: PowderProfile;
}

export function buildPowderSpec(
  structure: StructureModel,
  pattern: PowderPattern,
  instrument: InstrumentParameters,
  lorentz = true,
  backgroundTerms = 4,
): PowderSpec {
  // Time-of-flight: back-to-back-exponential profile driven by the diffractometer
  // constants (difC/difA/difB) plus α/β/σ shape coefficients. The .instprm here
  // rarely carries the shape coefficients, so seed them: σ scales with difC·Δd
  // (a POWGEN-like resolution), and α/β take moderator-scale (µs) starting
  // values. The profile stage then refines them against the data.
  if (instrument.kind === "tof") {
    const resolution = 0.0015; // Δd/d ballpark → σ_TOF ≈ difC·d·Δd/d
    const tof = {
      difC: instrument.difC,
      difA: instrument.difA ?? 0,
      difB: instrument.difB ?? 0,
      alpha0: 0, alpha1: 1.5,
      beta0: 0.02, beta1: 0,
      sig0: 0, sig1: (instrument.difC * resolution) ** 2, sig2: 0,
    };
    const zero = instrument.zero ?? 0;
    const profile: PowderProfile = { shape: "tof" };
    const seed = buildStructureRefinement(structure, pattern, { scale: 1, backgroundTerms, zero, tof, refineOccupancy: true });
    const seedCurves = powderCurves(structure, pattern, seed.params, seed.bindings, profile);
    const s = optimalScale(seedCurves.yObs.map((y) => (y > 0 ? y : 0)), seedCurves.yCalc);
    const spec = buildStructureRefinement(structure, pattern, { scale: s, backgroundTerms, zero, tof, refineOccupancy: true });
    const params = spec.params.map((p) => (STRUCTURAL_KINDS.has(p.kind) ? { ...p, fixed: true } : p));
    return { params, bindings: spec.bindings, profile };
  }

  const cw = instrument.kind === "constantWavelength" ? instrument : null;
  // A GSAS-II .instprm carries the Caglioti U,V,W → angle-dependent width; else
  // fall back to a single width.
  const caglioti = cw && cw.u !== undefined ? { u: cw.u, v: cw.v ?? 0, w: cw.w ?? 1 } : undefined;
  const zero = cw?.zero ?? 0;
  const profile: PowderProfile = {
    shape: caglioti ? "pseudoVoigt" : "gaussian",
    ...(caglioti ? { eta: 0.5 } : {}),
    lorentz,
  };

  // For a proper CW instrument, refine a Thompson–Cox–Hastings pseudo-Voigt:
  // the Gaussian Caglioti U/V/W plus a Lorentzian size–strain X/Y (seeded small
  // and refined in the profile stage). On real synchrotron data this Lorentzian
  // is the difference between a mediocre fit and a good one (e.g. GaNb4Se8
  // wR ≈ 10% → 5.5%). Only meaningful on a 2θ pattern.
  const profOpt = caglioti ? { caglioti, lorentzian: { x: 1, y: 0 } } : {};
  // Seed the scale from the data with a unit-scale evaluation.
  const seed = buildStructureRefinement(structure, pattern, { scale: 1, backgroundTerms, zero, ...profOpt, refineOccupancy: true });
  const curves = powderCurves(structure, pattern, seed.params, seed.bindings, profile);
  const s = optimalScale(curves.yObs.map((y) => (y > 0 ? y : 0)), curves.yCalc);

  const spec = buildStructureRefinement(structure, pattern, { scale: s, backgroundTerms, zero, ...profOpt, refineOccupancy: true });
  const params = spec.params.map((p) => (STRUCTURAL_KINDS.has(p.kind) ? { ...p, fixed: true } : p));
  return { params, bindings: spec.bindings, profile };
}

/**
 * Guided refinement uses the staged plan to unlock structural rows in the
 * expert order. UI-fixed structural rows must therefore be sent as unlockable,
 * while intentionally fixed profile terms (notably profU when refineU=false)
 * remain fixed. Occupancies are deliberately excluded (see GUIDED_UNLOCK_KINDS):
 * they stay fixed unless the user frees a row by hand.
 */
export function guidedPowderParams(params: readonly RefinementParameter[]): RefinementParameter[] {
  return params.map((p) => (GUIDED_UNLOCK_KINDS.has(p.kind) ? { ...p, fixed: false } : { ...p }));
}
