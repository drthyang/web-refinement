/**
 * Peak-correction registry — the single source of truth for the sample-geometry
 * and intensity corrections applied to a powder pattern's Bragg peaks.
 *
 * Each correction is one self-describing {@link PeakCorrection} descriptor that
 * carries its parameter(s), the geometry it is valid for, whether it is shared
 * across phases, and its forward-model hook (an additive 2θ shift and/or a
 * multiplicative intensity factor). Everything downstream derives from this list:
 *  - `powder.ts` applies the hooks in `placePeaks` (see `correctionsForPattern`),
 *  - `apply.ts` collects bound values into a generic bag keyed by ParameterKind,
 *  - `structureRefinement.ts` emits the parameters + guided "corrections" stage,
 *  - the multi-phase `SHARED_KINDS` and the powder-spec fixed-on-load sets,
 *  - the diagnostics correlation hints.
 *
 * Adding a correction is one descriptor here (+ its ParameterKind and one UI
 * category line), not an edit to a dozen scattered lists.
 *
 * Scope: this registry owns the peak-level *position* and *intensity* corrections
 * — the family that keeps growing (displacement, transparency, roughness,
 * absorption; next microabsorption, Sabine extinction, …). Preferred orientation
 * (baked into the cached |F|²·m·Lp unit intensity), the instrument zero, and
 * single-crystal extinction stay on their own paths; they are not this family.
 */

import type { ParameterKind } from "@/core/refinement/types";
import type { PowderPattern } from "@/core/diffraction/types";
import { cylinderAbsorption, surfaceRoughness } from "@/core/diffraction/intensity";

/** Bound correction-parameter values, keyed by ParameterKind (absent ⇒ identity). */
export type CorrectionValues = Partial<Record<ParameterKind, number>>;

/** One refinable parameter of a correction. */
export interface CorrectionParamSpec {
  /** Emitted RefinementParameter id. */
  readonly id: string;
  readonly label: string;
  readonly kind: ParameterKind;
  /** Default seed when the correction is enabled (its non-identity starting value). */
  readonly seed: number;
  readonly min?: number;
  readonly max?: number;
}

/** A correlation hint between two parameter kinds, for the fit diagnostics. */
export interface CorrelationPair {
  readonly a: ParameterKind;
  readonly b: ParameterKind;
  readonly message: string;
}

const RAD = Math.PI / 180;
/** Constant-wavelength 2θ pattern (the reflection/CW geometry these corrections need). */
const isCW = (p: PowderPattern): boolean => p.xUnit === "twoTheta" && p.radiation.kind !== "neutron-tof";

export interface PeakCorrection {
  /** Stable id used by callers to request the correction (e.g. "displacement"). */
  readonly id: string;
  /** Shared across phases (one sample/instrument) vs. per-phase, for multi-phase routing. */
  readonly shared: boolean;
  readonly params: readonly CorrectionParamSpec[];
  /** Geometry gate: emitted and applied only for patterns this returns true for. */
  appliesTo(pattern: PowderPattern): boolean;
  /** Whether the current values are a non-identity (non-no-op) — lets the loop skip. */
  active(v: CorrectionValues): boolean;
  /** Additive shift (degrees) applied to a peak's 2θ at its Bragg angle. */
  positionShift?(v: CorrectionValues, twoTheta: number): number;
  /** Multiplicative intensity factor at a peak's 2θ (returns 1 at identity). */
  intensityFactor?(v: CorrectionValues, twoTheta: number): number;
  readonly correlations?: readonly CorrelationPair[];
}

const DISPLACEMENT_MESSAGE =
  "Zero (constant), displacement (∝cosθ) and transparency (∝sin2θ) are the three peak-position corrections; over a narrow 2θ range they are near-degenerate. Free at most one or two, and only with wide angular coverage.";

const displacement: PeakCorrection = {
  id: "displacement",
  shared: true,
  params: [{ id: "sampleDispl", label: "sample displ. (°·cosθ)", kind: "sampleDisplacement", seed: 0, min: -2, max: 2 }],
  appliesTo: isCW,
  active: (v) => (v.sampleDisplacement ?? 0) !== 0,
  positionShift: (v, twoTheta) => (v.sampleDisplacement ?? 0) * Math.cos((twoTheta / 2) * RAD),
  correlations: [
    { a: "cellLength", b: "sampleDisplacement", message: "Sample displacement (∝cosθ) and the cell both move peak positions and separate only over a wide 2θ range. Fix the displacement from a standard, or free it after the cell is stable." },
    { a: "zeroShift", b: "sampleDisplacement", message: DISPLACEMENT_MESSAGE },
    { a: "sampleDisplacement", b: "sampleTransparency", message: DISPLACEMENT_MESSAGE },
  ],
};

const transparency: PeakCorrection = {
  id: "transparency",
  shared: true,
  params: [{ id: "sampleTransp", label: "transparency (°·sin2θ)", kind: "sampleTransparency", seed: 0, min: -2, max: 2 }],
  appliesTo: isCW,
  active: (v) => (v.sampleTransparency ?? 0) !== 0,
  positionShift: (v, twoTheta) => (v.sampleTransparency ?? 0) * Math.sin(2 * ((twoTheta / 2) * RAD)),
};

