import { describe, it, expect } from "vitest";
import { executor, fakeHost, sessionPort } from "@/testSupport/agentHeadless";
import { MAGNETIC_TRUTH, mn3gaMagneticSession } from "@/agent/evals/pages";
import { kComponent, simplicity } from "@/agent/magneticTools";

/**
 * The magnetic analysis step through the Agent's tools, on a synthetic Mn₃Ga
 * pattern with magnetic satellites from a known group at k = (0 0 ½): the
 * same calls the page's controls make, from the residual peaks to nuclear and
 * magnetic refined together.
 */

const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

function page() {
  const session = mn3gaMagneticSession();
  const { port, calls, session: now } = sessionPort(session);
  const { host } = fakeHost(port);
  const { ex, asked, seen } = executor(host, true);
  return { ex, port, calls, now, asked, seen, truthGroup: session.truthGroup };
}

describe("the magnetic analysis step through the Agent", () => {
  it("finds k, ranks the groups, fits the moments, and hands the model to the refinement", async () => {
    const { ex, calls, now, truthGroup } = page();
    const state = parse((await ex.run("magnetic_state", {})).text);
    expect(state.ions).toEqual(["Mn1 (Mn) ✓"]);
    expect(state.k).toBe("(0, 0, 0)");
    const peaks = state.residualPeaks as { usedByKSearch: { d: number }[]; notUsed?: string; strongestNotUsed?: { near?: string }[] };
    expect(peaks.usedByKSearch.length).toBeGreaterThanOrEqual(3);
    // A satellite on a nuclear reflection is left out of the search, and said so.
    expect(peaks.notUsed).toMatch(/^\d+ \(below 5σ, or on a nuclear reflection\)$/);

    // A change waits for the step's own method.
    expect((await ex.run("set_propagation_vector", { k: [0, 0, "1/2"] })).text).toMatch(/read_skill with name "magnetic-analysis" — it is how the user works on this step/);
    await ex.run("read_skill", { name: "magnetic-analysis" });

    // Three satellites fit several k: the search says so, and names the simplest.
    const search = parse((await ex.run("search_propagation_vector", {})).text);
    expect((search.candidates as { k: string }[]).map((c) => c.k)).toContain("(0 0 ½)");
    expect(search.simplest).toBe("(0 0 ½)");
    expect(String(search.reading)).toMatch(/k explain every included peak .*the search alone cannot decide\. The simplest is k = \(0 0 ½\)/);
    expect(calls).toContain("step 1");

    const set = parse((await ex.run("set_propagation_vector", { k: [0, 0, "1/2"] })).text);
    expect(set.k).toBe("(0, 0, 0.5)");
    expect(String(set.kKind)).toMatch(/commensurate/);
    expect((set.groups as { id: string }[]).map((g) => g.id)).toContain(MAGNETIC_TRUTH.id);
    // The same k again is no change.
    expect(parse((await ex.run("set_propagation_vector", { k: [0, 0, 0.5] })).text)).toMatchObject({ unchanged: true });

    const ranked = parse((await ex.run("rank_magnetic_groups", {})).text);
    expect(ranked.best).toBe(MAGNETIC_TRUTH.id);
    const groups = ranked.groups as { id: string; group: string; index: number; fit: { wR: number } }[];
    expect(groups[0]).toMatchObject({ id: MAGNETIC_TRUTH.id, group: truthGroup, index: 2 });
    expect(groups[0]!.fit.wR).toBeLessThan(groups[1]!.fit.wR);

    const chosen = parse((await ex.run("choose_magnetic_group", { id: MAGNETIC_TRUTH.id })).text);
    expect((chosen.chosen as { group: string }).group).toBe(truthGroup);
    const fitted = parse((await ex.run("refine_moments", {})).text);
    expect(String(fitted.note)).toMatch(/^Moments fitted: wR \d+(\.\d+)?%\.$/);
    const moment = Number(/([\d.]+) µB/.exec((fitted.chosen as { moments: string[] }).moments[0]!)![1]);
    expect(moment).toBeGreaterThan(0.9 * MAGNETIC_TRUTH.moment);

    const handed = parse((await ex.run("continue_magnetic_refinement", {})).text);
    expect(String(handed.note)).toMatch(/moment rows are on the refinement page, free/);
    expect(calls).toContain("step 0");
    expect(now().magnetic?.propagation[0]).toEqual([0, 0, 0.5]);
    const free = now().powderParams.filter((p) => !p.fixed && !p.expression).map((p) => p.id);
    expect(free).toEqual(expect.arrayContaining(["mom_Mn1_0"]));

    // Nuclear and magnetic together: hold the scale against the moment first.
    await ex.run("set_free", { fix: ["scale"] });
    const together = parse((await ex.run("refine", {})).text);
    expect(together.refined).toBe(true);
    expect(together.wR as number).toBeLessThan(5);
  }, 120_000);

  it("names the candidates when asked for one that is not there, and reads k as fractions", async () => {
    const { ex } = page();
    await ex.run("read_skill", { name: "magnetic-analysis" });
    await ex.run("set_propagation_vector", { k: ["0", "0", "½"] });
    expect((await ex.run("choose_magnetic_group", { id: "G999" })).text).toMatch(/no magnetic group "G999" for this k — the candidates are G1–G\d+/);
    expect((await ex.run("refine_moments", {})).text).toMatch(/choose a magnetic group first/);
    expect((await ex.run("select_magnetic_ions", { sites: ["Ga1"] })).text).toMatch(/not a magnetic ion site: Ga1/);
    expect(kComponent("1/3")).toBeCloseTo(1 / 3, 12);
    expect(kComponent(" -1 / 4 ")).toBe(-0.25);
    expect(() => kComponent("half")).toThrow(/not a k component/);
    expect(simplicity([0, 0, 0.5])).toBeLessThan(simplicity([0, 1 / 3, 1 / 3]));
    expect(simplicity([0.5, 0, 0])).toBeLessThan(simplicity([0.5, 0.5, 0]));
  }, 60_000);

  it("asks before each change of the step, with what it will do", async () => {
    const { ex, asked } = page();
    await ex.run("read_skill", { name: "magnetic-analysis" });
    await ex.run("set_propagation_vector", { k: [0, 0, 0.5] });
    await ex.run("choose_magnetic_group", { id: "G2" });
    expect(asked.map((a) => a.preview)).toEqual([
      "Propagation vector (0, 0, 0) → (0, 0, 0.5)",
      expect.stringMatching(/^Magnetic group G2 \(.+, index 2\)$/),
    ]);
  }, 60_000);
});
