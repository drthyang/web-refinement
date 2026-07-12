/**
 * Node-side evaluator pool for the MCP tools: the same parallel-Jacobian
 * design as the browser's EvaluatorPool, on `node:worker_threads`.
 *
 * Agent workflows call refine tools at high frequency, so the MCP surface gets
 * the pooled engine too. Each worker re-executes THIS bundle with
 * `workerData.__materiaEvaluator` set, builds a problem replica through
 * `buildProblemForSpec` (the same construction path as the driver — the
 * bit-identity invariant), and evaluates value-set batches.
 *
 * Availability is probed once: spawning workers requires a plain-JS entry
 * (the esbuild bundle, `dist/mcp-server.mjs`). Under vitest/vite-node the
 * entry is TypeScript, the probe fails, and callers fall back to the serial
 * driver — behavior is identical either way, only wall-clock differs.
 */

import type { EvaluatorSpec } from "@/workers/protocol";
import type { BatchEvaluator } from "@/core/refinement/engine";
import { buildProblemForSpec } from "@/workers/runPowder";

interface NodeWorkerLike {
  postMessage(msg: unknown): void;
  on(event: "message" | "error", cb: (payload: never) => void): void;
  terminate(): Promise<number>;
}

interface WorkerThreadsModule {
  Worker: new (filename: URL | string, opts: { workerData: unknown }) => NodeWorkerLike;
  isMainThread: boolean;
  parentPort: { postMessage(msg: unknown): void; on(event: "message", cb: (msg: never) => void): void } | null;
  workerData: unknown;
}

const EVALUATOR_FLAG = "__materiaEvaluator";

/**
 * Worker-mode entry: when the bundle is re-executed as a worker thread with
 * the evaluator flag, build the replica and serve evaluate messages forever.
 * Called from the server entry before it would start the stdio transport.
 * Returns true when running as an evaluator (the caller must not start MCP).
 */
export async function maybeRunAsEvaluator(): Promise<boolean> {
  const wt = await workerThreads();
  if (!wt || wt.isMainThread || !wt.parentPort) return false;
  const data = wt.workerData as { [EVALUATOR_FLAG]?: boolean; spec?: EvaluatorSpec } | null;
  if (!data || !data[EVALUATOR_FLAG] || !data.spec) return false;
  const problem = buildProblemForSpec(data.spec);
  wt.parentPort.on("message", (msg: { id: number; sets: Record<string, number>[] }) => {
    try {
      const results = msg.sets.map((values) => problem.calculate(values));
      wt.parentPort!.postMessage({ id: msg.id, ok: true, results });
    } catch (e) {
      wt.parentPort!.postMessage({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return true;
}

async function workerThreads(): Promise<WorkerThreadsModule | null> {
  try {
    return (await import("node:worker_threads")) as unknown as WorkerThreadsModule;
  } catch {
    return null;
  }
}

/** True when the current entry file can be re-executed by a worker thread. */
function runnableEntry(): string | null {
  const url = typeof import.meta !== "undefined" ? import.meta.url : "";
  if (!url.startsWith("file:")) return null;
  if (url.endsWith(".ts") || url.endsWith(".tsx")) return null; // vite-node/vitest — not runnable
  return url;
}

export interface NodeEvaluatorPool extends BatchEvaluator {
  readonly size: number;
  dispose(): Promise<void>;
}

/**
 * Create a worker-thread evaluator pool for `spec`, or null when pooling is
 * unavailable (non-node runtime, TS entry, single-core). Callers fall back to
 * the serial driver on null.
 */
export async function createNodeEvaluatorPool(spec: EvaluatorSpec, maxWorkers = 6): Promise<NodeEvaluatorPool | null> {
  const wt = await workerThreads();
  const entry = runnableEntry();
  if (!wt || !entry) return null;
  const os = await import("node:os").catch(() => null);
  const cores = os ? os.availableParallelism() : 2;
  const size = Math.max(0, Math.min(maxWorkers, cores - 1));
  if (size < 2) return null;

  const workers: NodeWorkerLike[] = [];
  const pending = new Map<number, { resolve: (r: { ok: boolean; results?: Float64Array[]; error?: string }) => void }>();
  let nextId = 1;
  try {
    for (let i = 0; i < size; i++) {
      const w = new wt.Worker(new URL(entry), { workerData: { [EVALUATOR_FLAG]: true, spec } });
      w.on("message", (msg: { id: number; ok: boolean; results?: Float64Array[]; error?: string }) => {
        const entry2 = pending.get(msg.id);
        if (entry2) {
          pending.delete(msg.id);
          entry2.resolve(msg);
        }
      });
      w.on("error", () => {
        /* a dead worker leaves its requests pending; evaluate() will reject via timeout-free design —
           errors surface on the next send as a hang, so treat construction errors as fatal below */
      });
      workers.push(w);
    }
  } catch {
    await Promise.all(workers.map((w) => w.terminate()));
    return null;
  }

  const send = (worker: NodeWorkerLike, sets: Record<string, number>[]): Promise<Float64Array[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {
        resolve: (r) => (r.ok && r.results ? resolve(r.results) : reject(new Error(r.error ?? "evaluator failed"))),
      });
      worker.postMessage({ id, sets });
    });

  return {
    size,
    async evaluate(sets: readonly Record<string, number>[]): Promise<Float64Array[]> {
      const chunkSize = Math.ceil(sets.length / workers.length);
      const jobs: Promise<Float64Array[]>[] = [];
      for (let w = 0, start = 0; w < workers.length && start < sets.length; w++, start += chunkSize) {
        jobs.push(send(workers[w]!, sets.slice(start, start + chunkSize) as Record<string, number>[]));
      }
      return (await Promise.all(jobs)).flat();
    },
    async dispose(): Promise<void> {
      await Promise.all(workers.map((w) => w.terminate()));
      pending.clear();
    },
  };
}
