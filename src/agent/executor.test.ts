import { describe, it, expect } from "vitest";
import { emptyRecord, keyOfState } from "@/agent/method";
import type { PowderAgentPort } from "@/agent/port";
import { AgentLink } from "@/agent/link";
import { freePlan } from "@/agent/liveCommon";
import { LIVE_TOOLS, inputJsonSchema } from "@/agent/tools";
import { newSession, type Session } from "@/app/powderSession";
import { exampleStructure } from "@/examples/mn3ga";
import type { RefinementParameter } from "@/core/refinement/types";
import { executor, fakeHost, pdfPort, sessionPort } from "@/testSupport/agentHeadless";

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
    const { host, records } = fakeHost(port);
    // The method's firm rules come first (see below); here the user allowed
    // the bare occupancies, so the correlations decide.
    const key = keyOfState("powder", port.state());
    records.set(key, { ...emptyRecord(key), exceptions: [{ rule: "bare-occupancy", reason: "test", at: 0 }] });
    const { ex, asked, seen } = executor(host, true);
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

  it("refines the structure whatever the cell check says, and counts the stages a refinement covers", async () => {
    const start = newSession(exampleStructure());
    const { port, calls } = sessionPort({ ...start, powderParams: start.powderParams.map((p) => ({ ...p, fixed: !["scale", "bkg0", "pos_Mn1_0"].includes(p.id) })) });
    const { host, records } = fakeHost(port);
    const { ex, asked } = executor(host, true);
    // No cell check yet: atomic parameters refine anyway (the deployed Agent
    // refused a full refinement here, citing the check).
    const done = parse((await ex.run("refine", {})).text);
    expect(done.refined).toBe(true);
    expect(calls.slice(0, 2)).toEqual(["probe", "refine"]);
    expect(asked.map((e) => e.tool)).toEqual(["refine"]);
    expect(done.methodNote).toBeUndefined(); // the base block was free alongside
    const key = keyOfState("powder", port.state());
    expect(records.get(key)!.stagesDone).toEqual(expect.arrayContaining(["base", "positions"]));

    // The check is recorded, not enforced.
    const check = parse((await ex.run("check_cell_symmetry", {})).text);
    expect(check.passed).toBe(true);
    expect(check.reading).toBe("Every peak indexes and no forbidden reflection shows intensity: refine the structure.");
    expect(records.get(key)!.cellCheck).toMatchObject({ passed: true, summary: "every peak indexes; no absence flagged" });
    const method = parse((await ex.run("get_state", {})).text).method as { stages: string[]; next: string; cellCheck: string };
    expect(method.stages).toEqual(["✓ Cell check", "✓ Scale, background, cell", "✓ Positions", "○ Profile", "○ ADPs", "○ Occupancy (if needed)", "○ Corrections (if needed)", "○ Symmetry review (last) (if needed)"]);
    expect(method.next).toBe("Profile");
    expect(method.cellCheck).toBe("every peak indexes; no absence flagged");

    // ADPs before the profile: refined, with a note.
    await ex.run("set_free", { fix: ["pos_Mn1_0"], free: ["B_Mn1"] });
    const adp = parse((await ex.run("refine", {})).text);
    expect(adp.methodNote).toMatch(/^Out of the method's order \(my-rietveld-workflow\): adps refined before profile\./);
  });

  it("questions the space group only last: review_symmetry waits for the method's stages", async () => {
    const start = newSession(exampleStructure());
    const { port } = sessionPort({ ...start, powderParams: start.powderParams.map((p) => ({ ...p, fixed: !["scale", "bkg0"].includes(p.id) })) });
    const { host, records } = fakeHost(port);
    const { ex, seen } = executor(host, true);
    const early = await ex.run("review_symmetry", {});
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/^Error: Not yet\. The space group is the last thing questioned: a structure is refined to the best its group allows first, and intensity that differs on the group's own reflections is what that refinement fixes/);
    expect(early.text).toMatch(/Refine these stages of my-rietveld-workflow first, each to convergence: Scale, background, cell, Positions, Profile, ADPs\./);
    expect(seen.filter((e) => e.tool === "review_symmetry").at(-1)!.outcome).toBe("Not yet: 4 stages to refine first");

    // Every required stage covered, but nothing refined on screen: still not yet.
    const key = keyOfState("powder", port.state());
    records.set(key, { ...emptyRecord(key), stagesDone: ["base", "positions", "profile", "adp"] });
    expect((await ex.run("review_symmetry", {})).text).toMatch(/^Error: Not yet: the review reads the refined residual, and the fit on screen is not refined\./);

    // Refined to convergence: the review reads the residual and is recorded.
    expect(parse((await ex.run("refine", {})).text).refined).toBe(true);
    const review = parse((await ex.run("review_symmetry", {})).text);
    expect(Array.isArray(review.observedForbidden)).toBe(true);
    expect(String(review.decision)).toMatch(/^The user's\./);
    expect(records.get(key)!.symmetryReviewed?.summary).toMatch(/forbidden reflection/);
    const method = parse((await ex.run("get_state", {})).text).method as { stages: string[]; symmetryReview: string };
    expect(method.stages.at(-1)).toBe("✓ Symmetry review (last) (if needed)");
    expect(method.symmetryReview).toBe(records.get(key)!.symmetryReviewed!.summary);
  });

  it("keeps notes on the analysis, without asking, and lists them in get_state", async () => {
    const { port, calls } = sessionPort(newSession(exampleStructure()));
    const { host, records, steps } = fakeHost(port);
    const { ex, asked } = executor(host, true);
    const out = parse((await ex.run("write_note", { text: "The minor phase is MnO (user)." })).text);
    expect(out).toMatchObject({ noted: true, notes: 1 });
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    expect(steps).toEqual([]);
    expect(records.get(keyOfState("powder", port.state()))!.notes.map((n) => n.text)).toEqual(["The minor phase is MnO (user)."]);
    expect((parse((await ex.run("get_state", {})).text).method as { notes: string[] }).notes).toEqual(["The minor phase is MnO (user)."]);
  });

  it("never frees an occupancy bare; only the user lifts the rule, asked even in Auto", async () => {
    const start = newSession(exampleStructure());
    const { port } = sessionPort({ ...start, powderParams: start.powderParams.map((p) => ({ ...p, fixed: !["scale", "occ_Mn1"].includes(p.id) })) });
    const { host, records } = fakeHost(port);
    const key = keyOfState("powder", port.state());
    const { ex, asked } = executor(host, "auto");
    const refused = await ex.run("refine", {});
    expect(refused.text).toMatch(/occ_Mn1 is a free occupancy with nothing but the scale to determine it.*Tie it \(set_site_ties/);
    const allow = parse((await ex.run("allow_exception", { rule: "bare-occupancy", reason: "Mn K-edge anomalous contrast" })).text);
    expect(allow.allowed).toBe("bare-occupancy");
    expect(asked.at(-1)).toMatchObject({ tool: "allow_exception", alwaysAsk: true, preview: "Refine an occupancy with no tie or second contrast, because: Mn K-edge anomalous contrast" });
    expect(records.get(key)!.exceptions).toEqual([expect.objectContaining({ rule: "bare-occupancy", reason: "Mn K-edge anomalous contrast" })]);
    // Past the rule, the correlation check still applies (scale ↔ the only occupancy).
    expect((await ex.run("refine", {})).text).not.toMatch(/free occupancy with nothing but the scale/);
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
    type Listed = { d: number; q: number; twoTheta: number; near?: string };
    const unexplained = peaks.unexplained as Listed[];
    const misfits = peaks.misfits as Listed[];
    // Only the peaks on no reflection count, and only they are marked on the
    // plot for the user, without an approval card.
    expect(unexplained.length).toBe(peaks.count as number);
    const shown = calls.find((c) => c.startsWith("showPeaks"));
    expect(shown).toBeDefined();
    expect(shown!.split(" ")[1]?.split(",").filter(Boolean).length ?? 0).toBe(peaks.count as number);
    if ((peaks.count as number) > 0) expect(String(peaks.markedOnPlot)).toMatch(/marked on the plot/);
    // Residual on a known reflection is its misfit, never an extra peak.
    for (const p of misfits) expect(p.near).toMatch(/^(on|beside) \S+ -?\d+ -?\d+ -?\d+( \(-?\d+\.\d% in d\))?$/);
    if (misfits.length > 0) expect(String(peaks.reading)).toMatch(/They are not extra peaks/);
    for (const p of [...unexplained, ...misfits]) {
      expect(p.q).toBeCloseTo((2 * Math.PI) / p.d, 3);
      expect(1.54 / (2 * Math.sin((p.twoTheta / 2) * Math.PI / 180))).toBeCloseTo(p.d, 4);
    }
    // showMisfits marks the misfits as well.
    calls.length = 0;
    await ex.run("find_unexplained_peaks", { showMisfits: true });
    expect(calls.find((c) => c.startsWith("showPeaks"))!.split(" ")[1]?.split(",").filter(Boolean).length ?? 0).toBe(unexplained.length + misfits.length);
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
    // There is no cell gate to lift, on either page.
    expect((await ex.run("allow_exception", { rule: "cell-gate", reason: "an impurity" })).text).toMatch(/invalid input for allow_exception/);
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
