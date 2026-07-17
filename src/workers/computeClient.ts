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
  EvaluatorReady,
  EvaluatorSpec,
  LeBailPrefitRequest,
  RefineMagneticRequest,
  RefinePdfRequest,
  RefinePowderRequest,
  RefineSingleCrystalRequest,
  WorkerMessage,
} from "@/workers/protocol";
import { leBailCellPrefit, type LeBailPrefitResult } from "@/core/workflow/leBailPrefit";
import type { RefinementResult, RefinementOptions, AgreementFactors, RefinementParameter } from "@/core/refinement/types";
import { refine, refineParallel, type BatchEvaluator } from "@/core/refinement/engine";
import { buildSingleCrystalRefinementProblem } from "@/core/workflow/singleCrystalRefinement";
import { buildMagneticSingleCrystalProblem, applyMagneticMoments } from "@/core/workflow/magnetic";
import { runPowderRefinement, runPdfRefinement, buildProblemForSpec, type PowderProgress } from "@/workers/runPowder";
import { refineStagedAsync } from "@/core/refinement/staged";
import { stagesFromKindGroups } from "@/core/workflow/structureRefinement";
import { refineMultiStart, type MultiStartOptions, type MultiStartResult } from "@/core/refinement/multiStart";
import { isMomentParameterKind } from "@/core/refinement/types";
import { canonicalizeMomentValues, momentDegeneracies, type MomentDegeneracy } from "@/core/magnetic/canonicalize";

type Pending = (response: ComputeResponse) => void;

/**
 * Spawn the compute worker. The `new URL("./compute.worker.ts", import.meta.url)`
 * must appear LITERALLY inside `new Worker(...)` — Vite detects that exact pattern
 * to emit a proper worker chunk. Hiding it behind a helper made Vite treat the
 * `.ts` as a generic asset and inline it as a `data:video/mp2t` URL, which a
 * module worker refuses to load, so `EvaluatorPool.init` awaited an ack that never
 * came and the whole refinement hung. Keep the pattern inline at every call site.
 */
function spawnWorker(): Worker {
  return new Worker(new URL("./compute.worker.ts", import.meta.url), { type: "module" });
}

/** WebGPU present on this thread — a reliable proxy for the worker having it too
 *  (same browser), used to decide whether to try the GPU |F|² evaluator. */
function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

/** Write a refinement result's converged values + esds back onto a copy of the
 *  starting parameters (for the multi-start driver to perturb the next start). */
function applyResultToParams(
  start: readonly RefinementParameter[],
  result: RefinementResult,
): RefinementParameter[] {
  return start.map((p) => {
    const e = result.esd[p.id];
    return { ...p, value: result.parameters[p.id] ?? p.value, ...(e !== undefined ? { esd: e } : {}) };
  });
}

/**
 * A single evaluator worker that sources the Jacobian's |F|² from the WebGPU
 * structure-factor kernel. Unlike the CPU pool it does NOT split the batch: one
 * worker receives every column so the kernel can batch them in one dispatch (the
 * GPU serializes work regardless, so more workers would not help and each would
 * spin up its own device). Off the driver thread, so the UI stays free.
 */
class GpuEvaluator implements BatchEvaluator {
  private readonly worker = spawnWorker();
  private nextId = 1;
  private readonly pending = new Map<number, (r: ComputeResponse) => void>();

