import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SCENARIOS } from "@/agent/evals/scenarios";
import { runScenario, transcript, type EvalModel, type EvalResult } from "@/agent/evals/harness";
import type { ChatEffort, ChatTransport } from "@/agent/chat";

/**
 * The eval suite against a real model: every scenario run through the chat
 * loop, the executor and the tools, and graded. Off unless asked for, since
 * it spends tokens and takes minutes:
 *
 *   MATERIA_AGENT_EVAL=1 ANTHROPIC_API_KEY=… npm run eval:agent
 *
 * MATERIA_AGENT_EVAL_MODEL (default claude-opus-5-5), _EFFORT (default high),
 * _TRANSPORT (api-key, ollama or lmstudio; a local server at _SERVER),
 * _ONLY (scenario ids, comma-separated), _REPEAT (runs per scenario, default
 * 1) and _OUT (a JSON report) adjust it. Each scenario's checks are soft
 * assertions: the run reports every failure, with the transcript.
 */

const env = process.env;
const live = env.MATERIA_AGENT_EVAL === "1";
const transport = (env.MATERIA_AGENT_EVAL_TRANSPORT ?? "api-key") as ChatTransport;
const model: EvalModel = {
  transport,
  model: env.MATERIA_AGENT_EVAL_MODEL ?? "claude-opus-5-5",
  effort: (env.MATERIA_AGENT_EVAL_EFFORT ?? "high") as ChatEffort,
  ...(transport === "api-key" && env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
  ...(env.MATERIA_AGENT_EVAL_SERVER ? { serverUrl: env.MATERIA_AGENT_EVAL_SERVER } : {}),
};
const only = env.MATERIA_AGENT_EVAL_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(env.MATERIA_AGENT_EVAL_REPEAT ?? 1) || 1);
const chosen = SCENARIOS.filter((s) => !only || only.includes(s.id));

describe.skipIf(!live)(`Agent evals, live (${model.model})`, () => {
  const results: EvalResult[] = [];

  afterAll(() => {
    const rows = chosen.map((s) => {
      const runs = results.filter((r) => r.scenario === s.id);
      return { id: s.id, passed: runs.filter((r) => r.passed).length, runs: runs.length };
    });
    const total = rows.reduce((n, r) => n + r.passed, 0);
    console.log(`\nAgent evals (${model.model}, ${transport}): ${total}/${results.length} runs passed\n${rows.map((r) => `  ${r.passed === r.runs ? "✓" : "✗"} ${r.id}: ${r.passed}/${r.runs}`).join("\n")}`);
    if (env.MATERIA_AGENT_EVAL_OUT) {
      mkdirSync(dirname(env.MATERIA_AGENT_EVAL_OUT), { recursive: true });
      writeFileSync(env.MATERIA_AGENT_EVAL_OUT, JSON.stringify({
        model: model.model,
        transport,
        effort: model.effort,
        at: new Date().toISOString(),
        summary: rows,
        runs: results.map((r) => ({ scenario: r.scenario, passed: r.passed, grades: r.grades, transcript: transcript(r.run, 2000) })),
      }, null, 2));
    }
  });

  for (const s of chosen) {
    for (let i = 0; i < repeat; i++) {
      it(`${s.id}${repeat > 1 ? ` #${i + 1}` : ""}: ${s.title}`, async () => {
        const result = await runScenario(s, model);
        results.push(result);
        const text = transcript(result.run);
        for (const g of result.grades) expect.soft(g.pass, `${g.check}: ${g.detail}\n---\n${text}`).toBe(true);
      }, 20 * 60_000);
    }
  }
});
