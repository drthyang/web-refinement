import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEV_CASES, HELD_OUT_TERMS, MESSAGE, TEST_CASES, TOLERANCES, VALIDATION_CASES, caseById, casePage } from "@/agent/validation/cases";
import { assertsFault, recovered, reproducibility, scoreRun, unsafeOutcomes, type CaseScore } from "@/agent/validation/scoring";
import { SpendLedger, armARecord, costOf, modelByKey } from "@/agent/validation/run";
import { decisionsOf, policyLine, traceNumbers, transcriptMarkdown } from "@/agent/validation/record";
import { runPolicy } from "@/agent/chat";
import { findingProblems, type Finding } from "@/agent/validation/findings";
import { agentSystemPrompt } from "@/agent/systemPrompt";
import { AgentExecutor } from "@/agent/executor";
import { fakeHost, sessionPort } from "@/testSupport/agentHeadless";
import { runScenario, type EvalEvent } from "@/agent/evals/harness";
import { scenario } from "@/agent/evals/scenarios";
import { scriptedModel, type ScriptTurn } from "@/agent/evals/scripted";
import { RIETVELD } from "@/agent/evals/replays";
import { allSkills } from "@/agent/skills";
import { stagesFor } from "@/agent/method";
import { openedSession, simulatePowder, structureOf, cif } from "@/agent/validation/simulate";

/**
 * The validation framework (docs/VALIDATION.md, "Does the Agent help?"): its
 * tolerances fixed, its splits kept apart, its scoring checked on known
 * outcomes, arm A's results pinned (the table in the doc), and the wiring of
 * arms B and C (the skills off) checked without a model.
 */

const ROOT = resolve(__dirname, "../../..");

describe("the validation's rules", () => {
  it("scores with the tolerances fixed before any run (a change is an edit here and in the doc)", () => {
    expect(TOLERANCES).toEqual({ cellRelative: 2e-4, positionAngstrom: 0.01, bIso: 0.25, weightPercent: 1.0, gofAcceptable: 1.5, lineD: 0.005 });
  });

  it("keeps a held-out test set of at least eight cases apart from the dev set, each with an objective answer", () => {
    const ids = VALIDATION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TEST_CASES.length).toBeGreaterThanOrEqual(8);
    for (const c of TEST_CASES) {
      expect(c.split).toBe("test");
      // The same words for every test case: the message names no fault.
      expect(c.message, c.id).toBeUndefined();
      // An answer to score: values to recover, or a fault to name.
      expect(c.truth.length > 0 || c.fault !== null, c.id).toBe(true);
    }
    for (const c of DEV_CASES) expect(c.split).toBe("dev");
    expect(MESSAGE).not.toMatch(/wavelength|unit|axis|centr|impurit|phase|peak|line|zero|cell/i);
  });

  it("never tunes on the test set: its structures and ids appear nowhere the Agent is taught or evaluated", () => {
    // The skills and the knowledge they cite; everything under src/agent (tools, prompt, eval scenarios and their
    // tests); and every source file that ships, since any of them can reach the model as a tool's text (the MCP
    // tools, the diagnostics, the known-phase library, the app). A unit test elsewhere is seen by no model.
    const files: string[] = [];
    const walk = (dir: string, tests: boolean): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (p !== join(ROOT, "src/agent/validation")) walk(p, tests || p === join(ROOT, "src/agent"));
        } else if (/\.(md|ts|tsx)$/.test(name) && (tests || !/\.test\.tsx?$/.test(name))) files.push(p);
      }
    };
    for (const dir of [".claude/skills", "knowledge"]) walk(join(ROOT, dir), true);
    walk(join(ROOT, "src"), false);
    expect(files.some((f) => f.includes("src/mcp/registry.ts")) && files.some((f) => f.includes("src/core/diagnostics/knownPhases.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("src/agent/evals/evals.test.ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(300);
    const terms = [...HELD_OUT_TERMS, ...TEST_CASES.map((c) => new RegExp(`\\b${c.id}\\b`))];
    // A test case's impurity is in the known-phase library, as a lab's would be, but the text that teaches the Agent does not name it.
    const taught = files.filter((f) => f.includes("/.claude/skills/") || f.includes("/knowledge/") || /src\/agent\/tools\.ts$|src\/mcp\/registry\.ts$/.test(f));
    expect(taught.length).toBeGreaterThan(6);
    expect(taught.filter((f) => /\bNaCl\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1))).toEqual([]);
    const hits = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return terms.filter((t) => t.test(text)).map((t) => `${f.slice(ROOT.length + 1)}: ${t}`);
    });
    expect(hits).toEqual([]);
  });
});

