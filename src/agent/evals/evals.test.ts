import { describe, it, expect } from "vitest";
import { SCENARIOS, scenario } from "@/agent/evals/scenarios";
import { runScenario, transcript, type EvalResult } from "@/agent/evals/harness";
import { scriptedModel, type ScriptTurn } from "@/agent/evals/scripted";
import { sentences } from "@/agent/evals/checks";
import { executor, fakeHost } from "@/testSupport/agentHeadless";
import { impurityD, mn3gaImpuritySession, mn3gaMisfitSession, powderPage } from "@/agent/evals/pages";

/**
 * The eval suite in CI: every scenario replayed with a scripted model, once
 * as the Agent should behave (every check passes) and once as it did when the
 * failure was found (the checks written against it fail). The real chat loop,
 * executor and tools run each time; only the model is scripted. The live run
 * against Claude is live.test.ts.
 */

const RIETVELD = { name: "read_skill", input: { name: "my-rietveld-workflow" } };
const PDF = { name: "read_skill", input: { name: "pdf-workflow" } };

interface Replay {
  readonly good: readonly ScriptTurn[];
  readonly bad: readonly ScriptTurn[];
  /** The checks the bad transcript must fail. */
  readonly catches: readonly string[];
}

const REPLAYS: Readonly<Record<string, Replay>> = {
  "full-refinement": {
    good: [
      { text: "First your method.", calls: [RIETVELD, { name: "get_state" }] },
      { text: "Stage 1: scale, background and cell.", calls: [{ name: "refine" }] },
      { text: "Positions next.", calls: [{ name: "set_free", input: { free: ["pos_Mn1_0"] } }, { name: "refine" }] },
      { text: "Now the profile.", calls: [{ name: "set_free", input: { free: ["width"] } }, { name: "refine" }] },
      { text: "Then the ADPs.", calls: [{ name: "set_free", input: { free: ["B_Mn1", "B_Ga1"] } }, { name: "refine" }] },
      { text: "Done: scale, background, cell, the Mn position, the peak width and both B_iso refined; the fit improved at every stage." },
    ],
    bad: [
      { calls: [RIETVELD, { name: "check_cell_symmetry" }] },
      { text: "The cell gate has not passed, so I cannot run the full refinement. The absences suggest the group is too symmetric: we should lower the symmetry to a subgroup first." },
    ],
    catches: ["does not refuse the refinement or cite a gate", "runs at least 3 converged refinements", "proposes no symmetry change before the review"],
  },
  "misfits-not-extra-peaks": {
    good: [
      { calls: [{ name: "find_unexplained_peaks" }] },
      { text: "No extra peaks: every residual peak sits on or beside a reflection the model already has. They are misfits of intensity and width, which refining the ADPs, the Mn position and the profile will fix." },
    ],
    bad: [
      { calls: [{ name: "find_unexplained_peaks" }] },
      { text: "Yes: there are 12 extra peaks in the residual. The space group may be too high; consider lowering the symmetry." },
    ],
    catches: ["calls no misfit an extra peak", "proposes no symmetry change before the review"],
  },
  "symmetry-last": {
    good: [
      { calls: [{ name: "get_state" }, { name: "review_symmetry" }] },
      { text: "Not yet. Your method refines the structure to the best its group allows before the group is questioned, and the positions, the profile and the ADPs are still to refine. Shall I refine them first?" },
    ],
    bad: [
      { text: "Yes. The misfit says the symmetry is too high: we should lower the symmetry to P 63 m c, a subgroup of P 63/m m c." },
    ],
    catches: ["proposes no symmetry change before the review", "explains refining first"],
  },
  "impurity-line": {
    good: [
      { calls: [{ name: "find_unexplained_peaks" }] },
      { text: `One line no phase explains, at d ≈ ${impurityD().toFixed(2)} Å: an impurity, or magnetic order. Do you know of a second phase in the sample?` },
    ],
    bad: [
      { text: "The residual is flat: the model accounts for everything." },
    ],
    catches: ["calls find_unexplained_peaks", `reports the line at d ≈ ${impurityD().toFixed(2)} Å`],
  },
  "bare-occupancy": {
    good: [
      { calls: [RIETVELD, { name: "set_free", input: { free: ["occ_Mn1"] } }, { name: "refine" }] },
      { text: "Refused, and rightly: the Mn occupancy has nothing but the scale to determine it. Tie it (Σ occ = 1 on a shared site, or hold the composition), or keep it fixed. Which would you like?" },
    ],
    bad: [
      { calls: [RIETVELD, { name: "set_free", input: { free: ["occ_Mn1"] } }, { name: "refine" }] },
      { calls: [{ name: "allow_exception", input: { rule: "bare-occupancy", reason: "the user asked for it" } }] },
      { calls: [{ name: "refine" }] },
      { text: "It did not run." },
    ],
    catches: ["does not ask to lift a firm rule unprompted", "changes the free set after a refused refinement (≤ 2 refusals)", "explains why the occupancy needs a tie"],
  },
  "free-everything": {
    good: [
      { calls: [RIETVELD, { name: "set_free", input: { free: ["*"] } }, { name: "refine" }] },
      { text: "The occupancies cannot refine bare; I hold them.", calls: [{ name: "set_free", input: { fix: ["occ_*"] } }, { name: "refine" }] },
      { text: "Everything but the occupancies refined; they stay fixed until you choose a tie." },
    ],
    bad: [
      { calls: [RIETVELD, { name: "set_free", input: { free: ["*"] } }, { name: "refine" }] },
      { calls: [{ name: "refine" }] },
      { text: "The refinement keeps being refused." },
    ],
    catches: ["changes the free set after a refused refinement (≤ 3 refusals)"],
  },
  "fit-window-in-d": {
    good: [
      { calls: [RIETVELD, { name: "set_fit_range", input: { min: 1.2, max: 3, unit: "dSpacing" } }] },
      { text: "The fit window is now d = 1.2–3 Å." },
    ],
    bad: [
      { calls: [RIETVELD, { name: "set_fit_range", input: { min: 1.2, max: 3 } }] },
      { text: "Done." },
    ],
    catches: ["sets the fit window to 1.2–3 (dSpacing)"],
  },
  "pdf-method": {
    good: [
      { calls: [PDF, { name: "refine" }] },
      { text: "Scale and cell done; the ADPs next.", calls: [{ name: "set_free", input: { free: ["U_*"] } }, { name: "refine" }] },
      { text: "One correlated-motion term.", calls: [{ name: "set_free", input: { free: ["delta2"] } }, { name: "refine" }] },
      { text: "Scale, cell, ADPs and δ2 refined, one stage at a time." },
    ],
    bad: [
      { calls: [{ name: "refine" }] },
      { calls: [PDF, { name: "set_free", input: { free: ["delta1", "delta2"] } }, { name: "refine" }] },
      { text: "Refined." },
    ],
    catches: ["reads the page's method before its first change", "runs at least 2 converged refinements"],
  },
  "pdf-local-structure": {
    good: [
      { calls: [PDF, { name: "boxcar_scan", input: { width: 3, step: 1.5 } }] },
      { text: "The boxes agree within their spread: no sign that the local structure differs from the average one over this range." },
    ],
    bad: [
      { text: "They are the same." },
    ],
    catches: ["calls boxcar_scan"],
  },
};

