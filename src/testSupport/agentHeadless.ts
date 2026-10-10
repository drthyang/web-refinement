/**
 * The Agent's pages without React, for tests and the eval suite: a powder
 * session and the GaTa4Se8 PDF demo behind real ports (the real curves and
 * the real engine), a host that keeps the Agent's records in memory, and an
 * executor that has read the pages' methods.
 */

import { AgentExecutor, type ActivityEntry, type AgentHost } from "@/agent/executor";
import { PAGE_METHOD } from "@/agent/skills";
import { emptyRecord, type AgentRecord } from "@/agent/method";
import type { AgentPort, PdfAgentPort, PdfLiveState, PowderAgentPort, PowderLiveState } from "@/agent/port";
import { gata4se8PdfExample } from "@/examples/gata4se8Pdf";
import { buildPdfProblem, buildPdfSpec, pdfCurves } from "@/core/workflow/pdf";
import { applyParameters } from "@/core/workflow/apply";
import { refine as refineProblem } from "@/core/refinement/engine";
import { boxcarWindows } from "@/core/workflow/pdfBoxcar";
import type { Session } from "@/app/powderSession";
import { powderRestraints } from "@/app/powderSpec";
import { powderCurves } from "@/core/workflow/powder";
import { runPowderRefinement } from "@/workers/runPowder";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";
import { excludedPointMask } from "@/core/refinement/factors";
import type { RefinementResult } from "@/core/refinement/types";
import type { StepKind } from "@/core/project/history";

/**
 * A powder page without React: a session, the real curves and the real
 * engine behind the port, so the tools judge an actual fit.
 */
export function sessionPort(start: Session): { port: PowderAgentPort; calls: string[]; session: () => Session } {
  let s = start;
  let result: RefinementResult | null = null;
  let fitRange: { min: number; max: number } | null = null;
  const calls: string[] = [];
  const state = (): PowderLiveState => {
    const curves = powderCurves(s.structure, s.pattern, s.powderParams, s.powderBindings, s.powderProfile);
    const xs = curves.x;
    const excluded = excludedPointMask(curves.yObs);
    let num = 0;
    let den = 0;
    let n = 0;
    curves.yObs.forEach((o, i) => {
      if (excluded[i]) return;
      n++;
      const w = 1 / Math.max(o, 1);
      num += w * (o - curves.yCalc[i]!) ** 2;
      den += w * o * o;
    });
    return {
      structure: s.structure,
      extraPhases: s.extraPhases,
      refinedPhases: [s.structure],
      pattern: s.pattern,
      parameters: s.powderParams,
      bindings: s.powderBindings,
      profile: s.powderProfile,
      magnetic: null,
      result,
      instrument: null,
      fitRange,
      extent: { min: Math.min(...xs), max: Math.max(...xs) },
      busy: false,
      viewOnly: false,
      wR: Math.sqrt(num / den),
      settings: { backgroundTerms: s.backgroundTerms, backgroundType: "chebyshev", mustrain: "isotropic", anisotropicAdp: false, siteTies: s.siteTies },
      curves,
      d: convertAxisArray(curves.x, s.pattern.xUnit, "dSpacing", axisContext(s.pattern)),
      observationCount: n,
      axis: axisContext(s.pattern),
      source: "test",
      restraints: powderRestraints([s.structure], s.siteTies, s.powderParams),
    };
  };
  const refine = async (): Promise<string | null> => {
    calls.push("refine");
    const r = runPowderRefinement({
      type: "refinePowder",
      requestId: 0,
      structure: s.structure,
      pattern: s.pattern,
      parameters: s.powderParams,
      bindings: s.powderBindings,
      shape: s.powderProfile.shape,
      restraints: powderRestraints([s.structure], s.siteTies, s.powderParams),
      options: { maxIterations: 20 },
    });
    s = { ...s, powderParams: s.powderParams.map((p) => ({ ...p, value: r.parameters[p.id] ?? p.value })) };
    result = r;
    return null;
  };
  const port: PowderAgentPort = {
    technique: "powder",
    state,
    setFixed: (changes) => {
      calls.push(`setFixed ${changes.map((c) => `${c.id}=${c.fixed}`).join(",")}`);
      const m = new Map(changes.map((c) => [c.id, c.fixed]));
      s = { ...s, powderParams: s.powderParams.map((p) => (m.has(p.id) ? { ...p, fixed: m.get(p.id)! } : p)) };
    },
    setBackgroundTerms: (n) => calls.push(`terms ${n}`),
    setBackgroundType: (t) => calls.push(`type ${t}`),
    setMustrain: (m) => calls.push(`mustrain ${m}`),
    setAnisotropicAdp: (on) => calls.push(`adp ${on}`),
    setSiteTies: (update) => {
      calls.push(`ties ${JSON.stringify(update)}`);
      s = { ...s, siteTies: { ...s.siteTies, ...update } };
    },
    setFitRange: (r) => {
      calls.push(`range ${r ? `${r.min}-${r.max}` : "whole"}`);
      fitRange = r ? { ...r } : null;
    },
    showPeaks: (peaks) => calls.push(`showPeaks ${peaks.map((p) => p.d.toFixed(3)).join(",")}`),
    refine,
    thorough: refine,
    probe: async (options) => {
      calls.push("probe");
      return runPowderRefinement({
        type: "refinePowder",
        requestId: 0,
        structure: s.structure,
        pattern: s.pattern,
        parameters: s.powderParams,
        bindings: s.powderBindings,
        shape: s.powderProfile.shape,
        restraints: powderRestraints([s.structure], s.siteTies, s.powderParams),
        options,
      });
    },
    cancel: () => calls.push("cancel"),
    reset: () => calls.push("reset"),
  };
  return { port, calls, session: () => s };
}

