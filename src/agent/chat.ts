/**
 * The in-app Agent conversation: a model through the Anthropic SDK, from the
 * browser, with the Agent tools (tools.ts) run by the executor on the live
 * page. Four ways in, same loop:
 *
 *  - `api-key`: the user's own Anthropic API key, sent straight from this
 *    browser to the API (the SDK's `dangerouslyAllowBrowser`). The key stays in
 *    this browser's storage; it is never part of a project file or a report.
 *  - `proxy`: the dev server's /api/anthropic route (vite.config.ts) holds the
 *    key from ANTHROPIC_API_KEY, so it never reaches the page. Local only.
 *  - `ollama` / `lmstudio`: a local model on the user's Ollama or LM Studio
 *    server, which speaks the same Messages API (ollama.ts, lmstudio.ts). It
 *    gets only the fields it reads: no caching, effort, adaptive thinking or
 *    fallback, which are Claude's.
 *
 * The loop is a manual tool loop over a stream, so text shows as it arrives
 * and an approval card can hold a tool call as long as the user needs. The
 * history is append-only (thinking blocks stay valid), and an interrupted turn
 * still answers every tool call it made, so the conversation can go on.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { LIVE_TOOLS, inputJsonSchema, liveTool, type LiveToolSpec } from "@/agent/tools";
import { scopeNote, scopedTools } from "@/agent/toolScope";
import { evidenceGate, gradeContradiction } from "@/agent/evidence";
import type { AgentSituation, ToolRunner } from "@/agent/executor";
import { agentSystemPrompt, autonomyNote, type AgentAutonomy } from "@/agent/systemPrompt";
import { CONTEXT_EDITING, CONTEXT_EDITING_BETA, historyChars, pruneForLocal } from "@/agent/contextWindow";
import { hasRefusalFallback } from "@/agent/chat-models";
import { ollamaBase, unreachableHint } from "@/agent/ollama";
import { ollamaNativeFetch, ollamaWindow, type OllamaPlan } from "@/agent/ollamaNative";
import { DEFAULT_OPENAI_CONTEXT, openaiBase, openaiCompatFetch, openaiUnreachableHint, openaiWindow } from "@/agent/openaiCompat";
import { ensureLmStudioContext, lmstudioBase, lmstudioUnreachableHint } from "@/agent/lmstudio";
import { MIN_AGENT_CONTEXT, contextAdvice, plainFetch } from "@/agent/localServer";

export type ChatTransport = "api-key" | "proxy" | "ollama" | "lmstudio" | "openai-compatible";
export type ChatEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatConfig {
  readonly transport: ChatTransport;
  /** The user's key (api-key transport only). */
  readonly apiKey?: string;
  /** Another API address for the api-key transport (default the Anthropic API). */
  readonly baseURL?: string;
  /** The local server (ollama and lmstudio transports; default that server's usual address), or an OpenAI-compatible server's base URL (with its /v1). */
  readonly serverUrl?: string;
  /**
   * OpenAI-compatible: the context to size requests to when the server does
   * not say how long a prompt it takes, in tokens (default 32k). Ollama: the
   * context to load a model with that is not loaded (default 32k; a loaded
   * model keeps its own, so another program using it is never reloaded).
   */
  readonly context?: number;
  readonly model: string;
  readonly effort: ChatEffort;
  /** How far the agent goes on its own (default "ask": stop at each gate). */
  readonly autonomy?: AgentAutonomy;
  /**
   * Let the API re-run a declined turn on another model (server-side refusal
   * fallback). Off unless the user turns it on: a silent model switch makes a
   * session harder to reproduce, so every turn stays on `model` by default,
   * and a turn another model answered is always announced.
   */
  readonly fallback?: boolean;
  /**
   * Which tools each request offers: "all" (Claude's default), or "stage" —
   * the page's, and on the powder page the method stage's (toolScope.ts): a
   * local model's default, its window being small.
   */
  readonly toolScope?: "stage" | "all";
  /** What the run policy (runPolicy) may be told instead of its default for the transport. */
  readonly policy?: { readonly turnCap?: number; readonly stallStop?: boolean; readonly temperature?: number | null };
  /**
   * The skills offered (default on). Off is the validation's ablation arm
   * (docs/VALIDATION.md): no skill index in the prompt and no read_skill; the
   * executor must be built with `skills: false` to match.
   */
  readonly skills?: boolean;
}

export interface ChatCallbacks {
  /** A new assistant message begins (one per model turn). */
  readonly onAssistantStart: () => void;
  readonly onText: (delta: string) => void;
  /** Summarized reasoning, as it streams. */
  readonly onThinking: (delta: string) => void;
  readonly onNotice: (text: string, tone: "info" | "error") => void;
  readonly onUsage: (usage: BetaUsage) => void;
  /** The model's message is complete, before its tool calls run: its words can be read against the page as it stands. */
  readonly onAssistantEnd?: () => void;
}

/** Most model turns one user message may run (each tool round is a turn). */
const MAX_TURNS = 40;
/**
 * A local model makes one call a turn where Claude makes several, so a full
 * refinement takes it twice the turns; the loop guard, not the cap, stops a
 * model going in circles.
 */
const MAX_TURNS_SIZED = 80;
/** The proxy route's path under the app's base URL (vite.config.ts serves it). */
export const PROXY_PATH = "api/anthropic";


/** Which API the history was written for: Claude's thinking is signed, another server's is not. */
type Backend = "anthropic" | "ollama" | "lmstudio" | "openai-compatible";

const isLocal = (t: ChatTransport): t is "ollama" | "lmstudio" => t === "ollama" || t === "lmstudio";
/** Requests sized to a window the app knows, with only the fields every server reads (not Claude's). */
const isSized = (t: ChatTransport): t is "ollama" | "lmstudio" | "openai-compatible" => isLocal(t) || t === "openai-compatible";
/** A window this long or more holds every tool: the OpenAI-compatible provider then offers them all. */
const LARGE_CONTEXT = 131_072;

