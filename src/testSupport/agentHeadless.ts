/**
 * The Agent's pages without React, for tests and the eval suite: a powder
 * session, the GaTa4Se8 PDF demo and a single-crystal data set behind real
 * ports (the real curves and the real engine), a host that keeps the Agent's
 * records in memory, and an executor that has read the pages' methods.
 */

import { AgentExecutor, type ActivityEntry, type AgentHost } from "@/agent/executor";
import type { AgentReport } from "@/agent/report";
import { PAGE_METHOD } from "@/agent/skills";
import { emptyRecord, type AgentRecord } from "@/agent/method";
import type { AgentPort, PdfAgentPort, PdfLiveState, PowderAgentPort, PowderLiveState, SingleCrystalAgentPort, SingleCrystalLiveState } from "@/agent/port";
import { gata4se8PdfExample } from "@/examples/gata4se8Pdf";
import { buildPdfProblem, buildPdfSpec, pdfCurves } from "@/core/workflow/pdf";
import { applyParameters } from "@/core/workflow/apply";
import { refine as refineProblem } from "@/core/refinement/engine";
import { boxcarTable, boxcarWindows, type BoxcarRun } from "@/core/workflow/pdfBoxcar";
import { DEFAULT_INSTRUMENT, keptRow, withValidUserTies, type Session } from "@/app/powderSession";
import { withEqualTies } from "@/core/refinement/constraints";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { isHydrogen, withAdpModel } from "@/core/crystal/adp";
import type { DistanceRestraint, RidingRule, StructureModel } from "@/core/crystal/types";
import { inversionText, invertedModel, invertedRiding, invertedTwinFractions } from "@/core/crystal/inversion";
import { ridingRules } from "@/core/crystal/riding";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";
import type { RefinementResult } from "@/core/refinement/types";
import type { SampleOptions, SampleResult } from "@/core/refinement/bayes/sampler";
import { magneticHandle } from "@/testSupport/magneticHeadless";
import { ComputeClient } from "@/workers/computeClient";
import {
  extentOf, hasTensorAdp, observationsIn, posteriorRun, powderFit, powderPageCurves, refinedPhasesOf, restraintRequest, thoroughFit, weightedR,
  withAnisotropicAdp, withAntisitePair, withBackgroundTerms, withBackgroundType, withCorrections, withFitResult, withFixed, withInstrumentConstants,
  withMustrain, withParameterTies, withPhase, withReset, withSiteTies, type FitWindow, type PowderCompute, type PowderPageModel,
} from "@/app/powderPage";
import { moveTo, recordStep, restoreStep, type ProjectHistory, type Snapshot, type StepActor, type StepKind } from "@/core/project/history";
import type { Workspace } from "@/core/project/types";
import { pdfReportInput, powderReportInput, singleCrystalReportInput } from "@/app/reportInputs";
import type { ExtinctionModel, OmittedMeasurement, Radiation, ResolutionRange, ShelxWeighting, SingleCrystalDataset, TwinLaw } from "@/core/diffraction/types";
import { EXTINCTION_PARAMETER_LABELS } from "@/core/diffraction/singleCrystalFactors";
import { measurementMerge } from "@/core/diffraction/merge";
import { SINGLE_CRYSTAL_REFINE_OPTIONS, buildSingleCrystalRefinementProblem, buildSingleCrystalSpec, mergedDataset, refineSingleCrystal, inResolution, isOmitted, optimalScale, singleCrystalRefinementComparison, withinResolution, withoutOmitted } from "@/core/workflow/singleCrystalRefinement";

/**
 * What a headless page keeps of itself in a History step, and how it goes
 * back to one: the app restores a step's workspace when the user (or the
 * Agent's go_to_step) returns to it, and a page registered here does the same.
 */
const PAGE_STATE = new WeakMap<AgentPort, { readonly capture: () => unknown; readonly restore: (captured: unknown) => void }>();

/**
 * A powder page without React: a session behind the page's own operations
 * (powderPage.ts) and the app's compute client, which runs in-thread here. So
 * a tool judges an actual fit, and the page computes what the app's does: the
 * same curves, agreement, setters, fits, Prefit and posterior, from the same
 * requests.
 */
