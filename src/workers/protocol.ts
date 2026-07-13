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
  /** Additional crystallographic phases; when present the pattern is refined as
   *  a multi-phase sum (shared instrument, per-phase scale/cell/atoms). */
  readonly extraPhases?: readonly StructureModel[];
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
  /**
   * Opt into the WebGPU structure-factor kernel for the parallel Jacobian
   * (single-phase, non-staged powder only). Default off: the exact f64 CPU pool
   * stays the reference path. When on, |F|² is the kernel's validated ~5e-7 f32
   * approximation and the fit converges to the same minimum (see
   * gpuPowderEvaluator); falls back to the CPU pool if WebGPU is unavailable.
   */
  readonly useGpu?: boolean;
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

/**
 * Problem definition for an EVALUATOR worker — a pool member that holds a
 * replica of the refinement problem and evaluates value-sets for the parallel
 * Jacobian. The replica is a pure function of this spec, so its outputs are
 * bit-identical to the driver's own problem.
 */
export type EvaluatorSpec =
  | {
      readonly kind: "powder";
      readonly structure: StructureModel;
      readonly pattern: PowderPattern;
      readonly parameters: RefinementParameter[];
      readonly bindings: ParameterBinding[];
      readonly restraints?: readonly LinearRestraint[];
      readonly shape: PeakShape;
      readonly eta?: number;
      readonly lorentz?: boolean;
      readonly backgroundType?: BackgroundType;
      readonly fitRange?: { readonly min?: number; readonly max?: number };
    }
  | {
      readonly kind: "magneticPowder";
      readonly structure: StructureModel;
      readonly magnetic: MagneticModel;
      readonly pattern: PowderPattern;
      readonly parameters: RefinementParameter[];
      readonly bindings: ParameterBinding[];
      readonly shape: PeakShape;
      readonly eta?: number;
      readonly fitRange?: { readonly min?: number; readonly max?: number };
    }
  | {
      readonly kind: "multiPhasePowder";
      readonly phases: readonly { readonly structure: StructureModel; readonly id: string }[];
      readonly pattern: PowderPattern;
      readonly parameters: RefinementParameter[];
      readonly bindings: ParameterBinding[];
      readonly shape: PeakShape;
      readonly eta?: number;
      readonly fitRange?: { readonly min?: number; readonly max?: number };
    }
  | {
      readonly kind: "singleCrystal";
      readonly structure: StructureModel;
      readonly dataset: SingleCrystalDataset;
      readonly parameters: RefinementParameter[];
      readonly bindings: ParameterBinding[];
    }
  | {
      readonly kind: "magneticSingleCrystal";
      readonly structure: StructureModel;
      readonly magnetic: MagneticModel;
      readonly dataset: SingleCrystalDataset;
      readonly parameters: RefinementParameter[];
      readonly bindings: ParameterBinding[];
    };

export interface InitEvaluatorRequest {
  readonly type: "initEvaluator";
  readonly requestId: number;
  readonly spec: EvaluatorSpec;
  /**
   * Request that this evaluator source |F|² from the WebGPU structure-factor
   * kernel (single-phase powder only). The worker feature-detects WebGPU and
   * reports back whether it actually engaged (EvaluatorReady.gpu); when it can't,
   * it silently serves the CPU forward model, so this is only ever a hint.
   */
  readonly useGpu?: boolean;
}

export interface EvaluateRequest {
  readonly type: "evaluate";
  readonly requestId: number;
  readonly sets: Record<string, number>[];
}

export type ComputeRequest =
  | RefinePowderRequest
  | RefineSingleCrystalRequest
  | RefineMagneticRequest
  | InitEvaluatorRequest
  | EvaluateRequest;

export interface ComputeSuccess {
  readonly requestId: number;
  readonly ok: true;
  readonly result: RefinementResult;
}

/** Acknowledgement that an evaluator worker built its problem replica. */
export interface EvaluatorReady {
  readonly requestId: number;
  readonly ok: true;
  readonly ready: true;
  /** Whether the worker engaged the WebGPU |F|² path (requested via useGpu). */
  readonly gpu?: boolean;
}

/** Evaluation results, ordered like the request's `sets`. */
export interface EvaluateSuccess {
  readonly requestId: number;
  readonly ok: true;
  readonly results: Float64Array[];
}

export interface ComputeFailure {
  readonly requestId: number;
  readonly ok: false;
  readonly error: string;
}

export type ComputeResponse = ComputeSuccess | EvaluatorReady | EvaluateSuccess | ComputeFailure;

/** Per-cycle progress emitted during a powder refinement (before the final
 *  response), so the UI can animate the calculated curve as it converges. */
export interface ComputeProgress {
  readonly requestId: number;
  readonly progress: { readonly yCalc: number[]; readonly rWeighted: number };
}

/** Anything the worker may post back: progress ticks then a final response. */
export type WorkerMessage = ComputeResponse | ComputeProgress;