export class AgentChat {
  private readonly messages: BetaMessageParam[] = [];
  private backend: Backend | null = null;
  private readonly tools: BetaTool[] = LIVE_TOOLS.map((t) => toBetaTool(t));
  private readonly toolsWithoutSkills: BetaTool[] = LIVE_TOOLS.filter((t) => t.name !== "read_skill").map((t) => toBetaTool(t, false));
  /** Where the analysis stood after the last call (the page, the stage), for the tools a request offers. */
  private here: AgentSituation | null = null;
  /** Every tool called in this conversation: it stays offered. */
  private readonly called = new Set<string>();
  private readonly withSkills = agentSystemPrompt();
  private readonly noSkills = agentSystemPrompt({ skills: false });
  /**
   * A local model's window, in tokens, as the server runs it (null: unknown,
   * then the history keeps to a fixed budget). Each request is sized to it.
   */
  private window: number | null = null;
  /** Characters per token of this model's prompts: a cautious guess, then measured from the server's own counts. */
  private charsPerToken = CHARS_PER_TOKEN;
  /** The last local request's size, to read the server's count against. */
  private sent: { readonly chars: number; readonly sentChars: number; readonly estimate: number } | null = null;
  /**
   * The server's counts that read as the whole prompt (near the estimate, and
   * not below the last such count): after two, it is known to count whole
   * prompts, cached or not, so a count far below the estimate means a cut. A
   * server that counts only what it had not cached gives one such count at
   * most (its first, cold request) and never arms the check.
   */
  private wholeCounts = 0;
  private lastWhole = 0;
  /** The server and model the measured characters per token are for. */
  private windowOf = "";
  /** Ollama: the longest context the model takes (null: unknown), and what the next request runs with. */
  private maxWindow: number | null = null;
  private ollamaPlan: OllamaPlan | null = null;

  constructor(private readonly executor: ToolRunner) {}

  /** Send one user message and run the turns it leads to. */
  async send(text: string, config: ChatConfig, cb: ChatCallbacks, signal: AbortSignal): Promise<void> {
    const client = clientFor(config, () => this.ollamaPlan);
    const backend: Backend = isSized(config.transport) ? config.transport : "anthropic";
    if (this.backend !== null && this.backend !== backend) this.keepPortableBlocks();
    this.backend = backend;
    this.window = null;
    if (this.windowOf !== `${config.transport} ${config.model}`) {
      // Another model: its tokens are counted anew.
      this.windowOf = `${config.transport} ${config.model}`;
      this.charsPerToken = CHARS_PER_TOKEN;
      this.wholeCounts = 0;
      this.lastWhole = 0;
    }
    if (config.transport === "lmstudio") {
      // A model LM Studio loads by itself gets its default context, often far
      // too short for the instructions: load it with room, or refuse. Its
      // context is the window each request must fit: a longer prompt is cut.
      const loaded = await ensureLmStudioContext(config.serverUrl ?? "", config.model, signal);
      if (loaded.notice) cb.onNotice(loaded.notice, "info");
      this.window = loaded.context;
      this.maxWindow = loaded.maxContext;
    }
    if (config.transport === "openai-compatible") {
      // The server's own context when it says (vLLM, llama.cpp, gateways), else the one the user set.
      const reported = await openaiWindow(config.serverUrl ?? "", config.apiKey, config.model, signal);
      this.window = reported ?? config.context ?? DEFAULT_OPENAI_CONTEXT;
    }
    if (config.transport === "ollama") {
      // Ollama runs a request at the context it asks for (num_ctx, through the
      // native API): the one the model is loaded with when it holds the Agent
      // (no reload), else the Agent's own, never past the model's maximum.
      const w = await ollamaWindow(config.serverUrl ?? "", config.model, signal);
      const want = Math.max(w.loaded ?? config.context ?? 0, MIN_AGENT_CONTEXT);
      this.maxWindow = w.max;
      this.window = w.max !== null ? Math.min(want, w.max) : want;
    }
    this.messages.push({ role: "user", content: text });
    this.executor.heard?.(text);
    let parseRetries = 0;
    let nudges = 0;
    // Evidence rules sent back for this message (evidence.ts): each at most once, and apart from the stall nudges.
    const gated = new Set<string>();
    const ran: string[] = [];
    // The same call at the same state, or call after call that changes nothing (when the policy counts those): a loop.
    const policy = runPolicy(config, this.window);
    const guard = new LoopGuard({ countStill: policy.stallStop, method: config.skills !== false });
    this.here = await this.situation();
    let fingerprint = this.here?.fingerprint ?? null;
    const maxTurns = policy.turnCap;
    // Refinements the guards refused in a row: after a few, the model is told how to get out.
    let refusedInARow = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal.aborted) return;
      // Sized before anything shows: a request that cannot fit is refused, not retried.
      const params = this.request(config);
      cb.onAssistantStart();
      let message: BetaMessage;
      const watch = { text: new RepeatWatch(), thinking: new RepeatWatch() };
      try {
        const stream = client.beta.messages.stream(params, { signal });
        stream.on("text", (delta) => {
          cb.onText(delta);
          if (watch.text.add(delta)) stream.abort();
        });
        stream.on("thinking", (delta) => {
          cb.onThinking(delta);
          if (watch.thinking.add(delta)) stream.abort();
        });
        message = await stream.finalMessage();
        parseRetries = 0;
      } catch (e) {
        if (signal.aborted) return;
        const looped = watch.text.unit ?? watch.thinking.unit;
        if (looped !== null) {
          // Stopped for repeating itself: keep the reply up to the first repeat,
          // so the history still alternates and the conversation can go on.
          this.messages.push({ role: "assistant", content: [{ type: "text", text: watch.text.kept() || "(stopped: the reply was repeating itself)" }] });
          cb.onNotice(
            `The model started repeating itself ("${looped.length > 60 ? looped.slice(0, 60) + "…" : looped}"), so this turn was stopped. ` +
              (isLocal(config.transport)
                ? "Local models do this when they lose track, often because the conversation no longer fits their context: try again, clear the conversation, or use a larger model or a longer context."
                : "Try rephrasing the request."),
            "error",
          );
          return;
        }
        if (e instanceof Anthropic.APIUserAbortError) return;
        // With streamed tool inputs, an input the SDK cannot parse at all fails
        // the stream; re-issue that turn (twice at most). API errors are final.
        if (!(e instanceof Anthropic.APIError) && parseRetries++ < 2) continue;
        throw e;
      }
      cb.onUsage(message.usage);
      this.messages.push({ role: "assistant", content: message.content });
      const cut = isSized(config.transport) ? this.readCount(message.usage) : null;
      cb.onAssistantEnd?.();
      // Never a silent switch: say which model answered when a fallback did.
      for (const b of message.content) {
        if (b.type === "fallback") cb.onNotice(`${b.from.model} declined this turn; ${b.to.model} answered it.`, "info");
      }

