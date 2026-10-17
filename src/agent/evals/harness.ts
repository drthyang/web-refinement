/**
 * The Agent eval suite: a scenario — a page, what the user says, what they
 * approve — run through the real chat loop (AgentChat), the real executor and
 * tools on a headless page, and the transcript graded by checks written from
 * the failures the researcher rounds and the users found.
 *
 * The model is whatever `config` points at: Claude in a live run
 * (live.test.ts, behind MATERIA_AGENT_EVAL), or a scripted stand-in
 * (scripted.ts) replaying a good and a bad transcript per scenario, so CI
 * checks that each check passes the behaviour it wants and catches the one it
 * was written against.
 */

import type { RefinementParameter } from "@/core/refinement/types";
import { matchIds } from "@/agent/liveCommon";
import { AgentChat, type ChatConfig, type RunPolicy } from "@/agent/chat";
import { AgentExecutor, type ActivityEntry, type ToolRunner } from "@/agent/executor";
import type { AgentPort } from "@/agent/port";
import type { AgentAutonomy } from "@/agent/systemPrompt";
import type { AgentRecord } from "@/agent/method";
import { liveTool } from "@/agent/tools";
import { REFERENCE } from "@/agent/references";
import { unverifiedNumbers } from "@/core/export/reportAudit";
import { fakeHost, headlessHistory } from "@/testSupport/agentHeadless";

/** One thing that happened in the conversation, in order. */
export type EvalEvent =
  | { readonly kind: "user"; readonly text: string }
  | {
    readonly kind: "reply";
    /** The model's words as it wrote them, references ({{wR}}, {{p:…}}) and all. */
    readonly text: string;
    /** The words as the app shows them: each reference filled from the page when the reply ended (absent when it had none). */
    readonly shown?: string;
    /** Each reference the reply used, with the value the page filled it with (null: the page had none). */
    readonly refs?: Readonly<Record<string, string | null>>;
  }
  | {
    readonly kind: "call";
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly isError: boolean;
    readonly text: string;
    /** The free parameters when the call was made (refine and boxcar_scan). */
    readonly free?: readonly string[];
  };

export type EvalCall = Extract<EvalEvent, { kind: "call" }>;

/** Tokens the model spent on a run, summed over its turns (zero for a scripted model). */
export interface EvalUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** A report the Agent wrote in a run: its text, and what the number audit read. */
export interface EvalReport {
  readonly title: string;
  /** The report as Markdown, its figures left out. */
  readonly markdown: string;
  readonly unverified: readonly string[];
  readonly audit: { readonly account: string; readonly against: string };
}

export interface EvalRun {
  readonly events: readonly EvalEvent[];
  readonly port: AgentPort;
  /** The Agent's records at the end, by analysis key. */
  readonly records: ReadonlyMap<string, AgentRecord>;
  /** Every approval the stand-in user was asked for. */
  readonly asked: readonly ActivityEntry[];
  /** The chat's notices (errors, stalls, loops). */
  readonly notices: readonly string[];
  readonly usage: EvalUsage;
  /** The reports written, in order. */
  readonly reports: readonly EvalReport[];
  /** Each model turn's prompt (every input token, cached or not) and reply, in tokens, in order. */
  readonly turns: readonly { readonly prompt: number; readonly output: number }[];
  /** Wall-clock time of the run, in seconds. */
  readonly seconds: number;
  /** The policy the run ran under (turn cap, tool scope, pruning, temperature…); null for a run saved before runs kept it. */
  readonly policy: RunPolicy | null;
}

export interface Verdict {
  readonly pass: boolean;
  readonly detail: string;
}

export interface Check {
  readonly name: string;
  readonly grade: (run: EvalRun) => Verdict;
}