export function sessionPort(start: Session, instrument: InstrumentParameters = DEFAULT_INSTRUMENT, opts: { readonly instrumentOnPage?: boolean; readonly client?: PowderCompute } = {}): { port: PowderAgentPort; calls: string[]; session: () => Session } {
  let s = start;
  // The page shows its instrument as the app does (a TOF pattern needs it for d); off by default, as the older tests expect.
  const shown = opts.instrumentOnPage ? instrument : undefined;
  let result: RefinementResult | null = null;
  let fitRange: FitWindow | null = null;
  const calls: string[] = [];
  // The app's compute client: without a Worker (here) it runs each request in-thread. A test may watch the requests.
  const client: PowderCompute = opts.client ?? new ComputeClient();
  /** The window as the app applies it: only when it narrows the pattern. */
  const activeWindow = (): FitWindow | null => {
    if (!fitRange) return null;
    const extent = extentOf(powderPageCurves(s).curves.x);
    return fitRange.min > extent.min || fitRange.max < extent.max ? { ...fitRange } : null;
  };
  const page = (): PowderPageModel => ({ session: s, instrument, fitRange: activeWindow(), result });
  const changed = (next: Session): void => {
    s = next;
    result = null;
  };
  const state = (): PowderLiveState => {
    const { curves } = powderPageCurves(s);
    const window = activeWindow();
    const zero = s.powderParams.find((p) => p.kind === "zeroShift")?.value;
    return {
      structure: s.structure,
      extraPhases: s.extraPhases,
      refinedPhases: refinedPhasesOf(s),
      pattern: s.pattern,
      parameters: s.powderParams,
      bindings: s.powderBindings,
      profile: s.powderProfile,
      magnetic: s.magnetic ?? null,
      result,
      instrument: shown ?? null,
      fitRange: window,
      extent: extentOf(curves.x),
      busy: false,
      viewOnly: s.pattern.xUnit === "tof" && s.powderProfile.shape !== "tof",
      wR: weightedR(s, curves, window),
      settings: {
        backgroundTerms: s.backgroundTerms,
        backgroundType: s.powderProfile.backgroundType ?? "chebyshev",
        mustrain: s.mustrain ?? "isotropic",
        anisotropicAdp: hasTensorAdp(s.structure),
        siteTies: s.siteTies,
        corrections: s.corrections ?? {},
      },
      curves,
      d: s.pattern.xUnit === "dSpacing" ? curves.x : convertAxisArray(curves.x, s.pattern.xUnit, "dSpacing", axisContext(s.pattern, shown, zero)),
      observationCount: observationsIn(curves, window),
      axis: axisContext(s.pattern, shown, zero),
      source: "test",
      restraints: restraintRequest(s).restraints ?? [],
    };
  };
  /** The posterior run to continue: its closure keeps the problem it sampled, as the page's. */
  let sampled: { result: SampleResult; rerun: (options: SampleOptions) => Promise<SampleResult> } | null = null;
  const port: PowderAgentPort = {
    technique: "powder",
    state,
    setFixed: (changes) => {
      calls.push(`setFixed ${changes.map((c) => `${c.id}=${c.fixed}`).join(",")}`);
      s = withFixed(s, changes);
    },
    setBackgroundTerms: (n) => {
      calls.push(`terms ${n}`);
      changed(withBackgroundTerms(s, n, instrument));
    },
    setBackgroundType: (t) => {
      calls.push(`type ${t}`);
      changed(withBackgroundType(s, t));
    },
    setMustrain: (m) => {
      calls.push(`mustrain ${m}`);
      changed(withMustrain(s, m, instrument));
    },
    setAnisotropicAdp: (on) => {
      calls.push(`adp ${on}`);
      changed(withAnisotropicAdp(s, on, instrument));
    },
    setSiteTies: (update) => {
      calls.push(`ties ${JSON.stringify(update)}`);
      changed(withSiteTies(s, update, instrument));
    },
    addAntisite: (a, b) => {
      calls.push(`antisite ${a} ${b}`);
      changed(withAntisitePair(s, a, b, instrument));
    },
    addPhase: (structure) => {
      calls.push(`add phase ${structure.name}`);
      changed(withPhase(s, structure, instrument));
    },
    setParameterTies: (update) => {
      calls.push(`ties ${JSON.stringify(update)}`);
      changed(withParameterTies(s, update));
    },
    setInstrumentConstants: (update) => {
      calls.push(`constants ${JSON.stringify(update)}`);
      changed(withInstrumentConstants(s, update));
    },
    setCorrections: (update) => {
      calls.push(`corrections ${JSON.stringify(update)}`);
      changed(withCorrections(s, update, instrument));
    },
    setFitRange: (r) => {
      calls.push(`range ${r ? `${r.min}-${r.max}` : "whole"}`);
      fitRange = r ? { min: r.min, max: r.max } : null;
    },
    showPeaks: (peaks) => calls.push(`showPeaks ${peaks.map((p) => p.d.toFixed(3)).join(",")}`),
    refine: async () => {
      calls.push("refine");
      const r = await powderFit(client, page(), { maxIterations: 20 });
      s = withFitResult(s, r);
      result = r;
      return null;
    },
    thorough: async () => {
      calls.push("thorough");
      const out = await thoroughFit(client, page());
      s = out.session;
      result = out.result;
      return null;
    },
    samplePosterior: async ({ continue: more, steps }) => {
      calls.push(`sample ${more ? "continue" : "start"} ${steps}`);
      if (more && !sampled) return "there is no posterior run to continue: sample first";
      const prior = more ? sampled : null;
      const rerun = prior ? prior.rerun : posteriorRun(client, page());
      const res = await rerun({ nSteps: steps, seed: 0xbae5, ...(prior ? { init: prior.result.resume } : {}) });
      sampled = { result: res, rerun };
      return res;
    },
    probe: async (options) => {
      calls.push("probe");
      return powderFit(client, page(), options);
    },
    // The page's report (Export ▾ → Report) from the same state.
    reportInput: () => {
      const st = state();
      return powderReportInput({
        session: s,
        refinedPhases: st.refinedPhases,
        params: s.powderParams,
        bindings: s.powderBindings,
        result,
        instrument,
        instrumentLoaded: true,
        wR: st.wR,
        rExp: result?.agreement.rExpected ?? null,
        gof: result?.agreement.goodnessOfFit ?? null,
        curves: { x: st.curves.x, yObs: st.curves.yObs, yCalc: st.curves.yCalc, diff: st.curves.yObs.map((o, i) => o - st.curves.yCalc[i]!) },
        xLabel: s.pattern.xUnit === "twoTheta" ? "2θ (°)" : s.pattern.xUnit,
        ticks: [],
        fitRange: st.fitRange,
        pointsInWindow: st.observationCount,
        tofViewOnly: false,
        explored: null,
      });
    },
    cancel: () => calls.push("cancel"),
    reset: (ids) => {
      calls.push(ids ? `reset ${ids.join(",")}` : "reset");
      changed(withReset(s, ids));
    },
    magnetic: () => magnetic,
    openStep: (step) => calls.push(`step ${step}`),
  };
  const magnetic = magneticHandle(() => s, (next) => {
    s = next;
    result = null;
  }, (step) => calls.push(`step ${step}`), shown);
  PAGE_STATE.set(port, {
    capture: () => ({ session: s, result, fitRange }),
    restore: (captured) => {
      const at = captured as { session: Session; result: RefinementResult | null; fitRange: FitWindow | null };
      s = at.session;
      result = at.result;
      fitRange = at.fitRange;
    },
  });
  return { port, calls, session: () => s };
}

