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

import type { ComputeRequest, ComputeResponse } from "@/workers/protocol";
import { refine, type RefinementProblem } from "@/core/refinement/engine";
import { buildSingleCrystalRefinementProblem } from "@/core/workflow/singleCrystalRefinement";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { runPowderRefinement, buildProblemForSpec } from "@/workers/runPowder";

const post = (msg: unknown, transfer?: Transferable[]): void =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

/** The problem replica when this worker serves as a pool evaluator. */
let evaluatorProblem: RefinementProblem | null = null;

function handle(req: ComputeRequest): ComputeResponse {
  try {
    if (req.type === "initEvaluator") {
      evaluatorProblem = buildProblemForSpec(req.spec);
      return { requestId: req.requestId, ok: true, ready: true };
    }
    if (req.type === "evaluate") {
      if (!evaluatorProblem) throw new Error("evaluate before initEvaluator");
      const results = req.sets.map((values) => evaluatorProblem!.calculate(values));
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
  const response = handle(event.data);
  // Zero-copy the evaluation curves back to the driver.
  const transfer = "results" in response && response.ok ? response.results.map((r) => r.buffer as ArrayBuffer) : [];
  post(response, transfer);
});
