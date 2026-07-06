/// <reference lib="webworker" />
/**
 * Compute worker: runs refinement off the main thread so the UI stays
 * responsive. Only the refinement driver lives here; it delegates to the pure
 * core workflow builders.
 */

import type { ComputeRequest, ComputeResponse } from "@/workers/protocol";
import { refine } from "@/core/refinement/engine";
import { buildPowderProblem } from "@/core/workflow/powder";
import { buildSingleCrystalProblem } from "@/core/workflow/singleCrystal";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";

function handle(req: ComputeRequest): ComputeResponse {
  try {
    if (req.type === "refinePowder") {
      const problem = buildPowderProblem(req.structure, req.pattern, req.parameters, req.bindings, {
        shape: req.shape,
        ...(req.eta !== undefined ? { eta: req.eta } : {}),
      });
      const result = refine(problem, req.options ?? {});
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
