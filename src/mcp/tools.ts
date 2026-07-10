/**
 * MCP tool handlers over the pure refinement core — the callable surface an
 * agent uses to run refinement the way a crystallographer does: parse → build →
 * refine → **assess** → **suggest** → **interpret**.
 *
 * Every handler is a pure function (JSON args → JSON result) with no MCP
 * dependency, so they are unit-testable directly; `server.ts` only adds the
 * stdio transport and schemas. The domain models are methods-free data (the same
 * constraint the Web Worker protocol enforces), so they cross the tool boundary
 * unchanged. Statelessness is deliberate: an agent threads the structure /
 * pattern / result through calls, so every agent-driven run is reproducible by
 * replaying the same tool calls (see docs/AGENT_TOOLS.md).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { PowderProfile } from "@/core/workflow/powder";
import type { MagneticModel } from "@/core/magnetic/types";
import { parseMagneticCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { detectDataFormat } from "@/parsers/detectFormat";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { buildPowderSpec, type MustrainModel } from "@/app/powderSpec";
import { runPowderRefinement } from "@/workers/runPowder";
import { powderCurves } from "@/core/workflow/powder";
import { excludedPointMask } from "@/core/refinement/factors";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";
import type { PeakShape } from "@/core/diffraction/profile";
import {
  assessRefinement,
  suggestNextSteps,
  type RefinementAssessment,
} from "@/core/diagnostics/assessment";
import { interpretStructure } from "@/core/diagnostics/interpret";

const DEFAULT_INSTRUMENT: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };

/** Parse a CIF/mCIF into a structure (and magnetic model, when present). */
export function parse_structure(args: { cif: string; id?: string }): { structure: StructureModel; magnetic: MagneticModel | null } {
  const { structure, magnetic } = parseMagneticCif(args.cif, args.id ?? "loaded");
  return { structure, magnetic: magnetic ?? null };
}

/** Classify + parse powder data; returns the pattern and how the format was detected. */
export function parse_powder_data(args: { text: string; filename?: string }): {
  detected: { dataType: string; xUnit?: string; source: string; confidence: string; note?: string };
  pattern: PowderPattern;
  summary: { points: number; xUnit: string; xMin: number; xMax: number; radiation: string };
} {
  const fmt = detectDataFormat({ text: args.text, filename: args.filename ?? "data" });
  if (fmt.dataType !== "powder") throw new Error(`detected ${fmt.dataType} data, not powder — use the single-crystal path`);
  const pattern = parsePowderData(args.text, {
    id: "data",
    name: args.filename ?? "data",
    xUnit: fmt.xUnit,
    radiation: fmt.radiation,
    ...(fmt.radiation.kind !== "neutron-tof" ? { wavelength: fmt.radiation.wavelength } : {}),
  });
  const xs = pattern.points.map((p) => p.x);
  return {
    detected: { dataType: fmt.dataType, ...(fmt.xUnit ? { xUnit: fmt.xUnit } : {}), source: fmt.source, confidence: fmt.confidence, ...(fmt.note ? { note: fmt.note } : {}) },
    pattern,
    summary: { points: pattern.points.length, xUnit: pattern.xUnit, xMin: Math.min(...xs), xMax: Math.max(...xs), radiation: pattern.radiation.kind },
  };
}

/** Parse an instrument-parameter file (.instprm / .prm / .irf) into a CW or TOF calibration. */
export function parse_instrument(args: { text: string }): InstrumentParameters {
  return parseInstrumentParameters(args.text);
}

/**
 * Build the symmetry-allowed refinement parameter set + bindings + profile for a
 * structure/pattern. Only symmetry-allowed parameters are created, so the agent
 * literally cannot free a forbidden one — the search space is pre-pruned.
 */
export function build_refinement(args: {
  structure: StructureModel;
  pattern: PowderPattern;
  instrument?: InstrumentParameters;
  backgroundTerms?: number;
  mustrain?: MustrainModel;
}): { parameters: RefinementParameter[]; bindings: ParameterBinding[]; profile: PowderProfile; freeCount: number } {
  const spec = buildPowderSpec(
    args.structure,
    args.pattern,
    args.instrument ?? DEFAULT_INSTRUMENT,
    true,
    args.backgroundTerms ?? 4,
    {},
    args.mustrain ?? "isotropic",
  );
  return {
    parameters: spec.params,
    bindings: spec.bindings,
    profile: spec.profile,
    freeCount: spec.params.filter((p) => !p.fixed && !p.expression).length,
  };
}

