/**
 * The powder session model: one loaded structure (+ optional extra phases and a
 * magnetic model), the observed pattern, and the refinement parameter set built
 * for them. Shared between the app shell (whose data loaders create/replace
 * sessions) and the PowderWorkbench engine (whose controls rebuild the spec).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { MagneticModel } from "@/core/magnetic/types";
import { buildPowderSpec, type SiteTies, type PowderSpec, type MustrainModel } from "@/app/powderSpec";
import { buildMultiPhaseSpec } from "@/app/multiPhaseSpec";
import { buildSyntheticPowder } from "@/examples/synthetic";

export const DEFAULT_INSTRUMENT: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };
export const DEFAULT_BACKGROUND_TERMS = 4;
export const DEFAULT_TIES: SiteTies = { positions: true, adp: true };
export const SYNTHETIC_SOURCE = "synthetic (self-consistent demo)";

export interface Session {
  structure: StructureModel;
  /** Additional crystallographic phases (multi-phase refinement). `structure` is
   *  phase 0; each extra phase adds its own scale/cell/atoms, sharing the
   *  instrument profile. Empty for a single-phase refinement. */
  extraPhases: StructureModel[];
  pattern: PowderPattern;
  powderParams: RefinementParameter[];
  /** Bindings that map the powder parameters onto the model (from buildPowderSpec). */
  powderBindings: ParameterBinding[];
  /** Peak-shape / Lorentz / background settings for display and refinement. */
  powderProfile: PowderProfile;
  /** Number of Chebyshev background coefficients in the powder model. */
  backgroundTerms: number;
  /** Tie position/ADP of atoms sharing a crystallographic site (disorder). */
  siteTies: SiteTies;
  /** Refine anisotropic (U tensor) rather than isotropic (B_iso) ADPs. */
  anisotropicAdp?: boolean;
  /** Sample microstrain (Mustrain) model: isotropic | uniaxial | generalized. */
  mustrain?: MustrainModel;
  /** GSAS-II's own calc/background overlay for a view-only (TOF) pattern. */
  powderOverlay?: { calc: number[]; background: number[] } | null;
  /** Provenance of the observed data driving the refinement. */
  powderSource: string;
  /** Optional magnetic model over `structure`, for magnetic reflection ticks. */
  magnetic?: MagneticModel;
}

export function newSession(structure: StructureModel, instrument: InstrumentParameters = DEFAULT_INSTRUMENT): Session {
  const pattern = buildSyntheticPowder(structure);
  const spec = buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES);
  return {
    structure,
    extraPhases: [],
    pattern,
    powderParams: spec.params,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    siteTies: DEFAULT_TIES,
    powderSource: SYNTHETIC_SOURCE,
  };
}

/** Build the powder spec for a session, branching to the multi-phase builder when
 *  the session carries extra phases (so every rebuild preserves all phases). */
export function buildSpecFor(structure: StructureModel, extraPhases: readonly StructureModel[], pattern: PowderPattern, instrument: InstrumentParameters, lorentz: boolean, backgroundTerms: number, ties: SiteTies, mustrain: MustrainModel): PowderSpec {
  return extraPhases.length > 0
    ? buildMultiPhaseSpec([structure, ...extraPhases], pattern, instrument, backgroundTerms, ties, mustrain)
    : buildPowderSpec(structure, pattern, instrument, lorentz, backgroundTerms, ties, mustrain);
}

/**
 * Session for a real loaded dataset (CW or TOF). `buildPowderSpec` seeds the
 * full symmetry-allowed parameter set — for TOF that includes the back-to-back-
 * exponential profile (α/β/σ) plus fixed diffractometer constants — and
 * estimates the scale from the observed counts.
 */
export function loadedSession(structure: StructureModel, pattern: PowderPattern, instrument: InstrumentParameters, extraPhases: StructureModel[] = []): Session {
  const spec = extraPhases.length > 0
    ? buildMultiPhaseSpec([structure, ...extraPhases], pattern, instrument, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES)
    : buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES);
  return {
    structure,
    extraPhases,
    pattern,
    powderParams: spec.params,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    siteTies: DEFAULT_TIES,
    powderOverlay: null,
    powderSource: pattern.name,
  };
}