export function fakeHost(port: AgentPort | null): { host: AgentHost; steps: { kind: StepKind; agent: boolean }[]; records: Map<string, AgentRecord> } {
  const steps: { kind: StepKind; agent: boolean }[] = [];
  const records = new Map<string, AgentRecord>();
  let agent = false;
  const host: AgentHost = {
    port: () => port,
    technique: () => port?.technique ?? null,
    settle: async () => undefined,
    asAgent: async (fn) => {
      agent = true;
      try {
        return await fn();
      } finally {
        agent = false;
      }
    },
    recordNow: (kind) => steps.push({ kind, agent }),
    history: () => null,
    goToStep: () => undefined,
    record: (key) => records.get(key) ?? emptyRecord(key),
    updateRecord: (key, update) => void records.set(key, update(records.get(key) ?? emptyRecord(key))),
  };
  return { host, steps, records };
}

/**
 * An executor as a conversation has it once the pages' methods are read
 * (`readMethods: false` for one that has read nothing yet). The reads run
 * before the activity is recorded, so tests see only their own calls.
 */
export function executor(host: AgentHost, decision: boolean | "auto" = true, { readMethods = true } = {}): { ex: AgentExecutor; asked: ActivityEntry[]; seen: ActivityEntry[] } {
  const asked: ActivityEntry[] = [];
  const seen: ActivityEntry[] = [];
  let recording = false;
  const ex = new AgentExecutor(host, {
    approve: async (entry) => {
      asked.push(entry);
      return decision === "auto" ? true : decision;
    },
    onActivity: (e) => {
      if (recording) seen.push(e);
    },
  });
  // A read_skill call runs synchronously up to its result, so the methods
  // count as read before this returns.
  if (readMethods) for (const name of Object.values(PAGE_METHOD)) void ex.run("read_skill", { name });
  recording = true;
  return { ex, asked, seen };
}

/** The GaTa4Se8 PDF demo behind a PDF page's port, refined with the real engine. */
export function pdfPort(): { port: PdfAgentPort; calls: string[] } {
  const demo = gata4se8PdfExample();
  const spec = buildPdfSpec(demo.structure, demo.pattern);
  let params = spec.params.map((p) => ({ ...p, value: demo.refinedParams[p.id] ?? p.value }));
  let result: RefinementResult | null = null;
  const defaultRange = { min: 1.5, max: 6 };
  let fitRange = { ...defaultRange };
  const rs = demo.pattern.points.map((p) => p.r);
  const calls: string[] = [];
  const state = (): PdfLiveState => {
    const curves = pdfCurves(demo.structure, demo.pattern, params, spec.bindings, fitRange);
    let num = 0;
    let den = 0;
    let n = 0;
    curves.x.forEach((r, i) => {
      if (r < fitRange.min || r > fitRange.max) return;
      n++;
      num += (curves.yObs[i]! - curves.yCalc[i]!) ** 2;
      den += curves.yObs[i]! ** 2;
    });
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    return {
      phases: [demo.structure],
      refinedPhases: [applyParameters(demo.structure, spec.bindings, values).model],
      pattern: demo.pattern,
      parameters: params,
      bindings: spec.bindings,
      result,
      fitRange,
      defaultRange,
      extent: { min: rs[0]!, max: rs.at(-1)! },
      busy: false,
      rw: Math.sqrt(num / den),
      curves,
      observationCount: n,
      positionMode: "atomic",
      spinModel: false,
      warnings: [],
      source: "test",
      restraints: spec.restraints,
    };
  };
  const refine = async (): Promise<string | null> => {
    calls.push("refine");
    const r = refineProblem(buildPdfProblem(demo.structure, demo.pattern, params, spec.bindings, spec.restraints, fitRange), { maxIterations: 4, analyticDerivatives: true });
    params = params.map((p) => ({ ...p, value: r.parameters[p.id] ?? p.value }));
    result = r;
    return null;
  };
  const port: PdfAgentPort = {
    technique: "pdf",
    state,
    setFixed: (changes) => {
      calls.push(`setFixed ${changes.map((c) => `${c.id}=${c.fixed}`).join(",")}`);
      const m = new Map(changes.map((c) => [c.id, c.fixed]));
      params = params.map((p) => (m.has(p.id) ? { ...p, fixed: m.get(p.id)! } : p));
    },
    setFitRange: (r) => {
      calls.push(`range ${r ? `${r.min}-${r.max}` : "default"}`);
      fitRange = r ? { ...r } : { ...defaultRange };
    },
    refine,
    thorough: async () => {
      calls.push("thorough");
      return "cancelled";
    },
    probe: async (options) => refineProblem(buildPdfProblem(demo.structure, demo.pattern, params, spec.bindings, spec.restraints, fitRange), { ...options, analyticDerivatives: true }),
    // The Boxcar view's scan, one short refinement per box, the rows untouched.
    boxcar: async (plan) => {
      calls.push(`boxcar ${plan.width}/${plan.step}`);
      const windows = boxcarWindows({ range: fitRange, width: plan.width, step: plan.step });
      let seed = params;
      const steps = windows.map((w) => {
        const result = refineProblem(buildPdfProblem(demo.structure, demo.pattern, seed, spec.bindings, spec.restraints, { min: w.min, max: w.max }), { maxIterations: 2, analyticDerivatives: true });
        seed = seed.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
        return { datasetId: String(w.center), result, parameters: seed, carried: true };
      });
      const freeIds = params.filter((p) => !p.fixed && !p.expression).map((p) => p.id);
      return { windows, width: plan.width, restarts: 0, freeIds, series: [{ direction: "up" as const, result: { steps, evolution: [] } }] };
    },
    cancel: () => calls.push("cancel"),
    reset: () => calls.push("reset"),
  };
  return { port, calls };
}