describe("the scoring", () => {
  it("reads a fault from a sentence that says it, not from one that denies it or plans to look", () => {
    expect(assertsFault("The peaks put every d 1 % long: the wavelength given (1.5554 Å) looks wrong, please confirm it.", "wavelength")).not.toBeNull();
    expect(assertsFault("The wavelength is consistent with the peak positions.", "wavelength")).toBeNull();
    expect(assertsFault("I'll check the wavelength first.", "wavelength")).toBeNull();
    expect(assertsFault("The x axis appears to hold d-spacings, not 2θ.", "units")).not.toBeNull();
    expect(assertsFault("Lines at h+k+l odd are present, which the I-centred model forbids: the structure is primitive (ordered).", "centring")).not.toBeNull();
    expect(assertsFault("There is no sign of an impurity.", "impurity")).toBeNull();
    expect(assertsFault("An impurity phase is likely: three lines index on no reflection.", "impurity")).not.toBeNull();
  });

  it("scores recovery against the truth with the stated tolerances", () => {
    const truth = structureOf(cif("T", [4, 4, 4, 90, 90, 90], "P m -3 m", ["A1 Ni 0 0 0 1 0.5", "B1 Al 0.5 0.5 0.5 1 0.5"]), "t");
    const s = sessionPort(openedSession(truth, simulatePowder({ phases: [truth], seed: 1 }))).port.state();
    expect(recovered({ kind: "cell", phase: 0, axis: "a", value: 4 }, s).pass).toBe(true);
    expect(recovered({ kind: "cell", phase: 0, axis: "a", value: 4.002 }, s).pass).toBe(false); // 5e-4 relative
    expect(recovered({ kind: "position", phase: 0, site: "B1", value: [0.5, 0.5, 0.5015] }, s).pass).toBe(true); // 0.006 Å
    expect(recovered({ kind: "position", phase: 0, site: "B1", value: [0.5, 0.5, 0.505] }, s).pass).toBe(false); // 0.02 Å
    expect(recovered({ kind: "position", phase: 0, site: "A1", value: [0.999, 0, 0] }, s).pass).toBe(true); // the nearest lattice image
    expect(recovered({ kind: "bIso", phase: 0, site: "A1", value: 0.8 }, s).pass).toBe(false);
    expect(recovered({ kind: "weightPercent", phase: /NaCl/, value: 4 }, s).found).toBeNull(); // the phase is not in the model
  });

  it("counts unsafe outcomes the same way for every arm", () => {
    const c = caseById("rutile-start-off")!;
    const port = casePage(c);
    const base = { state: port.state(), text: "", reports: [] };
    expect(unsafeOutcomes(c, base)).toEqual([]);
    expect(unsafeOutcomes(c, { ...base, reports: [{ unverified: ["16.4"] }] })).toEqual(["a report quotes 1 number the engine did not give (16.4)"]);
    port.setFitRange({ min: 10, max: 60 });
    expect(unsafeOutcomes(c, { ...base, state: port.state() })[0]).toMatch(/keeps 42 % of the pattern/);
  });

  it("calls a run reproducible only when every run reaches the same conclusion with values that agree", () => {
    const score = (pass: boolean, found: number): CaseScore => ({
      recovery: { scored: true, pass, values: [{ what: "a (Å)", truth: 4, found, error: Math.abs(found / 4 - 1), tolerance: TOLERANCES.cellRelative, pass, relative: true }] },
      fault: { kind: null, detected: null, evidence: null }, falseAlarms: [], fit: { wR: 0.05, gof: 1, pass: true }, unsafe: [],
      conclusion: { pass, why: "" },
    });
    expect(reproducibility([score(true, 4), score(true, 4.0001), score(true, 4.0002)]).pass).toBe(true);
    expect(reproducibility([score(true, 4), score(true, 4.0012), score(true, 4)]).pass).toBe(false); // 3e-4 apart
    expect(reproducibility([score(true, 4), score(false, 4.01), score(true, 4)]).sameConclusion).toBe(false);
  });
});