      if (message.stop_reason === "refusal") {
        // A call the declined reply began is answered, so the conversation stays valid.
        const begun = message.content.filter((b: BetaContentBlock): b is BetaToolUseBlock => b.type === "tool_use");
        if (begun.length) this.messages.push({ role: "user", content: begun.map((c) => toolError(c.id, "Not run: the model declined to continue this request.")) });
        cb.onNotice("The model declined to continue this request.", "error");
        return;
      }
      if (message.stop_reason === "pause_turn") continue;
      const calls = message.content.filter((b: BetaContentBlock): b is BetaToolUseBlock => b.type === "tool_use");
      if (cut !== null) {
        // The server cut the prompt after all: this reply did not see all of it. Run nothing it asked for.
        if (calls.length) this.messages.push({ role: "user", content: calls.map((c) => toolError(c.id, "Not run: the server cut the prompt, so this call was made without all of the conversation.")) });
        cb.onNotice(cut, "error");
        return;
      }
      if (calls.length === 0) {
        // A reply that stalls (promises a call it does not make, waits for a
        // tool that already answered, or says nothing after a result) leaves
        // the user waiting on nothing. Ask the model to go on, twice at most.
        const said = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
        const stall = nudges < MAX_NUDGES ? stalledReply(said, this.tools.map((t) => t.name), ran, config.skills !== false) : null;
        if (stall === null) {
          if (message.stop_reason === "max_tokens" && this.window !== null) cb.onNotice("The reply filled the room left in the model's window and was cut off. Ask it to go on, or clear the conversation to give it more room.", "error");
          if (!said.trim() && ran.length > 0) cb.onNotice(`The model gave no reply after the ${ran.at(-1)} result.${isLocal(config.transport) ? " Local models do this when the conversation no longer fits their context: clear the conversation, or use a longer context." : ""}`, "error");
          // An answer without the evidence its question needs goes back once, with what to run.
          const gate = gated.size < MAX_GATES ? this.finalAnswerCheck(said, text, ran, gated) : null;
          if (gate === null) return;
          gated.add(gate.id);
          cb.onNotice(gate.notice, "info");
          this.messages.push({ role: "user", content: gate.nudge });
          continue;
        }
        nudges++;
        cb.onNotice(stall.notice, "info");
        this.messages.push({ role: "user", content: stall.nudge });
        continue;
      }
      if (message.stop_reason === "max_tokens") {
        // A tool input cut off mid-way is never run; answer the calls so the
        // history stays valid, and say why.
        this.messages.push({ role: "user", content: calls.map((c) => toolError(c.id, "The response hit the output limit before this tool input was complete; it was not run.")) });
        cb.onNotice("The reply hit the output limit; its tool calls were not run.", "error");
        return;
      }
      const results: BetaToolResultBlockParam[] = [];
      let circling: string | null = null;
      for (const call of calls) {
        if (signal.aborted) {
          results.push(toolError(call.id, "Stopped by the user before this ran."));
          continue;
        }
        if (circling !== null) {
          results.push(toolError(call.id, `${FROM_APP} Not run: the app stopped this turn because the conversation was going in circles.`));
          continue;
        }
        const refused = guard.check(call.name, call.input, fingerprint);
        if (refused !== null) {
          circling = refused.why;
          results.push(toolError(call.id, refused.nudge));
          continue;
        }
        this.called.add(call.name);
        let out: { isError: boolean; text: string };
        try {
          out = await this.executor.run(call.name, call.input, signal);
        } catch (e) {
          // Never a call left without its answer: the conversation must stay valid.
          out = { isError: true, text: `Error: the tool failed to run: ${e instanceof Error ? e.message : String(e)}` };
        }
        ran.push(call.name);
        this.here = await this.situation();
        const after = this.here?.fingerprint ?? null;
        const seen = guard.record(call.name, call.input, out.text, fingerprint, after);
        fingerprint = after;
        if (seen.stop !== null) circling = seen.stop;
        let note = seen.note;
        if (call.name === "refine") {
          refusedInARow = out.isError && /Not refined|refused|not run/i.test(out.text) ? refusedInARow + 1 : 0;
          if (refusedInARow === REFUSED_HINT && note === null) note = `${FROM_APP} ${REFUSED_HINT} refinements in a row were refused. Go back to the last free set that refined (fix what you freed since), then free one group more at a time and refine after each; hold one of each pair the refusal names. Instrument terms and B values refine in turn, never together.`;
        }
        const text = note === null ? out.text : `${out.text}\n\n${note}`;
        results.push({ type: "tool_result", tool_use_id: call.id, content: text, ...(out.isError ? { is_error: true } : {}) });
      }
      // Every tool call is answered in ONE user message, even when stopped.
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) return;
      if (circling !== null) {
        // Never a silent stop: say where the analysis stands and what the Agent needs.
        const where = (await this.situation())?.summary;
        cb.onNotice(
          `The Copilot was going in circles: ${circling}, so the app stopped it here.${where ? ` Where it stands: ${where}` : ""} ` +
            `Tell it the next step to take (for example "free the atomic positions and refine"), or start a new conversation if it has lost track.`,
          "error",
        );
        return;
      }
    }
    cb.onNotice(`Stopped after ${maxTurns} model turns for one message. Say "continue" to go on.`, "info");
  }

  /**
   * A final answer the app sends back: a conclusion whose check did not run
   * for this message, or a grade of the fit that contradicts the engine's
   * verdict. Null for an answer that stands.
   */
  private finalAnswerCheck(reply: string, asked: string, ran: readonly string[], gated: ReadonlySet<string>): { id: string; notice: string; nudge: string } | null {
    const rule = evidenceGate(reply, asked, ran, this.page(), gated);
    if (rule) return { id: rule.id, notice: rule.notice, nudge: rule.nudge };
    if (gated.has("verdict") || !this.executor.fill) return null;
    const band = this.executor.fill("{{verdict}}");
    const contradiction = band.includes("{{") ? null : gradeContradiction(reply, band);
    if (contradiction === null) return null;
    return {
      id: "verdict",
      notice: `The answer ${contradiction}; the app asked the model to quote the engine's verdict.`,
      nudge: `${FROM_APP} Your answer ${contradiction}. The verdict is the engine's, not yours: quote it as {{verdict}} and explain what it rests on.`,
    };
  }

  /** One turn's request: everything Claude reads, or only what a local server does. */
  private request(config: ChatConfig): BetaMessageStreamParams {
    if (isSized(config.transport)) {
      // A thinking-capable model thinks by default, and the servers reuse the
      // cached prompt prefix by themselves.
      const scoped = this.offered(config);
      const system = `${this.systemFor(config)}\n\n${autonomyNote(config.autonomy ?? "ask", { skills: config.skills !== false })}${scoped ? `\n\n${scopeNote(config.skills !== false)}` : ""}`;
      let tools = scoped ?? this.allTools(config);
      if (this.window === null) {
        // The window unknown: old tool results go from the copy it gets past a fixed budget.
        this.sent = null;
        return { model: config.model, max_tokens: 64000, system, tools, messages: pruneForLocal(this.messages), ...temperatureOf(config) };
      }
      let fixed = system.length + JSON.stringify(tools).length;
      const cap = runPolicy(config, this.window).replyCap;
      let fit = fitWindow(this.messages, fixed, this.window, this.charsPerToken, cap);
      if (fit.refusal !== null && scoped) {
        // Every tool used stays offered, and a long session gathers many: when nothing else fits, the stage's tools only.
        const lean = this.offered(config, true)!;
        const leanFit = fitWindow(this.messages, system.length + JSON.stringify(lean).length, this.window, this.charsPerToken, cap);
        if (leanFit.refusal === null || leanFit.estimate < fit.estimate) {
          tools = lean;
          fixed = system.length + JSON.stringify(lean).length;
          fit = leanFit;
        }
      }
      if (fit.refusal !== null && config.transport === "ollama" && this.maxWindow !== null && this.window < this.maxWindow) {
        // Ollama can run the model with more: the smallest step of 8k that holds it (one reload), up to its maximum.
        const grown = Math.min(this.maxWindow, Math.ceil((fit.estimate + REPLY_RESERVE) / 8192) * 8192);
        const wider = fitWindow(this.messages, fixed, grown, this.charsPerToken, cap);
        if (wider.refusal === null) this.window = grown;
        fit = wider;
      }
      if (fit.refusal !== null) {
        // What the model could run with instead (LM Studio: a reload; Ollama: past its maximum, nothing).
        const advice = isLocal(config.transport)
          ? contextAdvice({ server: config.transport === "lmstudio" ? "LM Studio" : "Ollama", model: config.model, needed: fit.estimate + REPLY_RESERVE, current: this.window, max: this.maxWindow }).text
          : undefined;
        throw new Error(fit.refusal(config, advice));
      }
      this.sent = { chars: fit.chars, sentChars: fit.sentChars, estimate: fit.estimate };
      // fit was sized to this.window (grown when it had to be).
      this.ollamaPlan = config.transport === "ollama" ? { numCtx: this.window, numPredict: fit.maxTokens } : null;
      return { model: config.model, max_tokens: fit.maxTokens, system, tools, messages: fit.messages, ...temperatureOf(config) };
    }
    return {
      model: config.model,
      max_tokens: 64000,
      // The mode follows the cached prompt, so switching it keeps the cache.
      system: [{ type: "text", text: this.systemFor(config), cache_control: { type: "ephemeral" } }, { type: "text", text: `${autonomyNote(config.autonomy ?? "ask", { skills: config.skills !== false })}${this.offered(config) ? `\n\n${scopeNote(config.skills !== false)}` : ""}` }],
      // Inputs stream as generated; the executor validates each against its schema.
      tools: (this.offered(config) ?? this.allTools(config)).map((t) => ({ ...t, eager_input_streaming: true })),
      messages: this.messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: config.effort },
      // Caches the conversation so far on every turn, after the system prompt.
      cache_control: { type: "ephemeral" },
      // Old tool results leave the window once it fills (contextWindow.ts).
      context_management: CONTEXT_EDITING,
      betas: [CONTEXT_EDITING_BETA, ...(config.fallback && hasRefusalFallback(config.model) ? ["server-side-fallback-2026-07-01"] : [])],
      ...(config.fallback && hasRefusalFallback(config.model) ? { fallbacks: "default" as const } : {}),
    };
  }

  /**
   * The conversation moves to another backend: earlier replies keep only
   * their text and tool calls. The API rejects a local model's unsigned
   * thinking, and Claude's own blocks (signed thinking, fallback) mean nothing
   * to a local server.
   * Safe between messages: no tool loop is in flight.
   */
  private keepPortableBlocks(): void {
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      if (m.role !== "assistant" || typeof m.content === "string") continue;
      const kept = m.content.filter((b) => b.type === "text" || b.type === "tool_use");
      this.messages[i] = { role: "assistant", content: kept.length ? kept : [{ type: "text", text: "(no reply)" }] };
    }
  }

  /** The policy the conversation runs under now (its window as the last message found it): for a run's record. */
  policyFor(config: ChatConfig): RunPolicy {
    return runPolicy(config, this.window);
  }

  /** Messages so far (for tests). */
  history(): readonly BetaMessageParam[] {
    return this.messages;
  }

  private systemFor(config: ChatConfig): string {
    return config.skills === false ? this.noSkills : this.withSkills;
  }

  /** Every tool, as the model is offered it: without the skills (the validation's ablation arm), no read_skill, and each description in its form without them. */
  private allTools(config: ChatConfig): BetaTool[] {
    return config.skills === false ? this.toolsWithoutSkills : this.tools;
  }

  /**
   * The tools this request offers when they are scoped (null: every tool):
   * a local model's default, and only when the runner says where the
   * analysis stands.
   */
  private offered(config: ChatConfig, lean = false): BetaTool[] | null {
    // A local model's window is small; an OpenAI-compatible one's may be either: all the tools only when it is large.
    if (runPolicy(config, this.window).toolScope === "all" || this.here === null) return null;
    // Lean: the page's and the stage's tools only, for a prompt that otherwise cannot fit.
    const asked = lean ? [] : this.messages.filter((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(FROM_APP)).map((m) => m.content as string);
    const skills = config.skills !== false;
    return scopedTools({ page: this.here.page, stage: this.here.stage, magnetic: this.here.magnetic, asked, called: lean ? new Set<string>() : this.called, method: skills })
      .filter((t) => skills || t.name !== "read_skill")
      .map((t) => toBetaTool(t, skills));
  }

  /**
   * The server's count of the prompt it read, against what was sent: a count
   * far below the estimate means it cut the prompt (a sentence for the user);
   * otherwise it calibrates the characters per token. Null when it fits.
   */
  private readCount(usage: BetaUsage): string | null {
    const sent = this.sent;
    // These servers count the whole prompt as its input (LM Studio gives the cached part again
    // as cache_read; Ollama's prompt_eval_count and an OpenAI server's prompt_tokens are totals).
    const read = usage.input_tokens ?? 0;
    if (sent === null || this.window === null || read <= 0) return null;
    if (read < CUT_SHARE * sent.estimate) {
      if (this.wholeCounts < 2) return null;
      return `The server read only ${read.toLocaleString("en-US")} of about ${sent.estimate.toLocaleString("en-US")} prompt tokens: it cut the prompt, so this reply did not see all of its instructions and the conversation, and nothing it asked for was run. Check the context the model is loaded with, or clear the conversation.`;
    }
    // Measured on what the server surely read (reasoning a server drops is left out), so the
    // ratio errs low. A count near the window may be a cut one, and a count below the last
    // whole one may leave out what was cached: learn only from a prompt that clearly fit, whole.
    const ratio = sent.sentChars / read;
    if (ratio >= 2.4 && ratio <= 4.5 && read < 0.95 * this.window && read >= 0.9 * this.lastWhole) {
      this.wholeCounts++;
      this.lastWhole = read;
      this.charsPerToken = Math.min(MAX_CHARS_PER_TOKEN, Math.max(CHARS_PER_TOKEN_FLOOR, ratio * 0.92));
    }
    return null;
  }

  /** The page open, as the runner says (the evidence rules are per page). */
  private page(): "powder" | "pdf" | "singleCrystal" | null {
    try {
      return this.executor.page?.() ?? this.here?.page ?? null;
    } catch {
      return null;
    }
  }

  /** Where the analysis stands, when the runner can say (a failure to read it is no reason to stop a turn). */
  private async situation(): Promise<AgentSituation | null> {
    try {
      return (await this.executor.situation?.()) ?? null;
    } catch {
      return null;
    }
  }
}