/**
 * The port as the app hands it out: the page publishes a new port object at
 * every render, and its state() is that render's. A tool that changes the page
 * and then reads the port it was given sees the page as it was before; only a
 * port fetched again after the render sees the change.
 */
function renderSnapshot(port: AgentPort): AgentPort {
  const frozen = port.state();
  return { ...port, state: () => frozen } as AgentPort;
}

export function fakeHost(
  port: AgentPort | null,
  history: () => ProjectHistory | null = () => null,
  onRecord?: (kind: StepKind, agent: boolean) => void,
  goToStep: (id: string) => void = () => undefined,
): { host: AgentHost; steps: { kind: StepKind; agent: boolean }[]; records: Map<string, AgentRecord> } {
  const steps: { kind: StepKind; agent: boolean }[] = [];
  const records = new Map<string, AgentRecord>();
  let agent = false;
  const host: AgentHost = {
    port: () => (port ? renderSnapshot(port) : null),
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
    recordNow: (kind) => {
      steps.push({ kind, agent });
      onRecord?.(kind, agent);
    },
    history,
    goToStep,
    record: (key) => records.get(key) ?? emptyRecord(key),
    updateRecord: (key, update) => void records.set(key, update(records.get(key) ?? emptyRecord(key))),
  };
  return { host, steps, records };
}

/**
 * The History as the app keeps it, for a headless page: each step the
 * executor asks for is recorded from the page's state — the phases, the
 * parameters and the last result, and on the single-crystal page the
 * settings the report compares refinements by — and the first is the start,
 * as when data loads. The pages record a refinement's own step when it ends
 * ("Refine"); a headless port does not, so its caller records that one
 * (record("refine", "agent", "Refine")). A report written in a test or an
 * eval then lists the analysis' steps with their agreement, as the app's does.
 */
