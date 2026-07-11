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
import { parseSymmetryOperation } from "@/core/crystal/symmetry";

export const DEFAULT_INSTRUMENT: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };
export const DEFAULT_BACKGROUND_TERMS = 4;
export const DEFAULT_TIES: SiteTies = { positions: true, adp: true };
export const SYNTHETIC_SOURCE = "synthetic (self-consistent demo)";
/** Provenance marker for a clean, data-less workbench — the app's first-run
 *  state, before the demo or a user's own files are loaded. */
export const EMPTY_SOURCE = "__empty__";

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
  /** The user's original instrument file, retained verbatim on load. Exported
   *  into cross-check bundles as-is (the instrument model is lossy — it keeps
   *  difC/λ + a few width terms, not the full peak-shape profile). Undefined for
   *  the bundled demo and synthetic sessions. */
  rawInstrument?: { name: string; text: string };
  /** The user's original data file, retained verbatim on load, shipped in bundles
   *  as the exact original alongside the portable re-serialized data. */
  rawData?: { name: string; text: string };
  /** Optional magnetic model over `structure`, for magnetic reflection ticks. */
  magnetic?: MagneticModel;
}

/** A valid but data-less placeholder structure (P1, unit cell, no sites). The
 *  landing view renders instead of the workbench while this is loaded, so it is
 *  never fed to the compute machinery — it only keeps `Session` non-null. */
const EMPTY_STRUCTURE: StructureModel = {
  id: "empty",
  name: "",
  cell: { a: 1, b: 1, c: 1, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
  sites: [],
};

/** The clean, data-less session the workbench opens on. The shell shows a
 *  landing view until the user loads the demo or their own CIF; any load then
 *  replaces this. Kept structurally valid so nothing downstream special-cases it. */
export function emptySession(): Session {
  return {
    structure: EMPTY_STRUCTURE,
    extraPhases: [],
    pattern: { id: "empty", name: EMPTY_SOURCE, xUnit: "twoTheta", radiation: { kind: "neutron", wavelength: 1.54 }, points: [] },
    powderParams: [],
    powderBindings: [],
    powderProfile: { shape: "gaussian" },
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    siteTies: DEFAULT_TIES,
    powderOverlay: null,
    powderSource: EMPTY_SOURCE,
  };
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
export function loadedSession(structure: StructureModel, pattern: PowderPattern, instrument: InstrumentParameters, extraPhases: StructureModel[] = [], paramValues?: Record<string, number>): Session {
  const spec = extraPhases.length > 0
    ? buildMultiPhaseSpec([structure, ...extraPhases], pattern, instrument, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES)
    : buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES);
  // Optionally seed converged values (the bundled demo opens on a finished
  // refinement). The value becomes the baseline too, so it reads as clean, not
  // "modified", and Reset returns to it.
  const powderParams = paramValues
    ? spec.params.map((p) => {
        const v = paramValues[p.id];
        return v !== undefined ? { ...p, value: v, initialValue: v } : p;
      })
    : spec.params;
  return {
    structure,
    extraPhases,
    pattern,
    powderParams,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    siteTies: DEFAULT_TIES,
    powderOverlay: null,
    powderSource: pattern.name,
  };
}
