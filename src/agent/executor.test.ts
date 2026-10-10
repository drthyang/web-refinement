import { describe, it, expect } from "vitest";
import { AgentExecutor, type ActivityEntry, type AgentHost } from "@/agent/executor";
import { PAGE_METHOD } from "@/agent/skills";
import type { AgentPort, PdfAgentPort, PdfLiveState, PowderAgentPort, PowderLiveState } from "@/agent/port";
import { AgentLink } from "@/agent/link";
import { gata4se8PdfExample } from "@/examples/gata4se8Pdf";
import { buildPdfProblem, buildPdfSpec, pdfCurves } from "@/core/workflow/pdf";
import { applyParameters } from "@/core/workflow/apply";
import { refine as refineProblem } from "@/core/refinement/engine";
import { freePlan } from "@/agent/liveCommon";
import { boxcarWindows } from "@/core/workflow/pdfBoxcar";
import { LIVE_TOOLS, inputJsonSchema } from "@/agent/tools";
import { newSession, type Session } from "@/app/powderSession";
import { powderRestraints } from "@/app/powderSpec";
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

/**
 * An executor as a conversation has it once the pages' methods are read
 * (`readMethods: false` for one that has read nothing yet). The reads run
 * before the activity is recorded, so tests see only their own calls.
 */