describe("arm A: the app without the Agent (the bar; docs/VALIDATION.md's table)", () => {
  // case: [conclusion right, fault named (null: none injected), values recovered "k/n" or "n/a", unsafe outcomes]
  const EXPECTED: Record<string, [boolean, boolean | null, string, number]> = {
    "rutile-start-off": [true, null, "6/6", 1],
    "calcite-start-off": [true, null, "8/8", 1],
    "zno-wrong-wavelength": [false, false, "n/a", 1],
    "rutile-swapped-units": [false, false, "n/a", 1],
    "nial-wrong-centring": [false, false, "n/a", 1],
    "zno-nacl-impurity": [false, false, "4/5", 1],
    "calcite-unknown-line": [true, true, "8/8", 1],
    "rutile-cell-strained": [false, null, "6/6", 1],
    "dev-mn3ga-misfit": [true, null, "6/6", 1],
    "dev-mn3ga-fluorite": [false, false, "n/a", 1],
    "dev-mn3ga-wrong-wavelength": [false, false, "n/a", 1],
    "dev-mn3ga-swapped-units": [false, false, "n/a", 1],
    "dev-example3-magnetic": [false, false, "n/a", 1],
    "dev-mn3ga-impurity-line": [true, true, "n/a", 2],
    "dev-cscl-wrong-centring": [false, false, "n/a", 1],
    "dev-mn3ga-cell-strained": [false, null, "0/2", 1],
  };

  for (const c of VALIDATION_CASES.filter((x) => x.available?.() ?? true)) {
    it(c.id, async () => {
      const rec = await armARecord(c, 1, "test");
      const s = rec.score;
      const got: [boolean, boolean | null, string, number] = [
        s.conclusion.pass, s.fault.detected, s.recovery.scored ? `${s.recovery.values.filter((v) => v.pass).length}/${s.recovery.values.length}` : "n/a", s.unsafe.length,
      ];
      expect(got, `${c.id}: ${s.conclusion.why}`).toEqual(EXPECTED[c.id]);
      // The transcript a reviewer reads holds the case, the steps and the score.
      const md = transcriptMarkdown(rec, c);
      for (const h of ["## What the user asked", "## Steps", "## Conclusion (as the app shows it)", "## Score"]) expect(md).toContain(h);
    }, 60000);
  }

  it("the dev analog of the strained cell is solvable the same way", async () => {
    const c = caseById("dev-mn3ga-cell-strained")!;
    const port = casePage(c);
    await port.thorough();
    port.setFixed(port.state().parameters.filter((p) => p.fixed && !p.expression).map((p) => ({ id: p.id, fixed: false })));
    await port.refine();
    expect(scoreRun(c, { state: port.state(), text: "", reports: [] }).recovery.pass).toBe(true);
  });

  it("is deterministic: the same page gives the same score", async () => {
    const c = caseById("rutile-cell-strained")!;
    const [a, b] = [await armARecord(c), await armARecord(c)];
    expect(a.score).toEqual(b.score);
  });

  it("each case it fails is one the app's own tools can solve: the strained cell needs only the Prefit (Le Bail cell, then restarts)", async () => {
    // The Prefit on the page as it opens (scale, background and cell free), then everything refined.
    const port = casePage(caseById("rutile-cell-strained")!);
    await port.thorough();
    port.setFixed(port.state().parameters.filter((p) => p.fixed && !p.expression).map((p) => ({ id: p.id, fixed: false })));
    await port.refine();
    expect(port.state().result!.agreement.goodnessOfFit!).toBeLessThan(TOLERANCES.gofAcceptable);
    const score = scoreRun(caseById("rutile-cell-strained")!, { state: port.state(), text: "", reports: [] });
    expect(score.recovery.pass).toBe(true);
  });
});