/** Characters per token a local model's prompt is first taken to have: low, so the estimate errs high (measured: 3.7 on the Agent's prompt for qwen3.8-27b). */
export const CHARS_PER_TOKEN = 3;
const CHARS_PER_TOKEN_FLOOR = 2.5;
const MAX_CHARS_PER_TOKEN = 3.8;
/** Tokens kept free for a local model's reply and its thinking. */
export const REPLY_RESERVE = 6144;
/** The least room for a reply a request is sent with. */
export const MIN_REPLY = 2048;
/** The most an OpenAI-compatible reply is given (gpt-4o takes no more). */
const OPENAI_REPLY_CAP = 16384;

/**
 * How a conversation runs on its transport: its limits and the shape of each
 * request. Each default is the app's choice for that transport, with its
 * reason where it is set; a run records the policy it ran under, so models
 * reached in different ways are compared knowing how (docs/VALIDATION.md).
 */
export interface RunPolicy {
  /** Most model turns one user message may run (MAX_TURNS, MAX_TURNS_SIZED). */
  readonly turnCap: number;
  /** The tools a request offers: all of them, or the page's and the method stage's (toolScope.ts). */
  readonly toolScope: "stage" | "all";
  /** Old tool results: cleared by the API past a budget (Claude), or digested by the app to fit the window (contextWindow.ts). */
  readonly pruning: "server" | "digest";
  /** A turn stops after STILL_STOP read calls in a row that change nothing (LoopGuard). */
  readonly stallStop: boolean;
  /** Sent with each request; null: the server's default for the model. Claude thinks (adaptive), which takes its own. */
  readonly temperature: number | null;
  /** Most tokens one reply may take. */
  readonly replyCap: number;
  /** Claude's adaptive thinking at the configured effort, or what a local model does by default. */
  readonly thinking: "adaptive" | "model";
}