export function headlessHistory(port: AgentPort): { history: () => ProjectHistory | null; record: (kind: StepKind, actor?: StepActor, label?: string) => void; goTo: (id: string) => void } {
  const snapshot = (): Snapshot => {
    const s = port.state();
    const structures = "phases" in s ? s.phases : "dataset" in s ? [s.structure] : [s.structure, ...s.extraPhases];
    const refinement = { parameters: s.parameters, bindings: s.bindings, ...(s.result ? { lastResult: s.result } : {}) };
    const sc = "dataset" in s
      ? {
          extinctionModel: s.extinctionModel,
          resolution: { ...(s.resolution.dMin !== undefined ? { dMin: s.resolution.dMin } : {}), ...(s.resolution.dMax !== undefined ? { dMax: s.resolution.dMax } : {}) },
          omitted: s.omitted,
          outlierFilter: { on: s.outlierFilter.on, cutoffSigma: s.outlierFilter.cutoffSigma, ...(s.outlierFilter.minExtinction !== undefined ? { minExtinction: s.outlierFilter.minExtinction } : {}) },
          twinLaws: s.twinLaws,
          inverted: s.inverted !== undefined,
          ...(s.weighting ? { weighting: { a: s.weighting.a, b: s.weighting.b } } : {}),
        }
      : {};
    // A registered page keeps its own state with the step, to go back to it (PAGE_STATE).
    const page = PAGE_STATE.get(port);
    return { structures, workspace: { technique: port.technique, refinement, ...sc, ...(page ? { headlessPage: page.capture() } : {}) } as unknown as Workspace };
  };
  let h: ProjectHistory = recordStep(null, { ...snapshot(), kind: "load", label: "Start" });
  return {
    history: () => h,
    record: (kind, actor, label) => {
      h = recordStep(h, { ...snapshot(), kind, ...(label ? { label } : {}), ...(actor ? { actor } : {}) });
    },
    // The app's go-to-step: the step's state back on the page, and the History's current step moved to it.
    goTo: (id) => {
      const captured = (restoreStep(h, id).workspace as unknown as { headlessPage?: unknown }).headlessPage;
      if (captured !== undefined) PAGE_STATE.get(port)?.restore(captured);
      h = moveTo(h, id);
    },
  };
}

/**
 * An executor as a conversation has it once the pages' methods are read
 * (`readMethods: false` for one that has read nothing yet). The reads run
 * before the activity is recorded, so tests see only their own calls.
 */
export function executor(
  host: AgentHost,
  decision: boolean | "auto" = true,
  { readMethods = true, onReport }: { readMethods?: boolean; onReport?: (report: AgentReport) => void } = {},
): { ex: AgentExecutor; asked: ActivityEntry[]; seen: ActivityEntry[] } {
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
    modelLabel: () => "Test model · headless",
    ...(onReport ? { onReport } : {}),
  });
  // A read_skill call runs synchronously up to its result, so the methods
  // count as read before this returns.
  if (readMethods) for (const name of Object.values(PAGE_METHOD)) void ex.run("read_skill", { name });
  recording = true;
  return { ex, asked, seen };
}

/** What a structure's sites refine: one U each, the tensor, or both. */
function adpModelOf(structure: StructureModel): "isotropic" | "anisotropic" | "mixed" {
  // Hydrogens kept isotropic under an anisotropic model (X-ray) do not make it mixed.
  const heavy = structure.sites.filter((site) => !isHydrogen(site));
  const kinds = new Set((heavy.length ? heavy : structure.sites).map((site) => site.adp.kind));
  return kinds.size === 1 ? [...kinds][0]! : "mixed";
}

