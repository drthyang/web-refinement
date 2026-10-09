/**
 * The in-app Copilot conversation: Claude through the Anthropic SDK, from the
 * browser, with the Copilot tools (tools.ts) run by the executor on the live
 * page. Two ways in, same loop:
 *
 *  - `api-key`: the user's own Anthropic API key, sent straight from this
 *    browser to the API (the SDK's `dangerouslyAllowBrowser`). The key stays in
 *    this browser's storage; it is never part of a project file or a report.
 *  - `proxy`: the dev server's /api/anthropic route (vite.config.ts) holds the
 *    key from ANTHROPIC_API_KEY, so it never reaches the page. Local only.
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
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { COPILOT_TOOLS, inputJsonSchema } from "@/copilot/tools";
import type { ToolRunner } from "@/copilot/executor";
import { copilotSystemPrompt } from "@/copilot/systemPrompt";

export type ChatTransport = "api-key" | "proxy";
export type ChatEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatConfig {
  readonly transport: ChatTransport;
  /** The user's key (api-key transport only). */
  readonly apiKey?: string;
  /** Another API address for the api-key transport (default the Anthropic API). */
  readonly baseURL?: string;
  readonly model: string;
  readonly effort: ChatEffort;
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

/** Models that take the server-side refusal fallback (Claude API, `"default"` form). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export class CopilotChat {
  private readonly messages: BetaMessageParam[] = [];
  private readonly tools: BetaTool[] = COPILOT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: inputJsonSchema(t) as BetaTool["input_schema"],
    // Inputs stream as generated; the executor validates each against its schema.
    eager_input_streaming: true,
  }));
  private readonly system = copilotSystemPrompt();

  constructor(private readonly executor: ToolRunner) {}

  /** Send one user message and run the turns it leads to. */
  async send(text: string, config: ChatConfig, cb: ChatCallbacks, signal: AbortSignal): Promise<void> {
    const client = clientFor(config);
    this.messages.push({ role: "user", content: text });
    let parseRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return;
      cb.onAssistantStart();
      let message: BetaMessage;
      try {
        const stream = client.beta.messages.stream(
          {
            model: config.model,
            max_tokens: 64000,
            system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
            tools: this.tools,
            messages: this.messages,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: config.effort },
            // Caches the conversation so far on every turn, after the system prompt.
            cache_control: { type: "ephemeral" },
            ...(FALLBACK_MODELS.has(config.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal },
        );
        stream.on("text", (delta) => cb.onText(delta));
        stream.on("thinking", (delta) => cb.onThinking(delta));
        message = await stream.finalMessage();
        parseRetries = 0;
      } catch (e) {
        if (signal.aborted || e instanceof Anthropic.APIUserAbortError) return;
        // With streamed tool inputs, an input the SDK cannot parse at all fails
        // the stream; re-issue that turn (twice at most). API errors are final.
        if (!(e instanceof Anthropic.APIError) && parseRetries++ < 2) continue;
        throw e;
      }
      cb.onUsage(message.usage);
      this.messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        cb.onNotice("Claude declined to continue this request.", "error");
        return;
      }
      if (message.stop_reason === "pause_turn") continue;
      const calls = message.content.filter((b: BetaContentBlock): b is BetaToolUseBlock => b.type === "tool_use");
      if (calls.length === 0) return;
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
        const out = await this.executor.run(call.name, call.input, "chat");
        results.push({ type: "tool_result", tool_use_id: call.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
      }
      // Every tool call is answered in ONE user message, even when stopped.
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) return;
    }
    cb.onNotice(`Stopped after ${MAX_TURNS} model turns for one message. Say "continue" to go on.`, "info");
  }

  /** Messages so far (for tests). */
  history(): readonly BetaMessageParam[] {
    return this.messages;
  }
}

function toolError(id: string, text: string): BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text, is_error: true };
}

function clientFor(config: ChatConfig): Anthropic {
  if (config.transport === "proxy") {
    const base = new URL(`${import.meta.env.BASE_URL}${PROXY_PATH}`, window.location.origin).href;
    // The proxy replaces this placeholder with the real key, server side.
    return new Anthropic({ apiKey: "proxy-holds-the-key", baseURL: base, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }
  if (!config.apiKey) throw new Error("No API key: add one in the Copilot settings.");
  return new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
}

/** A readable sentence for an API error, for the conversation. */
export function describeChatError(e: unknown, transport: ChatTransport): string {
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