function executor(host: AgentHost, decision: boolean | "auto" = true, { readMethods = true } = {}): { ex: AgentExecutor; asked: ActivityEntry[]; seen: ActivityEntry[] } {
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

  it("reads a skill whole, and refuses a change until the page's method has been read", async () => {
    const { port, calls } = sessionPort(allFixed());
    const { ex, asked } = executor(fakeHost(port).host, true, { readMethods: false });
    const refused = await ex.run("set_free", { free: ["scale"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/read_skill with name "my-rietveld-workflow"/);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    // Reading another skill does not open the gate.
    await ex.run("read_skill", { name: "pdf-workflow" });
    expect((await ex.run("set_free", { free: ["scale"] })).isError).toBe(true);
    const skill = await ex.run("read_skill", { name: "my-rietveld-workflow" });
    expect(skill.isError).toBe(false);
    expect(skill.text).toMatch(/^Skill my-rietveld-workflow\n/);
    expect(skill.text).toContain("## The occupancy guardrail");
    expect(skill.text).toContain("- powder_structural_refinement:");
    expect(skill.text.length).toBeGreaterThan(8000); // whole, not cut to the ref budget
    expect((await ex.run("set_free", { free: ["scale"] })).isError).toBe(false);
    // A reference by name; an unknown one names the ones there are.
    expect((await ex.run("read_skill", { name: "my-rietveld-workflow", reference: "refinement_fitting_algorithms" })).text).toMatch(/^Reference "refinement_fitting_algorithms"/);
    expect((await ex.run("read_skill", { name: "my-rietveld-workflow", reference: "nope" })).text).toMatch(/has no reference "nope" — it has powder_structural_refinement/);
    // A new conversation reads the method again.
    ex.newConversation();
    expect((await ex.run("set_free", { fix: ["scale"] })).isError).toBe(true);
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
    expect(asked.at(-1)!.preview).toMatch(/^Refine .* · (strongest correlation \S+ ↔ \S+ -?0\.\d{3}|no correlation above 0\.5)$/);
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
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const { ex } = executor(fakeHost(port).host);
    const peaks = parse((await ex.run("find_unexplained_peaks", {})).text);
    expect(typeof peaks.count).toBe("number");
    // What it found is marked on the plot for the user, without an approval card.
    const shown = calls.find((c) => c.startsWith("showPeaks"));
    expect(shown).toBeDefined();
    expect(shown!.split(" ")[1]?.split(",").filter(Boolean).length ?? 0).toBe(peaks.count as number);
    if ((peaks.count as number) > 0) expect(String(peaks.markedOnPlot)).toMatch(/marked on the plot/);
    type Listed = { d: number; q: number; twoTheta: number; near?: string };
    const listed = [...(peaks.unexplained as Listed[]), ...(peaks.besideKnownReflections as Listed[]), ...(peaks.onKnownReflections as Listed[])];
    expect(listed.length).toBe(peaks.count as number);
    for (const p of peaks.onKnownReflections as Listed[]) expect(p.near).toMatch(/^\S+ -?\d+ -?\d+ -?\d+$/);
    for (const p of peaks.besideKnownReflections as Listed[]) expect(p.near).toMatch(/^beside \S+ -?\d+ -?\d+ -?\d+ \(-?\d+\.\d% in d\)$/);
    for (const p of listed) {
      expect(p.q).toBeCloseTo((2 * Math.PI) / p.d, 3);
      expect(1.54 / (2 * Math.sin((p.twoTheta / 2) * Math.PI / 180))).toBeCloseTo(p.d, 4);
    }
    const bonds = parse((await ex.run("bond_geometry", { cutoff: 3 })).text);
    expect(bonds.phase).toBe(port.state().structure.id);
    expect((await ex.run("bond_geometry", { phase: "nope" })).text).toMatch(/no phase "nope"/);
  });

  it("takes a fit window in d or Q and converts it with the page's own calibration", async () => {
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const { ex, asked } = executor(fakeHost(port).host, true);
    // The test pattern is 2θ at λ = 1.54 Å; get_state lists the window in d and Q too.
    const view = parse((await ex.run("get_state", {})).text);
    const other = (view.data as { inOtherUnits: Record<string, { extent: number[] }> }).inOtherUnits;
    expect(Object.keys(other).sort()).toEqual(["dSpacing", "q"]);
    expect(other.q!.extent[0]).toBeCloseTo((4 * Math.PI / 1.54) * Math.sin((12 / 2) * Math.PI / 180), 3);

    // Q 2–5 Å⁻¹ → d 1.2566–3.1416 Å → 2θ = 2 asin(λ/2d).
    await ex.run("set_fit_range", { min: 2, max: 5, unit: "q" });
    const twoTheta = (q: number): number => 2 * Math.asin((1.54 * q) / (4 * Math.PI)) * 180 / Math.PI;
    const [lo, hi] = calls.at(-1)!.replace("range ", "").split("-").map(Number);
    expect(lo).toBeCloseTo(twoTheta(2), 6);
    expect(hi).toBeCloseTo(twoTheta(5), 6);
    expect(asked.at(-1)!.preview).toMatch(/^Fit window 2 – 5 Å⁻¹ \(Q\) \(28\.\d+ – 75\.\d+ ° 2θ\)$/);
    // d runs the other way; the window is still ordered.
    await ex.run("set_fit_range", { min: 1.5, max: 3, unit: "dSpacing" });
    const [a, b] = calls.at(-1)!.replace("range ", "").split("-").map(Number);
    expect(a).toBeLessThan(b!);
    // A unit this pattern cannot reach is refused, naming the ones it can.
    expect((await ex.run("set_fit_range", { min: 1000, max: 2000, unit: "tof" })).text).toMatch(/cannot be read in tof: it converts to twoTheta, dSpacing, q/);
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

  it("sets the site ties as a settings step; a tie already set asks nothing", async () => {
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const { host, steps } = fakeHost(port);
    const { ex, asked } = executor(host, true);
    expect(parse((await ex.run("set_site_ties", { positions: true })).text).unchanged).toBe(true);
    expect((await ex.run("set_site_ties", {})).text).toMatch(/at least one of/);
    expect(asked).toEqual([]);
    await ex.run("set_site_ties", { composition: true, occupancyToUnity: true });
    expect(asked[0]!.preview).toBe("Σ occ = 1 on · hold composition on");
    expect(calls).toEqual(['ties {"occupancyToUnity":true,"composition":true}']);
    expect(port.state().settings.siteTies).toMatchObject({ composition: true, occupancyToUnity: true });
    expect(steps.at(-1)).toEqual({ kind: "settings", agent: true });
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

  it("scans boxes across r and reports Rw and the free values per box, leaving the rows as they were", async () => {
    const { port, calls } = pdfPort();
    const { ex, asked } = executor(fakeHost(port).host, true);
    const before = port.state().parameters.map((p) => p.value);
    const out = parse((await ex.run("boxcar_scan", { width: 2, step: 1 })).text);
    expect(asked.at(-1)!.preview).toMatch(/^Boxcar scan: 3 boxes of 2 Å every 1 Å across r 1\.5 – 6 Å, \d+ free parameters$/);
    expect(calls).toContain("boxcar 2/1");
    const pass = (out.boxcar as { passes: { boxes: { r: number[]; Rw: number; values: Record<string, number> }[]; spread: Record<string, unknown> }[] }).passes[0]!;
    expect(pass.boxes.map((b) => b.r)).toEqual([[1.5, 3.5], [2.5, 4.5], [3.5, 5.5]]);
    expect(pass.boxes.every((b) => Number.isFinite(b.Rw) && Object.keys(b.values).length > 0)).toBe(true);
    expect(String(out.note)).toMatch(/^3 boxes · Rw \d+\.\d% at low r → \d+\.\d% at high r$/);
    expect(port.state().parameters.map((p) => p.value)).toEqual(before);
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