const absorption: PeakCorrection = {
  id: "absorption",
  // Kept per-phase to preserve prior behaviour (absorption was not in SHARED_KINDS).
  shared: false,
  params: [{ id: "absorption", label: "μR", kind: "absorption", seed: 0, min: 0, max: 10 }],
  appliesTo: (p) => p.xUnit === "twoTheta",
  active: (v) => (v.absorption ?? 0) > 0,
  intensityFactor: (v, twoTheta) => cylinderAbsorption(v.absorption ?? 0, twoTheta),
};

const roughness: PeakCorrection = {
  id: "roughness",
  shared: true,
  params: [
    { id: "surfRoughA", label: "roughness SRA", kind: "surfaceRoughA", seed: 0.9, min: 0, max: 1 },
    { id: "surfRoughB", label: "roughness SRB", kind: "surfaceRoughB", seed: 0.1, min: 0, max: 5 },
  ],
  appliesTo: isCW,
  active: (v) => (v.surfaceRoughA ?? 1) < 1 && (v.surfaceRoughB ?? 0) > 0,
  intensityFactor: (v, twoTheta) => surfaceRoughness(v.surfaceRoughA ?? 1, v.surfaceRoughB ?? 0, twoTheta),
  correlations: [
    { a: "surfaceRoughA", b: "surfaceRoughB", message: "The Suortti roughness SRA/SRB are strongly correlated — together they set one low-angle intensity ramp, and near the no-roughness limit (SRA→1 or SRB→0) both derivatives vanish. Free them only when a real low-angle intensity deficit is present, and expect one of the two to be poorly determined." },
    { a: "surfaceRoughB", b: "scale", message: "Surface roughness suppresses low-angle intensity, which the scale and background also absorb. Refine roughness after the scale, background and cell are stable, on data with real low-angle reflections." },
    { a: "surfaceRoughB", b: "background", message: "Surface roughness suppresses low-angle intensity, which the scale and background also absorb. Refine roughness after the scale, background and cell are stable, on data with real low-angle reflections." },
  ],
};

/**
 * The registry, in application order. The order is load-bearing for bit-identical
 * results: position shifts accumulate as displacement + transparency, and
 * intensity factors multiply as absorption × roughness — the exact order the
 * hand-written code used before this registry existed.
 */
export const PEAK_CORRECTIONS: readonly PeakCorrection[] = [displacement, transparency, absorption, roughness];

/** All ParameterKinds owned by the registry (a correction may own several). */
export const CORRECTION_KINDS: readonly ParameterKind[] = PEAK_CORRECTIONS.flatMap((c) => c.params.map((p) => p.kind));
const CORRECTION_KIND_SET: ReadonlySet<ParameterKind> = new Set(CORRECTION_KINDS);
/** Correction kinds that are shared across phases (sample/instrument properties). */
export const SHARED_CORRECTION_KINDS: readonly ParameterKind[] = PEAK_CORRECTIONS
  .filter((c) => c.shared)
  .flatMap((c) => c.params.map((p) => p.kind));
const BY_ID: Readonly<Record<string, PeakCorrection>> = Object.fromEntries(PEAK_CORRECTIONS.map((c) => [c.id, c]));

/** Whether a ParameterKind is owned by the correction registry. */
export function isCorrectionKind(kind: ParameterKind): boolean {
  return CORRECTION_KIND_SET.has(kind);
}

/** Look up a correction descriptor by its request id. */
export function correctionById(id: string): PeakCorrection | undefined {
  return BY_ID[id];
}

/** The pattern-applicable corrections, split by how they enter the forward model. */
export interface PatternCorrections {
  /** Position corrections (2θ shifts), in registry order. */
  readonly positional: readonly PeakCorrection[];
  /** Intensity corrections (multiplicative), in registry order. */
  readonly intensity: readonly PeakCorrection[];
  /** Whether any position correction is currently non-identity (else the loop skips them). */
  readonly anyPositional: boolean;
}

/** Resolve which corrections apply to `pattern`, given the bound values `v`. */
export function correctionsForPattern(pattern: PowderPattern, v: CorrectionValues): PatternCorrections {
  const applicable = PEAK_CORRECTIONS.filter((c) => c.appliesTo(pattern));
  const positional = applicable.filter((c) => c.positionShift);
  return {
    positional,
    intensity: applicable.filter((c) => c.intensityFactor),
    anyPositional: positional.some((c) => c.active(v)),
  };
}

/** A correlation message for an unordered pair of kinds, if any correction owns it. */
export function correctionCorrelation(a: ParameterKind, b: ParameterKind): string | undefined {
  for (const c of PEAK_CORRECTIONS) {
    for (const pair of c.correlations ?? []) {
      if ((pair.a === a && pair.b === b) || (pair.a === b && pair.b === a)) return pair.message;
    }
  }
  return undefined;
}

/** A caller's request to emit a correction's parameters (see structureRefinement). */
export interface CorrectionRequest {
  /** Descriptor id, e.g. "displacement" | "transparency" | "absorption" | "roughness". */
  readonly id: string;
  /** Free the parameters (default true); false emits them fixed. */
  readonly refine?: boolean;
  /** Seed overrides keyed by ParameterKind; absent kinds use the descriptor default. */
  readonly seeds?: Partial<Record<ParameterKind, number>>;
}
