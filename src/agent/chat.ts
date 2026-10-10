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
import { LIVE_TOOLS, inputJsonSchema } from "@/agent/tools";
import type { ToolRunner } from "@/agent/executor";
import { agentSystemPrompt, autonomyNote, type AgentAutonomy } from "@/agent/systemPrompt";
import { CONTEXT_EDITING, CONTEXT_EDITING_BETA, pruneForLocal } from "@/agent/contextWindow";
import { hasRefusalFallback } from "@/agent/chat-models";
import { ollamaBase, unreachableHint } from "@/agent/ollama";
import { ensureLmStudioContext, lmstudioBase, lmstudioUnreachableHint } from "@/agent/lmstudio";
import { plainFetch } from "@/agent/localServer";

export type ChatTransport = "api-key" | "proxy" | "ollama" | "lmstudio";
export type ChatEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatConfig {
  readonly transport: ChatTransport;
  /** The user's key (api-key transport only). */
  readonly apiKey?: string;
  /** Another API address for the api-key transport (default the Anthropic API). */
  readonly baseURL?: string;
  /** The local server (ollama and lmstudio transports; default that server's usual address). */
  readonly serverUrl?: string;
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
}

export interface ChatCallbacks {
  /** A new assistant message begins (one per model turn). */
  readonly onAssistantStart: () => void;
  readonly onText: (delta: string) => void;
  /** Summarized reasoning, as it streams. */
  readonly onThinking: (delta: string) => void;
  readonly onNotice: (text: string, tone: "info" | "error") => void;
  readonly onUsage: (usage: BetaUsage) => void;
}

/** Most model turns one user message may run (each tool round is a turn). */
const MAX_TURNS = 40;
/** The proxy route's path under the app's base URL (vite.config.ts serves it). */
export const PROXY_PATH = "api/anthropic";


/** Which API the history was written for: Claude's thinking is signed, a local server's is not. */
type Backend = "anthropic" | "ollama" | "lmstudio";

const isLocal = (t: ChatTransport): t is "ollama" | "lmstudio" => t === "ollama" || t === "lmstudio";

