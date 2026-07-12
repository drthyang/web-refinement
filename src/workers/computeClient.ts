/**
 * Thin typed client over the compute worker. Components call `refinePowder` /
 * `refineSingleCrystal` and await a RefinementResult; the postMessage plumbing
 * and request/response correlation live here, not in the UI.
 *
 * `refinePowderParallel` / `refineMagneticPowderParallel` run the SAME
 * Levenberg–Marquardt core with the Jacobian columns fanned out over a pool of
 * evaluator workers (each holding a bit-identical problem replica); the
 * baseline/trial evaluations run on a local problem instance. Falls back to
 * the single-worker (or in-thread) path when Web Workers are unavailable or
 * the machine has no spare cores.
 */

import type {
  ComputeRequest,
  ComputeResponse,
  EvaluatorSpec,
  RefineMagneticRequest,
  RefinePowderRequest,
  RefineSingleCrystalRequest,
  WorkerMessage,
} from "@/workers/protocol";
import type { RefinementResult, RefinementOptions, AgreementFactors } from "@/core/refinement/types";
import { refine, refineParallel, type BatchEvaluator } from "@/core/refinement/engine";
import { buildSingleCrystalRefinementProblem } from "@/core/workflow/singleCrystalRefinement";
import { buildMagneticSingleCrystalProblem } from "@/core/workflow/magnetic";
import { runPowderRefinement, buildProblemForSpec, type PowderProgress } from "@/workers/runPowder";

type Pending = (response: ComputeResponse) => void;

const workerUrl = (): URL => new URL("./compute.worker.ts", import.meta.url);

/**
 * A pool of evaluator workers for the parallel Jacobian. Each worker holds a
 * problem replica built from the shared spec; `evaluate` splits a batch into
 * contiguous chunks (one per worker), so reassembly preserves order exactly.
 */
class EvaluatorPool implements BatchEvaluator {
  private readonly workers: Worker[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: ComputeResponse) => void }>();

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl(), { type: "module" });
      w.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const msg = event.data;
        if ("progress" in msg) return;
        const entry = this.pending.get(msg.requestId);
        if (entry) {
          this.pending.delete(msg.requestId);
          entry.resolve(msg);
        }
      });
      this.workers.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private send(worker: Worker, req: ComputeRequest): Promise<ComputeResponse> {
    return new Promise((resolve) => {
      this.pending.set(req.requestId, { resolve });
      worker.postMessage(req);
    });
  }

  async init(spec: EvaluatorSpec): Promise<void> {
    const acks = await Promise.all(
      this.workers.map((w) => this.send(w, { type: "initEvaluator", requestId: this.nextId++, spec })),
    );
    for (const ack of acks) {
      if (!ack.ok) throw new Error(`evaluator init failed: ${(ack as { error?: string }).error ?? "unknown"}`);
    }
  }

  async evaluate(sets: readonly Record<string, number>[]): Promise<Float64Array[]> {
    const n = this.workers.length;
    const chunkSize = Math.ceil(sets.length / n);
    const jobs: Promise<ComputeResponse>[] = [];
    for (let w = 0, start = 0; w < n && start < sets.length; w++, start += chunkSize) {
      const chunk = sets.slice(start, start + chunkSize) as Record<string, number>[];
      jobs.push(this.send(this.workers[w]!, { type: "evaluate", requestId: this.nextId++, sets: chunk }));
    }
    const responses = await Promise.all(jobs);
    const out: Float64Array[] = [];
    for (const r of responses) {
      if (!r.ok || !("results" in r)) throw new Error(`evaluation failed: ${(r as { error?: string }).error ?? "bad response"}`);
      out.push(...r.results);
    }
    return out;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.pending.clear();
  }
}

