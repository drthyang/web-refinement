/**
 * Schema migrations for project documents, applied before validation.
 *
 * Each step maps version N to N+1 on the raw parsed JSON (untyped records —
 * the old shapes have no types any more). The chain runs until the document
 * reaches `PROJECT_SCHEMA_VERSION`; the validator then checks the result like
 * any current file, so a migration cannot smuggle in a malformed document.
 *
 * ## v1 → v2
 *
 * v1 was a flat, technique-blind aggregate written only by the powder page's
 * "Project JSON" export (never read back by the app):
 *
 * ```
 * { schemaVersion: 1, metadata, structures, magneticModels, datasets,
 *   parameters, bindings, lastResult? }
 * ```
 *
 * It is lifted into a v2 `workspace` by inspecting `datasets[0]`: powder
 * points → a powder workspace, reflections → a single-crystal workspace. v1
 * never recorded the instrument, profile, background basis or fit window, so
 * those take best-effort defaults (inferred from the parameter kinds where
 * possible) and the metadata notes say so.
 */

import { PROJECT_SCHEMA_VERSION } from "@/core/project/types";
import { ProjectFileError, isRecord } from "@/core/project/validate";

type Rec = Record<string, unknown>;

/** Bring a parsed document up to the current schema version. */
export function migrateProjectData(data: Rec): Rec {
  let doc = data;
  let version = typeof doc.schemaVersion === "number" ? doc.schemaVersion : NaN;
  while (version < PROJECT_SCHEMA_VERSION) {
    const step = STEPS[version];
    if (!step) throw new ProjectFileError(`schemaVersion: no migration from v${version}`);
    doc = step(doc);
    version = doc.schemaVersion as number;
  }
  return doc;
}

const STEPS: Readonly<Record<number, (doc: Rec) => Rec>> = {
  1: migrateV1ToV2,
};

const V1_NOTE =
  "Migrated from schema v1, which did not record the instrument, peak profile, background basis or fit window — those were reset to defaults; reload the instrument file to restore the profile.";

function migrateV1ToV2(doc: Rec): Rec {
  const datasets = Array.isArray(doc.datasets) ? doc.datasets : [];
  const dataset = datasets[0];
  if (!isRecord(dataset)) throw new ProjectFileError("datasets: a v1 project needs one dataset to migrate");
  const parameters = Array.isArray(doc.parameters) ? doc.parameters : [];
  const bindings = Array.isArray(doc.bindings) ? doc.bindings : [];
  const refinement: Rec = { parameters, bindings, ...(isRecord(doc.lastResult) ? { lastResult: doc.lastResult } : {}) };
  const magneticModels = Array.isArray(doc.magneticModels) ? doc.magneticModels : [];
  const magnetic = magneticModels.find(isRecord);
  const meta = isRecord(doc.metadata) ? doc.metadata : {};
  const notes = typeof meta.notes === "string" && meta.notes.trim() !== "" ? `${meta.notes}\n${V1_NOTE}` : V1_NOTE;

  const kinds = new Set(parameters.filter(isRecord).map((p) => p.kind));
  let workspace: Rec;
  if (Array.isArray(dataset.points)) {
    const radiation = isRecord(dataset.radiation) ? dataset.radiation : {};
    const isTof = dataset.xUnit === "tof" || radiation.kind === "neutron-tof";
    const wavelength =
      typeof dataset.wavelength === "number" ? dataset.wavelength : typeof radiation.wavelength === "number" ? radiation.wavelength : 1.54;
    const instrument: Rec = isTof
      ? // No difC was recorded: a TOF pattern reopens view-only until the
        // instrument file is reloaded (the profile shape below says so too).
        { kind: "constantWavelength", wavelength }
      : { kind: "constantWavelength", wavelength, ...(radiation.kind === "xray" || radiation.kind === "neutron" ? { radiationKind: radiation.kind } : {}) };
    const profile: Rec = isTof
      ? { shape: "gaussian" }
      : kinds.has("profileU")
        ? { shape: "pseudoVoigt", eta: 0.5, lorentz: true }
        : { shape: "gaussian", lorentz: true };
    const backgroundTerms = Math.max(1, parameters.filter((p) => isRecord(p) && p.kind === "background").length || 4);
    workspace = {
      technique: "powder",
      pattern: dataset,
      instrument,
      instrumentLoaded: false,
      profile,
      backgroundTerms,
      siteTies: { positions: true, adp: true },
      source: typeof dataset.name === "string" ? dataset.name : "project v1",
      ...(magnetic ? { magnetic } : {}),
      refinement,
    };
  } else if (Array.isArray(dataset.reflections)) {
    const radiation = isRecord(dataset.radiation) ? dataset.radiation : {};
    const probe = radiation.kind === "xray" || radiation.kind === "neutron-tof" ? radiation.kind : "neutron";
    workspace = {
      technique: "singleCrystal",
      dataset,
      probe,
      refinement,
      ...(magnetic ? { magnetic } : {}),
    };
  } else {
    throw new ProjectFileError("datasets[0]: neither a powder pattern (points) nor a reflection list — cannot migrate this v1 project");
  }

  return {
    schemaVersion: 2,
    metadata: { ...meta, notes },
    structures: Array.isArray(doc.structures) ? doc.structures : [],
    workspace,
  };
}
