/**
 * Thin typed client over the compute worker. Components call `refinePowder` /
 * `refineSingleCrystal` and await a RefinementResult; the postMessage plumbing
 * and request/response correlation live here, not in the UI.
 *
 * Falls back to synchronous in-thread computation when Web Workers are
 * unavailable (e.g. during tests), so callers get one uniform async API.
 */

import type {
  ComputeRequest,
  ComputeResponse,
  RefineMagneticRequest,
  RefinePowderRequest,
  RefineSingleCrystalRequest,
} from "@/workers/protocol";
import type { RefinementResult } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import { buildPowderProblem } from "@/core/workflow/powder";
import { buildSingleCrystalProblem } from "@/core/workflow/singleCrystal";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";

type Pending = (response: ComputeResponse) => void;

export class ComputeClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./compute.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<ComputeResponse>) => {
      const resolve = this.pending.get(event.data.requestId);
      if (resolve) {
        this.pending.delete(event.data.requestId);
        resolve(event.data);
      }
    });
    return this.worker;
  }

  private run(req: ComputeRequest): Promise<RefinementResult> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve(runInline(req));
    }
    return new Promise<RefinementResult>((resolve, reject) => {
      this.pending.set(req.requestId, (response) => {
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error));
      });
      worker.postMessage(req);
    });
  }

  refinePowder(req: Omit<RefinePowderRequest, "requestId" | "type">): Promise<RefinementResult> {
    return this.run({ ...req, type: "refinePowder", requestId: this.nextId++ });
  }

  refineSingleCrystal(
    req: Omit<RefineSingleCrystalRequest, "requestId" | "type">,
  ): Promise<RefinementResult> {
    return this.run({ ...req, type: "refineSingleCrystal", requestId: this.nextId++ });
  }

  refineMagnetic(req: Omit<RefineMagneticRequest, "requestId" | "type">): Promise<RefinementResult> {
    return this.run({ ...req, type: "refineMagnetic", requestId: this.nextId++ });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

function runInline(req: ComputeRequest): RefinementResult {
  if (req.type === "refinePowder") {
    const problem = buildPowderProblem(req.structure, req.pattern, req.parameters, req.bindings, {
      shape: req.shape,
      ...(req.eta !== undefined ? { eta: req.eta } : {}),
    });
    return refine(problem, req.options ?? {});
  }
  if (req.type === "refineMagnetic") {
    const problem = buildMagneticSingleCrystalProblem(
      req.structure, req.magnetic, req.dataset, req.parameters, req.bindings,
    );
    return refine(problem, req.options ?? {});
  }
  const problem = buildSingleCrystalProblem(req.structure, req.dataset, req.parameters, req.bindings);
  return refine(problem, req.options ?? {});
}