export class AgentChat {
  private readonly messages: BetaMessageParam[] = [];
  private backend: Backend | null = null;
  private readonly tools: BetaTool[] = LIVE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: inputJsonSchema(t) as BetaTool["input_schema"],
  }));
  private readonly system = agentSystemPrompt();

  constructor(private readonly executor: ToolRunner) {}

  /** Send one user message and run the turns it leads to. */
  async send(text: string, config: ChatConfig, cb: ChatCallbacks, signal: AbortSignal): Promise<void> {
    const client = clientFor(config);
    const backend: Backend = isLocal(config.transport) ? config.transport : "anthropic";
    if (this.backend !== null && this.backend !== backend) this.keepPortableBlocks();
    this.backend = backend;
    if (config.transport === "lmstudio") {
      // A model LM Studio loads by itself gets its default context, often far
      // too short for the instructions: load it with room, or refuse.
      const loaded = await ensureLmStudioContext(config.serverUrl ?? "", config.model, signal);
      if (loaded) cb.onNotice(loaded, "info");
    }
    this.messages.push({ role: "user", content: text });
    let parseRetries = 0;
    let nudges = 0;
    const ran: string[] = [];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return;
      cb.onAssistantStart();
      let message: BetaMessage;
      const watch = { text: new RepeatWatch(), thinking: new RepeatWatch() };
      try {
        const stream = client.beta.messages.stream(this.request(config), { signal });
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
      // Never a silent switch: say which model answered when a fallback did.
      for (const b of message.content) {
        if (b.type === "fallback") cb.onNotice(`${b.from.model} declined this turn; ${b.to.model} answered it.`, "info");
      }

      if (message.stop_reason === "refusal") {
        cb.onNotice("Claude declined to continue this request.", "error");
        return;
      }
      if (message.stop_reason === "pause_turn") continue;
      const calls = message.content.filter((b: BetaContentBlock): b is BetaToolUseBlock => b.type === "tool_use");
      if (calls.length === 0) {
        // A reply that stalls (promises a call it does not make, waits for a
        // tool that already answered, or says nothing after a result) leaves
        // the user waiting on nothing. Ask the model to go on, twice at most.
        const said = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
        const stall = nudges < MAX_NUDGES ? stalledReply(said, this.tools.map((t) => t.name), ran) : null;
        if (stall === null) {
          if (!said.trim() && ran.length > 0) cb.onNotice(`The model gave no reply after the ${ran.at(-1)} result.${isLocal(config.transport) ? " Local models do this when the conversation no longer fits their context: clear the conversation, or use a longer context." : ""}`, "error");
          return;
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
      for (const call of calls) {
        if (signal.aborted) {
          results.push(toolError(call.id, "Stopped by the user before this ran."));
          continue;
        }
        const out = await this.executor.run(call.name, call.input);
        ran.push(call.name);
        results.push({ type: "tool_result", tool_use_id: call.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
      }
      // Every tool call is answered in ONE user message, even when stopped.
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) return;
    }
    cb.onNotice(`Stopped after ${MAX_TURNS} model turns for one message. Say "continue" to go on.`, "info");
  }

  /** One turn's request: everything Claude reads, or only what a local server does. */
  private request(config: ChatConfig): BetaMessageStreamParams {
    if (isLocal(config.transport)) {
      // A thinking-capable model thinks by default, and both servers reuse the
      // cached prompt prefix by themselves.
      // A local window is small: old tool results go from the copy it gets.
      return { model: config.model, max_tokens: 64000, system: `${this.system}\n\n${autonomyNote(config.autonomy ?? "ask")}`, tools: this.tools, messages: pruneForLocal(this.messages) };
    }
    return {
      model: config.model,
      max_tokens: 64000,
      // The mode follows the cached prompt, so switching it keeps the cache.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }, { type: "text", text: autonomyNote(config.autonomy ?? "ask") }],
      // Inputs stream as generated; the executor validates each against its schema.
      tools: this.tools.map((t) => ({ ...t, eager_input_streaming: true })),
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

  /** Messages so far (for tests). */
  history(): readonly BetaMessageParam[] {
    return this.messages;
  }
}

/** Most times one user message may ask a stalled model to go on. */
const MAX_NUDGES = 2;
const FROM_APP = "(From the app, not the user.)";

/**
 * A reply with no tool call that leaves the user waiting on nothing, and what
 * the app tells the model about it; null for an ordinary final reply. `ran`
 * holds the tools that already ran for this message, in order.
 */
export function stalledReply(text: string, tools: readonly string[], ran: readonly string[]): { notice: string; nudge: string } | null {
  const last = ran.at(-1);
  if (!text.trim()) {
    if (last === undefined) return null;
    return {
      notice: `The model said nothing after the ${last} result; the app asked it to go on.`,
      nudge: `${FROM_APP} You replied with nothing after the ${last} result above. Say what it shows and take the next step your method calls for, or stop for the user and say why.`,
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
  const acting = /\b(now|next)\s*[.!]?$/i.test(last) || /^(starting|running|calling|proceeding|launching|beginning)\b/i.test(last) || /\b(I'll|I will|I'm going to|I am going to|let me|let's) (now )?(call|run|start|refine|free|fix|check|set|assess|use)\b/i.test(last);
  if (!acting) return null;
  // The tool named closest to the end, else "refine" when the reply speaks of refining.
  let best: string | null = null;
  let at = -1;
  for (const name of tools) {
    const i = t.lastIndexOf(name);
    if (i > at) {
      at = i;
      best = name;
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

function toolError(id: string, text: string): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text, is_error: true };
}

function clientFor(config: ChatConfig): Anthropic {
  if (isLocal(config.transport)) {
    // A local server ignores the key, but the SDK wants one; plainFetch never sends it.
    const baseURL = config.transport === "ollama" ? ollamaBase(config.serverUrl ?? "") : lmstudioBase(config.serverUrl ?? "");
    return new Anthropic({ apiKey: config.transport, baseURL, dangerouslyAllowBrowser: true, maxRetries: 1, fetch: plainFetch });
  }
  if (config.transport === "proxy") {
    const base = new URL(`${import.meta.env.BASE_URL}${PROXY_PATH}`, window.location.origin).href;
    // The proxy replaces this placeholder with the real key, server side.
    return new Anthropic({ apiKey: "proxy-holds-the-key", baseURL: base, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }
  if (!config.apiKey) throw new Error("No API key: add one in the Agent settings.");
  return new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
}

/** A readable sentence for an API error, for the conversation. */
export function describeChatError(e: unknown, config: Pick<ChatConfig, "transport" | "model" | "serverUrl">): string {
  const { transport } = config;
  if (transport === "ollama") return describeOllamaError(e, config);
  if (transport === "lmstudio") return describeLmStudioError(e, config);
  if (e instanceof Anthropic.AuthenticationError) {
    return transport === "proxy"
      ? "The proxy's API key was rejected. Check ANTHROPIC_API_KEY where the dev server runs."
      : "The API key was rejected. Check it in the Agent settings.";
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
      return `Ollama has no model "${config.model}". Pull it (ollama pull ${config.model}) or pick another in the Agent settings.`;
    }
    if (/does not support tools/i.test(message)) {
      return `"${config.model}" cannot call tools, and the Agent works only through them. Pick a model marked "tools" in the Agent settings.`;
    }
    return `Ollama error ${e.status ?? ""}: ${message}`;
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
      return `LM Studio could not run "${config.model}": ${message} Load it in LM Studio, or pick another in the Agent settings.`;
    }
    return `LM Studio error ${e.status ?? ""}: ${message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
