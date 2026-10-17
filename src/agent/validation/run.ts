/**
 * Running the validation's arms (docs/VALIDATION.md, "Does the Agent help?"):
 * arm A (the app without the Agent: no model), and arms B (the Agent with its
 * skills and guardrails) and C (the Agent without skills, the guardrails
 * kept) on a model from MODELS. Every run is kept whole: its record (JSON)
 * and its transcript (Markdown), scored by scoring.ts.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatEffort, ChatTransport } from "@/agent/chat";
import { runScenario, type EvalModel, type EvalScenario, type EvalUsage } from "@/agent/evals/harness";
import { MESSAGE, casePage, type ValidationCase } from "@/agent/validation/cases";
import { runArmA } from "@/agent/validation/armA";
import { scoreRun } from "@/agent/validation/scoring";
import { agentConclusionText, agentRecord, transcriptMarkdown, type Arm, type ValidationRecord } from "@/agent/validation/record";

/** The models the validation compares, the same cases and scoring for each (the user's choice, 2026-10-14). */
export interface ValidationModel {
  readonly key: string;
  readonly label: string;
  readonly transport: ChatTransport;
  readonly model: string;
  readonly effort: ChatEffort;
  /** The context to size requests to (a server that says its own overrides it). */
  readonly context?: number;
  /** Minutes one run may take. */
  readonly timeoutMin: number;
  /** USD per million tokens, for the spend tracker (zero for a local model). */
  readonly price: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  /** Which split it runs by default (the API model: the test set only, to keep within the cap). */
  readonly splits: readonly ("dev" | "test")[];
}

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export const MODELS: readonly ValidationModel[] = [
  { key: "qwen", label: "qwen3.8-27b (LM Studio, 32k)", transport: "lmstudio", model: "qwen/qwen3.8-27b", effort: "high", context: 32768, timeoutMin: 45, price: FREE, splits: ["dev", "test"] },
  { key: "gemma", label: "gemma4:26b (Ollama, 32k)", transport: "ollama", model: "gemma4:26b", effort: "high", context: 32768, timeoutMin: 45, price: FREE, splits: ["dev", "test"] },
  { key: "glimmer", label: "meta/muse-glimmer (LM Studio, 28B, up to 128k)", transport: "lmstudio", model: "meta/muse-glimmer", effort: "high", timeoutMin: 45, price: FREE, splits: ["dev", "test"] },
  // API prices per million tokens as docs/AGENT_EVALS.md records them for Sonnet 5.5.
  { key: "sonnet", label: "Claude Sonnet 5.5 (API)", transport: "api-key", model: "claude-sonnet-5-5", effort: "high", timeoutMin: 30, price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, splits: ["test"] },
];

export const modelByKey = (key: string): ValidationModel | undefined => MODELS.find((m) => m.key === key);

/** A run's cost in USD at the model's prices. */
export function costOf(m: Pick<ValidationModel, "price">, u: EvalUsage): number {
  return (u.input * m.price.input + u.output * m.price.output + u.cacheRead * m.price.cacheRead + u.cacheWrite * m.price.cacheWrite) / 1e6;
}

/**
 * The spend ledger: what the API runs have cost, kept in a file so the cap
 * holds across invocations. Before a run, `allows` says whether its expected
 * cost still fits; during it, the runner aborts a run that passes the cap.
 */
export class SpendLedger {
  private data: { capUsd: number; spentUsd: number; runs: { key: string; costUsd: number; date: string }[] };