  constructor() {
    this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if ("progress" in msg) return;
      const resolve = this.pending.get(msg.requestId);
      if (resolve) {
        this.pending.delete(msg.requestId);
        resolve(msg);
      }
    });
    // A worker that fails to load (bad chunk URL, CSP, network) fires `error`
    // before any message; reject every pending request so init/evaluate throws
    // instead of awaiting forever. runParallel then falls back to the CPU pool.
    this.worker.addEventListener("error", () => this.failAll("gpu evaluator worker failed to load"));
  }

  private failAll(error: string): void {
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ requestId: id, ok: false, error });
    }
  }

  private send(req: ComputeRequest): Promise<ComputeResponse> {
    return new Promise((resolve) => {
      this.pending.set(req.requestId, resolve);
      this.worker.postMessage(req);
    });
  }

  /** Build the replica and try to engage the GPU. Returns whether it engaged. */
  async init(spec: EvaluatorSpec): Promise<boolean> {
    const ack = await this.send({ type: "initEvaluator", requestId: this.nextId++, spec, useGpu: true });
    if (!ack.ok) throw new Error(`gpu evaluator init failed: ${(ack as { error?: string }).error ?? "unknown"}`);
    return (ack as EvaluatorReady).gpu === true;
  }

  async evaluate(sets: readonly Record<string, number>[]): Promise<Float64Array[]> {
    const r = await this.send({ type: "evaluate", requestId: this.nextId++, sets: sets as Record<string, number>[] });
    if (!r.ok || !("results" in r)) throw new Error(`gpu evaluation failed: ${(r as { error?: string }).error ?? "bad response"}`);
    return r.results;
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

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
      const w = spawnWorker();
      w.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
        const msg = event.data;
        if ("progress" in msg) return;
        const entry = this.pending.get(msg.requestId);
        if (entry) {
          this.pending.delete(msg.requestId);
          entry.resolve(msg);
        }
      });
      // A worker that fails to load fires `error` before any message — fail every
      // pending request so `init`/`evaluate` throws instead of hanging forever
      // (the bug that inlined the worker as a data: URL and spun the UI).
      w.addEventListener("error", () => {
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          entry.resolve({ requestId: id, ok: false, error: "evaluator worker failed to load" });
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

/** Result of {@link ComputeClient.refineMagneticPowderMultiStart}: the standard
 *  multi-start report plus the magnetic degeneracies (flat directions / ±m sign)
 *  detected at the final converged state. */
export interface MagneticMultiStartResult extends MultiStartResult {
  readonly degeneracies: MomentDegeneracy[];
}

export class ComputeClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly progress = new Map<number, PowderProgress>();
  private activePool: EvaluatorPool | null = null;
  private activeGpu: GpuEvaluator | null = null;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = spawnWorker();
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
    // Surface a worker load failure as a rejected request rather than an infinite
    // wait (see spawnWorker's note on the data:-URL hang).
    this.worker.addEventListener("error", () => {
      for (const [id, resolve] of this.pending) {
        this.pending.delete(id);
        this.progress.delete(id);
        resolve({ requestId: id, ok: false, error: "compute worker failed to load" });
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

  /** Real-space PDF refinement off the main thread (inline in node/tests). */
  refinePdf(req: Omit<RefinePdfRequest, "requestId" | "type">, onProgress?: PowderProgress): Promise<RefinementResult> {
    return this.run({ ...req, type: "refinePdf", requestId: this.nextId++ }, onProgress);
  }

  /**
   * Le Bail cell pre-fit off the main thread: refine the cell against peak
   * positions with free intensities (no structure), returning the refined cell +
   * free-cell values to seed a structural refinement. Runs inline only when no
   * worker is available (node/tests).
   */
  leBailPrefit(req: Omit<LeBailPrefitRequest, "requestId" | "type">): Promise<LeBailPrefitResult> {
    const worker = this.ensureWorker();
    const full: LeBailPrefitRequest = { ...req, type: "leBailPrefit", requestId: this.nextId++ };
    if (!worker) {
      return Promise.resolve(leBailCellPrefit(req.structure, req.pattern, req.cellParameters, req.cellBindings, {
        shape: req.shape,
        ...(req.eta !== undefined ? { eta: req.eta } : {}),
        ...(req.fitRange ? { fitRange: req.fitRange } : {}),
        ...(req.tof ? { tof: req.tof } : {}),
      }));
    }
    return new Promise<LeBailPrefitResult>((resolve, reject) => {
      this.pending.set(full.requestId, (response) => {
        if (response.ok && "leBail" in response) resolve(response.leBail);
        else reject(new Error(response.ok ? "unexpected response" : response.error));
      });
      worker.postMessage(full);
    });
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
  /** The evaluator spec for a powder request (single-phase or multi-phase). */
  private powderSpec(req: Omit<RefinePowderRequest, "requestId" | "type">): EvaluatorSpec {
    const multiPhase = req.extraPhases && req.extraPhases.length > 0;
    return multiPhase
      ? {
          kind: "multiPhasePowder",
          phases: [{ structure: req.structure, id: req.structure.id }, ...req.extraPhases!.map((st) => ({ structure: st, id: st.id }))],
          pattern: req.pattern,
          parameters: req.parameters,
          bindings: req.bindings,
          shape: req.shape,
          ...(req.eta !== undefined ? { eta: req.eta } : {}),
          ...(req.fitRange ? { fitRange: req.fitRange } : {}),
        }
      : {
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
  }

  /**
   * PDF refinement with the Jacobian parallelized over the evaluator pool —
   * same replica-construction guarantee as the powder path (both sides build
   * from `buildProblemForSpec`, so pooled and serial are bit-identical). The
   * staged sequence runs each stage's Jacobian on the pool too; falls back to
   * the single-worker `refinePdf` when pooling is unavailable.
   */
  async refinePdfParallel(
    req: Omit<RefinePdfRequest, "requestId" | "type">,
    onProgress?: PowderProgress,
  ): Promise<RefinementResult> {
    const size = this.poolSize();
    if (size < 2) {
      return this.refinePdf(req, onProgress);
    }
    const spec: EvaluatorSpec = {
      kind: "pdf",
      structure: req.structure,
      ...(req.extraPhases && req.extraPhases.length ? { extraPhases: req.extraPhases } : {}),
      pattern: req.pattern,
      parameters: req.parameters,
      bindings: req.bindings,
      ...(req.restraints && req.restraints.length ? { restraints: req.restraints } : {}),
      ...(req.fitRange ? { fitRange: req.fitRange } : {}),
    };
    if (req.staged && req.staged.length > 0) {
      return this.runStagedParallel(spec, req.staged, req.options ?? {}, req.pattern.points.length, onProgress);
    }
    return this.runParallel(spec, req.options ?? {}, req.pattern.points.length, onProgress, false);
  }

  async refinePowderParallel(
    req: Omit<RefinePowderRequest, "requestId" | "type">,
    onProgress?: PowderProgress,
  ): Promise<RefinementResult> {
    const size = this.poolSize();
    if (size < 2) {
      return this.refinePowder(req, onProgress);
    }
    const spec = this.powderSpec(req);
    if (req.staged && req.staged.length > 0) {
      // Staged sequence with every stage's Jacobian on the pool. One init
      // serves all stages: replicas evaluate from the full values record, so
      // stage-local fixed flags and carried values never touch them.
      return this.runStagedParallel(spec, req.staged, req.options ?? {}, req.pattern.points.length, onProgress);
    }
    return this.runParallel(spec, req.options ?? {}, req.pattern.points.length, onProgress, req.useGpu ?? false);
  }

  /**
   * Multi-start powder refinement (escape local minima): one baseline refine
   * plus `multiStart.restarts` perturbed restarts, keeping the lowest-χ² result.
   * Every start is a full pool-parallel refine sharing ONE evaluator pool (init
   * once, reuse across restarts), so the cost is ~(restarts+1)× a single refine
   * without repeated worker spin-up. Works for single- and multi-phase powder.
   */
  async refinePowderMultiStart(
    req: Omit<RefinePowderRequest, "requestId" | "type">,
    multiStart: MultiStartOptions = {},
    onProgress?: PowderProgress,
  ): Promise<MultiStartResult> {
    const spec = this.powderSpec(req);
    const options = req.options ?? {};
    const patternLen = req.pattern.points.length;

    if (this.poolSize() < 2) {
      // No pool: run each start in-thread through the serial engine.
      const runOnce = (start: readonly RefinementParameter[]): { parameters: RefinementParameter[]; final: RefinementResult } => {
        const result = refine(buildProblemForSpec({ ...spec, parameters: [...start] }), options);
        return { parameters: applyResultToParams(start, result), final: result };
      };
      return refineMultiStart(spec.parameters, runOnce, multiStart);
    }

    const pool = new EvaluatorPool(this.poolSize());
    this.activePool = pool;
    try {
      await pool.init(spec);
      const onIteration = onProgress
        ? (yCalc: Float64Array, agreement: AgreementFactors): void =>
            onProgress(Array.from(yCalc.subarray(0, patternLen)), agreement.rWeighted ?? 0)
        : undefined;
      const runOnce = async (start: readonly RefinementParameter[]): Promise<{ parameters: RefinementParameter[]; final: RefinementResult }> => {
        const problem = buildProblemForSpec({ ...spec, parameters: [...start] });
        const result = await refineParallel(problem, { ...options, ...(onIteration ? { onIteration } : {}) }, pool);
        return { parameters: applyResultToParams(start, result), final: result };
      };
      return await refineMultiStart(spec.parameters, runOnce, multiStart);
    } finally {
      pool.dispose();
      if (this.activePool === pool) this.activePool = null;
    }
  }

  private async runStagedParallel(
    spec: EvaluatorSpec,
    staged: RefinePowderRequest["staged"] & object,
    options: Partial<RefinementOptions>,
    patternLen: number,
    onProgress?: PowderProgress,
  ): Promise<RefinementResult> {
    const pool = new EvaluatorPool(this.poolSize());
    this.activePool = pool;
    try {
      await pool.init(spec);
      const onIteration = onProgress
        ? (yCalc: Float64Array, agreement: AgreementFactors): void =>
            onProgress(Array.from(yCalc.subarray(0, patternLen)), agreement.rWeighted ?? 0)
        : undefined;
      const opts = { ...options, ...(onIteration ? { onIteration } : {}) };
      const out = await refineStagedAsync(
        spec.parameters,
        (params) => buildProblemForSpec({ ...spec, parameters: [...params] }),
        stagesFromKindGroups(staged),
        opts,
        (problem, o) => refineParallel(problem, o, pool),
      );
      if (!out.final) throw new Error("staged refinement unlocked no parameters");
      return out.final;
    } finally {
      pool.dispose();
      if (this.activePool === pool) this.activePool = null;
    }
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

  /**
   * Local-minimum-resistant magnetic powder refinement — the "Escape min" path
   * for magnetic structures (GAP #1). Phase 1a on Mn₃Ga showed the instability is
   * NOT distinct deep minima but a near-flat "sublattice-partition" valley plus
   * the global time-reversal (±m) degeneracy (docs/REFINEMENT_NOTES.md). So the
   * strategy is, cheapest-sufficient-first:
   *
   *  1. FREEZE the nuclear scaffold and search ONLY the moment subspace with the
   *     existing seeded multi-start — leaving the TOF profile free during the
   *     moment search is exactly what let one 1a start diverge, and the
   *     moment↔moment flat direction reads clean only with nuclear held.
   *  2. Seed the best moment partition into ONE final joint LM over the caller's
   *     full freed set; e.s.d.s and correlations are reported from that step only.
   *  3. Canonicalize the global sign so ±m twins collapse to one deterministic
   *     answer, and surface the data-limited (flat) directions as a degeneracy
   *     report rather than pretending a unique partition.
   *
   * Basin hopping is intentionally NOT added: 1a found no discrete basins to hop
   * between (23/24 starts within <1% of the same χ²).
   */
  async refineMagneticPowderMultiStart(
    spec: Omit<Extract<EvaluatorSpec, { kind: "magneticPowder" }>, "kind">,
    multiStart: MultiStartOptions = {},
    options: Partial<RefinementOptions> = {},
    onProgress?: PowderProgress,
  ): Promise<MagneticMultiStartResult> {
    const params = spec.parameters;
    const isMoment = (p: RefinementParameter): boolean => isMomentParameterKind(p.kind);
    const specWith = (parameters: readonly RefinementParameter[]): Extract<EvaluatorSpec, { kind: "magneticPowder" }> =>
      ({ kind: "magneticPowder", ...spec, parameters: [...parameters] });

    // (1) Freeze the nuclear scaffold for the restart search: only the moment
    // modes move. Fixed/tied parameters are left as-is.
    const frozenNuclear = params.map((p) =>
      !isMoment(p) && !p.fixed && !p.expression ? { ...p, fixed: true } : { ...p },
    );

    // Each restart is a moment-only solve, run in-thread: the moment subspace is
    // a handful of columns, so the parallel Jacobian would spend more on pool
    // spin-up than it saves — and in-thread keeps the search bit-reproducible.
    const runOnce = (start: readonly RefinementParameter[]): { parameters: RefinementParameter[]; final: RefinementResult } => {
      const result = refine(buildProblemForSpec(specWith(start)), options);
      return { parameters: applyResultToParams(start, result), final: result };
    };
    const ms = await refineMultiStart(frozenNuclear, runOnce, {
      // Cold moment search: kick modes (often seeded at 0) by a µ_B-scale amount.
      escapeSigma: 6,
      relFraction: 1,
      ...multiStart,
      shouldPerturb: isMoment,
    });

    // (2) Final joint LM from the best moment partition over the caller's full
    // freed set (nuclear un-frozen). Pool-accelerated when workers are present —
    // this is the one solve with many nuclear columns.
    const jointStart = params.map((p) => {
      const best = ms.parameters.find((q) => q.id === p.id);
      return isMoment(p) && best ? { ...p, value: best.value } : { ...p };
    });
    const joint = await this.refineMagneticPowderParallel(specWith(jointStart), options, onProgress);

    // (3) Canonicalize the global sign and collect degeneracies from the final
    // diagnostics (built on the engine's existing SVD/correlation output).
    const refinedMag = applyMagneticMoments(spec.magnetic, spec.bindings, joint.parameters);
    const canonValues = canonicalizeMomentValues(joint.parameters, refinedMag, spec.structure.cell, params);
    const finalResult: RefinementResult = { ...joint, parameters: canonValues };
    return {
      final: finalResult,
      parameters: applyResultToParams(jointStart, finalResult),
      restartsRun: ms.restartsRun,
      bestStartIndex: ms.bestStartIndex,
      improved: ms.improved,
      costByStart: ms.costByStart,
      degeneracies: momentDegeneracies(joint.diagnostics, params),
    };
  }

  private async runParallel(
    spec: EvaluatorSpec,
    options: Partial<RefinementOptions>,
    patternLen: number,
    onProgress?: PowderProgress,
    useGpu = false,
  ): Promise<RefinementResult> {
    const onIteration = onProgress
      ? (yCalc: Float64Array, agreement: AgreementFactors): void =>
          onProgress(Array.from(yCalc.subarray(0, patternLen)), agreement.rWeighted ?? 0)
      : undefined;
    const opts = { ...options, ...(onIteration ? { onIteration } : {}) };

    // GPU |F|² path (opt-in): single-phase nuclear powder batches its Jacobian
    // columns through the structure-factor kernel in ONE worker. Falls through to
    // the CPU pool when not requested, WebGPU is unavailable, or the worker could
    // not engage it — the baseline/trial evaluations stay on the driver either way.
    if (useGpu && spec.kind === "powder" && hasWebGpu()) {
      const gpuEval = new GpuEvaluator();
      let engaged = false;
      try {
        engaged = await gpuEval.init(spec);
      } catch {
        engaged = false;
      }
      if (engaged) {
        this.activeGpu = gpuEval;
        try {
          return await refineParallel(buildProblemForSpec(spec), opts, gpuEval);
        } finally {
          gpuEval.dispose();
          if (this.activeGpu === gpuEval) this.activeGpu = null;
        }
      }
      gpuEval.dispose();
    }

    const pool = new EvaluatorPool(this.poolSize());
    this.activePool = pool;
    try {
      await pool.init(spec);
      return await refineParallel(buildProblemForSpec(spec), opts, pool);
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

  /**
   * Local-minimum-resistant magnetic single-crystal refinement — the "escape min"
   * path for a single magnetic dataset (the merged magnetic-supercell `.int`,
   * whose nuclear reflections and satellites live in ONE dataset). Same shape as
   * the powder and joint siblings: freeze the nuclear scaffold, search the moment
   * subspace from a seeded multi-start, seed the best partition into one final LM
   * over the caller's full freed set, canonicalize the global ±m sign, and report
   * the data-limited moment directions.
   */
  async refineMagneticSingleCrystalMultiStart(
    spec: Omit<Extract<EvaluatorSpec, { kind: "magneticSingleCrystal" }>, "kind">,
    multiStart: MultiStartOptions = {},
    options: Partial<RefinementOptions> = {},
  ): Promise<MagneticMultiStartResult> {
    const params = spec.parameters;
    const isMoment = (p: RefinementParameter): boolean => isMomentParameterKind(p.kind);
    const specWith = (parameters: readonly RefinementParameter[]): Extract<EvaluatorSpec, { kind: "magneticSingleCrystal" }> =>
      ({ kind: "magneticSingleCrystal", ...spec, parameters: [...parameters] });

    const frozenNuclear = params.map((p) => (!isMoment(p) && !p.fixed && !p.expression ? { ...p, fixed: true } : { ...p }));
    const runOnce = (start: readonly RefinementParameter[]): { parameters: RefinementParameter[]; final: RefinementResult } => {
      const r = refine(buildProblemForSpec(specWith(start)), options);
      return { parameters: applyResultToParams(start, r), final: r };
    };
    const ms = await refineMultiStart(frozenNuclear, runOnce, {
      escapeSigma: 6,
      relFraction: 1,
      ...multiStart,
      shouldPerturb: isMoment,
    });

    const jointStart = params.map((p) => {
      const best = ms.parameters.find((q) => q.id === p.id);
      return isMoment(p) && best ? { ...p, value: best.value } : { ...p };
    });
    // Forward the caller's options to the FINAL LM (the solve that produces the
    // reported values/e.s.d.s) — the powder/joint siblings do; without it this
    // result-producing step silently runs at the engine defaults.
    const joint = await this.refineMagneticParallel({ ...spec, parameters: jointStart, options });

    const refinedMag = applyMagneticMoments(spec.magnetic, spec.bindings, joint.parameters);
    const canonValues = canonicalizeMomentValues(joint.parameters, refinedMag, spec.structure.cell, params);
    const finalResult: RefinementResult = { ...joint, parameters: canonValues };
    return {
      final: finalResult,
      parameters: applyResultToParams(jointStart, finalResult),
      restartsRun: ms.restartsRun,
      bestStartIndex: ms.bestStartIndex,
      improved: ms.improved,
      costByStart: ms.costByStart,
      degeneracies: momentDegeneracies(joint.diagnostics, params),
    };
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
    this.activeGpu?.dispose();
    this.activeGpu = null;
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
    this.activeGpu?.dispose();
    this.activeGpu = null;
    this.pending.clear();
  }
}

/** Error message a cancelled refinement rejects with (callers detect it). */
export const CANCELLED = "__refinement_cancelled__";

function runInline(req: ComputeRequest, onProgress?: PowderProgress): RefinementResult {
  if (req.type === "refinePowder") {
    return runPowderRefinement(req, onProgress);
  }
  if (req.type === "refinePdf") {
    return runPdfRefinement(req, onProgress);
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