export function runPolicy(config: ChatConfig, window: number | null): RunPolicy {
  const sized = isSized(config.transport);
  const set = config.policy ?? {};
  return {
    turnCap: set.turnCap ?? (sized ? MAX_TURNS_SIZED : MAX_TURNS),
    // A local model's window is small; an OpenAI-compatible one's may be either: all the tools only when it is large.
    toolScope: config.toolScope ?? (isLocal(config.transport) || (config.transport === "openai-compatible" && (window ?? 0) < LARGE_CONTEXT) ? "stage" : "all"),
    pruning: sized ? "digest" : "server",
    // Calls that change nothing are counted on a sized transport only: Claude may read at length (a ref page by page).
    stallStop: set.stallStop ?? sized,
    temperature: sized ? set.temperature ?? null : null,
    // OpenAI's own models take at most 16k (gpt-4o) to 32k tokens of reply: cap it there.
    replyCap: config.transport === "openai-compatible" ? OPENAI_REPLY_CAP : 64000,
    thinking: sized ? "model" : "adaptive",
  };
}

/** A sized request's temperature, when the policy sets one. */
function temperatureOf(config: ChatConfig): { temperature?: number } {
  const t = runPolicy(config, null).temperature;
  return t === null ? {} : { temperature: t };
}
/** Template tokens around each message. */
const MESSAGE_TOKENS = 8;
/** A prompt the server counts below this share of the estimate was cut. */
const CUT_SHARE = 0.4;

const k = (n: number): string => `${Math.round(n / 1024)}k`;

