/// <reference lib="webworker" />
/**
 * Compute worker: runs refinement off the main thread so the UI stays
 * responsive. Only the refinement driver lives here; it delegates to the pure
 * core workflow builders.
 *
 * A worker can also act as an EVALUATOR — one member of the parallel-Jacobian
 * pool: `initEvaluator` builds a replica of the refinement problem from its
 * spec (the same construction path the driver uses, see
 * `buildProblemForSpec`), and each `evaluate` request maps value-sets through
 * the replica's pure `calculate`, returning the curves with zero-copy
 * transfer. Replica outputs are bit-identical to the driver's.
 */

import type { ComputeRequest, ComputeResponse, EvaluatorSpec } from "@/workers/protocol";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import { buildSingleCrystalRefinementProblem } from "@/core/workflow/singleCrystalRefinement";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { runPowderRefinement, runPdfRefinement, buildProblemForSpec } from "@/workers/runPowder";
import { leBailCellPrefit } from "@/core/workflow/leBailPrefit";
import { GpuStructureFactor } from "@/workers/gpuStructureFactor";
import { evaluatePowderBatchOnGpu } from "@/workers/gpuPowderEvaluator";

const post = (msg: unknown, transfer?: Transferable[]): void =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

/** The problem replica when this worker serves as a pool evaluator. */
let evaluatorProblem: RefinementProblem | null = null;
/** GPU |F|² accelerator + its spec, set when this evaluator runs the GPU path. */
let gpu: GpuStructureFactor | null = null;
let gpuSpec: Extract<EvaluatorSpec, { kind: "powder" }> | null = null;

async function handle(req: ComputeRequest): Promise<ComputeResponse> {
  try {
    if (req.type === "initEvaluator") {
      evaluatorProblem = buildProblemForSpec(req.spec);
      gpu = null;
      gpuSpec = null;
      // GPU |F|² path: single-phase nuclear powder only. Feature-detected; on any
      // failure the worker just serves the CPU forward model (gpu: false).
      if (req.useGpu && req.spec.kind === "powder") {
        gpu = await GpuStructureFactor.create();
        if (gpu) gpuSpec = req.spec;
      }
      return { requestId: req.requestId, ok: true, ready: true, gpu: gpu !== null };
    }
    if (req.type === "evaluate") {
      if (!evaluatorProblem) throw new Error("evaluate before initEvaluator");
      const results = gpu && gpuSpec
        ? await evaluatePowderBatchOnGpu(gpuSpec, evaluatorProblem, gpu, req.sets)
        : req.sets.map((values) => evaluatorProblem!.calculate(values));
      return { requestId: req.requestId, ok: true, results };
    }
    if (req.type === "refinePowder") {
      // Emit each accepted cycle's calculated curve as a progress message so the
      // UI can animate convergence; the final result is returned below.
      const result = runPowderRefinement(req, (yCalc, rWeighted) =>
        post({ requestId: req.requestId, progress: { yCalc, rWeighted } }),
      );
      return { requestId: req.requestId, ok: true, result };
    }
    if (req.type === "refinePdf") {
      const result = runPdfRefinement(req, (yCalc, rWeighted) =>
        post({ requestId: req.requestId, progress: { yCalc, rWeighted } }),
      );
      return { requestId: req.requestId, ok: true, result };
    }
    if (req.type === "leBailPrefit") {
      const leBail = leBailCellPrefit(req.structure, req.pattern, req.cellParameters, req.cellBindings, {
        shape: req.shape,
        ...(req.eta !== undefined ? { eta: req.eta } : {}),
        ...(req.fitRange ? { fitRange: req.fitRange } : {}),
        ...(req.tof ? { tof: req.tof } : {}),
      });
      return { requestId: req.requestId, ok: true, leBail };
    }
    if (req.type === "refineMagnetic") {
      const problem = buildMagneticSingleCrystalProblem(
        req.structure, req.magnetic, req.dataset, req.parameters, req.bindings,
      );
      const result = refine(problem, req.options ?? {});
      return { requestId: req.requestId, ok: true, result };
    }
    const problem = buildSingleCrystalRefinementProblem(req.structure, req.dataset, req.parameters, req.bindings);
    const result = refine(problem, req.options ?? {});
    return { requestId: req.requestId, ok: true, result };
  } catch (err) {
    return { requestId: req.requestId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

self.addEventListener("message", (event: MessageEvent<ComputeRequest>) => {
  void handle(event.data).then((response) => {
    // Zero-copy the evaluation curves back to the driver.
    const transfer = "results" in response && response.ok ? response.results.map((r) => r.buffer as ArrayBuffer) : [];
    post(response, transfer);
  });
});
