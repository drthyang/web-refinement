/**
 * Project save / open — the mapping between the app's live state and the
 * project file's technique workspaces (core/project).
 *
 * Pure functions, no React: each engine calls its `…WorkspaceFrom` to snapshot
 * itself when the user saves, and the shell (or the engine, on a fresh mount)
 * calls the matching restore helper when a file is opened. Keeping both
 * directions in one place, per technique, is what makes the format easy to
 * extend: a new field is added to the type, captured here, restored here, and
 * validated in core/project/validate — four edits, all in named places.
 *
 * Restoring never trusts a file over the running code: the engines rebuild
 * their parameter spec from structure + data exactly as on a normal load, then
 * overlay the saved rows by id (`overlaySavedParameters`). Parameters a newer
 * build added start at their defaults; parameters a file names that the build
 * no longer has are dropped — except the moment rows a magnetic model brought
 * in, which no spec builder can regenerate and which are appended verbatim.
 */

import { APP_VERSION } from "@/app/constants";
import type { Session } from "@/app/powderSession";
import { EMPTY_SOURCE } from "@/app/powderSession";
import type { StructureModel } from "@/core/crystal/types";
import type { DistortionModeSet } from "@/core/crystal/distortionModes";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { PdfPattern, PowderXUnit, SingleCrystalDataset } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import {
  PROJECT_SCHEMA_VERSION,
  TECHNIQUE_LABEL,
  type FitWindow,
  type ModulatedHypothesis,
  type PdfPositionMode,
  type PdfWorkspace,
  type PowderWorkspace,
  type ProjectFile,
  type SingleCrystalProbe,
  type SingleCrystalWorkspace,
  type Technique,
  type Workspace,
} from "@/core/project/types";
import { isMomentParameterKind, type ParameterBinding, type RefinementParameter, type RefinementResult } from "@/core/refinement/types";
import type { BoxcarPlan, BoxcarRun } from "@/core/workflow/pdfBoxcar";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** A deep-enough copy of a parameter row: the engines mutate value/fixed in place. */
function cloneParameter(p: RefinementParameter): RefinementParameter {
  return { ...p };
}

/**
 * Overlay saved parameter rows onto a freshly built spec, by id. The spec
 * decides which parameters exist; the file supplies their state (value,
 * initial value, fixed/free, esd). Saved rows the spec does not know are
 * dropped unless `append` says they must be kept — the moment rows a magnetic
 * model contributed, which only the magnetic page can (re)create.
 */
export function overlaySavedParameters(
  spec: readonly RefinementParameter[],
  saved: readonly RefinementParameter[],
  append: (p: RefinementParameter) => boolean = () => false,
): RefinementParameter[] {
  const byId = new Map(saved.map((p) => [p.id, p]));
  const specIds = new Set(spec.map((p) => p.id));
  const restored = spec.map((p) => {
    const s = byId.get(p.id);
    if (!s) return cloneParameter(p);
    const { esd: _esd, ...rest } = p;
    return { ...rest, value: s.value, initialValue: s.initialValue, fixed: s.fixed, ...(s.esd !== undefined ? { esd: s.esd } : {}) };
  });
  for (const s of saved) if (!specIds.has(s.id) && append(s)) restored.push(cloneParameter(s));
  return restored;
}

/** The file's metadata title when the user has not named the project. */
export function defaultProjectTitle(structure: StructureModel, technique: Technique): string {
  return `${structure.name || structure.id} · ${TECHNIQUE_LABEL[technique]}`;
}

export interface ProjectEnvelope {
  readonly structures: readonly StructureModel[];
  readonly workspace: Workspace;
  readonly title: string;
  /** Kept from the file the session was opened from, so re-saving preserves it. */
  readonly createdAt?: string;
  readonly notes?: string;
  /** Active page (0 nuclear / 1 magnetic). */
  readonly step?: number;
}

