import { describe, it, afterAll, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VALIDATION_CASES, type ValidationCase } from "@/agent/validation/cases";
import { reproducibility } from "@/agent/validation/scoring";
import { SUMMARY_HEAD, SpendLedger, agentArmRecord, armARecord, commitNow, costOf, modelByKey, saveRecord, summaryRow } from "@/agent/validation/run";
import type { Arm, ValidationRecord } from "@/agent/validation/record";

/**
 * The validation's arms on real runs (docs/VALIDATION.md, "Does the Agent
 * help?"). Off unless asked for: arms B and C spend a model's time or the API
 * budget.
 *
 *   MATERIA_VALIDATION=1 MATERIA_VALIDATION_MODEL=qwen npx vitest run src/agent/validation/live.test.ts
 *
 * MATERIA_VALIDATION_MODEL is a key of MODELS (run.ts: qwen, gemma, glimmer,
 * sonnet); _ARMS (default "B,C"; "A" needs no model), _SPLIT ("test", "dev" or
 * "all"; default the model's own: the API model runs the test set only),
 * _REPEAT (runs per case, default 3), _ONLY (case ids), _OUT (directory for
 * the records, the transcripts and summary.md; default
 * /tmp/materia-validation/<model>), _SERVER (the local server's address) and,
 * for the API, ANTHROPIC_API_KEY, _CAP_USD (default 15: MATERIA's share of the
 * cycle's $40), _RUN_CAP_USD (one run's ceiling, default 2) and _LEDGER (the
 * spend file shared across invocations, default /tmp/materia-validation/spend.json).
 *
 * Runs go in rounds (run 1 of every case and arm, then run 2, …), so a cap
 * reached part way leaves every case with the same number of runs. Every run
 * is kept, passed or failed; nothing is retried.
 */

const env = process.env;
const live = env.MATERIA_VALIDATION === "1";
const arms = (env.MATERIA_VALIDATION_ARMS ?? "B,C").split(",").map((s) => s.trim()).filter(Boolean) as Arm[];
const modelKey = env.MATERIA_VALIDATION_MODEL ?? "";
const model = modelByKey(modelKey);
const needsModel = arms.some((a) => a !== "A");
const repeat = Math.max(1, Number(env.MATERIA_VALIDATION_REPEAT ?? 3) || 3);
const only = env.MATERIA_VALIDATION_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const splitEnv = env.MATERIA_VALIDATION_SPLIT;
const splits = splitEnv === "all" ? ["dev", "test"] : splitEnv ? [splitEnv] : (model?.splits ?? ["dev", "test"]);
const out = env.MATERIA_VALIDATION_OUT ?? `/tmp/materia-validation/${model?.key ?? "arm-a"}`;
const api = model?.transport === "api-key";
const ledger = api ? new SpendLedger(env.MATERIA_VALIDATION_LEDGER ?? "/tmp/materia-validation/spend.json", Number(env.MATERIA_VALIDATION_CAP_USD ?? 15)) : null;
const runCap = Number(env.MATERIA_VALIDATION_RUN_CAP_USD ?? 2);
const cases: ValidationCase[] = VALIDATION_CASES.filter((c) => splits.includes(c.split) && (!only || only.includes(c.id)) && (c.available?.() ?? true));
const commit = commitNow();

describe.skipIf(!live)(`Validation arms ${arms.join(", ")} (${model?.label ?? "no model"})`, () => {
  const records: ValidationRecord[] = [];
  const skipped: string[] = [];

  it("is configured", () => {
    if (needsModel) expect(model, `MATERIA_VALIDATION_MODEL must be one of the MODELS keys, not "${modelKey}"`).toBeDefined();
    if (api) expect(env.ANTHROPIC_API_KEY, "the API arm needs ANTHROPIC_API_KEY").toBeTruthy();
  });

  for (let run = 1; run <= repeat; run++) {
    for (const arm of arms) {
      for (const c of cases) {
        it(`${c.id} · arm ${arm} · run ${run}`, async () => {
          if (arm === "A") {
            const rec = await armARecord(c, run, commit);
            saveRecord(out, rec, c);
            records.push(rec);
            return;
          }
          if (ledger && !ledger.allows()) {
            skipped.push(`${c.id} arm ${arm} run ${run}: the spend cap ($${ledger.cap}) would be passed (spent $${ledger.spent.toFixed(2)})`);
            return;
          }
          const ctrl = new AbortController();
          const rec = await agentArmRecord({
            c, arm, model: model!, run, commit, signal: ctrl.signal,
            ...(env.MATERIA_VALIDATION_SERVER ? { server: env.MATERIA_VALIDATION_SERVER } : {}),
            ...(api && env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
            ...(env.MATERIA_VALIDATION_TEMPERATURE ? { temperature: Number(env.MATERIA_VALIDATION_TEMPERATURE) } : {}),
            onUsage: (u) => {
              if (!ledger) return;
              const cost = costOf(model!, u);
              if (cost > runCap || ledger.spent + cost > ledger.cap) ctrl.abort();
            },
          });
          ledger?.add(`${c.id}/${arm}/${model!.key}/run${run}`, rec.costUsd ?? 0);
          saveRecord(out, rec, c);
          records.push(rec);
        }, (model?.timeoutMin ?? 10) * 60_000);
      }
    }
  }

  afterAll(() => {
    if (!records.length && !skipped.length) return;
    const lines = [`# Validation runs: ${model?.label ?? "arm A"} at ${commit}`, "", SUMMARY_HEAD, ...records.map(summaryRow), ""];
    lines.push("## Reproducibility", "", "| case | arm | runs | right | same conclusion | spreads within tolerance |", "| --- | --- | --- | --- | --- | --- |");
    for (const c of cases) {
      for (const arm of arms) {
        const scores = records.filter((r) => r.case === c.id && r.arm === arm).map((r) => r.score);
        if (!scores.length) continue;
        const rep = reproducibility(scores);
        lines.push(`| ${c.id} | ${arm} | ${rep.runs} | ${rep.passes} | ${rep.sameConclusion ? "yes" : "no"} | ${rep.spread.length ? (rep.spread.every((x) => x.pass) ? "yes" : rep.spread.filter((x) => !x.pass).map((x) => x.what).join(", ")) : "n/a"} |`);
      }
    }
    if (ledger) lines.push("", `Spent: $${ledger.spent.toFixed(2)} of $${ledger.cap}.`);
    if (skipped.length) lines.push("", "## Not run", "", ...skipped.map((s) => `- ${s}`));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
    console.log(lines.join("\n"));
  });
});