  constructor(private readonly path: string, capUsd: number) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { capUsd, spentUsd: 0, runs: [] };
    this.data.capUsd = capUsd;
  }

  get spent(): number {
    return this.data.spentUsd;
  }

  get cap(): number {
    return this.data.capUsd;
  }

  /** The expected cost of the next run: the mean so far, or `prior` before any. */
  expected(prior = 0.4): number {
    const r = this.data.runs;
    return r.length ? r.reduce((a, x) => a + x.costUsd, 0) / r.length : prior;
  }

  allows(prior?: number): boolean {
    return this.data.spentUsd + this.expected(prior) <= this.data.capUsd;
  }

  add(key: string, costUsd: number): void {
    this.data.spentUsd += costUsd;
    this.data.runs.push({ key, costUsd, date: new Date().toISOString() });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

export function commitNow(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Arm A on a case: the app without the Agent. */
export async function armARecord(c: ValidationCase, run = 1, commit = commitNow()): Promise<ValidationRecord> {
  const a = await runArmA(casePage(c));
  const score = scoreRun(c, { state: a.port.state(), text: a.conclusion, reports: [] });
  return {
    case: c.id, split: c.split, arm: "A", model: "none", run, commit, date: new Date().toISOString(), message: c.message ?? MESSAGE,
    decisions: a.decisions, numbers: [], conclusion: a.conclusion, reports: [], score, seconds: a.seconds, notices: [],
  };
}

/**
 * What the stand-in user approves in arms B and C: every change, and adding a
 * phase the Agent proposes (a user would let it test the idea; a phase the
 * sample does not hold is then scored as unsafe). Lifting a firm rule
 * (allow_exception) and an instrument's constants are declined: those are
 * the user's alone.
 */
export const APPROVED_ASKS = ["add_known_phase"] as const;

/** The eval scenario a case runs as in arms B and C. */
export function caseScenario(c: ValidationCase): EvalScenario {
  return {
    id: c.id,
    title: c.title,
    origin: c.source,
    page: () => casePage(c),
    ...(c.available ? { available: c.available } : {}),
    messages: [c.message ?? MESSAGE],
    autonomy: "auto",
    approve: "changes",
    approveAsked: [...APPROVED_ASKS],
    checks: [],
  };
}

/** Arm B or C on a case, on a model: run, score and record. `abort` stops a run (the spend cap). */
export async function agentArmRecord(args: {
  readonly c: ValidationCase; readonly arm: Exclude<Arm, "A">; readonly model: ValidationModel; readonly run: number;
  readonly server?: string; readonly apiKey?: string; readonly signal?: AbortSignal; readonly onUsage?: (u: EvalUsage) => void; readonly commit?: string;
  /** A temperature for a local model (default: the server's for the model, as the app runs it); the record keeps the one used. */
  readonly temperature?: number;
}): Promise<ValidationRecord> {
  const m = args.model;
  const config: EvalModel = {
    transport: m.transport,
    model: m.model,
    effort: m.effort,
    ...(m.context ? { context: m.context } : {}),
    ...(args.server ? { serverUrl: args.server } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.arm === "C" ? { skills: false } : {}),
    ...(args.temperature !== undefined ? { policy: { temperature: args.temperature } } : {}),
  };
  const result = await runScenario(caseScenario(args.c), config, args.signal, args.onUsage);
  const r = result.run;
  const score = scoreRun(args.c, { state: (r.port as ReturnType<typeof casePage>).state(), text: agentConclusionText(r), reports: r.reports });
  return agentRecord({ c: args.c, arm: args.arm, model: m.key, run: args.run, commit: args.commit ?? commitNow(), message: args.c.message ?? MESSAGE, result: r, score, costUsd: costOf(m, r.usage) });
}

/** Keep a run: its record as JSON and its transcript as Markdown, under `dir/<case>/<arm>-<model>-run<k>.{json,md}`. */
export function saveRecord(dir: string, rec: ValidationRecord, c: ValidationCase): string {
  const base = join(dir, rec.case, `${rec.arm}-${rec.model}-run${rec.run}`);
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.json`, JSON.stringify(rec, null, 2));
  writeFileSync(`${base}.md`, transcriptMarkdown(rec, c));
  return base;
}

/** One line per run, for a summary table. */
export function summaryRow(rec: ValidationRecord): string {
  const s = rec.score;
  const rec2 = s.recovery.scored ? `${s.recovery.values.filter((v) => v.pass).length}/${s.recovery.values.length}` : "n/a";
  const fault = s.fault.kind === null ? "n/a" : s.fault.detected ? "named" : "missed";
  return `| ${rec.case} | ${rec.split} | ${rec.arm} | ${rec.model} | ${rec.run} | ${rec2} | ${fault} | ${s.falseAlarms.length ? s.falseAlarms.map((a) => a.kind).join(", ") : "—"} | ${s.fit.gof === null ? "—" : s.fit.gof.toFixed(2)} | ${s.unsafe.length} | ${s.conclusion.pass ? "right" : "wrong"} |`;
}

export const SUMMARY_HEAD = "| case | split | arm | model | run | recovered | fault | false alarms | GoF | unsafe | conclusion |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