/** Wrap a workspace into a complete, timestamped project file. */
export function projectFileFor(env: ProjectEnvelope): ProjectFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    metadata: {
      title: env.title,
      createdAt: env.createdAt ?? now,
      modifiedAt: now,
      appVersion: APP_VERSION,
      ...(env.notes !== undefined ? { notes: env.notes } : {}),
    },
    structures: env.structures,
    workspace: env.workspace,
    ...(env.step !== undefined ? { view: { step: env.step } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Powder
// ---------------------------------------------------------------------------

/** The powder engine's private view state that travels with the session. */
export interface PowderViewState {
  readonly fitRange: FitWindow | null;
  readonly displayUnit: PowderXUnit | null;
  readonly manualPeakD: readonly number[];
}

export function powderWorkspaceFrom(
  session: Session,
  result: RefinementResult | null,
  instrument: InstrumentParameters,
  instrumentLoaded: boolean,
  view: PowderViewState,
): PowderWorkspace {
  return {
    technique: "powder",
    pattern: session.pattern,
    instrument,
    instrumentLoaded,
    profile: session.powderProfile,
    backgroundTerms: session.backgroundTerms,
    siteTies: session.siteTies,
    ...(session.anisotropicAdp !== undefined ? { anisotropicAdp: session.anisotropicAdp } : {}),
    ...(session.mustrain !== undefined ? { mustrain: session.mustrain } : {}),
    ...(session.powderOverlay ? { overlay: session.powderOverlay } : {}),
    source: session.powderSource,
    ...(session.rawInstrument ? { rawInstrument: session.rawInstrument } : {}),
    ...(session.rawData ? { rawData: session.rawData } : {}),
    ...(session.magnetic ? { magnetic: session.magnetic } : {}),
    refinement: {
      parameters: session.powderParams.map(cloneParameter),
      bindings: [...session.powderBindings],
      ...(result ? { lastResult: result } : {}),
    },
    ...(view.fitRange ? { fitRange: view.fitRange } : {}),
    ...(view.displayUnit ? { displayUnit: view.displayUnit } : {}),
    ...(view.manualPeakD.length > 0 ? { manualPeaks: [...view.manualPeakD] } : {}),
  };
}

export interface RestoredPowder {
  readonly session: Session;
  readonly instrument: InstrumentParameters;
  readonly instrumentLoaded: boolean;
  readonly result: RefinementResult | null;
  readonly view: PowderViewState;
}

/**
 * Rebuild the shell's powder session from a workspace. The saved parameter
 * rows and bindings ARE the session's (the powder engine holds them as state,
 * not as a memo), so they are taken as saved; the engine's own controls
 * rebuild the spec from them on the next change, preserving values by id.
 */
export function sessionFromPowderWorkspace(ws: PowderWorkspace, structures: readonly StructureModel[]): RestoredPowder {
  const structure = structures[0];
  if (!structure) throw new Error("project has no primary phase");
  const session: Session = {
    structure,
    extraPhases: structures.slice(1),
    pattern: ws.pattern,
    powderParams: ws.refinement.parameters.map(cloneParameter),
    powderBindings: [...ws.refinement.bindings],
    powderProfile: ws.profile,
    backgroundTerms: ws.backgroundTerms,
    siteTies: ws.siteTies,
    ...(ws.anisotropicAdp !== undefined ? { anisotropicAdp: ws.anisotropicAdp } : {}),
    ...(ws.mustrain !== undefined ? { mustrain: ws.mustrain } : {}),
    ...(ws.overlay ? { powderOverlay: { calc: [...ws.overlay.calc], background: [...ws.overlay.background] } } : {}),
    // A hand-edited source equal to the landing marker would hide the loaded
    // data behind the empty state; fall back to the pattern's name.
    powderSource: ws.source === EMPTY_SOURCE ? ws.pattern.name || "project" : ws.source,
    ...(ws.rawInstrument ? { rawInstrument: ws.rawInstrument } : {}),
    ...(ws.rawData ? { rawData: ws.rawData } : {}),
    ...(ws.magnetic ? { magnetic: ws.magnetic } : {}),
  };
  return {
    session,
    instrument: ws.instrument,
    instrumentLoaded: ws.instrumentLoaded,
    result: ws.refinement.lastResult ?? null,
    view: {
      fitRange: ws.fitRange ?? null,
      displayUnit: ws.displayUnit ?? null,
      manualPeakD: [...(ws.manualPeaks ?? [])],
    },
  };
}

// ---------------------------------------------------------------------------
// Single crystal
// ---------------------------------------------------------------------------

/** The single-crystal page's modulated-moment panel inputs, as the page holds them. */
export interface ModulatedInputs {
  readonly kText: readonly [string, string, string];
  readonly ionState: Readonly<Record<string, { readonly on: boolean; readonly dir: readonly [string, string, string]; readonly phase: string }>>;
  readonly moment: number;
  readonly seed: number;
  readonly restarts: number;
}

export interface SingleCrystalSnapshot {
  readonly dataset: SingleCrystalDataset;
  readonly magneticDataset: SingleCrystalDataset | null;
  readonly probe: SingleCrystalProbe;
  readonly params: readonly RefinementParameter[];
  /** Spec bindings plus the applied moment bindings. */
  readonly bindings: readonly ParameterBinding[];
  readonly result: RefinementResult | null;
  readonly magnetic: MagneticModel | null;
  readonly filterOn: boolean;
  readonly cutoffSigma: number;
  readonly modulated: ModulatedInputs;
}

export function singleCrystalWorkspaceFrom(s: SingleCrystalSnapshot): SingleCrystalWorkspace {
  return {
    technique: "singleCrystal",
    dataset: s.dataset,
    ...(s.magneticDataset ? { magneticDataset: s.magneticDataset } : {}),
    probe: s.probe,
    refinement: {
      parameters: s.params.map(cloneParameter),
      bindings: [...s.bindings],
      ...(s.result ? { lastResult: s.result } : {}),
    },
    ...(s.magnetic ? { magnetic: s.magnetic } : {}),
    outlierFilter: { on: s.filterOn, cutoffSigma: s.cutoffSigma },
    modulated: modulatedHypothesisFrom(s.modulated),
  };
}

export function modulatedHypothesisFrom(m: ModulatedInputs): ModulatedHypothesis {
  return {
    k: [...m.kText] as [string, string, string],
    ions: Object.fromEntries(
      Object.entries(m.ionState).map(([label, ion]) => [label, { on: ion.on, direction: [...ion.dir] as [string, string, string], phase: ion.phase }]),
    ),
    moment: m.moment,
    seed: m.seed,
    restarts: m.restarts,
  };
}

export function modulatedInputsFrom(h: ModulatedHypothesis): ModulatedInputs {
  return {
    kText: [...h.k] as [string, string, string],
    ionState: Object.fromEntries(
      Object.entries(h.ions).map(([label, ion]) => [label, { on: ion.on, dir: [...ion.direction] as [string, string, string], phase: ion.phase }]),
    ),
    moment: h.moment,
    seed: h.seed,
    restarts: h.restarts,
  };
}

/** Nuclear rows from the fresh spec with saved state; saved moment rows appended. */
export function restoreSingleCrystalParameters(spec: readonly RefinementParameter[], ws: SingleCrystalWorkspace): RefinementParameter[] {
  return overlaySavedParameters(spec, ws.refinement.parameters, (p) => ws.magnetic !== undefined && isMomentParameterKind(p.kind));
}

/** The applied moment bindings a saved single-crystal workspace carries. */
export function restoreMomentBindings(ws: SingleCrystalWorkspace): ParameterBinding[] {
  return ws.magnetic ? ws.refinement.bindings.filter((b) => isMomentParameterKind(b.kind)) : [];
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export interface PdfSnapshot {
  readonly pattern: PdfPattern;
  readonly params: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];
  readonly result: RefinementResult | null;
  readonly fitRange: FitWindow;
  readonly positionMode: PdfPositionMode;
  readonly modes: { readonly set: DistortionModeSet; readonly parentName: string; readonly fromActivation?: boolean } | null;
  readonly spinModel: {
    readonly magnetic: MagneticModel;
    readonly params: readonly RefinementParameter[];
    readonly bindings: readonly ParameterBinding[];
  } | null;
  readonly boxcarPlan: BoxcarPlan;
  readonly boxcarRun: BoxcarRun | null;
}

export function pdfWorkspaceFrom(s: PdfSnapshot): PdfWorkspace {
  return {
    technique: "pdf",
    pattern: s.pattern,
    refinement: {
      parameters: s.params.map(cloneParameter),
      bindings: [...s.bindings],
      ...(s.result ? { lastResult: s.result } : {}),
    },
    fitRange: s.fitRange,
    positionMode: s.positionMode,
    ...(s.modes
      ? { distortionModes: { set: s.modes.set, parentName: s.modes.parentName, ...(s.modes.fromActivation ? { fromActivation: true } : {}) } }
      : {}),
    ...(s.spinModel
      ? { spinModel: { magnetic: s.spinModel.magnetic, parameters: s.spinModel.params.map(cloneParameter), bindings: [...s.spinModel.bindings] } }
      : {}),
    boxcar: { plan: s.boxcarPlan, ...(s.boxcarRun ? { lastRun: s.boxcarRun } : {}) },
  };
}
