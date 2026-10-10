import { describe, it, expect } from "vitest";
import { AgentExecutor, type ActivityEntry, type AgentHost } from "@/agent/executor";
import type { AgentPort, PdfAgentPort, PdfLiveState, PowderAgentPort, PowderLiveState } from "@/agent/port";
import { AgentLink } from "@/agent/link";
import { gata4se8PdfExample } from "@/examples/gata4se8Pdf";
import { buildPdfProblem, buildPdfSpec, pdfCurves } from "@/core/workflow/pdf";
import { applyParameters } from "@/core/workflow/apply";
import { refine as refineProblem } from "@/core/refinement/engine";
import { freePlan } from "@/agent/liveCommon";
import { LIVE_TOOLS, inputJsonSchema } from "@/agent/tools";
import { newSession, type Session } from "@/app/powderSession";
import { exampleStructure } from "@/examples/mn3ga";
import { powderCurves } from "@/core/workflow/powder";
import { runPowderRefinement } from "@/workers/runPowder";
import { axisContext, convertAxisArray } from "@/visualization/axisUnits";
import { excludedPointMask } from "@/core/refinement/factors";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { StepKind } from "@/core/project/history";

/**
 * A powder page without React: a session, the real curves and the real
 * engine behind the port, so the tools judge an actual fit.
 */
function sessionPort(start: Session): { port: PowderAgentPort; calls: string[]; session: () => Session } {
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
      source: "test",
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
    setFitRange: (r) => {
      calls.push(`range ${r ? `${r.min}-${r.max}` : "whole"}`);
      fitRange = r ? { ...r } : null;
    },
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
        options,
      });
    },
    cancel: () => calls.push("cancel"),
    reset: () => calls.push("reset"),
  };
  return { port, calls, session: () => s };
}

function fakeHost(port: AgentPort | null): { host: AgentHost; steps: { kind: StepKind; agent: boolean }[] } {
  const steps: { kind: StepKind; agent: boolean }[] = [];
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
  };
  return { host, steps };
}

function executor(host: AgentHost, decision: boolean | "auto" = true): { ex: AgentExecutor; asked: ActivityEntry[]; seen: ActivityEntry[] } {
  const asked: ActivityEntry[] = [];
  const seen: ActivityEntry[] = [];
  const ex = new AgentExecutor(host, {
    approve: async (entry) => {
      asked.push(entry);
      return decision === "auto" ? true : decision;
    },
    onActivity: (e) => seen.push(e),
  });
  return { ex, asked, seen };
}

const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

describe("Agent tool list", () => {
  it("has unique names and an object JSON schema for every tool", () => {
    const names = LIVE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of LIVE_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z_]*$/);
      const schema = inputJsonSchema(t);
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("offers no tool that sets a parameter value", () => {
    for (const t of LIVE_TOOLS) expect(Object.keys(t.inputSchema)).not.toContain("value");
  });
});

describe("freePlan", () => {
  const params: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: 1, initialValue: 1, fixed: true },
    { id: "bkg0", label: "bkg 0", kind: "background", value: 0, initialValue: 0, fixed: true },
    { id: "bkg1", label: "bkg 1", kind: "background", value: 0, initialValue: 0, fixed: false },
    { id: "occ_Ga", label: "occ Ga", kind: "occupancy", value: 0.5, initialValue: 0.5, fixed: true, expression: "= 1 - occ_Mn" },
  ];

  it("changes only the named parameters, by id or glob", () => {
    expect(freePlan(params, ["scale", "bkg*"], []).changes).toEqual([
      { id: "scale", fixed: false },
      { id: "bkg0", fixed: false },
    ]);
    expect(freePlan(params, [], ["bkg*"]).changes).toEqual([{ id: "bkg1", fixed: true }]);
  });

  it("skips tied parameters with a note, and rejects names that match nothing", () => {
    const plan = freePlan(params, ["occ_*"], []);
    expect(plan.changes).toEqual([]);
    expect(plan.note).toMatch(/tied parameter occ_Ga/);
    expect(() => freePlan(params, ["zero"], [])).toThrow(/nothing matches "zero".*scale, bkg0/);
    expect(() => freePlan(params, ["scale"], ["scale"])).toThrow(/both freed and fixed/);
    expect(() => freePlan(params, [], [])).toThrow(/pass `free`, `fix`/);
  });
});