/** The GaTa4Se8 PDF demo behind a PDF page's port, refined with the real engine. */
export function pdfPort(): { port: PdfAgentPort; calls: string[] } {
  const demo = gata4se8PdfExample();
  let model: StructureModel = demo.structure;
  let spec = buildPdfSpec(model, demo.pattern);
  let params = spec.params.map((p) => ({ ...p, value: demo.refinedParams[p.id] ?? p.value }));
  let result: RefinementResult | null = null;
  let lastRun: BoxcarRun | null = null;
  const defaultRange = { min: 1.5, max: 6 };
  let fitRange = { ...defaultRange };
  const rs = demo.pattern.points.map((p) => p.r);
  const calls: string[] = [];
  const state = (): PdfLiveState => {
    const curves = pdfCurves(model, demo.pattern, params, spec.bindings, fitRange);
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
      phases: [model],
      refinedPhases: [applyParameters(model, spec.bindings, values).model],
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
      adpModel: adpModelOf(model),
      spinModel: false,
      warnings: [],
      source: "test",
      restraints: spec.restraints,
    };
  };
  const refine = async (): Promise<string | null> => {
    calls.push("refine");
    const r = refineProblem(buildPdfProblem(model, demo.pattern, params, spec.bindings, spec.restraints, fitRange), { maxIterations: 4, analyticDerivatives: true });
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
    // The ADPs box: the model rebuilt in the other ADP model, the other rows kept by id.
    setAdpModel: (anisotropic) => {
      calls.push(`adp ${anisotropic ? "anisotropic" : "isotropic"}`);
      model = withAdpModel(model, anisotropic ? "anisotropic" : "isotropic");
      const old = new Map(params.map((p) => [p.id, p]));
      spec = buildPdfSpec(model, demo.pattern);
      params = spec.params.map((p) => { const o = old.get(p.id); return o ? { ...p, value: o.value, fixed: o.fixed } : p; });
      result = null;
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
    probe: async (options) => refineProblem(buildPdfProblem(model, demo.pattern, params, spec.bindings, spec.restraints, fitRange), { ...options, analyticDerivatives: true }),
    // The Boxcar view's scan, one short refinement per box, the rows untouched.
    boxcar: async (plan) => {
      calls.push(`boxcar ${plan.width}/${plan.step}${plan.bonds?.length ? ` bonds ${plan.bonds.join(",")}` : ""}`);
      const windows = boxcarWindows({ range: fitRange, width: plan.width, step: plan.step });
      const own = plan.free ? new Set(plan.free) : null;
      let seed = own ? params.map((p) => (p.expression ? p : { ...p, fixed: !own.has(p.id) })) : params;
      const steps = windows.map((w) => {
        const result = refineProblem(buildPdfProblem(model, demo.pattern, seed, spec.bindings, spec.restraints, { min: w.min, max: w.max }), { maxIterations: 2, analyticDerivatives: true });
        seed = seed.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
        return { datasetId: String(w.center), result, parameters: seed, carried: true };
      });
      const freeIds = (own ? params.filter((p) => own.has(p.id)) : params).filter((p) => (own || !p.fixed) && !p.expression).map((p) => p.id);
      lastRun = { windows, width: plan.width, restarts: 0, freeIds, series: [{ direction: "up" as const, result: { steps, evolution: [] } }], ...(plan.bonds?.length ? { bondSites: [...plan.bonds] } : {}) };
      return lastRun;
    },
    reportInput: () => {
      const st = state();
      return pdfReportInput({
        phases: st.refinedPhases, params, bindings: spec.bindings, result, pattern: demo.pattern, rw: st.rw, fitRange,
        curves: { x: st.curves.x, yObs: st.curves.yObs, yCalc: st.curves.yCalc, diff: st.curves.yObs.map((o, i) => o - st.curves.yCalc[i]!) },
        positionMode: "atomic", spinModel: null, explored: null,
        boxcar: lastRun ? boxcarTable(lastRun, model, spec.bindings, params) : null,
      });
    },
    cancel: () => calls.push("cancel"),
    reset: () => calls.push("reset"),
  };
  return { port, calls };
}

/**
 * A single-crystal page without React: a structure and its reflections behind
 * the port, refined with the real engine, the outlier filter and the ADP
 * switch as the page has them.
 */
