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
  WorkerMessage,
} from "@/workers/protocol";
import type { RefinementResult } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import { buildSingleCrystalRefinementProblem } from "@/core/workflow/singleCrystalRefinement";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { runPowderRefinement, type PowderProgress } from "@/workers/runPowder";

type Pending = (response: ComputeResponse) => void;

export class ComputeClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly progress = new Map<number, PowderProgress>();

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./compute.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if ("progress" in msg) {
        this.progress.get(msg.requestId)?.(msg.progress.yCalc, msg.progress.rWeighted);
        return;
      }
      const resolve = this.pending.get(msg.requestId);
      if (resolve) {
        this.pending.delete(msg.requestId);
        this.progress.delete(msg.requestId);
        resolve(msg);
      }
    });
    return this.worker;
  }

  private run(req: ComputeRequest, onProgress?: PowderProgress): Promise<RefinementResult> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve(runInline(req, onProgress));
    }
    return new Promise<RefinementResult>((resolve, reject) => {
      if (onProgress) this.progress.set(req.requestId, onProgress);
      this.pending.set(req.requestId, (response) => {
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error));
      });
      worker.postMessage(req);
    });
  }

  refinePowder(req: Omit<RefinePowderRequest, "requestId" | "type">, onProgress?: PowderProgress): Promise<RefinementResult> {
    return this.run({ ...req, type: "refinePowder", requestId: this.nextId++ }, onProgress);
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

function runInline(req: ComputeRequest, onProgress?: PowderProgress): RefinementResult {
  if (req.type === "refinePowder") {
    return runPowderRefinement(req, onProgress);
  }
  if (req.type === "refineMagnetic") {
    const problem = buildMagneticSingleCrystalProblem(
      req.structure, req.magnetic, req.dataset, req.parameters, req.bindings,
    );
    return refine(problem, req.options ?? {});
  }
  const problem = buildSingleCrystalRefinementProblem(req.structure, req.dataset, req.parameters, req.bindings);
  return refine(problem, req.options ?? {});
}