describe("AgentExecutor on a live powder fit", () => {
  it("reads the analysis without asking, compactly", async () => {
    const { port } = sessionPort(newSession(exampleStructure()));
    const { host } = fakeHost(port);
    const { ex, asked } = executor(host);
    const out = await ex.run("get_state", {});
    expect(out.isError).toBe(false);
    expect(out.text.length).toBeLessThan(8000);
    const view = parse(out.text);
    expect(view.ref).toBe("#1");
    expect(view.technique).toBe("powder");
    expect(Array.isArray(view.parameterGroups)).toBe(true);
    expect((view.data as { axis: string }).axis).toBe("twoTheta");
    expect(asked).toEqual([]);
  });

  it("rejects unknown fields and tools, and says when nothing is open", async () => {
    const { ex } = executor(fakeHost(sessionPort(newSession(exampleStructure())).port).host);
    expect((await ex.run("set_free", { free: ["scale"], value: 3 })).text).toMatch(/invalid input for set_free/);
    expect((await ex.run("set_value", {})).text).toBe("Error: no tool named set_value");
    const empty = executor(fakeHost(null).host).ex;
    expect((await empty.run("get_state", {})).text).toMatch(/no analysis is open/);
  });

  /** The demo session with every parameter fixed, so freeing one is a change. */
  const allFixed = (): Session => {
    const s = newSession(exampleStructure());
    return { ...s, powderParams: s.powderParams.map((p) => ({ ...p, fixed: true })) };
  };

  it("does not ask about a change that changes nothing", async () => {
    const { port, calls } = sessionPort(allFixed());
    const { ex, asked } = executor(fakeHost(port).host, true);
    const out = parse((await ex.run("set_free", { fix: ["scale"] })).text);
    expect(out.unchanged).toBe(true);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("asks before a change; a decline leaves the page untouched", async () => {
    const { port, calls } = sessionPort(allFixed());
    const { host, steps } = fakeHost(port);
    const { ex, asked } = executor(host, false);
    const out = await ex.run("set_free", { free: ["scale"] });
    expect(parse(out.text).declined).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.preview).toMatch(/^Free scale/);
    expect(calls).toEqual([]);
    expect(steps).toEqual([]);
  });

  it("an approved change runs as the agent and becomes an agent step", async () => {
    const { port, calls } = sessionPort(allFixed());
    const { host, steps } = fakeHost(port);
    const { ex, seen } = executor(host, true);
    const out = parse((await ex.run("set_free", { free: ["scale", "bkg*"] })).text);
    expect(calls[0]).toMatch(/^setFixed /);
    expect(out.free).toEqual(expect.arrayContaining(["scale"]));
    // The user's own edits are flushed first (as the user), then the agent's step.
    expect(steps).toEqual([{ kind: "edit", agent: false }, { kind: "edit", agent: true }]);
    expect(seen.map((e) => e.status)).toEqual(["waiting", "running", "done"]);
  });

  it("refines with the real engine, then assesses and suggests on the result", async () => {
    const start = newSession(exampleStructure());
    // Start the scale off its true value so the refinement has work to do.
    const { port, session } = sessionPort({
      ...start,
      powderParams: start.powderParams.map((p) => ({ ...p, fixed: true, ...(p.kind === "scale" ? { value: p.value * 0.6 } : {}) })),
    });
    const { host } = fakeHost(port);
    const { ex } = executor(host, "auto");
    expect((await ex.run("refine", {})).text).toMatch(/no parameter is free/);
    await ex.run("set_free", { free: ["scale"] });
    const refined = parse((await ex.run("refine", {})).text);
    expect(refined.refined).toBe(true);
    expect(refined.wR as number).toBeLessThan(refined.wRBefore as number);
    expect(session().powderParams.find((p) => p.kind === "scale")!.fixed).toBe(false);

    const assessment = parse((await ex.run("assess_refinement", {})).text);
    expect(typeof assessment.summary).toBe("string");
    expect(assessment.verdict).toBeDefined();
    const next = parse((await ex.run("suggest_next_steps", {})).text);
    expect(next.steps).toBeDefined();
  });

  it("reports a refinement that did not finish", async () => {
    const { port } = sessionPort(newSession(exampleStructure()));
    const stuck: PowderAgentPort = { ...port, refine: async () => "cancelled" };
    const { ex } = executor(fakeHost(stuck).host, "auto");
    const out = parse((await ex.run("refine", {})).text);
    expect(out.refined).toBe(false);
    expect(String(out.note)).toMatch(/did not finish \(cancelled\)/);
  });

  it("never refines correlated parameters together: the free set is checked before anyone is asked", async () => {
    const start = newSession(exampleStructure());
    // Scale with every site occupancy: an exact degeneracy (all three only scale intensity).
    const { port, calls } = sessionPort({ ...start, powderParams: start.powderParams.map((p) => ({ ...p, fixed: !["scale", "occ_Mn1", "occ_Ga1"].includes(p.id) })) });
    const { ex, asked, seen } = executor(fakeHost(port).host, true);
    const out = await ex.run("refine", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Not refined: .*Not determined by the data at all, together: .*occ_Mn1.*Fix one of each pair with set_free/);
    expect(asked).toEqual([]);
    expect(calls).toEqual(["probe"]);
    const card = seen.filter((e) => e.tool === "refine").at(-1)!;
    expect(card.status).toBe("failed");
    expect(card.outcome).toMatch(/^Not run: .* not determined$/);

    // With the occupancies fixed again, the approval card names the strongest pair left.
    await ex.run("set_free", { fix: ["occ_*"], free: ["bkg*"] });
    const refined = parse((await ex.run("refine", {})).text);
    expect(refined.refined).toBe(true);
    expect(asked.at(-1)!.preview).toMatch(/^Refine .* · strongest correlation \S+ ↔ \S+ -?0\.\d{3}$/);
  });

  it("does not refine when the correlation check itself fails", async () => {
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const broken: PowderAgentPort = { ...port, probe: async () => { throw new Error("cancelled"); } };
    const { ex, asked } = executor(fakeHost(broken).host, true);
    expect((await ex.run("refine", {})).text).toMatch(/could not check the free parameters' correlations before refining \(cancelled\); nothing was refined/);
    expect(asked).toEqual([]);
    expect(calls).not.toContain("refine");
  });

  it("refuses a change while a refinement runs, but lets a cancel through", async () => {
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const busy: PowderAgentPort = { ...port, state: () => ({ ...port.state(), busy: true }) };
    const { ex, asked } = executor(fakeHost(busy).host, true);
    expect((await ex.run("set_free", { free: ["scale"] })).text).toMatch(/a refinement is running/);
    expect(asked).toEqual([]);
    const cancelled = parse((await ex.run("cancel_refinement", {})).text);
    expect(cancelled.cancelled).toBe("requested");
    expect(calls).toContain("cancel");
  });

  it("keeps big answers small and opens them with read_ref", async () => {
    const { port } = sessionPort(newSession(exampleStructure()));
    const { ex } = executor(fakeHost(port).host);
    const all = parse((await ex.run("get_state", { parameters: ["*"] })).text);
    expect(JSON.stringify(all).length).toBeLessThan(8000);
    const rows = all.parameterRows as unknown[] | { ref: string };
    const ref = Array.isArray(rows) ? `${String(all.ref)}/parameterRows` : rows.ref;
    const window = parse((await ex.run("read_ref", { ref, start: 0, end: 2 })).text);
    expect((window.items as unknown[]).length).toBe(2);
  });

  it("finds residual peaks and bond lengths on the live model", async () => {
    const { port } = sessionPort(newSession(exampleStructure()));
    const { ex } = executor(fakeHost(port).host);
    const peaks = parse((await ex.run("find_unexplained_peaks", {})).text);
    expect(typeof peaks.count).toBe("number");
    const bonds = parse((await ex.run("bond_geometry", { cutoff: 3 })).text);
    expect(bonds.phase).toBe(port.state().structure.id);
    expect((await ex.run("bond_geometry", { phase: "nope" })).text).toMatch(/no phase "nope"/);
  });

  it("validates the fit window against the pattern", async () => {
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const { ex } = executor(fakeHost(port).host, "auto");
    const { extent } = port.state();
    expect((await ex.run("set_fit_range", { min: 50, max: 40 })).text).toMatch(/needs max > min/);
    await ex.run("set_fit_range", { min: extent.min + 5, max: extent.max - 5 });
    expect(calls.at(-1)).toBe(`range ${extent.min + 5}-${extent.max - 5}`);
    await ex.run("set_fit_range", { whole: true });
    expect(calls.at(-1)).toBe("range whole");
  });
});

/**
 * A PDF page without React: the bundled demo's structure and G(r) at its
 * converged values, the real curves and the real engine behind the port, over
 * a short r window so the fit is quick.
 */
function pdfPort(): { port: PdfAgentPort; calls: string[] } {
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
    cancel: () => calls.push("cancel"),
    reset: () => calls.push("reset"),
  };
  return { port, calls };
}

describe("AgentExecutor on a live PDF fit", () => {
  it("reads the PDF page in its own terms: r window, Rw, no GoF", async () => {
    const { port } = pdfPort();
    const { ex, asked } = executor(fakeHost(port).host);
    const view = parse((await ex.run("get_state", {})).text);
    expect(view.technique).toBe("pdf");
    expect((view.data as { axis: string; fitWindow: number[] }).axis).toBe("r (Å)");
    expect((view.data as { fitWindow: number[] }).fitWindow).toEqual([1.5, 6]);
    expect(typeof view.Rw).toBe("number");
    expect(String(view.convention)).toMatch(/no GoF/);
    expect(JSON.stringify(view)).not.toMatch(/"gof"|"wR"/);
    expect(asked).toEqual([]);
  });

  it("refuses a powder-only tool, naming the page", async () => {
    const { ex } = executor(fakeHost(pdfPort().port).host, "auto");
    for (const name of ["check_cell_symmetry", "set_background", "rank_next_parameters"]) {
      const out = await ex.run(name, name === "set_background" ? { terms: 3 } : {});
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(new RegExp(`${name} works on the powder page only; the PDF page is open`));
    }
  });

  it("frees, refines as the agent, and reports Rw; the assessment drops the GoF verdict", async () => {
    const { port, calls } = pdfPort();
    const { host, steps } = fakeHost(port);
    const { ex, asked, seen } = executor(host);
    expect((await ex.run("assess_refinement", {})).text).toMatch(/refine first/);

    await ex.run("set_free", { free: ["delta2"] });
    expect(calls).toContain("setFixed delta2=false");
    const out = parse((await ex.run("refine", {})).text);
    expect(asked.at(-1)!.preview).toMatch(/^Refine G\(r\), \d+ free parameters · (strongest correlation \S+ ↔ \S+ -?\d\.\d{3}|no correlation above 0\.5)$/);
    expect(out.refined).toBe(true);
    expect(typeof out.Rw).toBe("number");
    expect(typeof out.RwBefore).toBe("number");
    expect(out.gof).toBeUndefined();
    expect(seen.filter((e) => e.tool === "refine").at(-1)!.outcome).toMatch(/· Rw \d+\.\d\d%$/);
    expect(steps.some((st) => st.agent)).toBe(true);

    const verdict = parse((await ex.run("assess_refinement", {})).text);
    expect(JSON.stringify(verdict.verdict)).not.toMatch(/"gof"/);
    expect(String(verdict.convention)).toMatch(/no GoF/);
    const next = parse((await ex.run("suggest_next_steps", {})).text);
    expect(next.steps).toBeDefined();
  });

  it("refuses δ1 and δ2 together, which correlate on this G(r), and says why", async () => {
    const { port, calls } = pdfPort();
    const { ex, asked } = executor(fakeHost(port).host, true);
    await ex.run("set_free", { free: ["delta1", "delta2"] });
    const out = await ex.run("refine", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/delta1 ↔ delta2 -0\.9\d\d \(δ1 and δ2 both sharpen the near-neighbour peaks/);
    expect(calls).not.toContain("refine");
    // Only the set_free was asked about.
    expect(asked.map((e) => e.tool)).toEqual(["set_free"]);
  });

  it("restores the default r window and passes on why a run did not finish", async () => {
    const { port, calls } = pdfPort();
    const { ex, asked } = executor(fakeHost(port).host);
    await ex.run("set_fit_range", { min: 2, max: 5 });
    expect(calls.at(-1)).toBe("range 2-5");
    await ex.run("set_fit_range", { whole: true });
    expect(asked.at(-1)!.preview).toBe("Fit the default window, r 1.5 – 6 Å");
    expect(calls.at(-1)).toBe("range default");
    const out = parse((await ex.run("refine", { mode: "thorough" })).text);
    expect(out.refined).toBe(false);
    expect(String(out.note)).toMatch(/did not finish \(cancelled\)/);
  });
});

describe("AgentLink", () => {
  it("lets a page clear only its own port", () => {
    const link = new AgentLink();
    const pdf = pdfPort().port;
    link.publish(pdf);
    // The powder page, inactive under the PDF page, re-renders.
    link.release("powder");
    expect(link.port()).toBe(pdf);
    link.release("pdf");
    expect(link.port()).toBeNull();
  });
});