export interface EvalScenario {
  readonly id: string;
  readonly title: string;
  /** What found the failure this scenario guards against. */
  readonly origin: string;
  readonly page: () => AgentPort;
  /** False when the page's data are not on this machine (a scenario on git-ignored data): it is skipped, not failed. */
  readonly available?: () => boolean;
  /** What the user says, one message per turn. */
  readonly messages: readonly string[];
  readonly autonomy: AgentAutonomy;
  /**
   * What the stand-in user approves: every change (default) or none. A change
   * only the user may make (an always-ask tool: lifting a firm rule, adding a
   * phase, an instrument constant) is declined unless the scenario's user
   * asked for it and names the tool here.
   */
  readonly approve?: "changes" | "nothing";
  /** Always-ask tools the stand-in user approves (their request asked for it). */
  readonly approveAsked?: readonly string[];
  readonly checks: readonly Check[];
}

export interface EvalResult {
  readonly scenario: string;
  readonly run: EvalRun;
  readonly grades: readonly (Verdict & { readonly check: string })[];
  readonly passed: boolean;
}

/** The model's side of a run: everything but the autonomy, which the scenario sets. */
export type EvalModel = Omit<ChatConfig, "autonomy">;

export const calls = (run: EvalRun): EvalCall[] => run.events.filter((e): e is EvalCall => e.kind === "call");
export const replies = (run: EvalRun): string[] => run.events.filter((e) => e.kind === "reply").map((e) => (e as { text: string }).text).filter((t) => t.trim() !== "");
export const isChange = (name: string): boolean => liveTool(name)?.effect === "change";

/**
 * The parameters a refine or boxcar_scan call fits: the page's free set, or
 * for a scan given `free`, the ones that list names (the scan frees them, the
 * page's set aside). Undefined for other tools.
 */
export function freeAtCall(name: string, input: unknown, parameters: readonly RefinementParameter[]): string[] | undefined {
  if (name !== "refine" && name !== "boxcar_scan") return undefined;
  const given = (input as { free?: unknown } | null)?.free;
  if (name === "boxcar_scan" && Array.isArray(given) && given.every((g) => typeof g === "string")) {
    try {
      return matchIds(parameters.filter((p) => !p.expression), given as string[]);
    } catch {
      return []; // a pattern that matches nothing: the call is refused
    }
  }
  return parameters.filter((p) => !p.fixed && !p.expression).map((p) => p.id);
}

