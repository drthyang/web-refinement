/**
 * Sequential-refinement dataset factories: the thin domain adapters that feed a
 * powder (Rietveld) or PDF series into the ONE engine-level controller,
 * `refinement/sequential.refineSequential` — same optimizer, same seeding, same
 * evolution table for both techniques (temperature/pressure/composition
 * series). Each dataset simply closes over its own pattern + fit range and
 * defers to the technique's problem builder.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern, PowderPattern } from "@/core/diffraction/types";
import type { LinearRestraint, ParameterBinding } from "@/core/refinement/types";
import type { SequentialDataset } from "@/core/refinement/sequential";
import { buildPowderProblem, type FitRange, type PowderProfile } from "@/core/workflow/powder";
import { buildPdfProblem } from "@/core/workflow/pdf";

/** One Rietveld dataset per powder pattern (same structure/bindings across the
 *  series; per-dataset fit range optional). */
export function powderSequentialDatasets(
  structure: StructureModel,
  patterns: readonly PowderPattern[],
  bindings: readonly ParameterBinding[],
  profile: PowderProfile = { shape: "gaussian" },
  restraints: readonly LinearRestraint[] = [],
  fitRanges: readonly (FitRange | undefined)[] = [],
): SequentialDataset[] {
  return patterns.map((pattern, i) => ({
    id: pattern.id,
    label: pattern.name || pattern.id,
    buildProblem: (parameters) =>
      buildPowderProblem(structure, pattern, parameters, bindings, profile, restraints, fitRanges[i]),
  }));
}

/** One PDF dataset per G(r) pattern — the real-space twin of the powder
 *  factory, feeding the identical sequential controller. */
export function pdfSequentialDatasets(
  structure: StructureModel,
  patterns: readonly PdfPattern[],
  bindings: readonly ParameterBinding[],
  restraints: readonly LinearRestraint[] = [],
  fitRanges: readonly (FitRange | undefined)[] = [],
): SequentialDataset[] {
  return patterns.map((pattern, i) => ({
    id: pattern.id,
    label: pattern.name || pattern.id,
    buildProblem: (parameters) =>
      buildPdfProblem(structure, pattern, parameters, bindings, restraints, fitRanges[i]),
  }));
}
