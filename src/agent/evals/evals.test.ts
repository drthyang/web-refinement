import { describe, it, expect } from "vitest";
import { SCENARIOS, scenario } from "@/agent/evals/scenarios";
import { regrade, runScenario, savedRun, transcript, type EvalResult, type SavedRun } from "@/agent/evals/harness";
import { scriptedModel, type ScriptTurn } from "@/agent/evals/scripted";
import { sentences } from "@/agent/evals/checks";
import { executor, fakeHost } from "@/testSupport/agentHeadless";
import { LIVE_TOOLS } from "@/agent/tools";
import { impurityD, mn3gaImpuritySession, mn3gaMisfitSession, powderPage } from "@/agent/evals/pages";

/**
 * The eval suite in CI: every scenario replayed with a scripted model, once
 * as the Agent should behave (every check passes) and once as it did when the
 * failure was found (the checks written against it fail). The real chat loop,
 * executor and tools run each time; only the model is scripted. The live run
 * against Claude is live.test.ts.
 */

import { MORE_FAILURES, REPLAYS, RIETVELD, SC } from "@/agent/evals/replays";

async function replay(id: string, turns: readonly ScriptTurn[], toolScope?: "stage"): Promise<EvalResult & { overrun: number; offered: readonly (readonly string[])[] }> {
  const stand = await scriptedModel(turns);
  try {
    const result = await runScenario(scenario(id), { ...stand.model, ...(toolScope ? { toolScope } : {}) });
    return { ...result, overrun: stand.overrun(), offered: stand.offered() };
  } finally {
    await stand.close();
  }
}

const failing = (r: EvalResult): string[] => r.grades.filter((g) => !g.pass).map((g) => g.check);
const verdicts = (r: EvalResult): [string, boolean][] => r.grades.map((g) => [g.check, g.pass]);
/** The run as live.test.ts saves it (through JSON), scored again: the same verdicts. */
const regraded = (r: EvalResult): [string, boolean][] => verdicts(regrade(JSON.parse(JSON.stringify(savedRun(r))) as SavedRun, scenario(r.scenario)));
const why = (r: EvalResult): string => `${r.grades.map((g) => `${g.pass ? "✓" : "✗"} ${g.check}: ${g.detail}`).join("\n")}\n---\n${transcript(r.run)}`;