describe("arms B and C, wired without a model", () => {
  it("arm C's prompt has no skills: no index, no read_skill, no page method", () => {
    const off = agentSystemPrompt({ skills: false });
    expect(off).not.toMatch(/read_skill|<skills>|my-rietveld-workflow|magnetic-analysis|pdf-workflow|sc-workflow|skill/i);
    // The guardrails stay.
    expect(off).toMatch(/no occupancy refines bare/);
    expect(off).toMatch(/The space group is questioned last/);
    expect(agentSystemPrompt()).toMatch(/<skills>/);
  });

  it("arm C's executor refuses read_skill and does not hold changes for a method read", async () => {
    const { port } = sessionPort(openedSession(structureOf(cif("T", [4, 4, 4, 90, 90, 90], "P m -3 m", ["A1 Ni 0 0 0 1 0.5"]), "t"), simulatePowder({ phases: [structureOf(cif("T", [4, 4, 4, 90, 90, 90], "P m -3 m", ["A1 Ni 0 0 0 1 0.5"]), "t")], seed: 2 })));
    const opts = { approve: async () => true, onActivity: () => undefined };
    const off = new AgentExecutor(fakeHost(port).host, { ...opts, skills: false });
    expect((await off.run("read_skill", { name: "my-rietveld-workflow" })).text).toMatch(/no skills in this configuration/);
    expect((await off.run("set_free", { free: ["scale"] })).text).not.toMatch(/read the method first/);
    const on = new AgentExecutor(fakeHost(port).host, opts);
    expect((await on.run("set_free", { free: ["scale"] })).text).toMatch(/read the method first/);
  });

  it("arm C sees no method anywhere the model reads: the prompt, the tools, and every answer and note", async () => {
    // A session that touches every place the method shows: get_state, a refinement out of the
    // method's order (the ADPs first), the symmetry review's gate, and the report.
    const script = (skills: boolean): ScriptTurn[] => [
      { calls: [...(skills ? [RIETVELD] : []), { name: "get_state" }] },
      { calls: [{ name: "set_free", input: { free: ["B_Mn1", "B_Ga1"] } }, { name: "refine" }] },
      { calls: [{ name: "review_symmetry" }] },
      { calls: [{ name: "write_report", input: { summary: "The ADPs refined." } }] },
      { text: "The ADPs refined." },
    ];
    const seen = async (skills: boolean, toolScope: "all" | "stage"): Promise<{ text: string; offered: readonly (readonly string[])[] }> => {
      const stand = await scriptedModel(script(skills));
      try {
        await runScenario(scenario("full-refinement"), { ...stand.model, toolScope, ...(skills ? {} : { skills: false }) });
        // What the model reads of each request: the instructions, the tools and the conversation (not the API's own settings).
        const read = (stand.requests() as { system?: unknown; tools?: unknown; messages?: unknown }[]).map((r) => ({ system: r.system, tools: r.tools, messages: r.messages }));
        return { text: JSON.stringify(read), offered: stand.offered() };
      } finally {
        await stand.close();
      }
    };
    const labels = [...new Set((["powder", "pdf", "singleCrystal"] as const).flatMap((page) => stagesFor(page).map((st) => st.label)))];
    const checklist = new RegExp(`[✓○] (${labels.map((l) => l.replace(/[()]/g, "\\$&")).join("|")})`);
    const method = [...allSkills().map((k) => new RegExp(k.name)), /read_skill/, /"method":/, /methodNote/, checklist, /the method's|stages? of the method|method's (order|stages)/i];
    const leaks = (text: string): string[] => method.filter((m) => m.test(text)).map(String);
    for (const scope of ["all", "stage"] as const) {
      const off = await seen(false, scope);
      expect(leaks(off.text), scope).toEqual([]);
      // No stage to scope by: a local model is offered every tool of the page (bar read_skill), on every request.
      if (scope === "stage") for (const o of off.offered) expect(o.length).toBe(off.offered[0]!.length);
    }
    // The same probe finds the method where it is.
    expect(leaks((await seen(true, "all")).text).length).toBeGreaterThan(3);
  }, 60_000);

  it("says in each transcript the policy the run ran under", () => {
    const local = runPolicy({ transport: "lmstudio", model: "m", effort: "high", policy: { temperature: 0.6 } }, 32768);
    expect(policyLine(local)).toBe("turn cap 80 · tools by the page and the method's stage · old results digested to fit the window · stops after reads that change nothing · temperature 0.6 · replies up to 64000 tokens");
    expect(policyLine(runPolicy({ transport: "api-key", model: "m", effort: "high" }, null))).toMatch(/^turn cap 40 · every tool · old results cleared by the API · no stop .* · adaptive thinking/);
  });

  it("prices the API runs and stops before the cap", () => {
    const sonnet = modelByKey("sonnet")!;
    expect(sonnet.splits).toEqual(["test"]);
    expect(costOf(sonnet, { input: 1e6, output: 1e5, cacheRead: 1e7, cacheWrite: 2e5 })).toBeCloseTo(2 + 1 + 1 + 0.5, 6);
    expect(costOf(modelByKey("qwen")!, { input: 1e9, output: 1e9, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    const ledger = new SpendLedger(join(mkdtempSync(join(tmpdir(), "spend-")), "spend.json"), 1);
    expect(ledger.allows(0.4)).toBe(true);
    ledger.add("a", 0.5);
    expect(ledger.allows()).toBe(true); // 0.5 spent, 0.5 expected
    ledger.add("b", 0.4);
    expect(ledger.allows()).toBe(false); // 0.9 spent, 0.45 expected
  });

  it("records each decision with the words before it, and traces each number to the engine output it came from", () => {
    const events: EvalEvent[] = [
      { kind: "user", text: MESSAGE },
      { kind: "reply", text: "First the cell check." },
      { kind: "call", name: "check_cell_symmetry", input: {}, isError: false, text: JSON.stringify({ leBail: { rwp: 0.08312, a: 4.59371 } }) },
      { kind: "reply", text: "The Le Bail fit reaches Rwp 8.31 % with a = 4.5937 Å; the moment is 2.75 µB." },
      { kind: "reply", text: "The fit ends at wR {{wR}}.", shown: "The fit ends at wR 4.61 %.", refs: { wR: "4.61 %" } },
    ];
    const d = decisionsOf({ events });
    expect(d).toEqual([expect.objectContaining({ step: 1, tool: "check_cell_symmetry", why: "First the cell check." })]);
    const n = traceNumbers({ events });
    const where = (x: (typeof n)[number]): unknown => (x.source === null ? null : "reference" in x.source ? `ref ${x.source.value}` : x.source.step);
    // A number of the model's own is traced to the tool output it came from; a reference is the engine's by construction.
    expect(n.map((x) => [x.text, where(x)])).toEqual([["8.31", 1], ["4.5937", 1], ["2.75", null], ["{{wR}}", "ref 4.61 %"]]);
  });
});

describe("findings, as a reviewer files them", () => {
  const ok: Finding = {
    case: "dev-mn3ga-misfit", run: 1, step: 4, kind: "bug",
    evidence: { refs: ["dev-mn3ga-misfit/B/qwen/run1#step4"], numbers: ["wR 14.26 % at step 4"] },
    proposed_fix: "pass the fit window to the probe", needs_user_approval: false,
  };

  it("takes a well-formed finding", () => {
    expect(findingProblems(ok)).toEqual([]);
  });

  it("holds a new tool or a skill change for the user's approval", () => {
    expect(findingProblems({ ...ok, kind: "skill-gap" })).toEqual([expect.stringMatching(/needs the user's approval/)]);
    expect(findingProblems({ ...ok, kind: "missing-tool", needs_user_approval: true })).toEqual([]);
  });

  it("lets a test-set finding propose a fix only once reproduced on a dev case", () => {
    const onTest: Finding = { ...ok, case: "zno-wrong-wavelength", evidence: { ...ok.evidence, refs: ["zno-wrong-wavelength/B/qwen/run1#step4"] } };
    expect(findingProblems(onTest)).toEqual([expect.stringMatching(/reproduced on a dev case/)]);
    expect(findingProblems({ ...onTest, reproduced_on: "dev-mn3ga-wrong-wavelength" })).toEqual([]);
    expect(findingProblems({ ...onTest, reproduced_on: "rutile-start-off" })).toEqual([expect.stringMatching(/reproduced on a dev case/)]);
    expect(findingProblems({ ...onTest, proposed_fix: "" })).toEqual([]);
  });

  it("needs evidence that points into a transcript", () => {
    expect(findingProblems({ ...ok, evidence: { refs: ["somewhere"], numbers: [] } })).toEqual([expect.stringMatching(/not a transcript reference/)]);
  });
});
