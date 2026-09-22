/**
 * Project file format (schema v2) — the reproducible, serializable unit of work.
 *
 * A project is one JSON document that captures everything needed to reopen a
 * session where it was left: the crystallographic phases, the observed data,
 * the refinement parameters with their values and fixed/free states, the
 * technique-specific model settings, and the last result.
 *
 * ## Shape
 *
 * ```
 * {
 *   schemaVersion, metadata,
 *   structures: [primary, ...additionalPhases],
 *   workspace:  { technique: "powder" | "singleCrystal" | "pdf", ...technique-specific },
 *   view?:      { step }
 * }
 * ```
 *
 * The **workspace is a tagged union on `technique`**. Exactly one technique's
 * block is present, and each technique owns its own dataset type (a
 * `PowderPattern`, a `SingleCrystalDataset`, a `PdfPattern`), its own model
 * settings, and its own validator (`validate.ts`). A file can therefore never
 * be read as the wrong kind of measurement: the reader dispatches on the tag
 * and refuses anything whose data does not match it. Adding a technique means
 * adding one member to `Workspace`, one validator branch, and one capture /
 * restore pair in the app — nothing shared changes.
 *
 * ## Rules
 *
 * - **Plain JSON, no methods, no typed arrays.** Every referenced type is a
 *   methods-free data object, so the file round-trips losslessly (a test).
 * - **Self-describing.** The full parameter rows and bindings are stored, not
 *   just values by id, so a file is readable on its own. On load the app still
 *   rebuilds the technique's spec from structure + data and overlays the saved
 *   rows by id, so a file written by an older build keeps working when new
 *   parameters appear (they simply start at their defaults).
 * - **References by id.** `structures[0]` is the primary phase — the one a
 *   magnetic model decorates (`MagneticModel.structureId`) and the one the
 *   single-crystal engine refines; the rest are additional phases.
 * - **Timestamps as ISO-8601 strings.**
 * - **Optional means absent.** A field with no value is left out, never
 *   written as `null` (the one exception is `null` inside arrays, which JSON
 *   requires) — keeps files diff-friendly and readers simple.
 *
 * Versioning and migration policy: see `io.ts` and docs/PROJECT_FORMAT.md.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { DistortionModeSet } from "@/core/crystal/distortionModes";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { PdfPattern, PowderPattern, PowderXUnit, SingleCrystalDataset } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { MustrainModel, SiteTies } from "@/core/workflow/powderModelOptions";
import type { BoxcarPlan, BoxcarRun } from "@/core/workflow/pdfBoxcar";

/** Current schema version. Bump on any breaking change and add a migration. */
export const PROJECT_SCHEMA_VERSION = 2;

/** The measurement techniques a project can hold — the `workspace` tag. */
export type Technique = "powder" | "singleCrystal" | "pdf";
export const TECHNIQUES: readonly Technique[] = ["powder", "singleCrystal", "pdf"];

/** Human label per technique, for titles and messages. */
export const TECHNIQUE_LABEL: Readonly<Record<Technique, string>> = {
  powder: "Rietveld (powder)",
  singleCrystal: "Single crystal (F²)",
  pdf: "PDF (real space)",
};

/** Provenance metadata, for reproducibility and validation traceability. */
export interface ProjectMetadata {
  readonly title: string;
  /** ISO-8601 timestamps. Stored as strings for JSON portability. */
  readonly createdAt: string;
  readonly modifiedAt: string;
  /** App version that wrote the file, for migration and bug triage. */
  readonly appVersion: string;
  readonly notes?: string;
}

/** An inclusive abscissa window (2θ / TOF / Q / d for powder, r in Å for PDF). */
export interface FitWindow {
  readonly min: number;
  readonly max: number;
}

/**
 * The refinement state every technique carries: the full parameter rows
 * (values, initial values, bounds, fixed/free, esds), the bindings that map
 * them onto the model, and the most recent result if a fit has run.
 */
export interface RefinementState {
  readonly parameters: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly lastResult?: RefinementResult;
}

