/**
 * Typed request/response protocol for the compute worker. Payloads are plain
 * JSON (structured-clone-safe): domain models are methods-free data types.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type {
  ParameterBinding,
  LinearRestraint,
  RefinementOptions,
  RefinementParameter,
  RefinementResult,
} from "@/core/refinement/types";
import type { PeakShape } from "@/core/diffraction/profile";
import type { BackgroundType } from "@/core/diffraction/background";
import type { StageKinds } from "@/core/workflow/structureRefinement";

export interface RefinePowderRequest {
  readonly type: "refinePowder";
  readonly requestId: number;
  readonly structure: StructureModel;
  readonly pattern: PowderPattern;
  readonly parameters: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly restraints?: readonly LinearRestraint[];
  readonly shape: PeakShape;
  readonly eta?: number;
  /** Apply the 2θ Lorentz factor. Default true; false for pre-reduced I(Q). */
  readonly lorentz?: boolean;
  readonly backgroundType?: BackgroundType;
  /**
   * When present, run a staged (guided) refinement unlocking these kind-groups
   * in order instead of a single co-refinement of all free parameters.
   */
  readonly staged?: readonly StageKinds[];
  /** Restrict refinement to an inclusive abscissa window; omit for full range. */
  readonly fitRange?: { readonly min?: number; readonly max?: number };
  readonly options?: Partial<RefinementOptions>;
}

export interface RefineSingleCrystalRequest {
  readonly type: "refineSingleCrystal";
  readonly requestId: number;
  readonly structure: StructureModel;
  readonly dataset: SingleCrystalDataset;
  readonly parameters: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly options?: Partial<RefinementOptions>;
}

export interface RefineMagneticRequest {
  readonly type: "refineMagnetic";
  readonly requestId: number;
  readonly structure: StructureModel;
  readonly magnetic: MagneticModel;
  readonly dataset: SingleCrystalDataset;
  readonly parameters: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly options?: Partial<RefinementOptions>;
}

export type ComputeRequest =
  | RefinePowderRequest
  | RefineSingleCrystalRequest
  | RefineMagneticRequest;

export interface ComputeSuccess {
  readonly requestId: number;
  readonly ok: true;
  readonly result: RefinementResult;
}

export interface ComputeFailure {
  readonly requestId: number;
  readonly ok: false;
  readonly error: string;
}

export type ComputeResponse = ComputeSuccess | ComputeFailure;

/** Per-cycle progress emitted during a powder refinement (before the final
 *  response), so the UI can animate the calculated curve as it converges. */
export interface ComputeProgress {
  readonly requestId: number;
  readonly progress: { readonly yCalc: number[]; readonly rWeighted: number };
}

/** Anything the worker may post back: progress ticks then a final response. */
export type WorkerMessage = ComputeResponse | ComputeProgress;