export function singleCrystalPort(start: StructureModel, loaded: SingleCrystalDataset): { port: SingleCrystalAgentPort; calls: string[] } {
  let model = start;
  let base: SingleCrystalDataset = loaded;
  let extinctionModel: ExtinctionModel = loaded.extinctionModel ?? "shelx";
  let omitted: readonly OmittedMeasurement[] = [];
  let resolution: ResolutionRange = {};
  let riding: readonly RidingRule[] | null = start.riding?.length ? start.riding : null;
  let weighting: ShelxWeighting | null = loaded.weighting ?? null;
  let twinLaws: readonly TwinLaw[] = loaded.twinLaws ?? [];
  let restraints: readonly DistanceRestraint[] = start.restraints ?? [];
  let merged = false;
  let inverted = false;
  // The reflections with the extinction model, as the page's probed dataset.
  let dataset: SingleCrystalDataset = { ...loaded, extinctionModel };
  let spec = buildSingleCrystalSpec(model, dataset, { extinction: 0 });
  let params = spec.params;
  let result: RefinementResult | null = null;
  let filter: { on: boolean; cutoffSigma: number; minExtinction?: number } = { on: false, cutoffSigma: 6 };
  const calls: string[] = [];
  const values = (): Record<string, number> => Object.fromEntries(params.map((p) => [p.id, p.value]));
  // The omitted measurements go first; the filter reads the residuals of the whole set against the current model, as the page's.
  const kept = (): SingleCrystalDataset => withinResolution(withoutOmitted(dataset, omitted), model.cell, resolution);
  const active = (): SingleCrystalDataset => {
    if (!filter.on) return kept();
    const full = singleCrystalRefinementComparison(model, dataset, params, spec.bindings);
    return { ...dataset, reflections: dataset.reflections.filter((r, i) => !isOmitted(r, omitted) && inResolution(r, model.cell, resolution) && Math.abs(full.rows[i]?.deltaOverSigma ?? 0) <= filter.cutoffSigma && (filter.minExtinction === undefined || (full.rows[i]?.extinction ?? 1) >= filter.minExtinction)) };
  };
  const state = (): SingleCrystalLiveState => {
    const ds = active();
    const nKept = kept().reflections.length;
    const outside = withoutOmitted(dataset, omitted).reflections.length - nKept;
    const cmp = singleCrystalRefinementComparison(model, ds, params, spec.bindings);
    const merge = measurementMerge((merged ? loaded : ds).reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, intensity: r.iObs, sigma: r.sigma ?? 0 })), model.spaceGroup.operations);
    return {
      structure: model,
      refinedStructure: applyParameters(model, spec.bindings, values()).model,
      dataset,
      totalReflections: loaded.reflections.length,
      measurement: loaded.reflections,
      probe: dataset.radiation.kind,
      parameters: params,
      bindings: spec.bindings,
      result,
      busy: false,
      agreement: cmp.agreement,
      merge: merge.statistics,
      rows: cmp.rows,
      allRows: ds.reflections.length < dataset.reflections.length ? singleCrystalRefinementComparison(model, dataset, params, spec.bindings).rows : cmp.rows,
      outlierFilter: { ...filter, excluded: nKept - ds.reflections.length },
      omitted,
      resolution: { ...resolution, excluded: outside },
      riding: riding ?? [],
      weighting,
      twinLaws,
      distanceRestraints: restraints,
      extinctionModel,
      adpModel: adpModelOf(model),
      ...(inverted ? { inverted: inversionText(start, invertedModel(start)), loadedAs: start } : {}),
      magnetic: false,
      observationCount: ds.reflections.length,
      source: dataset.name,
      restraints: [],
    };
  };
  const port: SingleCrystalAgentPort = {
    technique: "singleCrystal",
    state,
    setFixed: (changes) => {
      calls.push(`setFixed ${changes.map((c) => `${c.id}=${c.fixed}`).join(",")}`);
      const m = new Map(changes.map((c) => [c.id, c.fixed]));
      params = params.map((p) => (m.has(p.id) ? { ...p, fixed: m.get(p.id)! } : p));
    },
    // The page's switch: the tensors (or spheres) seeded from the refined ADPs, entering fixed.
    setAdpModel: (anisotropic) => {
      calls.push(`adp ${anisotropic ? "anisotropic" : "isotropic"}`);
      const refined = applyParameters(model, spec.bindings, values()).model;
      const seeds = new Map(refined.sites.map((site) => [site.label, site.adp]));
      const switched = withAdpModel({ ...start, sites: start.sites.map((site) => ({ ...site, adp: seeds.get(site.label) ?? site.adp })) }, anisotropic ? "anisotropic" : "isotropic", { hydrogensIsotropic: dataset.radiation.kind === "xray" });
      model = riding ? { ...switched, riding } : switched;
      const old = new Map(params.map((p) => [p.id, p]));
      spec = buildSingleCrystalSpec(model, dataset, { extinction: 0 });
      params = withValidUserTies(spec.params.map((p) => keptRow(p, p.kind === "bIso" || p.kind === "uAniso" ? undefined : old.get(p.id))));
      result = null;
    },
    setExtinctionModel: (m) => {
      calls.push(`extinction model ${m}`);
      extinctionModel = m;
      dataset = { ...base, extinctionModel, ...(weighting ? { weighting } : {}), ...(twinLaws.length ? { twinLaws } : {}) };
      params = params.map((p) => (p.kind === "extinction" ? { ...p, label: EXTINCTION_PARAMETER_LABELS[m], value: 0, initialValue: 0 } : p));
      result = null;
    },
    setRadiation: (update) => {
      calls.push(`radiation ${JSON.stringify(update)}`);
      const probe = update.probe ?? base.radiation.kind;
      const wl = update.wavelength ?? ("wavelength" in base.radiation ? base.radiation.wavelength : 1.54);
      const radiation: Radiation = probe === "neutron-tof" ? { kind: "neutron-tof" } : probe === "xray" ? { kind: "xray", wavelength: wl, polarization: 0.5 } : { kind: "neutron", wavelength: wl };
      base = { ...base, radiation };
      dataset = { ...base, extinctionModel, ...(weighting ? { weighting } : {}), ...(twinLaws.length ? { twinLaws } : {}) };
      const k = optimalScale(model, active(), params, spec.bindings);
      if (k !== null) params = params.map((p) => (p.kind === "scale" ? { ...p, value: k } : p));
      result = null;
    },
    setResolution: (update) => {
      calls.push(`resolution ${JSON.stringify(update)}`);
      const end = (v: number | null | undefined, was: number | undefined): number | undefined => (v === undefined ? was : v ?? undefined);
      const dMin = end(update.dMin, resolution.dMin);
      const dMax = end(update.dMax, resolution.dMax);
      resolution = { ...(dMin !== undefined ? { dMin } : {}), ...(dMax !== undefined ? { dMax } : {}) };
    },
    setTwinLaws: (laws) => {
      calls.push(`twin ${laws.map((l) => JSON.stringify(l.matrix)).join(" ") || "none"}`);
      const before = twinLaws;
      twinLaws = laws;
      const { twinLaws: _, ...rest } = dataset;
      dataset = laws.length ? { ...rest, twinLaws: laws } : rest;
      const old = new Map(params.map((p) => [p.id, p]));
      spec = buildSingleCrystalSpec(model, dataset, { extinction: 0 });
      // As the page: a law that stays where it was keeps its fraction.
      const stays = (id: string): boolean => {
        const i = Number(/^twin_(\d+)$/.exec(id)?.[1] ?? 0) - 1;
        const a = before[i];
        const b = laws[i];
        return i >= 0 && !!a && !!b && a.matrix.every((row, r) => row.every((v, c) => Math.round(v) === Math.round(b.matrix[r]![c]!)));
      };
      params = withValidUserTies(spec.params.map((p) => keptRow(p, p.kind === "twinFraction" && !stays(p.id) ? undefined : old.get(p.id))));
      result = null;
    },
    setParameterTies: (update) => {
      calls.push(`ties ${JSON.stringify(update)}`);
      params = withValidUserTies(withEqualTies(params, update));
    },
    // The page's handler: the merged equivalents (or every measurement) with the batch rows rebuilt, the omissions and the last fit cleared.
    setMerged: (on) => {
      calls.push(`merged ${on}`);
      merged = on;
      const set = on ? mergedDataset(loaded, model.spaceGroup.operations) : loaded;
      base = { ...set, radiation: base.radiation };
      dataset = { ...base, extinctionModel, ...(weighting ? { weighting } : {}), ...(twinLaws.length ? { twinLaws } : {}) };
      const old = new Map(params.map((p) => [p.id, p]));
      spec = buildSingleCrystalSpec(model, dataset, { extinction: 0 });
      params = withValidUserTies(spec.params.map((p) => keptRow(p, old.get(p.id))));
      omitted = [];
      result = null;
    },
    setDistanceRestraints: (next) => {
      calls.push(`restraints ${next.length}`);
      restraints = next;
      model = next.length ? { ...model, restraints: next } : (({ restraints: _, ...rest }) => rest)(model);
      result = null;
    },
    // The page's handler: the model inverted through the origin, the shifts negated, the riding groups placed afresh, a twin with both hands re-expressed.
    invertStructure: () => {
      calls.push("invert");
      // As the page: one transform both ways, the one that takes the model as loaded to its inverse.
      const forward = invertedModel(start);
      const total = forward.shift.map((v, i) => v + forward.translation[i]!) as unknown as typeof forward.shift;
      const flip = invertedModel(model, { total });
      const nextRiding = riding ? invertedRiding(riding, invertedModel(applyParameters(model, spec.bindings, values()).model, { total }).structure) : null;
      const lawOf = (id: string): number => Number(spec.bindings.find((b) => b.parameterId === id && b.kind === "twinFraction")?.targetKey ?? 0) - 1;
      const twins = invertedTwinFractions(twinLaws, twinLaws.map((_, i) => params.find((p) => p.kind === "twinFraction" && lawOf(p.id) === i)?.value ?? 0));
      riding = nextRiding;
      restraints = flip.structure.restraints ?? [];
      model = { ...flip.structure, ...(nextRiding ? { riding: nextRiding } : {}) };
      const old = new Map(params.map((p) => [p.id, p]));
      spec = buildSingleCrystalSpec(model, dataset, { extinction: 0 });
      params = withValidUserTies(spec.params.map((p) => {
        const row = keptRow(p, old.get(p.id));
        if (p.kind === "positionShift") return { ...row, value: -(old.get(p.id)?.value ?? 0) };
        if (p.kind === "ridingTorsion") return { ...row, value: p.value, initialValue: p.value };
        if (p.kind === "twinFraction") return { ...row, value: twins[lawOf(p.id)] ?? row.value };
        return row;
      }));
      inverted = !inverted;
      result = null;
      return inverted ? inversionText(start, invertedModel(start)) : "back to the model as loaded";
    },
    setWeighting: (next) => {
      calls.push(`weighting ${next ? `${next.a} ${next.b}` : "1/σ²"}`);
      weighting = next && (next.a > 0 || next.b > 0) ? { a: next.a, b: next.b } : null;
      const { weighting: _, ...rest } = dataset;
      dataset = weighting ? { ...rest, weighting } : rest;
      result = null;
    },
    // The page's handler: rules from the structure as refined now; the hydrogens' rows leave the fit (or come back).
    setRiding: (on, options) => {
      calls.push(`riding ${on ? "on" : "off"}${options ? ` ${JSON.stringify(options)}` : ""}`);
      const rules = on ? ridingRules({ ...applyParameters(model, spec.bindings, values()).model, riding: [] }, options) : null;
      if (rules && rules.rules.length === 0) return "no hydrogen is bonded to an atom of this model";
      riding = rules ? rules.rules : null;
      model = riding ? { ...model, riding } : (({ riding: _, ...rest }) => rest)(model);
      const old = new Map(params.map((p) => [p.id, p]));
      spec = buildSingleCrystalSpec(model, dataset, { extinction: 0 });
      params = withValidUserTies(spec.params.map((p) => keptRow(p, old.get(p.id))));
      result = null;
      return rules && rules.unbonded.length ? `not riding (no parent in bonding distance): ${rules.unbonded.join(", ")}` : null;
    },
    setOmitted: (next) => {
      calls.push(`omit ${next.map((o) => `${o.h} ${o.k} ${o.l}${o.batch !== undefined ? `/${o.batch}` : ""}`).join(", ")}`);
      omitted = next;
    },
    setOutlierFilter: (update) => {
      calls.push(`filter ${JSON.stringify(update)}`);
      const minExtinction = update.minExtinction === null ? undefined : update.minExtinction ?? filter.minExtinction;
      filter = { on: update.on ?? filter.on, cutoffSigma: update.cutoffSigma ?? filter.cutoffSigma, ...(minExtinction !== undefined ? { minExtinction } : {}) };
    },
    refine: async () => {
      calls.push("refine");
      const r = refineSingleCrystal(model, active(), params, spec.bindings, SINGLE_CRYSTAL_REFINE_OPTIONS);
      params = params.map((p) => ({ ...p, value: r.parameters[p.id] ?? p.value }));
      result = r;
      return null;
    },
    thorough: async () => {
      calls.push("thorough");
      return "cancelled";
    },
    probe: async (options, cut) => {
      const data = active();
      // As the page: the reflections whose y at the current model is below the cut leave the probe's data only.
      const rows = cut ? singleCrystalRefinementComparison(model, dataset, params, spec.bindings).rows : [];
      const yOf = new Map(dataset.reflections.map((r, i) => [r, rows[i]?.extinction ?? 1] as const));
      const fitted = cut ? { ...data, reflections: data.reflections.filter((r) => (yOf.get(r) ?? 1) >= cut.minExtinction) } : data;
      return refineProblem(buildSingleCrystalRefinementProblem(model, fitted, params, spec.bindings), { analyticDerivatives: true, ...options });
    },
    reportInput: () => {
      const st = state();
      return singleCrystalReportInput({
        structure: st.refinedStructure, base: model, params, bindings: spec.bindings, result, dataset: active(), totalReflections: loaded.reflections.length,
        excluded: st.outlierFilter.excluded, filterOn: filter.on, cutoffSigma: filter.cutoffSigma, minExtinction: filter.minExtinction ?? null, omitted, resolution: st.resolution, agreement: st.agreement, merge: st.merge,
        points: st.rows.map((r) => ({ obs: r.foSq, calc: r.fcSq })), magnetic: null, explored: null,
        ...(st.inverted ? { inverted: st.inverted } : {}),
      });
    },
    cancel: () => calls.push("cancel"),
    reset: (ids) => {
      calls.push(`reset${ids ? ` ${ids.join(",")}` : ""}`);
      const only = ids ? new Set(ids) : null;
      params = params.map((p) => (only && !only.has(p.id) ? p : { ...p, value: p.initialValue }));
      result = null;
    },
  };
  return { port, calls };
}