/** A user-supplied file retained verbatim (instrument / data), for cross-check bundles. */
export interface RawFile {
  readonly name: string;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Powder (Rietveld)
// ---------------------------------------------------------------------------

export interface PowderWorkspace {
  readonly technique: "powder";
  readonly pattern: PowderPattern;
  /** The instrument the profile was seeded from — the default when none was loaded. */
  readonly instrument: InstrumentParameters;
  /** Whether `instrument` came from a user file (vs. the built-in default). */
  readonly instrumentLoaded: boolean;
  /** Peak-shape / Lorentz / background-basis settings. */
  readonly profile: PowderProfile;
  /** Number of background coefficients in the model. */
  readonly backgroundTerms: number;
  /** Shared-site position / ADP / occupancy ties (disorder). */
  readonly siteTies: SiteTies;
  /** Refine anisotropic (U tensor) rather than isotropic (B_iso) ADPs. */
  readonly anisotropicAdp?: boolean;
  /** Sample microstrain model. Absent ⇒ isotropic. */
  readonly mustrain?: MustrainModel;
  /** A reference calc/background overlay for a view-only pattern (GSAS-II CSV). */
  readonly overlay?: { readonly calc: readonly number[]; readonly background: readonly number[] };
  /** Provenance of the observed data (file name or the demo marker). */
  readonly source: string;
  readonly rawInstrument?: RawFile;
  readonly rawData?: RawFile;
  /**
   * The magnetic model applied to the primary phase, if any. Its moment
   * parameters and bindings live inside `refinement` alongside the nuclear
   * ones (that is how the powder engine holds them).
   */
  readonly magnetic?: MagneticModel;
  readonly refinement: RefinementState;
  /** Refinement window in the pattern's native unit. Absent ⇒ the whole pattern. */
  readonly fitRange?: FitWindow;
  /** Display-only x-axis unit chosen by the user. Absent ⇒ the native unit. */
  readonly displayUnit?: PowderXUnit;
  /** Residual peaks the user added by hand on the magnetic page (d-spacings, Å). */
  readonly manualPeaks?: readonly number[];
}

// ---------------------------------------------------------------------------
// Single crystal (integrated intensities)
// ---------------------------------------------------------------------------

/** Probe the reflections were measured with (the file cannot carry it). */
export type SingleCrystalProbe = "xray" | "neutron" | "neutron-tof";
export const SINGLE_CRYSTAL_PROBES: readonly SingleCrystalProbe[] = ["xray", "neutron", "neutron-tof"];

/**
 * The single-k magnetic-supercell hypothesis (the "modulated moments" panel):
 * the user's inputs, kept as the strings they typed so fractions like "1/4"
 * reopen exactly. The refinement result is deterministic from these plus the
 * data and is re-run rather than stored.
 */
export interface ModulatedHypothesis {
  readonly k: readonly [string, string, string];
  readonly ions: Readonly<Record<string, {
    readonly on: boolean;
    readonly direction: readonly [string, string, string];
    readonly phase: string;
  }>>;
  readonly moment: number;
  readonly seed: number;
  readonly restarts: number;
}

export interface SingleCrystalWorkspace {
  readonly technique: "singleCrystal";
  /** The nuclear reflection set, as loaded (radiation as the file gave it). */
  readonly dataset: SingleCrystalDataset;
  /** Companion magnetic reflection set for joint co-refinement, if loaded. */
  readonly magneticDataset?: SingleCrystalDataset;
  /** The user's probe choice, which overrides the dataset's radiation kind. */
  readonly probe: SingleCrystalProbe;
  /**
   * Nuclear parameters plus any applied moment rows; bindings likewise (the
   * moment bindings are the ones whose kind is a moment kind).
   */
  readonly refinement: RefinementState;
  /** Magnetic model applied from the symmetry analysis, if any. */
  readonly magnetic?: MagneticModel;
  /** SHELX-style OMIT filter on |Fo²−Fc²|/σ. Absent ⇒ off. */
  readonly outlierFilter?: { readonly on: boolean; readonly cutoffSigma: number };
  readonly modulated?: ModulatedHypothesis;
}

// ---------------------------------------------------------------------------
// Pair distribution function (real space)
// ---------------------------------------------------------------------------

export type PdfPositionMode = "atomic" | "irreps";
export const PDF_POSITION_MODES: readonly PdfPositionMode[] = ["atomic", "irreps"];

export interface PdfWorkspace {
  readonly technique: "pdf";
  readonly pattern: PdfPattern;
  readonly refinement: RefinementState;
  /** The r window the model is computed and fitted in (Å). */
  readonly fitRange: FitWindow;
  /** Per-coordinate shifts ("atomic") or symmetry-adapted mode amplitudes ("irreps"). */
  readonly positionMode: PdfPositionMode;
  /**
   * The distortion-mode parameterization in force, when one was built from a
   * parent CIF or a subgroup activation. It cannot be regenerated from the
   * child structure alone, so the whole set is stored.
   */
  readonly distortionModes?: {
    readonly set: DistortionModeSet;
    readonly parentName: string;
    readonly fromActivation?: boolean;
  };
  /**
   * The spin model handed over from the magnetic page (mPDF co-refinement):
   * the model plus the moment rows and bindings as handed over. The refined
   * moment values are the ones in `refinement.parameters`.
   */
  readonly spinModel?: {
    readonly magnetic: MagneticModel;
    readonly parameters: readonly RefinementParameter[];
    readonly bindings: readonly ParameterBinding[];
  };
  /** The boxcar (sliding r-window) plan, and the last scan if one was run. */
  readonly boxcar?: {
    readonly plan: BoxcarPlan;
    readonly lastRun?: BoxcarRun;
  };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

export type Workspace = PowderWorkspace | SingleCrystalWorkspace | PdfWorkspace;

/** UI hints. Optional and ignorable — nothing scientific lives here. */
export interface ProjectView {
  /** Active page: 0 = nuclear refinement, 1 = magnetic analysis. */
  readonly step?: number;
}

/** The complete state of a session. */
export interface ProjectFile {
  readonly schemaVersion: number;
  readonly metadata: ProjectMetadata;
  /** Crystallographic phases; `[0]` is the primary phase. */
  readonly structures: readonly StructureModel[];
  readonly workspace: Workspace;
  readonly view?: ProjectView;
}

// Re-exported for call sites that narrow on the dataset types.
export type { SingleCrystalDataset, PowderPattern, PdfPattern };