async function replay(id: string, turns: readonly ScriptTurn[]): Promise<EvalResult & { overrun: number }> {
  const stand = await scriptedModel(turns);
  try {
    const result = await runScenario(scenario(id), stand.model);
    return { ...result, overrun: stand.overrun() };
  } finally {
    await stand.close();
  }
}

const failing = (r: EvalResult): string[] => r.grades.filter((g) => !g.pass).map((g) => g.check);
const why = (r: EvalResult): string => `${r.grades.map((g) => `${g.pass ? "✓" : "✗"} ${g.check}: ${g.detail}`).join("\n")}\n---\n${transcript(r.run)}`;

describe("Agent evals, scripted", () => {
  it("has a good and a bad replay for every scenario", () => {
    expect(Object.keys(REPLAYS).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });

  for (const s of SCENARIOS) {
    describe(s.id, () => {
      const r = REPLAYS[s.id]!;
      it("passes every check as the Agent should behave", async () => {
        const result = await replay(s.id, r.good);
        expect(result.overrun, why(result)).toBe(0);
        expect(failing(result), why(result)).toEqual([]);
      }, 60_000);

      it("fails the checks written against the failure", async () => {
        const result = await replay(s.id, r.bad);
        const names = s.checks.map((c) => c.name);
        for (const c of r.catches) expect(names, `${c} is not a check of ${s.id}`).toContain(c);
        expect(failing(result), why(result)).toEqual(expect.arrayContaining([...r.catches]));
      }, 60_000);
    });
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
});
