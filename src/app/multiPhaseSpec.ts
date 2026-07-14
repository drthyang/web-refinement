/**
 * Build a multi-phase powder refinement spec from several structures sharing one
 * instrument. Each phase contributes its own scale, cell, atoms, and (optional)
 * sample microstructure; the instrument profile, background, zero, and TOF
 * calibration are **shared** across phases (one beam, one detector). Wraps the
 * single-phase {@link buildPowderSpec} per phase and merges: per-phase parameter
 * ids are prefixed `p{i}_`, the scale is re-bound to that phase's id, and the
 * shared instrument rows are kept once (from the first phase).
 *
 * The result feeds `buildMultiPhasePowderProblem` / `multiPhaseCurves`. Validated
 * on the Mn₃Ga + MnO POWGEN data: single-phase wR ≈ 36% → two-phase ≈ 8.5%.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { PowderPhase } from "@/core/workflow/multiPhase";
import { buildPowderSpec, type SiteTies, type MustrainModel } from "@/app/powderSpec";
import { SHARED_CORRECTION_KINDS } from "@/core/diffraction/corrections";

/** Instrument rows shared across phases (one beam illuminates every phase). The
 *  isotropic size/strain (profileX/Y, tofProfile, isotropic TOF Mustrain) is
 *  shared too — matching multiPhase.ts; only anisotropic microstructure is per-phase. */
const SHARED_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "peakWidth", "background", "zeroShift", "profileU", "profileV", "profileW",
  "profileX", "profileY", "asymSL", "asymHL", "tofCalibration", "tofProfile", "mustrainIso",
  // Sample-geometry corrections that are one-per-sample (registry-declared shared).
  ...SHARED_CORRECTION_KINDS,
]);

export interface MultiPhaseSpec {
  readonly phases: PowderPhase[];
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly profile: PowderProfile;
}

export function buildMultiPhaseSpec(
  structures: readonly StructureModel[],
  pattern: PowderPattern,
  instrument: InstrumentParameters,
  backgroundTerms = 6,
  ties: SiteTies = {},
  mustrain: MustrainModel = "isotropic",
): MultiPhaseSpec {
  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  let profile: PowderProfile | undefined;
  structures.forEach((structure, i) => {
    const spec = buildPowderSpec(structure, pattern, instrument, true, backgroundTerms, ties, mustrain);
    if (i === 0) profile = spec.profile;
    for (const p of spec.params) {
      if (SHARED_KINDS.has(p.kind)) { if (i === 0) params.push(p); continue; }
      params.push({ ...p, id: `p${i}_${p.id}`, label: `${structure.name}: ${p.label}` });
    }
    for (const b of spec.bindings) {
      if (SHARED_KINDS.has(b.kind)) { if (i === 0) bindings.push(b); continue; }
      // Per-phase: prefix the param id; re-bind the scale from the pattern to
      // this phase's id so multiPhase routes it to just this phase.
      bindings.push({
        ...b,
        parameterId: `p${i}_${b.parameterId}`,
        ...(b.kind === "scale" ? { targetId: structure.id } : {}),
      });
    }
  });
  return {
    phases: structures.map((s) => ({ structure: s, id: s.id })),
    params,
    bindings,
    profile: profile ?? { shape: "gaussian" },
  };
}
