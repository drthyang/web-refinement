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

/** Structural kinds held fixed on first load; freed via the table or guided. */
const STRUCTURAL_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "positionShift", "bIso", "uAniso", "occupancy", "poRatio", "absorption",
]);

/**
 * Instrument / profile kinds (peak shape, width, zero, TOF calibration + shape).
 * These are held fixed on first load too, so the default "Refine" does *not*
 * touch instrument parameters — a plain scale/background/cell fit. The user frees
 * them per row, or runs the guided sequence, which refines the profile in its
 * expert-order stage.
 */
const INSTRUMENT_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY",
  "asymSL", "asymHL", "zeroShift", "tofCalibration", "tofProfile",
]);

/** Everything the UI holds fixed on load (structural + instrument/profile). */
const FIXED_ON_LOAD_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  ...STRUCTURAL_KINDS,
  ...INSTRUMENT_KINDS,
]);

/**
 * Kinds the guided (staged) sequence is allowed to unlock. It re-frees the
 * structural kinds (except occupancy) and the profile kinds — but keeps
 * `profileU` fixed (the Gaussian U correlates strongly with sample broadening;
 * refined only when explicitly requested) and `tofCalibration` fixed (difC/difA
 * stay at the instrument calibration). This reproduces the previous free set
 * exactly, now that everything starts fixed on load.
 *
 * Occupancies are *shown* (fixed on load) but never freed automatically — not on
 * first load and not by the guided sequence. They correlate strongly with scale
 * and ADP, and a meaningful refinement usually needs a chemically-motivated
 * occupancy-sum restraint the app cannot infer, so the user frees them per row
 * (and adds restraints) deliberately.
 */
const GUIDED_UNLOCK_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  ...[...STRUCTURAL_KINDS].filter((k) => k !== "occupancy"),
  ...[...INSTRUMENT_KINDS].filter((k) => k !== "profileU" && k !== "tofCalibration"),
]);

export interface PowderSpec {
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly profile: PowderProfile;
}

/** Whether atoms sharing a crystallographic site are tied (see structureRefinement). */
export interface SiteTies {
  readonly positions?: boolean;
  readonly adp?: boolean;
  /** Constrain Σ(occupancy) on a shared site to exactly 1 (vs. the starting sum). */
  readonly occupancyToUnity?: boolean;
}

export function buildPowderSpec(
  structure: StructureModel,
  pattern: PowderPattern,
  instrument: InstrumentParameters,
  lorentz = true,
  backgroundTerms = 4,
  ties: SiteTies = {},
): PowderSpec {
  const tieOpts = {
    tieSharedPositions: ties.positions ?? true,
    tieSharedAdp: ties.adp ?? true,
    constrainOccupancyToUnity: ties.occupancyToUnity ?? false,
  };
  // Time-of-flight: back-to-back-exponential profile driven by the diffractometer
  // constants (difC/difA/difB) plus α/β/σ shape coefficients. The .instprm here
  // rarely carries the shape coefficients, so seed them: σ scales with difC·Δd
  // (a POWGEN-like resolution), and α/β take moderator-scale (µs) starting
  // values. The profile stage then refines them against the data.
  // The pattern's unit — not the instrument alone — decides the branch: a TOF
  // pattern with a TOF calibration gets the back-to-back-exponential profile; a
  // 2θ pattern always gets the constant-wavelength profile even if a TOF
  // instrument happens to be loaded (e.g. after "Reset to example").
  if (pattern.xUnit === "tof" && instrument.kind === "tof") {
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
    const seed = buildStructureRefinement(structure, pattern, { scale: 1, backgroundTerms, zero, tof, refineOccupancy: true, ...tieOpts });
    const seedCurves = powderCurves(structure, pattern, seed.params, seed.bindings, profile);
    const s = optimalScale(seedCurves.yObs.map((y) => (y > 0 ? y : 0)), seedCurves.yCalc);
    const spec = buildStructureRefinement(structure, pattern, { scale: s, backgroundTerms, zero, tof, refineOccupancy: true, ...tieOpts });
    const params = spec.params.map((p) => (FIXED_ON_LOAD_KINDS.has(p.kind) ? { ...p, fixed: true } : p));
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
  // the Gaussian Caglioti U/V/W plus a Lorentzian size–strain X/Y. Seed the
  // Lorentzian from the instrument's *calibrated* X/Y when the file carries them
  // (a GSAS .prm/.instprm does) — this is the instrument resolution and is what
  // lets sharp synchrotron peaks fit on load; refined further in the profile
  // stage. Only fall back to X=1 when the file gives no Lorentzian at all.
  // (Seeding 11-BM's real X≈0.17 vs the old placeholder X=1 takes wR 52%→~19%.)
  const profOpt = caglioti ? { caglioti, lorentzian: { x: cw?.x ?? 1, y: cw?.y ?? 0 } } : {};
  // Seed the scale from the data with a unit-scale evaluation.
  const seed = buildStructureRefinement(structure, pattern, { scale: 1, backgroundTerms, zero, ...profOpt, refineOccupancy: true, ...tieOpts });
  const curves = powderCurves(structure, pattern, seed.params, seed.bindings, profile);
  const s = optimalScale(curves.yObs.map((y) => (y > 0 ? y : 0)), curves.yCalc);

  const spec = buildStructureRefinement(structure, pattern, { scale: s, backgroundTerms, zero, ...profOpt, refineOccupancy: true, ...tieOpts });
  const params = spec.params.map((p) => (FIXED_ON_LOAD_KINDS.has(p.kind) ? { ...p, fixed: true } : p));
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