export class ComputeClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly progress = new Map<number, PowderProgress>();
  private activePool: EvaluatorPool | null = null;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(workerUrl(), { type: "module" });
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
        if (response.ok && "result" in response) resolve(response.result);
        else reject(new Error(response.ok ? "unexpected response" : response.error));
      });
      worker.postMessage(req);
    });
  }

  refinePowder(req: Omit<RefinePowderRequest, "requestId" | "type">, onProgress?: PowderProgress): Promise<RefinementResult> {
    return this.run({ ...req, type: "refinePowder", requestId: this.nextId++ }, onProgress);
  }

  /** Pool size: leave one core for the UI/driver; 0 or 1 means "don't pool". */
  private poolSize(): number {
    if (typeof Worker === "undefined") return 0;
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 2 : 2;
    return Math.max(0, Math.min(6, cores - 1));
  }

  /**
   * Flat powder refinement with the Jacobian parallelized over an evaluator
   * pool. Bit-identical to `refinePowder` (same generator core, replica
   * problems from the same builder); falls back to it when pooling is
   * unavailable or the request needs paths the pool does not cover
   * (staged sequences, multi-phase).
   */
  async refinePowderParallel(
    req: Omit<RefinePowderRequest, "requestId" | "type">,
    onProgress?: PowderProgress,
  ): Promise<RefinementResult> {
    const size = this.poolSize();
    if (size < 2 || (req.staged && req.staged.length > 0) || (req.extraPhases && req.extraPhases.length > 0)) {
      return this.refinePowder(req, onProgress);
    }
    const spec: EvaluatorSpec = {
      kind: "powder",
      structure: req.structure,
      pattern: req.pattern,
      parameters: req.parameters,
      bindings: req.bindings,
      ...(req.restraints ? { restraints: req.restraints } : {}),
      shape: req.shape,
      ...(req.eta !== undefined ? { eta: req.eta } : {}),
      ...(req.lorentz !== undefined ? { lorentz: req.lorentz } : {}),
      ...(req.backgroundType !== undefined ? { backgroundType: req.backgroundType } : {}),
      ...(req.fitRange ? { fitRange: req.fitRange } : {}),
    };
    return this.runParallel(spec, req.options ?? {}, req.pattern.points.length, onProgress);
  }

  /** Nuclear + magnetic powder co-refinement through the evaluator pool. */
  async refineMagneticPowderParallel(
    spec: Omit<Extract<EvaluatorSpec, { kind: "magneticPowder" }>, "kind">,
    options: Partial<RefinementOptions> = {},
    onProgress?: PowderProgress,
  ): Promise<RefinementResult> {
    const full: EvaluatorSpec = { kind: "magneticPowder", ...spec };
    const size = this.poolSize();
    if (size < 2) {
      const problem = buildProblemForSpec(full);
      return refine(problem, options);
    }
    return this.runParallel(full, options, spec.pattern.points.length, onProgress);
  }

  private async runParallel(
    spec: EvaluatorSpec,
    options: Partial<RefinementOptions>,
    patternLen: number,
    onProgress?: PowderProgress,
  ): Promise<RefinementResult> {
    const pool = new EvaluatorPool(this.poolSize());
    this.activePool = pool;
    try {
      await pool.init(spec);
      const problem = buildProblemForSpec(spec);
      const onIteration = onProgress
        ? (yCalc: Float64Array, agreement: AgreementFactors): void =>
            onProgress(Array.from(yCalc.subarray(0, patternLen)), agreement.rWeighted ?? 0)
        : undefined;
      return await refineParallel(problem, { ...options, ...(onIteration ? { onIteration } : {}) }, pool);
    } finally {
      pool.dispose();
      if (this.activePool === pool) this.activePool = null;
    }
  }

  refineSingleCrystal(
    req: Omit<RefineSingleCrystalRequest, "requestId" | "type">,
  ): Promise<RefinementResult> {
    return this.run({ ...req, type: "refineSingleCrystal", requestId: this.nextId++ });
  }

  /** Single-crystal refinement with the Jacobian over the evaluator pool —
   *  nearly every SC parameter is geometry (each column recomputes all |F|²),
   *  so large aniso-ADP refinements scale with the pool size. */
  async refineSingleCrystalParallel(
    req: Omit<RefineSingleCrystalRequest, "requestId" | "type">,
  ): Promise<RefinementResult> {
    if (this.poolSize() < 2) return this.refineSingleCrystal(req);
    const spec: EvaluatorSpec = { kind: "singleCrystal", structure: req.structure, dataset: req.dataset, parameters: req.parameters, bindings: req.bindings };
    return this.runParallel(spec, req.options ?? {}, req.dataset.reflections.length);
  }

  refineMagnetic(req: Omit<RefineMagneticRequest, "requestId" | "type">): Promise<RefinementResult> {
    return this.run({ ...req, type: "refineMagnetic", requestId: this.nextId++ });
  }

  /** Magnetic single-crystal (nuclear + moments) through the evaluator pool. */
  async refineMagneticParallel(req: Omit<RefineMagneticRequest, "requestId" | "type">): Promise<RefinementResult> {
    if (this.poolSize() < 2) return this.refineMagnetic(req);
    const spec: EvaluatorSpec = { kind: "magneticSingleCrystal", structure: req.structure, magnetic: req.magnetic, dataset: req.dataset, parameters: req.parameters, bindings: req.bindings };
    return this.runParallel(spec, req.options ?? {}, req.dataset.reflections.length);
  }

  /** Abort any in-flight refinement: terminate the worker(s) (fresh ones are
   *  created on the next run) and reject every pending request as cancelled. */
  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.activePool?.dispose();
    this.activePool = null;
    for (const [requestId, resolve] of this.pending) {
      resolve({ requestId, ok: false, error: CANCELLED });
    }
    this.pending.clear();
    this.progress.clear();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.activePool?.dispose();
    this.activePool = null;
    this.pending.clear();
  }
}

/** Error message a cancelled refinement rejects with (callers detect it). */
export const CANCELLED = "__refinement_cancelled__";

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
  if (req.type === "refineSingleCrystal") {
    const problem = buildSingleCrystalRefinementProblem(req.structure, req.dataset, req.parameters, req.bindings);
    return refine(problem, req.options ?? {});
  }
  throw new Error(`request type ${req.type} has no in-thread fallback`);
}
