/// <reference lib="webworker" />
/**
 * Compute worker: runs refinement off the main thread so the UI stays
 * responsive. Only the refinement driver lives here; it delegates to the pure
 * core workflow builders.
 */

import type { ComputeRequest, ComputeResponse } from "@/workers/protocol";
import { refine } from "@/core/refinement/engine";
import { buildSingleCrystalProblem } from "@/core/workflow/singleCrystal";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { runPowderRefinement } from "@/workers/runPowder";

const post = (msg: unknown): void => (self as DedicatedWorkerGlobalScope).postMessage(msg);

function handle(req: ComputeRequest): ComputeResponse {
  try {
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
    const problem = buildSingleCrystalProblem(req.structure, req.dataset, req.parameters, req.bindings);
    const result = refine(problem, req.options ?? {});
    return { requestId: req.requestId, ok: true, result };
  } catch (err) {
    return { requestId: req.requestId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

self.addEventListener("message", (event: MessageEvent<ComputeRequest>) => {
  const response = handle(event.data);
  (self as DedicatedWorkerGlobalScope).postMessage(response);
});