const withoutThinking = (messages: readonly BetaMessageParam[]): BetaMessageParam[] =>
  messages.map((m) => (m.role !== "assistant" || typeof m.content === "string" ? m : { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") }));

/**
 * A local request sized to the model's window (tokens): the history pruned to
 * what is left after the instructions, the tools and room for the reply; the
 * reply capped at the room left. When even the most pruned history does not
 * fit, a refusal instead: a prompt the server would cut is never sent.
 */
export function fitWindow(messages: readonly BetaMessageParam[], fixedChars: number, window: number, charsPerToken: number, replyCap = 64000): {
  readonly messages: BetaMessageParam[];
  readonly chars: number;
  /** The characters every server surely reads: without the reasoning of earlier replies, which some drop. */
  readonly sentChars: number;
  readonly estimate: number;
  readonly maxTokens: number;
  /** Why nothing was sent; `advice` (contextAdvice) replaces the generic next step. */
  readonly refusal: ((config: Pick<ChatConfig, "transport" | "model">, advice?: string) => string) | null;
} {
  const overhead = MESSAGE_TOKENS * (messages.length + 2);
  const budget = Math.max(0, Math.floor((window - REPLY_RESERVE - overhead) * charsPerToken - fixedChars));
  const pruned = pruneForLocal(messages, budget);
  const chars = fixedChars + historyChars(pruned);
  const sentChars = fixedChars + historyChars(withoutThinking(pruned));
  const estimate = Math.ceil(chars / charsPerToken) + overhead;
  const room = window - estimate;
  if (room >= MIN_REPLY) return { messages: pruned, chars, sentChars, estimate, maxTokens: Math.min(replyCap, room), refusal: null };
  return {
    messages: pruned,
    chars,
    sentChars,
    estimate,
    maxTokens: 0,
    refusal: (config, advice) => {
      const needs = `it needs about ${k(estimate + MIN_REPLY)} (the instructions and tools alone about ${k(fixedChars / charsPerToken)}). Nothing was sent, so the model was not handed a cut prompt.`;
      if (advice) return `This conversation no longer fits the ${k(window)}-token context ${config.transport === "lmstudio" ? "LM Studio" : "Ollama"} runs ${config.model} with, even with the old tool results shortened. Nothing was sent, so the model was not handed a cut prompt. ${advice}`;
      return config.transport === "lmstudio"
        ? `This conversation no longer fits the ${k(window)}-token context LM Studio runs ${config.model} with, even with the old tool results shortened: ${needs} Start a new conversation, or give the model a longer context (lms unload ${config.model} && lms load ${config.model} --context-length ${2 * window}).`
        : config.transport === "openai-compatible"
          ? `This conversation no longer fits the ${k(window)}-token window used for ${config.model} (the server's own, or the context set in the Copilot settings when the server does not say), even with the old tool results shortened: ${needs} Start a new conversation, or set a longer context if the model takes one.`
          : `This conversation no longer fits ${config.model}'s ${k(window)}-token context on Ollama, even with the old tool results shortened: ${needs} Start a new conversation, or pick a model with a longer context.`;
    },
  };
}

/** A call made again at the same state, its result unchanged: noted once, and the third time the turn stops. */
const MAX_SAME_CALL = 3;
/** Repeated calls of any kind in one message before the turn stops. */
const MAX_REPEATS = 4;
/** Calls in a row that change nothing: the model is told at the first count, and the turn stops at the second. */
const STILL_NOTE = 12;
/** Tools whose answer differs call to call at the same state (a fresh MCMC draw): a repeat is the same call at the same state. */
const SAMPLERS: ReadonlySet<string> = new Set(["sample_posterior"]);
/** Read tools that neither count toward STILL_STOP nor reset it: reading what is there, and writing notes and the report. */
const STILL_NEUTRAL: ReadonlySet<string> = new Set(["read_ref", "read_skill", "write_note", "write_report"]);
const STILL_STOP = 20;

const callKey = (name: string, input: unknown): string => `${name} ${stableJson(input ?? {})}`;
/** A result as compared between calls: without its ref, which numbers every result anew. */
const sameText = (text: string): string => text.replace(/"ref":"#\d+",?/g, "");

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/**
 * The chat's guard against a model going in circles (local models lose track
 * and call the same tool again and again). Per user message it remembers each
 * call (tool and input), the state it was made at (the runner's fingerprint)
 * and what it answered:
 *
 *  - the same call at the same state with the same answer is a repeat: its
 *    result carries a note from the app saying so;
 *  - a third such call at the same state is not run, and the turn stops; so
 *    does a fourth repeat of any kind, or STILL_STOP calls in a row that
 *    changed nothing (the model is told at STILL_NOTE).
 *
 * Without a fingerprint (a runner that cannot say), a repeat is the same call
 * with the same answer, and nothing is refused before it runs.
 */
export class LoopGuard {
  private readonly seen = new Map<string, { readonly at: string | null; readonly text: string; readonly count: number }>();
  private repeats = 0;
  private still = 0;
  private toldStill = false;

  /** `method`: a page's written method is in play (false without the skills, the validation's arm C: the notes then name none). */
  constructor(private readonly opts: { readonly countStill?: boolean; readonly method?: boolean } = {}) {}

  /** Before a call: why it must not run (it already ran twice at this very state), or null. */
  check(name: string, input: unknown, at: string | null): { readonly why: string; readonly nudge: string } | null {
    const prev = this.seen.get(callKey(name, input));
    if (at === null || prev === undefined || prev.at !== at || prev.count < MAX_SAME_CALL - 1) return null;
    return {
      why: `it called ${name} ${MAX_SAME_CALL} times with the same input, and nothing changed in between`,
      nudge: `${FROM_APP} Not run: ${name} already ran ${prev.count} times with this input, and nothing has changed since. The app stopped this turn; the user will tell you how to go on.`,
    };
  }

  /** After a call: a note for the model (a repeat, or calls that change nothing), and why the turn must stop, if it must. */
  record(name: string, input: unknown, text: string, before: string | null, after: string | null): { readonly note: string | null; readonly stop: string | null } {
    const key = callKey(name, input);
    const prev = this.seen.get(key);
    const answer = sameText(text);
    // The same answer at the same state; for a sampler (a new draw each time) the same state is enough.
    const repeat = prev !== undefined && (before === null ? prev.text === answer : prev.at === before && (prev.text === answer || SAMPLERS.has(name)));
    const count = repeat ? prev.count + 1 : 1;
    this.seen.set(key, { at: before, text: answer, count });
    // Only reads count toward a stall: a change attempt, a note or a report is work even when the fit
    // stays as it was (a boxcar scan, a refused refinement), and reading a ref or a skill reads what is there.
    const changed = before !== null && after !== before;
    if (changed) this.still = 0;
    else if (!STILL_NEUTRAL.has(name) && liveTool(name)?.effect === "read") this.still = this.opts.countStill !== false && before !== null ? this.still + 1 : 0;
    if (repeat) {
      this.repeats++;
      if (count >= MAX_SAME_CALL) return { note: null, stop: `it called ${name} ${count} times with the same input, and nothing changed in between` };
      if (this.repeats >= MAX_REPEATS) return { note: null, stop: `it repeated calls it had already made ${this.repeats} times, with nothing changed in between` };
      return {
        note: `${FROM_APP} You already made this call (${name}, the same input) and nothing has changed since: this is the same result as before.${name === "read_skill" ? " The skill is already in this conversation." : ""} Do not call it again. Take the next step${this.opts.method === false ? "" : " of the method"} with what you have, or stop and tell the user what you need.`,
        stop: null,
      };
    }
    if (this.still >= STILL_STOP) return { note: null, stop: `it made ${this.still} tool calls in a row without changing the analysis` };
    if (this.still >= STILL_NOTE && !this.toldStill) {
      this.toldStill = true;
      return { note: `${FROM_APP} ${this.still} tool calls in a row have not changed the analysis. Make the change ${this.opts.method === false ? "the analysis needs" : "the method calls for"} next, write the report if the work is done, or stop and ask the user.`, stop: null };
    }
    return { note: null, stop: null };
  }
}

/** Refused refinements in a row before the model is told how to get out. */
const REFUSED_HINT = 3;

/** Most times one user message may ask a stalled model to go on. */
const MAX_NUDGES = 2;
/** Most times one user message's final answer may be sent back for its evidence or its verdict. */
const MAX_GATES = 2;
const FROM_APP = "(From the app, not the user.)";

/**
 * A reply with no tool call that leaves the user waiting on nothing, and what
 * the app tells the model about it; null for an ordinary final reply. `ran`
 * holds the tools that already ran for this message, in order.
 */
export function stalledReply(text: string, tools: readonly string[], ran: readonly string[], method = true): { notice: string; nudge: string } | null {
  const last = ran.at(-1);
  if (!text.trim()) {
    if (last === undefined) return null;
    return {
      notice: `The model said nothing after the ${last} result; the app asked it to go on.`,
      nudge: `${FROM_APP} You replied with nothing after the ${last} result above. Say what it shows and take the next step${method ? " your method calls for" : ""}, or stop for the user and say why.`,
    };
  }
  // "I was waiting for the check_cell_symmetry tool to complete" — about a
  // tool, not about the user ("I'll wait for your go-ahead" is a real stop).
  const waiting = ran.length === 0 ? undefined : text.split(/(?<=[.!?])\s+/).find(
    (st) => /\bwait(s|ing|ed)?\b/i.test(st) && !/\byou(r|rs)?\b/i.test(st) && (ran.some((n) => st.includes(n)) || /\b(tool|result|finish|complete|analysis)\b/i.test(st)),
  );
  const waitedOn = waiting === undefined ? null : [...ran].reverse().find((n) => waiting.includes(n)) ?? last!;
  if (waitedOn !== null) {
    return {
      notice: `The model said it was waiting for ${waitedOn}, which had already finished; the app pointed it to the result.`,
      nudge: `${FROM_APP} ${waitedOn} already finished; its result is the tool result above. Nothing is running. Read it, say what it shows, and go on.`,
    };
  }
  const tool = announcedTool(text, tools);
  if (tool === null) return null;
  return {
    notice: `The reply said it would run ${tool} but made no tool call, so nothing ran; the app asked it to go on.`,
    nudge: `${FROM_APP} Your last reply said you would act now, but it made no tool call, so nothing ran. If you meant to act, make the call now. If you meant to stop for the user, say so in one line.`,
  };
}

/**
 * The tool a reply announces it is about to run without calling it, or null.
 * Its last paragraph speaks of acting now ("Starting the Le Bail gate now.",
 * "I'll call refine()"), the reply names a tool, and it neither asks the user
 * nor says it is stopping — a gate where the method waits for the user is not
 * nudged.
 */
export function announcedTool(text: string, tools: readonly string[]): string | null {
  const t = text.trim();
  if (!t || /\?\s*$/.test(t)) return null;
  const last = t.split(/\n\s*\n/).filter((p) => p.trim()).at(-1)!.trim();
  if (/\b(shall|should|may) I\b|\bwould you\b|\bdo you want\b|\blet me know\b|\bif you (want|agree|approve|prefer)\b|\byour (go-ahead|approval|call|decision)\b|\b(stop|stopping|pause|wait|waiting|hold) (here|for)\b/i.test(last)) return null;
  // An action the reply takes now, in the first person ("I'll refine", "Starting the gate now."):
  // "for now" is a stop, and "next" without a person is a summary of what is left.
  const firstPerson = /\b(I|I'll|I will|I'm|I am|let me|let's|we'll|we will)\b/i.test(last);
  const acting = /^(starting|running|calling|proceeding|launching|beginning)\b/i.test(last)
    || /\b(I'll|I will|I'm going to|I am going to|let me|let's) (now )?(call|run|start|refine|free|fix|check|set|assess|use)\b/i.test(last)
    || (/\b(now|next)\s*[.!]?$/i.test(last) && !/\bfor now\s*[.!]?$/i.test(last) && firstPerson);
  if (!acting) return null;
  // The tool named closest to the end, as a word ("refine" is not in "refinement"), else "refine" when the reply speaks of refining.
  let best: string | null = null;
  let at = -1;
  for (const name of tools) {
    for (const m of t.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g"))) {
      if (m.index > at) {
        at = m.index;
        best = name;
      }
    }
  }
  return best ?? (/\brefin(e|ing)\b/i.test(t) ? "refine" : null);
}

/**
 * Watches a streamed reply for a degenerate loop: the same phrase (8 to 400
 * characters, with a letter in it) at least six times in a row at its end,
 * whitespace aside. Checked every couple of hundred characters, so a loop is
 * caught within a few repeats.
 */
export class RepeatWatch {
  private raw = "";
  private checkedAt = 0;
  /** The repeating phrase, once found. */
  unit: string | null = null;

  /** Add a delta; true when the reply has just been found looping. */
  add(delta: string): boolean {
    if (this.unit !== null) return false;
    this.raw += delta;
    if (this.raw.length - this.checkedAt < 200) return false;
    this.checkedAt = this.raw.length;
    this.unit = repeatingTail(this.raw);
    return this.unit !== null;
  }

  /** The reply up to the end of the phrase's first occurrence. */
  kept(): string {
    const flat = this.raw.replace(/\s+/g, " ").trim();
    if (this.unit === null) return flat;
    const at = flat.indexOf(this.unit);
    return at < 0 ? flat : flat.slice(0, at + this.unit.length).trim();
  }
}

/** The phrase `text` ends by repeating at least `run` times in a row, or null. */
export function repeatingTail(text: string, run = 6, minUnit = 8, maxUnit = 400): string | null {
  const flat = text.replace(/\s+/g, " ").trimEnd() + " ";
  for (let len = minUnit; len <= maxUnit && len * run <= flat.length; len++) {
    const unit = flat.slice(-len);
    let k = 2;
    while (k <= run && flat.slice(-len * k, -len * (k - 1)) === unit) k++;
    if (k > run && /\p{L}/u.test(unit)) return unit.trim();
  }
  return null;
}

function toBetaTool(t: LiveToolSpec, skills = true): BetaTool {
  return { name: t.name, description: skills ? t.description : t.withoutSkills ?? t.description, input_schema: inputJsonSchema(t) as BetaTool["input_schema"] };
}

function toolError(id: string, text: string): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text, is_error: true };
}

function clientFor(config: ChatConfig, ollamaPlan: () => OllamaPlan | null): Anthropic {
  if (config.transport === "openai-compatible") {
    // The SDK's requests become chat completions (openaiCompat.ts); the key goes only to the server named, as a Bearer token.
    const base = openaiBase(config.serverUrl ?? "");
    return new Anthropic({ apiKey: "openai-compatible", baseURL: base, dangerouslyAllowBrowser: true, maxRetries: 1, fetch: openaiCompatFetch(base, config.apiKey || undefined) });
  }
  if (isLocal(config.transport)) {
    // A local server ignores the key, but the SDK wants one; plainFetch never sends it.
    // Ollama goes through its native chat, the only endpoint that takes a context length.
    const baseURL = config.transport === "ollama" ? ollamaBase(config.serverUrl ?? "") : lmstudioBase(config.serverUrl ?? "");
    return new Anthropic({ apiKey: config.transport, baseURL, dangerouslyAllowBrowser: true, maxRetries: 1, fetch: config.transport === "ollama" ? ollamaNativeFetch(ollamaPlan) : plainFetch });
  }
  if (config.transport === "proxy") {
    const base = new URL(`${import.meta.env.BASE_URL}${PROXY_PATH}`, window.location.origin).href;
    // The proxy replaces this placeholder with the real key, server side.
    return new Anthropic({ apiKey: "proxy-holds-the-key", baseURL: base, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }
  if (!config.apiKey) throw new Error("No API key: add one in the Copilot settings.");
  return new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
}

/** A readable sentence for an API error, for the conversation. */
export function describeChatError(e: unknown, config: Pick<ChatConfig, "transport" | "model" | "serverUrl">): string {
  const { transport } = config;
  if (transport === "ollama") return describeOllamaError(e, config);
  if (transport === "openai-compatible") return describeOpenAIError(e, config);
  if (transport === "lmstudio") return describeLmStudioError(e, config);
  if (e instanceof Anthropic.AuthenticationError) {
    return transport === "proxy"
      ? "The proxy's API key was rejected. Check ANTHROPIC_API_KEY where the dev server runs."
      : "The API key was rejected. Check it in the Copilot settings.";
  }
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key is not allowed to use that model.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (e instanceof Anthropic.APIConnectionError) {
    return transport === "proxy"
      ? "Could not reach the proxy. It runs only with the dev server (npm run dev or npm run preview)."
      : "Could not reach the Anthropic API from this browser.";
  }
  if (e instanceof Anthropic.APIError) {
    const body = e.error as { error?: { type?: string; message?: string } } | undefined;
    if (body?.error?.type === "proxy_not_configured") return body.error.message ?? "The proxy has no API key.";
    return `API error ${e.status ?? ""}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function describeOllamaError(e: unknown, config: Pick<ChatConfig, "model" | "serverUrl">): string {
  if (e instanceof Anthropic.APIConnectionError) {
    return unreachableHint(config.serverUrl ?? "", typeof window === "undefined" ? null : window.location.origin);
  }
  if (e instanceof Anthropic.APIError) {
    const body = e.error as { error?: { message?: string } } | undefined;
    const message = body?.error?.message ?? e.message;
    if (e.status === 404 && /not found/i.test(message)) {
      return `Ollama has no model "${config.model}". Pull it (ollama pull ${config.model}) or pick another in the Copilot settings.`;
    }
    if (/does not support tools/i.test(message)) {
      return `"${config.model}" cannot call tools, and the Copilot works only through them. Pick a model marked "tools" in the Copilot settings.`;
    }
    return `Ollama error ${e.status ?? ""}: ${message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function describeOpenAIError(e: unknown, config: Pick<ChatConfig, "model" | "serverUrl">): string {
  const base = openaiBase(config.serverUrl ?? "");
  if (e instanceof Anthropic.APIConnectionError) return openaiUnreachableHint(base);
  if (e instanceof Anthropic.APIError) {
    const body = e.error as { error?: { message?: string } | string } | undefined;
    const message = (typeof body?.error === "string" ? body.error : body?.error?.message) ?? e.message;
    if (e.status === 401 || e.status === 403) return `${base} refused the API key (${e.status}): ${message} Check the key in the Copilot settings.`;
    if (e.status === 429) return `${base} is rate-limiting this key: ${message} Wait a moment and try again.`;
    if (/context|too long|maximum.*tokens|token limit/i.test(message) && /length|exceed|maximum|limit|long/i.test(message)) {
      return `The server says the prompt is longer than ${config.model} takes: ${message} Set the context in the Copilot settings to what the model takes (the Copilot then shortens old results to fit), or start a new conversation.`;
    }
    if (e.status === 404 || /model.*(not found|does not exist)|unknown model/i.test(message)) return `${base} has no model "${config.model}": ${message} Pick another in the Copilot settings.`;
    if (/tool|function/i.test(message) && /support/i.test(message)) return `"${config.model}" cannot call tools on ${base}, and the Copilot works only through them: ${message}`;
    return `Server error ${e.status ?? ""} from ${base}: ${message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function describeLmStudioError(e: unknown, config: Pick<ChatConfig, "model" | "serverUrl">): string {
  if (e instanceof Anthropic.APIConnectionError) return lmstudioUnreachableHint(config.serverUrl ?? "");
  if (e instanceof Anthropic.AuthenticationError) {
    return "LM Studio's server asks for an API token. Turn off Require Authentication in its server settings to use it from this page.";
  }
  if (e instanceof Anthropic.APIError) {
    const body = e.error as { error?: { message?: string } | string; message?: string } | undefined;
    const message = (typeof body?.error === "string" ? body.error : body?.error?.message) ?? body?.message ?? e.message;
    if (/context/i.test(message) && /length|overflow|exceed|greater/i.test(message)) {
      return `The conversation no longer fits the context LM Studio loaded "${config.model}" with. Reload it with a context length of at least 32k (lms load ${config.model} --context-length 32768), or clear the conversation.`;
    }
    if (/not (found|loaded)|no model|does not exist/i.test(message)) {
      return `LM Studio could not run "${config.model}": ${message} Load it in LM Studio, or pick another in the Copilot settings.`;
    }
    return `LM Studio error ${e.status ?? ""}: ${message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