/**
 * Run a constrained least-squares refinement of the given (freed) parameters.
 * The numerical optimization is the deterministic Levenberg–Marquardt engine —
 * the agent chooses *what* to free, never the values. Returns the full result
 * (refined values, esds, agreement, and the SVD/correlation/at-bound
 * diagnostics) plus the observation count and residual for `assess_refinement`.
 */
export function refine_powder(args: {
  structure: StructureModel;
  pattern: PowderPattern;
  parameters: RefinementParameter[];
  bindings: ParameterBinding[];
  profile: PowderProfile;
  instrument?: InstrumentParameters;
  extraPhases?: StructureModel[];
  staged?: boolean;
  fitRange?: { min: number; max: number };
  maxIterations?: number;
}): { result: RefinementResult; observationCount: number; residual: { d: number[]; yObs: number[]; yCalc: number[] } } {
  const shape: PeakShape = args.profile.shape;
  const result = runPowderRefinement({
    type: "refinePowder",
    requestId: 0,
    structure: args.structure,
    ...(args.extraPhases && args.extraPhases.length ? { extraPhases: args.extraPhases } : {}),
    pattern: args.pattern,
    parameters: args.parameters,
    bindings: args.bindings,
    shape,
    ...(args.profile.eta !== undefined ? { eta: args.profile.eta } : {}),
    ...(args.profile.lorentz !== undefined ? { lorentz: args.profile.lorentz } : {}),
    ...(args.profile.backgroundType !== undefined ? { backgroundType: args.profile.backgroundType } : {}),
    ...(args.fitRange ? { fitRange: args.fitRange } : {}),
    options: { maxIterations: args.maxIterations ?? 20 },
  });

  // Residual (obs − calc) as d-spacing arrays, so assess_refinement can scan the
  // positive residual for the missing-phase / magnetic-order signal.
  const refined = args.parameters.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  const curves = powderCurves(args.structure, args.pattern, refined, args.bindings, args.profile);
  const ctx = axisContext(args.pattern, args.instrument);
  const d = args.pattern.xUnit === "dSpacing" ? [...curves.x] : convertAxisArray(curves.x, args.pattern.xUnit, "dSpacing", ctx);
  const excluded = excludedPointMask(curves.yObs);
  const observationCount = excluded.reduce((n, ex) => n + (ex ? 0 : 1), 0);
  return { result, observationCount, residual: { d, yObs: [...curves.yObs], yCalc: [...curves.yCalc] } };
}

/**
 * The judgment tool: turn a refinement result into the structured "what matters"
 * an expert reads off it — trust verdict, dangerous correlations, at-bound and
 * unphysical parameters, ill-conditioning, over/under-parameterization, and
 * unexplained residual peaks (the missing-phase / magnetic-order signal).
 */
export function assess_refinement(args: {
  result: RefinementResult;
  parameters: RefinementParameter[];
  observationCount: number;
  residual?: { d: number[]; yObs: number[]; yCalc: number[] };
  mode?: "powder" | "single-crystal";
}): RefinementAssessment {
  return assessRefinement({
    result: args.result,
    parameters: args.parameters,
    observationCount: args.observationCount,
    ...(args.residual ? { residual: args.residual } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
  });
}

/** The decision tool: rank the next actions given an assessment (sequencing only). */
export function suggest_next_steps(args: { assessment: RefinementAssessment }): ReturnType<typeof suggestNextSteps> {
  return suggestNextSteps(args.assessment);
}

/**
 * The materials tool: read the refined structure for engineering/discovery
 * signals — microstructure (size/microstrain), stoichiometry (partial
 * occupancy), displacement anomalies, magnetic order, and bond-length sanity.
 */
export function interpret_structure(args: {
  structure: StructureModel;
  parameters?: RefinementParameter[];
  esd?: Record<string, number>;
  wavelength?: number;
  magnetic?: MagneticModel | null;
}): ReturnType<typeof interpretStructure> {
  return interpretStructure({
    structure: args.structure,
    ...(args.parameters ? { parameters: args.parameters } : {}),
    ...(args.esd ? { esd: args.esd } : {}),
    ...(args.wavelength !== undefined ? { wavelength: args.wavelength } : {}),
    ...(args.magnetic ? { magnetic: args.magnetic } : {}),
  });
}
