/**
 * Typed request/response protocol for the compute worker. Payloads are plain
 * JSON (structured-clone-safe): domain models are methods-free data types.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type {
  ParameterBinding,
  RefinementOptions,
  RefinementParameter,
  RefinementResult,
} from "@/core/refinement/types";
import type { PeakShape } from "@/core/diffraction/profile";

export interface RefinePowderRequest {
  readonly type: "refinePowder";
  readonly requestId: number;
  readonly structure: StructureModel;
  readonly pattern: PowderPattern;
  readonly parameters: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly shape: PeakShape;
  readonly eta?: number;
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

export type ComputeRequest = RefinePowderRequest | RefineSingleCrystalRequest;

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