/** Run one scenario and grade it. Never throws for the model's behaviour; a chat error becomes a notice. */
export async function runScenario(scenario: EvalScenario, model: EvalModel, signal: AbortSignal = new AbortController().signal, onUsage?: (usage: EvalUsage) => void): Promise<EvalResult> {
  const port = scenario.page();
  // The History as the app keeps it: the report lists the steps the analysis took.
  const history = headlessHistory(port);
  const { host, records } = fakeHost(port, history.history, (kind, agent) => history.record(kind, agent ? "agent" : undefined), history.goTo);
  const asked: ActivityEntry[] = [];
  const events: EvalEvent[] = [];
  const notices: string[] = [];
  const reports: EvalReport[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const turns: { prompt: number; output: number }[] = [];
  const started = Date.now();
  const executor = new AgentExecutor(host, {
    approve: async (entry) => {
      asked.push(entry);
      return (!entry.alwaysAsk || (scenario.approveAsked ?? []).includes(entry.tool)) && scenario.approve !== "nothing";
    },
    onActivity: () => undefined,
    onReport: (r) => reports.push({ title: r.title, markdown: withoutFigures(r.markdown), unverified: r.unverified, audit: r.audit }),
    // The ablation without skills (docs/VALIDATION.md, arm C) turns them off on both sides.
    ...(model.skills === false ? { skills: false } : {}),
  });
  const runner: ToolRunner = {
    run: async (name, input, signal) => {
      settle();
      const free = freeAtCall(name, input, port.state().parameters);
      const out = await executor.run(name, input, signal);
      // The page records a refinement's step when it ends, as the Agent's.
      if (name === "refine" && !out.isError && /"refined":true/.test(out.text)) history.record("refine", "agent", "Refine");
      events.push({ kind: "call", name, input: (input ?? {}) as Record<string, unknown>, isError: out.isError, text: out.text, ...(free ? { free } : {}) });
      return out;
    },
    newConversation: () => executor.newConversation(),
    heard: (text) => executor.heard(text),
    situation: () => executor.situation(),
    // As the app's runner (useAgent.ts): the final-answer check reads the engine's {{verdict}} through it.
    fill: (text) => executor.fill(text),
    page: () => executor.page(),
  };
  const chat = new AgentChat(runner);
  let reply: { kind: "reply"; text: string; shown?: string; refs?: Record<string, string | null> } | null = null;
  // A reply's references are filled where the app shows it, from the page as it stands when the reply ends
  // (before the call it asks for runs, or when the next reply or the turn ends).
  const settle = (): void => {
    const r = reply as { kind: "reply"; text: string; shown?: string; refs?: Record<string, string | null> } | null;
    if (!r || r.shown !== undefined || !r.text.includes("{{")) return;
    r.shown = executor.fill(r.text);
    r.refs = Object.fromEntries([...r.text.matchAll(REFERENCE)].map((m) => {
      const filled = executor.fill(`{{${m[1]!}}}`);
      return [m[1]!, filled.includes("{{") ? null : filled];
    }));
  };
  for (const text of scenario.messages) {
    events.push({ kind: "user", text });
    try {
      await chat.send(text, { ...model, autonomy: scenario.autonomy }, {
        onAssistantStart: () => {
          settle();
          reply = { kind: "reply", text: "" };
          events.push(reply);
        },
        onText: (delta) => {
          if (reply) reply.text += delta;
        },
        onThinking: () => undefined,
        onNotice: (notice) => notices.push(notice),
        onUsage: (u) => {
          usage.input += u.input_tokens ?? 0;
          usage.output += u.output_tokens ?? 0;
          usage.cacheRead += u.cache_read_input_tokens ?? 0;
          usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
          // Claude counts the cached part apart from the input; a local server's input is the whole prompt.
          const whole = model.transport === "ollama" || model.transport === "lmstudio" || model.transport === "openai-compatible";
          turns.push({ prompt: whole ? u.input_tokens ?? 0 : (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 });
          // The spend tracker watches the running total (docs/VALIDATION.md: the API cap).
          onUsage?.({ ...usage });
        },
      }, signal);
    } catch (e) {
      notices.push(`chat error: ${e instanceof Error ? e.message : String(e)}`);
    }
    settle();
  }
  const run: EvalRun = { events, port, records, asked, notices, usage, reports, turns, seconds: (Date.now() - started) / 1000, policy: chat.policyFor({ ...model, autonomy: scenario.autonomy }) };
  const grades = scenario.checks.map((c) => ({ check: c.name, ...c.grade(run) }));
  return { scenario: scenario.id, run, grades, passed: grades.every((g) => g.pass) };
}

/** A report's Markdown without its figures (data URIs of a few hundred kB each). */
export function withoutFigures(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, "![$1](figure left out)");
}

/**
 * A run as an `_OUT` report keeps it: every event in full (each tool's
 * answer), the records, what the stand-in user was asked, the notices, the
 * reports and the grades. regrade() scores it again with the checks as they
 * are now, at no cost.
 */
export interface SavedRun {
  readonly scenario: string;
  readonly technique: AgentPort["technique"];
  readonly passed: boolean;
  readonly usage: EvalUsage;
  readonly grades: EvalResult["grades"];
  readonly events: readonly EvalEvent[];
  readonly records: readonly AgentRecord[];
  readonly asked: readonly { readonly tool: string; readonly preview?: string; readonly alwaysAsk?: boolean }[];
  readonly notices: readonly string[];
  readonly reports: readonly EvalReport[];
  /** Each turn's prompt and reply in tokens, and the run's time (runs saved before they were kept have none). */
  readonly turns?: EvalRun["turns"];
  readonly seconds?: number;
  readonly policy?: RunPolicy;
}

export function savedRun(r: EvalResult): SavedRun {
  return {
    scenario: r.scenario,
    technique: r.run.port.technique,
    passed: r.passed,
    usage: r.run.usage,
    grades: r.grades,
    events: r.run.events,
    records: [...r.run.records.values()],
    asked: r.run.asked.map((e) => ({ tool: e.tool, ...(e.preview !== undefined ? { preview: e.preview } : {}), ...(e.alwaysAsk ? { alwaysAsk: true } : {}) })),
    notices: r.run.notices,
    reports: r.run.reports,
    turns: r.run.turns,
    seconds: r.run.seconds,
    ...(r.run.policy ? { policy: r.run.policy } : {}),
  };
}

/** Thrown by a saved run's page: the page's final state was not saved, so a check that reads it keeps its verdict. */
class StateNotSaved extends Error {}

/**
 * Score a saved run again with the scenario's checks as they are now. The
 * number audit runs again on each report (the account against the text it
 * was checked against), so a change to the audit counts. A check that reads
 * the page's final state (the window set, the reflections left out) cannot
 * run on a saved run: it keeps the verdict the run had, marked as kept.
 */
export function regrade(saved: SavedRun, scenario: EvalScenario): EvalResult {
  const refused = (): never => {
    throw new StateNotSaved("the page's state is not saved");
  };
  const port = { technique: saved.technique, state: refused, magnetic: refused } as unknown as AgentPort;
  // Each write_report's answer with the audit run again, in order.
  let n = 0;
  const events = saved.events.map((e) => {
    if (e.kind !== "call" || e.name !== "write_report" || e.isError) return e;
    const report = saved.reports[n++];
    if (!report) return e;
    const unverified = unverifiedNumbers(report.audit.account, report.audit.against);
    const out = JSON.parse(e.text) as Record<string, unknown>;
    const { unverifiedNumbers: _old, note: _note, ...rest } = out;
    return { ...e, text: JSON.stringify(unverified.length ? { ...rest, unverifiedNumbers: unverified } : rest) };
  });
  const run: EvalRun = {
    events,
    port,
    records: new Map(saved.records.map((r) => [r.key, r])),
    asked: saved.asked as unknown as ActivityEntry[],
    notices: saved.notices,
    usage: saved.usage,
    reports: saved.reports,
    turns: saved.turns ?? [],
    seconds: saved.seconds ?? 0,
    policy: saved.policy ?? null,
  };
  const before = new Map(saved.grades.map((g) => [g.check, g]));
  const grades = scenario.checks.map((c) => {
    try {
      return { check: c.name, ...c.grade(run) };
    } catch (e) {
      if (!(e instanceof StateNotSaved)) throw e;
      const was = before.get(c.name);
      return { check: c.name, pass: was?.pass ?? false, detail: `${was?.detail ?? "not graded in the run"} (kept from the run: this check reads the page's final state)` };
    }
  });
  return { scenario: saved.scenario, run, grades, passed: grades.every((g) => g.pass) };
}

/** A run as text, for a report or a failing test's message. */
export function transcript(run: EvalRun, max = 400): string {
  const cut = (t: string): string => (t.length > max ? `${t.slice(0, max)}…` : t);
  return run.events.map((e) =>
    e.kind === "user" ? `USER: ${e.text}`
      : e.kind === "reply" ? `AGENT: ${cut(e.text)}`
        : `  → ${e.name}(${JSON.stringify(e.input)})${e.isError ? " ✗" : ""} ${cut(e.text)}`,
  ).join("\n") + (run.notices.length ? `\nNOTICES: ${run.notices.join(" | ")}` : "");
}

/**
 * What the local tier asks of every run besides its scenario's checks
 * (docs/AGENT_EVALS.md): the conversation never hits the turn cap, the app
 * never stops it for going in circles, no chat error, and no prompt the
 * server cut. Also the most times one call (tool and input) was made.
 */
export interface TierFlags {
  readonly turnCap: boolean;
  readonly loopStopped: boolean;
  readonly chatError: boolean;
  readonly truncated: boolean;
  readonly maxSameCall: number;
}

export function tierFlags(run: EvalRun): TierFlags {
  const counts = new Map<string, number>();
  for (const c of calls(run)) {
    const key = `${c.name} ${JSON.stringify(c.input)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    turnCap: run.notices.some((n) => /^Stopped after \d+ model turns/.test(n)),
    loopStopped: run.notices.some((n) => /going in circles/.test(n)),
    chatError: run.notices.some((n) => n.startsWith("chat error:")),
    truncated: run.notices.some((n) => /cut the prompt|does not fit|no longer fits/i.test(n)),
    maxSameCall: Math.max(0, ...counts.values()),
  };
}
