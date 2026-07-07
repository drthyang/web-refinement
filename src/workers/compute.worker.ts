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

function handle(req: ComputeRequest): ComputeResponse {
  try {
    if (req.type === "refinePowder") {
      return { requestId: req.requestId, ok: true, result: runPowderRefinement(req) };
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