describe("Agent evals, scripted", () => {
  it("has a good and a bad replay for every scenario", () => {
    expect(Object.keys(REPLAYS).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });

  for (const s of SCENARIOS) {
    // A scenario on data only some machines have (the user's own) replays where they are.
    describe.skipIf(!(s.available?.() ?? true))(s.id, () => {
      const r = REPLAYS[s.id]!;
      it("passes every check as the Agent should behave", async () => {
        const result = await replay(s.id, r.good);
        expect(result.overrun, why(result)).toBe(0);
        expect(failing(result), why(result)).toEqual([]);
        expect(regraded(result), "the saved run, scored again").toEqual(verdicts(result));
      }, 60_000);

      it("offers every tool the good replay calls when the tools follow the stage (a local model's list)", async () => {
        const result = await replay(s.id, r.good, "stage");
        // Request i is answered with turn i: each call it makes must have been offered with it.
        const missing = r.good.flatMap((turn, i) => (turn.calls ?? []).filter((c) => !result.offered[i]?.includes(c.name)).map((c) => `turn ${i + 1}: ${c.name}`));
        expect(missing, why(result)).toEqual([]);
        expect(failing(result), why(result)).toEqual([]);
        // Fewer tools than the page has, on the powder page.
        if (result.run.port.technique === "powder") expect(Math.min(...result.offered.slice(0, r.good.length).map((o) => o.length))).toBeLessThan(LIVE_TOOLS.filter((t) => t.pages.includes("powder")).length);
      }, 60_000);

      it("fails the checks written against the failure", async () => {
        const result = await replay(s.id, r.bad);
        const names = s.checks.map((c) => c.name);
        for (const c of r.catches) expect(names, `${c} is not a check of ${s.id}`).toContain(c);
        expect(failing(result), why(result)).toEqual(expect.arrayContaining([...r.catches]));
        expect(regraded(result), "the saved run, scored again").toEqual(verdicts(result));
      }, 60_000);
    });
  }
});

describe("checks every scenario holds, shown to catch their failure", () => {
  for (const f of MORE_FAILURES) {
    it(`${f.scenario}: ${f.catches.join(", ")}`, async () => {
      const result = await replay(f.scenario, f.turns);
      for (const c of f.catches) expect(scenario(f.scenario).checks.map((k) => k.name), `${c} is not a check of ${f.scenario}`).toContain(c);
      expect(failing(result), why(result)).toEqual(expect.arrayContaining([...f.catches]));
    }, 60_000);
  }
});

describe("the eval pages", () => {
  it("the misfit page has misfits and no extra peak; the impurity page has the one line", async () => {
    const misfit = JSON.parse((await executor(fakeHost(powderPage(mn3gaMisfitSession())).host).ex.run("find_unexplained_peaks", {})).text) as { count: number; misfits: unknown[] };
    expect(misfit.count).toBe(0);
    expect(misfit.misfits.length).toBeGreaterThan(3);
    const impurity = JSON.parse((await executor(fakeHost(powderPage(mn3gaImpuritySession())).host).ex.run("find_unexplained_peaks", {})).text) as { count: number; unexplained: { d: number }[] };
    expect(impurity.count).toBe(1);
    expect(impurity.unexplained[0]!.d).toBeCloseTo(impurityD(), 1);
  }, 60_000);

  it("reads a reply sentence by sentence, with its negations", () => {
    expect(sentences("No extra peaks. Two misfits:\n- 1 0 0\n- 1 1 0")).toEqual(["No extra peaks.", "Two misfits:", "- 1 0 0", "- 1 1 0"]);
  });

  it("does not take a rule about what refines together for a refusal (full-refinement, Haiku, 2026-10-11)", async () => {
    const r = await replay("full-refinement", [
      { calls: [RIETVELD, { name: "get_state" }] },
      { text: "Stage 1: scale, background and cell.", calls: [{ name: "refine" }] },
      { text: "Positions next.", calls: [{ name: "set_free", input: { free: ["pos_Mn1_0"] } }, { name: "refine" }] },
      { text: "Now the profile.", calls: [{ name: "set_free", input: { free: ["width"] } }, { name: "refine" }] },
      { text: "The instrument-thermal rule says the profile width must not refine together with the B values, so I'll fix `width` and free the two B values.", calls: [{ name: "set_free", input: { free: ["B_Mn1", "B_Ga1"], fix: ["width"] } }, { name: "refine" }] },
      { text: "Done: every stage refined." },
    ]);
    expect(r.grades.find((g) => g.check === "does not refuse the refinement or cite a gate")?.pass, why(r)).toBe(true);
    // The refusal it was written against still fails.
    const refused = await replay("full-refinement", [
      { calls: [RIETVELD, { name: "check_cell_symmetry" }] },
      { text: "The cell gate has not passed, so I cannot run the full refinement together with the profile." },
    ]);
    expect(refused.grades.find((g) => g.check === "does not refuse the refinement or cite a gate")?.pass, why(refused)).toBe(false);
  }, 60_000);

  it("reads a zero count as none, and keeps speculation about other peaks a claim (misfits-not-extra-peaks, Sonnet, 2026-10-11)", async () => {
    const zero = await replay("misfits-not-extra-peaks", [
      { calls: [{ name: "find_unexplained_peaks" }] },
      { text: "`find_unexplained_peaks` returned 0 unexplained peaks at the default 8σ threshold. The residual peaks sit on the model's reflections: misfits of intensity and width, which refining fixes." },
    ]);
    expect(zero.grades.find((g) => g.check === "calls no misfit an extra peak")?.pass, why(zero)).toBe(true);
    // The tool found none: "other unexplained peaks could be…" says there are some.
    const guessed = await replay("misfits-not-extra-peaks", [
      { calls: [{ name: "find_unexplained_peaks" }] },
      { text: "The residual peaks are misfits on the model's reflections. Other unexplained peaks could be sample-environment lines or an impurity." },
    ]);
    expect(guessed.grades.find((g) => g.check === "calls no misfit an extra peak")?.pass, why(guessed)).toBe(false);
  }, 60_000);

  it("does not take a denied R_int for a quoted one (sc-listing-honesty, 2026-10-11)", async () => {
    const check = "says the data are a refinement's listing and quotes no R_int from them";
    const denied = await replay("sc-listing-honesty", [
      { calls: [SC, { name: "reflection_statistics" }] },
      { text: "These Fo² are a refinement's listing (.fcf): each reflection once, so no R_int (1570 reflections)." },
    ]);
    expect(denied.grades.find((g) => g.check === check)?.pass, why(denied)).toBe(true);
    for (const quoted of ["The data look good: R_int (0.0 %), from the listing.", "An R_int of 0 % for this listing.", "From the listing, R_int = 0.0 %."]) {
      const r = await replay("sc-listing-honesty", [{ calls: [SC, { name: "reflection_statistics" }] }, { text: quoted }]);
      expect(r.grades.find((g) => g.check === check)?.pass, why(r)).toBe(false);
    }
  }, 60_000);

  it("sends back a grade that contradicts the engine's verdict, as the app does", async () => {
    // The harness's runner once had no `fill`, so this final-answer check ran in the app but never in an eval or the validation.
    const turns = (answer: string): ScriptTurn[] => [
      { calls: [RIETVELD, { name: "get_state" }] },
      { text: "Stage 1: scale, background and cell.", calls: [{ name: "refine" }] },
      { calls: [{ name: "assess_refinement" }] },
      { text: answer },
      { text: "The engine's verdict is {{verdict}}." },
    ];
    const quoted = await replay("full-refinement", turns("The engine's verdict is {{verdict}}."));
    const band = quoted.run.events.flatMap((e) => (e.kind === "reply" && e.refs ? [e.refs["verdict"]] : []))[0];
    expect(band, why(quoted)).toBeTruthy();
    expect(quoted.run.notices.filter((n) => /quote the engine's verdict/.test(n)), why(quoted)).toEqual([]);
    const contradicting = /excellent|good/.test(band!) ? "A poor fit, every stage refined." : "An excellent fit, every stage refined.";
    const graded = await replay("full-refinement", turns(contradicting));
    expect(graded.run.notices.some((n) => /quote the engine's verdict/.test(n)), why(graded)).toBe(true);
    expect(graded.overrun, why(graded)).toBe(0);
    // Every run keeps the policy it ran under, through the saved run too.
    expect(graded.run.policy).toMatchObject({ turnCap: 40, toolScope: "all", pruning: "server" });
    expect((JSON.parse(JSON.stringify(savedRun(graded))) as SavedRun).policy).toEqual(graded.run.policy);
  }, 60_000);

  it("does not take a denial for a proposal: \"Neither is evidence for a lower group\"", async () => {
    // A live run (2026-10-10) failed symmetry-last on that sentence: "neither" was not read as a negation.
    const r = await replay("symmetry-last", [
      { calls: [{ name: "get_state" }] },
      { text: "The misfit and the weak line at 2.1 Å are what refinement fixes. Neither is evidence for a lower group; the positions and the ADPs come first." },
    ]);
    expect(r.grades.find((g) => g.check === "proposes no symmetry change before the review")?.pass, why(r)).toBe(true);
  }, 60_000);
});
