/**
 * Project file format — the reproducible, serializable unit of work.
 *
 * A ProjectFile is plain JSON: every field above is a data type with no methods,
 * so `JSON.stringify(project)` round-trips losslessly. This is the contract the
 * round-trip validation test guards (Phase 9).
 */

import type { StructureModel } from "@/core/crystal/types";
import type {
  DiffractionDataset,
  SingleCrystalDataset,
  PowderPattern,
} from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type {
  ParameterBinding,
  RefinementParameter,
  RefinementResult,
} from "@/core/refinement/types";

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

/**
 * The complete state of a refinement session.
 *
 * `schemaVersion` gates migration: readers compare it against
 * PROJECT_SCHEMA_VERSION and refuse or upgrade older/newer files rather than
 * silently misreading them.
 */
export interface ProjectFile {
  readonly schemaVersion: number;
  readonly metadata: ProjectMetadata;

  /** One or more crystal structures (multi-phase ready, single-phase first). */
  readonly structures: readonly StructureModel[];
  /** Magnetic models layered onto structures by id. Empty for nuclear-only. */
  readonly magneticModels: readonly MagneticModel[];

  /** Loaded experimental datasets (single-crystal and/or powder). */
  readonly datasets: readonly DiffractionDataset[];

  /** Flat refinement parameter list plus their bindings into the models. */
  readonly parameters: readonly RefinementParameter[];
  readonly bindings: readonly ParameterBinding[];

  /** Most recent refinement result, if any. History lives inside it. */
  readonly lastResult?: RefinementResult;
}

// Re-export the narrowing helpers' underlying types for convenience at call sites.
export type { SingleCrystalDataset, PowderPattern };
