import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AgentChat, CHARS_PER_TOKEN, LoopGuard, MIN_REPLY, REPLY_RESERVE, announcedTool, describeChatError, fitWindow, repeatingTail, runPolicy, stalledReply } from "@/agent/chat";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentExecutor } from "@/agent/executor";
import { LIVE_TOOLS } from "@/agent/tools";
import { executor, fakeHost } from "@/testSupport/agentHeadless";
import { mn3gaSession, powderPage } from "@/agent/evals/pages";

/**
 * The chat loop against a stand-in Messages API that streams scripted turns
 * (server-sent events, as the real API does). It checks what the SDK sends and
 * that the loop runs tools, answers them, and stops — no network, no key.
 */

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "fallback"; from: string; to: string };

function sse(blocks: Block[], stop: string): string {
  const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  let out = ev("message_start", {
    message: { id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80 } },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type === "thinking") {
      // As Ollama streams it: no signature.
      out += ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
      out += ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
    } else if (b.type === "fallback") {
      out += ev("content_block_start", { index, content_block: { type: "fallback", from: { model: b.from }, to: { model: b.to }, trigger: { type: "refusal" } } });
    } else {
      out += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  out += ev("message_stop", {});
  return out;
}

/** The same turn as Ollama's native chat streams it: one JSON line per piece, then the counts. */
function ndjson(blocks: Block[], doneReason = "stop", promptTokens?: number): string {
  const lines = blocks.map((b) =>
    b.type === "thinking" ? { message: { role: "assistant", content: "", thinking: b.thinking } }
      : b.type === "text" ? { message: { role: "assistant", content: b.text } }
        : b.type === "tool_use" ? { message: { role: "assistant", content: "", tool_calls: [{ function: { name: b.name, arguments: b.input } }] } }
          : {},
  );
  lines.push({ done: true, done_reason: doneReason, ...(promptTokens !== undefined ? { prompt_eval_count: promptTokens } : {}), eval_count: 20 } as never);
  return lines.map((l) => JSON.stringify({ model: "m", ...l })).join("\n") + "\n";
}

/** Ollama's REST answers, for an Ollama stand-in: the model loaded now (and its context), and its longest. */
interface OllamaSide {
  readonly model: string;
  readonly loaded: number | null;
  readonly max: number | null;
}

/** LM Studio's REST answers, for an LM Studio stand-in: the model list, and what a load does. */
interface LmStudioSide {
  readonly models: unknown;
  readonly load?: { status: number; json: unknown };
  readonly seen: { path: string; body: unknown }[];
}

async function fakeApi(turns: (string | { status: number; json: unknown })[], lmstudio?: LmStudioSide, ollama?: OllamaSide): Promise<{ url: string; server: Server; requests: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] }> {
  const requests: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (ollama && (req.url === "/api/ps" || req.url === "/api/show")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/api/ps"
          ? { models: ollama.loaded === null ? [] : [{ name: ollama.model, model: ollama.model, context_length: ollama.loaded }] }
          : { model_info: ollama.max === null ? {} : { "qwen3.context_length": ollama.max } }));
        return;
      }
      if (lmstudio && req.url?.startsWith("/api/v1/models")) {
        const text = Buffer.concat(chunks).toString("utf8");
        lmstudio.seen.push({ path: req.url, body: text ? JSON.parse(text) : null });
        const out = req.url === "/api/v1/models" ? { status: 200, json: lmstudio.models } : (lmstudio.load ?? { status: 200, json: { status: "loaded" } });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
        return;
      }
      requests.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const turn = turns[requests.length - 1];
      if (!turn) {
        res.statusCode = 500;
        res.end("no more turns");
        return;
      }
      if (typeof turn !== "string") {
        res.writeHead(turn.status, { "content-type": "application/json" });
        res.end(JSON.stringify(turn.json));
        return;
      }
      res.writeHead(200, { "content-type": req.url === "/api/chat" ? "application/x-ndjson" : "text/event-stream" });
      res.end(turn);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server, requests };
}

describe("AgentChat", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it("runs the tool loop: calls, answers every call in one message, then stops on text", async () => {
    const api = await fakeApi([
      sse([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu_1", name: "get_state", input: {} }, { type: "tool_use", id: "tu_2", name: "assess_refinement", input: {} }], "tool_use"),
      sse([{ type: "text", text: "The fit is good." }], "end_turn"),
    ]);
    server = api.server;
    const ran: string[] = [];
    const executor = {
      run: async (name: string) => {
        ran.push(name);
        return name === "assess_refinement" ? { isError: true, text: "Error: refine first" } : { isError: false, text: "{\"technique\":\"powder\"}" };
      },
    } as unknown as AgentExecutor;
    const chat = new AgentChat(executor);
    let text = "";
    let starts = 0;
    await chat.send(
      "How is the fit?",
      { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" },
      { onAssistantStart: () => starts++, onText: (d) => (text += d), onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined },
      new AbortController().signal,
    );

    expect(ran).toEqual(["get_state", "assess_refinement"]);
    expect(text).toBe("Let me look.The fit is good.");
    expect(starts).toBe(2);
    const history = chat.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const results = history[2]!.content as { type: string; tool_use_id: string; is_error?: boolean }[];
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([["tu_1", false], ["tu_2", true]]);

    // What the SDK sent: the model, the key, the tools, caching, thinking — and
    // no fallback, which is opt-in.
    const first = api.requests[0]!;
    expect(first.headers["x-api-key"]).toBe("sk-test");
    // Only context editing is on: old tool results leave the window server-side, never a skill.
    expect(first.headers["anthropic-beta"]).toBe("context-management-2025-06-27");
    expect(first.body.context_management).toMatchObject({ edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["read_skill"] }] });
    expect(first.body.model).toBe("claude-opus-5-5");
    expect(first.body.fallbacks).toBeUndefined();
    expect(first.body.stream).toBe(true);
    expect(first.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(first.body.output_config).toEqual({ effort: "high" });
    expect(first.body.cache_control).toEqual({ type: "ephemeral" });
    const tools = first.body.tools as { name: string; eager_input_streaming?: boolean }[];
    expect(tools.map((t) => t.name)).toEqual(LIVE_TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.eager_input_streaming)).toBe(true);
    const system = first.body.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    // The skills by name and description; their bodies are read on demand.
    expect(system[0]!.text).toContain("<skills>");
    expect(system[0]!.text).toContain("- my-rietveld-workflow (the Powder page's method): The user's personal powder Rietveld");
    expect(system[0]!.text).not.toContain("## The occupancy guardrail");
    // The mode follows the cached prompt: ask first unless the user chose auto.
    expect(system[1]).toEqual({ type: "text", text: expect.stringMatching(/^Mode: ask\. Every change waits for the user's approval/) });
    // The second request carries the whole history, unchanged.
    expect((api.requests[1]!.body.messages as unknown[]).length).toBe(3);
  });

  it("ends each message before its tool calls run, so its references are filled from the page as it stood", async () => {
    const api = await fakeApi([
      sse([{ type: "text", text: "At {{wR}} now; refining." }, { type: "tool_use", id: "tu_1", name: "refine", input: {} }], "tool_use"),
      sse([{ type: "text", text: "Now {{wR}}." }], "end_turn"),
    ]);
    server = api.server;
    const events: string[] = [];
    const chat = new AgentChat({ run: async (name: string) => { events.push(`run ${name}`); return { isError: false, text: "{}" }; } } as unknown as AgentExecutor);
    await chat.send(
      "refine",
      { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" },
      { onAssistantStart: () => events.push("start"), onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined, onAssistantEnd: () => events.push("end") },
      new AbortController().signal,
    );
    expect(events).toEqual(["start", "end", "run refine", "start", "end"]);
    // The model's own history keeps its references as it wrote them.
    expect((chat.history()[1]!.content as { type: string; text?: string }[])[0]!.text).toBe("At {{wR}} now; refining.");
  });

  it("sends back a grade of the fit that contradicts the engine's verdict, once, with the verdict to quote", async () => {
    const api = await fakeApi([
      sse([{ type: "text", text: "An excellent fit: nothing left to do." }], "end_turn"),
      sse([{ type: "text", text: "The engine calls it {{verdict}}: the residual still shows the impurity." }], "end_turn"),
    ]);
    server = api.server;
    const notices: string[] = [];
    const runner = { run: async () => ({ isError: false, text: "{}" }), page: () => "powder", fill: (t: string) => t.replace(/\{\{verdict\}\}/g, "poor") };
    const chat = new AgentChat(runner as unknown as AgentExecutor);
    await chat.send(
      "How good is the fit?",
      { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" },
      { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (n) => notices.push(n), onUsage: () => undefined },
      new AbortController().signal,
    );
    expect(api.requests).toHaveLength(2);
    expect(notices.join(" ")).toMatch(/"excellent".*"poor"/);
    const nudge = (api.requests[1]!.body.messages as { role: string; content: unknown }[]).at(-1)!;
    expect(String(nudge.content)).toContain("{{verdict}}");
  });

  it("sends the fallback when opted in, and says when another model answered", async () => {
    const api = await fakeApi([sse([{ type: "fallback", from: "claude-opus-5-5", to: "claude-opus-4-8" }, { type: "text", text: "ok" }], "end_turn")]);
    server = api.server;
    const notices: string[] = [];
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    await chat.send(
      "hi",
      { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high", fallback: true },
      { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t) => notices.push(t), onUsage: () => undefined },
      new AbortController().signal,
    );
    expect(String(api.requests[0]!.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(api.requests[0]!.body.fallbacks).toBe("default");
    expect(notices).toEqual(["claude-opus-5-5 declined this turn; claude-opus-4-8 answered it."]);
    // The fallback block stays in the history, verbatim, as the API requires.
    expect((chat.history()[1]!.content as { type: string }[])[0]!.type).toBe("fallback");
  });

  it("sends no fallback for a model without one, even when opted in", async () => {
    const api = await fakeApi([sse([{ type: "text", text: "ok" }], "end_turn")]);
    server = api.server;
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    await chat.send(
      "hi",
      { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-haiku-5-5", effort: "low", fallback: true },
      { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined },
      new AbortController().signal,
    );
    expect(api.requests[0]!.body.fallbacks).toBeUndefined();
    expect(api.requests[0]!.headers["anthropic-beta"]).toBe("context-management-2025-06-27");
  });

  it("answers the calls of a stopped turn so the conversation stays valid", async () => {
    const api = await fakeApi([sse([{ type: "tool_use", id: "tu_1", name: "refine", input: {} }, { type: "tool_use", id: "tu_2", name: "assess_refinement", input: {} }], "tool_use")]);
    server = api.server;
    const ctrl = new AbortController();
    const chat = new AgentChat({
      run: async () => {
        ctrl.abort(); // the user presses Stop while the first call runs
        return { isError: false, text: "{\"refined\":true}" };
      },
    } as unknown as AgentExecutor);
    await chat.send(
      "refine",
      { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" },
      { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined },
      ctrl.signal,
    );
    const last = chat.history().at(-1)!;
    expect(last.role).toBe("user");
    const results = last.content as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["tu_1", "tu_2"]);
    expect(results[1]!.is_error).toBe(true);
    expect(results[1]!.content).toMatch(/Stopped by the user/);
  });
});

describe("AgentChat on Ollama", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });
  const quiet = { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined };

  const qwen = (loaded: number | null = null, max: number | null = 40960): OllamaSide => ({ model: "qwen3:32b", loaded, max });

  it("speaks Ollama's native chat, with only plain headers, and the context it asks for", async () => {
    const api = await fakeApi([ndjson([{ type: "thinking", thinking: "Look first." }, { type: "tool_use", id: "call_1", name: "get_state", input: {} }]), ndjson([{ type: "text", text: "Fine." }])], undefined, qwen());
    server = api.server;
    let thought = "";
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{\"technique\":\"powder\"}" }) } as unknown as AgentExecutor);
    await chat.send("How is it?", { transport: "ollama", serverUrl: api.url + "/", model: "qwen3:32b", effort: "high" }, { ...quiet, onThinking: (d) => (thought += d) }, new AbortController().signal);

    expect(thought).toBe("Look first.");
    expect(api.requests.map((r) => r.path)).toEqual(["/api/chat", "/api/chat"]);
    const first = api.requests[0]!;
    for (const h of ["x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access", "x-stainless-lang"]) expect(first.headers[h]).toBeUndefined();
    expect(first.body.model).toBe("qwen3:32b");
    expect(first.body.stream).toBe(true);
    // Not loaded: the Agent's own 32k, the reply capped at the room left.
    const options = first.body.options as { num_ctx: number; num_predict: number };
    expect(options.num_ctx).toBe(32768);
    expect(options.num_predict).toBeGreaterThanOrEqual(2048);
    expect(options.num_predict).toBeLessThan(32768);
    const messages = first.body.messages as { role: string; content: string }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("<skills>");
    expect(messages[0]!.content).toMatch(/Mode: ask\. [^]*$/);
    expect(messages[1]).toEqual({ role: "user", content: "How is it?" });
    const tools = first.body.tools as { type: string; function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(LIVE_TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.type === "function")).toBe(true);
    // The tool loop runs as it does on Claude: the call is answered, then the reply.
    expect(chat.history().map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const second = api.requests[1]!.body.messages as { role: string; content: string; tool_name?: string; thinking?: string; tool_calls?: unknown[] }[];
    expect(second.slice(2)).toEqual([
      { role: "assistant", content: "", thinking: "Look first.", tool_calls: [{ function: { name: "get_state", arguments: {} } }] },
      { role: "tool", content: "{\"technique\":\"powder\"}", tool_name: "get_state" },
    ]);
  });

  it("sends the policy's temperature to a local model, and none by default (the server's)", async () => {
    const api = await fakeApi([ndjson([{ type: "text", text: "Fine." }]), ndjson([{ type: "text", text: "Fine." }])], undefined, qwen(40960));
    server = api.server;
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    await chat.send("hi", { transport: "ollama", serverUrl: api.url, model: "qwen3:32b", effort: "high" }, quiet, new AbortController().signal);
    await chat.send("hi", { transport: "ollama", serverUrl: api.url, model: "qwen3:32b", effort: "high", policy: { temperature: 0.6 } }, quiet, new AbortController().signal);
    expect(api.requests.map((r) => (r.body.options as { temperature?: number }).temperature)).toEqual([undefined, 0.6]);
  });

  it("runs at the context the model is loaded with, when it holds the Agent: no reload", async () => {
    const api = await fakeApi([ndjson([{ type: "text", text: "Fine." }])], undefined, qwen(40960));
    server = api.server;
    await new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor).send("hi", { transport: "ollama", serverUrl: api.url, model: "qwen3:32b", effort: "high" }, quiet, new AbortController().signal);
    expect((api.requests[0]!.body.options as { num_ctx: number }).num_ctx).toBe(40960);
  });

  it("asks for a longer context when the method no longer fits 32k, up to the model's maximum, and refuses past it", async () => {
    const skill = "m".repeat(70_000);
    const turns = [ndjson([{ type: "tool_use", id: "s", name: "read_skill", input: { name: "my-rietveld-workflow" } }]), ndjson([{ type: "text", text: "Read." }])];
    const run = async () => ({ isError: false, text: skill });
    const api = await fakeApi(turns, undefined, qwen(null, 131072));
    server = api.server;
    await new AgentChat({ run } as unknown as AgentExecutor).send("Read your method.", { transport: "ollama", serverUrl: api.url, model: "qwen3:32b", effort: "high" }, quiet, new AbortController().signal);
    expect(api.requests.map((r) => (r.body.options as { num_ctx: number }).num_ctx)).toEqual([32768, 57344]);
    await new Promise<void>((r) => api.server.close(() => r()));

    // A model that takes at most 40k cannot hold it: nothing is sent, and the user is told why.
    const small = await fakeApi(turns, undefined, qwen(null, 40960));
    server = small.server;
    const chat = new AgentChat({ run } as unknown as AgentExecutor);
    const err = await chat.send("Read your method.", { transport: "ollama", serverUrl: small.url, model: "qwen3:32b", effort: "high" }, quiet, new AbortController().signal).then(() => null, (e: unknown) => e);
    expect(small.requests).toHaveLength(1);
    expect((err as Error).message).toMatch(/^This conversation no longer fits the 40k-token context Ollama runs qwen3:32b with, even with the old tool results shortened\. Nothing was sent, so the model was not handed a cut prompt\. This conversation needs about \d+k tokens; qwen3:32b takes at most 40k\. Start a new conversation \(the analysis stays as it is\), or pick a model with a longer context\.$/);
  });

  it("moving the conversation to Claude drops Ollama's unsigned thinking from earlier replies", async () => {
    const local = await fakeApi([ndjson([{ type: "thinking", thinking: "unsigned" }, { type: "text", text: "Hi." }])], undefined, qwen());
    const claude = await fakeApi([sse([{ type: "text", text: "Hello again." }], "end_turn")]);
    server = local.server;
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    const signal = new AbortController().signal;
    await chat.send("hi", { transport: "ollama", serverUrl: local.url, model: "qwen3:32b", effort: "high" }, quiet, signal);
    expect((chat.history()[1]!.content as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "text"]);

    await chat.send("again", { transport: "api-key", apiKey: "sk-test", baseURL: claude.url, model: "claude-opus-5-5", effort: "high" }, quiet, signal);
    await new Promise<void>((r) => claude.server.close(() => r()));
    const sent = claude.requests[0]!.body.messages as { role: string; content: string | { type: string }[] }[];
    expect((sent[1]!.content as { type: string }[]).map((b) => b.type)).toEqual(["text"]);
  });

  it("names the missing model and how to get it", async () => {
    const api = await fakeApi([{ status: 404, json: { error: "model 'nope:1b' not found" } }], undefined, { model: "nope:1b", loaded: null, max: null });
    server = api.server;
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    const config = { transport: "ollama" as const, serverUrl: api.url, model: "nope:1b", effort: "high" as const };
    const err = await chat.send("hi", config, quiet, new AbortController().signal).then(() => null, (e: unknown) => e);
    expect(describeChatError(err, config)).toBe('Ollama has no model "nope:1b". Pull it (ollama pull nope:1b) or pick another in the Copilot settings.');
  });

  it("names a model that cannot call tools", async () => {
    const api = await fakeApi([{ status: 400, json: { error: "registry.ollama.ai/library/gemma:2b does not support tools" } }], undefined, { model: "gemma:2b", loaded: null, max: 8192 });
    server = api.server;
    const config = { transport: "ollama" as const, serverUrl: api.url, model: "gemma:2b", effort: "high" as const };
    const err = await new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor).send("hi", config, quiet, new AbortController().signal).then(() => null, (e: unknown) => e);
    // 8k cannot hold the Agent: refused before anything is sent.
    expect((err as Error).message).toMatch(/no longer fits the 8k-token context Ollama runs gemma:2b with.*gemma:2b takes at most 8k/);
    expect(api.requests).toHaveLength(0);
  });
});

/** LM Studio's list with these models (key → loaded context, or null when not loaded). */
function lmModels(models: Record<string, number | null>, max = 131072): LmStudioSide {
  return {
    models: { models: Object.entries(models).map(([key, ctx]) => ({ type: "llm", key, max_context_length: max, loaded_instances: ctx === null ? [] : [{ id: key, config: { context_length: ctx } }], capabilities: { trained_for_tool_use: true } })) },
    seen: [],
  };
}

describe("AgentChat on LM Studio", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });
  const quiet = { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined };
  const runner = { run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor;

  it("sends plain headers and only the fields a local server reads, to <server>/v1/messages", async () => {
    const api = await fakeApi([sse([{ type: "tool_use", id: "call_1", name: "get_state", input: {} }], "tool_use"), sse([{ type: "text", text: "Fine." }], "end_turn")], lmModels({ "qwen/qwen3-32b": 32768 }));
    server = api.server;
    const chat = new AgentChat(runner);
    await chat.send("How is it?", { transport: "lmstudio", serverUrl: api.url + "/", model: "qwen/qwen3-32b", effort: "high" }, quiet, new AbortController().signal);

    const first = api.requests[0]!;
    for (const h of ["x-api-key", "authorization", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access", "x-stainless-lang"]) expect(first.headers[h]).toBeUndefined();
    expect(first.body.model).toBe("qwen/qwen3-32b");
    for (const k of ["thinking", "output_config", "cache_control", "fallbacks"]) expect(first.body[k]).toBeUndefined();
    expect(chat.history().map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("moving from Ollama to LM Studio drops the other server's thinking", async () => {
    const api = await fakeApi([ndjson([{ type: "thinking", thinking: "unsigned" }, { type: "text", text: "Hi." }]), sse([{ type: "text", text: "Hello." }], "end_turn")], lmModels({ "qwen/qwen3-32b": 40960 }), { model: "qwen3:32b", loaded: null, max: 40960 });
    server = api.server;
    const chat = new AgentChat(runner);
    const signal = new AbortController().signal;
    await chat.send("hi", { transport: "ollama", serverUrl: api.url, model: "qwen3:32b", effort: "high" }, quiet, signal);
    await chat.send("again", { transport: "lmstudio", serverUrl: api.url, model: "qwen/qwen3-32b", effort: "high" }, quiet, signal);
    const sent = api.requests[1]!.body.messages as { role: string; content: string | { type: string }[] }[];
    expect((sent[1]!.content as { type: string }[]).map((b) => b.type)).toEqual(["text"]);
  });

  it("explains a context overflow and a server that wants a token", async () => {
    const config = { transport: "lmstudio" as const, model: "qwen/qwen3-8b", effort: "high" as const };
    for (const [status, json, expected] of [
      [400, { type: "error", error: { type: "invalid_request_error", message: "The number of tokens to keep from the initial prompt is greater than the context length." } }, /no longer fits the context LM Studio loaded "qwen\/qwen3-8b" with.*lms load qwen\/qwen3-8b --context-length 32768/],
      [401, { error: { message: "Invalid API token" } }, /asks for an API token/],
      [422, { error: "boom" }, /^LM Studio error 422: boom$/],
    ] as const) {
      const api = await fakeApi([{ status, json }], lmModels({ "qwen/qwen3-8b": 32768 }));
      server = api.server;
      const chat = new AgentChat(runner);
      const err = await chat.send("hi", { ...config, serverUrl: api.url }, quiet, new AbortController().signal).then(() => null, (e: unknown) => e);
      expect(describeChatError(err, config)).toMatch(expected);
      await new Promise<void>((r) => api.server.close(() => r()));
      server = null;
    }
  });

  it("loads a model that is not loaded with a 32k context before the first message, and says so", async () => {
    const side = lmModels({ "qwen/qwen3-32b": null });
    const api = await fakeApi([sse([{ type: "text", text: "Fine." }], "end_turn")], side);
    server = api.server;
    const notices: string[] = [];
    await new AgentChat(runner).send("hi", { transport: "lmstudio", serverUrl: api.url, model: "qwen/qwen3-32b", effort: "high" }, { ...quiet, onNotice: (t) => notices.push(t) }, new AbortController().signal);
    expect(side.seen.map((x) => x.path)).toEqual(["/api/v1/models", "/api/v1/models/load"]);
    expect(side.seen[1]!.body).toEqual({ model: "qwen/qwen3-32b", context_length: 32768 });
    expect(notices).toEqual(["Loaded qwen/qwen3-32b in LM Studio with a 32k context."]);
    expect(api.requests).toHaveLength(1);
  });

  it("will not send to a copy loaded with too little context, and says how to reload it", async () => {
    const side = lmModels({ "qwen/qwen3-32b": 4096 });
    const api = await fakeApi([sse([{ type: "text", text: "never" }], "end_turn")], side);
    server = api.server;
    const config = { transport: "lmstudio" as const, serverUrl: api.url, model: "qwen/qwen3-32b", effort: "high" as const };
    const err = await new AgentChat(runner).send("hi", config, quiet, new AbortController().signal).then(() => null, (e: unknown) => e);
    expect(describeChatError(err, config)).toMatch(/loaded with 4k tokens of context.*lms unload qwen\/qwen3-32b && lms load qwen\/qwen3-32b --context-length 32768/);
    expect(api.requests).toHaveLength(0);
    expect(side.seen.map((x) => x.path)).toEqual(["/api/v1/models"]);
  });
});

describe("a reply that repeats itself", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it("finds the repeating phrase, and leaves ordinary text alone", () => {
    expect(repeatingTail("Let me refine. " + "(Actually, I'll call refine())\n\n".repeat(7))).toBe("(Actually, I'll call refine())");
    expect(repeatingTail("(Actually, I'll call refine()) ".repeat(4))).toBeNull();
    expect(repeatingTail("-".repeat(400))).toBeNull();
    expect(repeatingTail("The scale converged; the background terms are stable; the cell moved by 0.002 Å, well within its esd. Next, positions.")).toBeNull();
  });

  it("stops the turn, keeps the history valid, and says why", async () => {
    const loop = "I will now refine the scale. " + "(Actually, I'll call refine())\n\n".repeat(40);
    const api = await fakeApi([ndjson([{ type: "text", text: loop }]), ndjson([{ type: "text", text: "OK." }])], undefined, { model: "qwen3:8b", loaded: null, max: 40960 });
    server = api.server;
    const notices: string[] = [];
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    const quiet = { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t: string) => notices.push(t), onUsage: () => undefined };
    const config = { transport: "ollama" as const, serverUrl: api.url, model: "qwen3:8b", effort: "high" as const };
    await chat.send("Refine it.", config, quiet, new AbortController().signal);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^The model started repeating itself \("\(Actually, I'll call refine\(\)\)"\), so this turn was stopped\. Local models/);
    const history = chat.history();
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((history[1]!.content as { text: string }[])[0]!.text).toBe("I will now refine the scale. (Actually, I'll call refine())");
    // The conversation goes on.
    await chat.send("Go on.", config, quiet, new AbortController().signal);
    expect(chat.history().map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("a reply that stalls", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });
  const names = LIVE_TOOLS.map((t) => t.name);

  it("knows a promise to act from a real stop", () => {
    const gate = "According to your method, we must first pass the Le Bail gate. I will start by running the check_cell_symmetry tool.\n\nIf this passes, we move to Stage 1.\n\nStarting the Le Bail gate now.";
    expect(announcedTool(gate, names)).toBe("check_cell_symmetry");
    expect(announcedTool("(Actually, I'll call refine())", names)).toBe("refine");
    // Stopping at a gate for the user, or asking, is not a stall.
    expect(announcedTool("The cell gate passed. Next I would free the positions — shall I go on?", names)).toBeNull();
    expect(announcedTool("The scale and background are stable (wR 7.6%). I'll stop here so you can look at the residual before we free the atoms.", names)).toBeNull();
    expect(announcedTool("The fit converged at wR 4.0%, GoF 1.3. assess_refinement finds nothing to fix.", names)).toBeNull();
  });

  it("knows waiting on a tool that already answered, or an empty reply after a result", () => {
    const waited = stalledReply("I apologize for the pause. I was waiting for the check_cell_symmetry tool to complete its analysis, as it performs a complex Le Bail fit.", names, ["check_cell_symmetry"]);
    expect(waited!.nudge).toMatch(/check_cell_symmetry already finished; its result is the tool result above/);
    expect(stalledReply("I'll wait for your go-ahead before refining the atoms.", names, ["check_cell_symmetry"])).toBeNull();
    expect(stalledReply("", names, ["refine"])!.notice).toMatch(/said nothing after the refine result/);
    expect(stalledReply("", names, [])).toBeNull();
  });

  it("asks a model that went quiet after a tool result to go on", async () => {
    const api = await fakeApi([
      sse([{ type: "text", text: "Running the Le Bail gate." }, { type: "tool_use", id: "c1", name: "check_cell_symmetry", input: {} }], "tool_use"),
      sse([], "end_turn"),
      sse([{ type: "text", text: "Every peak indexes in I 2₁ 3; the gate passes." }], "end_turn"),
    ]);
    server = api.server;
    const notices: string[] = [];
    let text = "";
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{\"passed\":true}" }) } as unknown as AgentExecutor);
    await chat.send("Check the cell.", { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" }, {
      onAssistantStart: () => undefined, onText: (d) => (text += d), onThinking: () => undefined, onNotice: (t) => notices.push(t), onUsage: () => undefined,
    }, new AbortController().signal);
    expect(notices).toEqual(["The model said nothing after the check_cell_symmetry result; the app asked it to go on."]);
    expect(text).toMatch(/the gate passes\.$/);
    const third = api.requests[2]!.body.messages as { role: string; content: unknown }[];
    expect(third.at(-1)).toEqual({ role: "user", content: expect.stringMatching(/^\(From the app, not the user\.\) You replied with nothing after the check_cell_symmetry result/) });
  });

  it("asks for the call a reply promised, once, and never more than twice per message", async () => {
    const promise = sse([{ type: "text", text: "I will start by running check_cell_symmetry.\n\nStarting the Le Bail gate now." }], "end_turn");
    const api = await fakeApi([promise, promise, promise, promise]);
    server = api.server;
    const notices: string[] = [];
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    await chat.send("Check the cell.", { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" }, {
      onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t) => notices.push(t), onUsage: () => undefined,
    }, new AbortController().signal);
    expect(api.requests).toHaveLength(3);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/said it would run check_cell_symmetry but made no tool call/);
  });
});

describe("auto mode", () => {
  it("tells the model to work through the stages on its own", async () => {
    const api = await fakeApi([sse([{ type: "text", text: "On it." }], "end_turn")]);
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    await chat.send("Refine it.", { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high", autonomy: "auto" }, {
      onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined,
    }, new AbortController().signal);
    await new Promise<void>((r) => api.server.close(() => r()));
    const system = api.requests[0]!.body.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]!.text).toMatch(/^Mode: auto\. .*while it converges sensibly go on to the next\. Stop and report when a stage fails/);
  });
});

describe("the loop guard", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });
  const quiet = (notices: string[]) => ({ onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t: string) => notices.push(t), onUsage: () => undefined });
  const model = (url: string) => ({ transport: "api-key" as const, apiKey: "sk-test", baseURL: url, model: "qwen/qwen3.8-27b", effort: "high" as const });

  it("notes a call repeated at the same state, refuses the third, and tells a changed state apart", () => {
    const g = new LoopGuard({ countStill: true });
    expect(g.record("get_state", {}, '{"ref":"#1","wR":8}', "s1", "s1")).toEqual({ note: null, stop: null });
    // The same call, the same state, the same answer (only the ref differs): a repeat.
    const again = g.record("get_state", {}, '{"ref":"#2","wR":8}', "s1", "s1");
    expect(again.note).toMatch(/^\(From the app, not the user\.\) You already made this call \(get_state, the same input\) and nothing has changed since/);
    expect(again.stop).toBeNull();
    expect(g.check("get_state", {}, "s1")).toMatchObject({ why: "it called get_state 3 times with the same input, and nothing changed in between" });
    // After a change, the same call is a new one.
    expect(g.check("get_state", {}, "s2")).toBeNull();
    expect(g.record("get_state", {}, '{"ref":"#3","wR":7}', "s2", "s2").note).toBeNull();
    // Inputs compare by value, whatever their key order.
    expect(g.record("set_free", { free: ["a"], fix: ["b"] }, "{}", "s2", "s3").note).toBeNull();
    expect(g.record("set_free", { fix: ["b"], free: ["a"] }, "{}", "s3", "s3").note).toBeNull();
  });

  it("without a fingerprint, a repeat is the same call with the same answer", () => {
    const g = new LoopGuard();
    g.record("read_skill", { name: "m" }, "Skill m", null, null);
    expect(g.record("read_skill", { name: "m" }, "Skill m", null, null).note).toMatch(/The skill is already in this conversation\./);
    expect(g.record("read_skill", { name: "m" }, "Skill m", null, null).stop).toBe("it called read_skill 3 times with the same input, and nothing changed in between");
  });

  it("does not count calls that change nothing for Claude, nor reading refs and skills for anyone", () => {
    const claude = new LoopGuard({ countStill: false });
    expect(Array.from({ length: 30 }, (_, i) => claude.record("reflection_equivalents", { h: i }, `{"n":${i}}`, "s", "s")).every((o) => o.stop === null && o.note === null)).toBe(true);
    const local = new LoopGuard({ countStill: true });
    const pages = Array.from({ length: 30 }, (_, i) => local.record("read_ref", { ref: "#3", start: i * 100 }, `page ${i}`, "s", "s"));
    expect(pages.every((o) => o.stop === null && o.note === null)).toBe(true);
  });

  it("counts only reads toward a stall: notes, reports and change attempts are work", () => {
    const g = new LoopGuard({ countStill: true });
    // A wrap-up as qwen3.8-27b did it on the PDF page: scans, notes, the table, reports.
    const calls: [string, Record<string, unknown>][] = [
      ...Array.from({ length: 3 }, (_, i): [string, Record<string, unknown>] => ["boxcar_scan", { width: 2 + i }]),
      ...Array.from({ length: 8 }, (_, i): [string, Record<string, unknown>] => ["write_note", { text: `n${i}` }]),
      ["structure_table", {}],
      ...Array.from({ length: 3 }, (_, i): [string, Record<string, unknown>] => ["write_report", { summary: `r${i}` }]),
      ...Array.from({ length: 6 }, (_, i): [string, Record<string, unknown>] => ["refine", { i }]),
    ];
    expect(calls.map(([n, input], i) => g.record(n, input, `{"n":${i}}`, "s", "s")).every((o) => o.stop === null && o.note === null)).toBe(true);
  });

  it("tells the model once when the twelfth call that changes nothing is a repeat", () => {
    const g = new LoopGuard({ countStill: true });
    for (let i = 0; i < 11; i++) g.record("reflection_equivalents", { h: i }, `{"n":${i}}`, "s", "s");
    // The twelfth repeats the eleventh: its note is the repeat's; the next call gets the stall note.
    expect(g.record("reflection_equivalents", { h: 10 }, '{"n":10}', "s", "s").note).toMatch(/You already made this call/);
    expect(g.record("reflection_equivalents", { h: 12 }, '{"n":12}', "s", "s").note).toMatch(/13 tool calls in a row|12 tool calls in a row/);
  });

  it("stops when call after call changes nothing, and tells the model first", () => {
    const g = new LoopGuard({ countStill: true });
    const outs = Array.from({ length: 20 }, (_, i) => g.record("reflection_equivalents", { h: i, k: 0, l: 0 }, `{"n":${i}}`, "s", "s"));
    expect(outs[11]!.note).toMatch(/12 tool calls in a row have not changed the analysis/);
    expect(outs.slice(0, 19).every((o) => o.stop === null)).toBe(true);
    expect(outs[19]!.stop).toBe("it made 20 tool calls in a row without changing the analysis");
  });

  it("stops the user's loop — the method and the state read again and again — and says where the analysis stands", async () => {
    // As qwen3.8-27b did on the user's data: read_skill and get_state, turn after turn, nothing else.
    const turn = (n: number) => sse([{ type: "tool_use", id: `s${n}`, name: "read_skill", input: { name: "my-rietveld-workflow" } }, { type: "tool_use", id: `g${n}`, name: "get_state", input: {} }], "tool_use");
    const api = await fakeApi(Array.from({ length: 10 }, (_, i) => turn(i)));
    server = api.server;
    const ran: string[] = [];
    const runner = {
      run: async (name: string) => {
        ran.push(name);
        return { isError: false, text: name === "read_skill" ? "Skill my-rietveld-workflow\n\n# My Rietveld workflow" : `{"ref":"#${ran.length}","technique":"powder"}` };
      },
      situation: () => ({ page: "powder", stage: "base", stagesDone: [], magnetic: false, fingerprint: "unchanged", summary: "the powder page; done: Fit range; next: Scale, background, cell; no refinement on screen yet." }),
    };
    const notices: string[] = [];
    const chat = new AgentChat(runner as unknown as AgentExecutor);
    await chat.send("Can you refine the structure for me?", model(api.url), quiet(notices), new AbortController().signal);
    // Two rounds ran; the third round's calls did not, and the model was not asked again.
    expect(ran).toEqual(["read_skill", "get_state", "read_skill", "get_state"]);
    expect(api.requests).toHaveLength(3);
    expect(notices).toEqual([
      "The Copilot was going in circles: it called read_skill 3 times with the same input, and nothing changed in between, so the app stopped it here. Where it stands: the powder page; done: Fit range; next: Scale, background, cell; no refinement on screen yet. Tell it the next step to take (for example \"free the atomic positions and refine\"), or start a new conversation if it has lost track.",
    ]);
    // The second round's results said so; every call of the last round is answered, so the conversation goes on.
    const history = chat.history();
    const second = history[4]!.content as { content: string }[];
    expect(second.every((r) => /You already made this call/.test(r.content))).toBe(true);
    const last = history.at(-1)!.content as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(last.map((r) => [r.tool_use_id, r.is_error])).toEqual([["s2", true], ["g2", true]]);
    expect(last[0]!.content).toMatch(/Not run: read_skill already ran 2 times with this input, and nothing has changed since/);
  });

  it("lets a call run again once the analysis changed", async () => {
    const api = await fakeApi([
      sse([{ type: "tool_use", id: "r1", name: "refine", input: {} }], "tool_use"),
      sse([{ type: "tool_use", id: "r2", name: "refine", input: {} }], "tool_use"),
      sse([{ type: "tool_use", id: "r3", name: "refine", input: {} }], "tool_use"),
      sse([{ type: "text", text: "Converged." }], "end_turn"),
    ]);
    server = api.server;
    let step = 0;
    const runner = {
      run: async () => ({ isError: false, text: `{"refined":true,"wR":${10 - ++step}}` }),
      situation: () => ({ page: "powder", stage: "base", stagesDone: [], magnetic: false, fingerprint: `step ${step}`, summary: "" }),
    };
    const notices: string[] = [];
    const chat = new AgentChat(runner as unknown as AgentExecutor);
    await chat.send("Refine.", model(api.url), quiet(notices), new AbortController().signal);
    expect(step).toBe(3);
    expect(notices).toEqual([]);
    expect(JSON.stringify(chat.history())).not.toMatch(/You already made this call/);
  });

  it("stops the loop on the real executor and page, with the stage it was at", async () => {
    const turn = (n: number) => sse([{ type: "tool_use", id: `g${n}`, name: "get_state", input: {} }], "tool_use");
    const api = await fakeApi(Array.from({ length: 6 }, (_, i) => turn(i)));
    server = api.server;
    const { ex } = executor(fakeHost(powderPage(mn3gaSession())).host);
    const notices: string[] = [];
    const chat = new AgentChat(ex);
    await chat.send("Refine it.", model(api.url), quiet(notices), new AbortController().signal);
    expect(api.requests).toHaveLength(3);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^The Copilot was going in circles: it called get_state 3 times with the same input, and nothing changed in between, so the app stopped it here\. Where it stands: the powder page; done: nothing yet; next: Fit range; no refinement on screen yet\./);
  });
});

describe("a local model's window", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });
  const quiet = (notices: string[]) => ({ onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t: string) => notices.push(t), onUsage: () => undefined });
  const fixed = 70_000; // about the system prompt and every tool, in characters

  it("prunes the history to what the window leaves, and caps the reply at the room left", () => {
    const big = Array.from({ length: 30 }, (_, i): BetaMessageParam[] => [
      { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "get_state", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: JSON.stringify({ ref: `#${i}`, wR: 9, pad: "x".repeat(6000) }) }] },
    ]).flat();
    const fit = fitWindow([{ role: "user", content: "Refine it." }, ...big], 20_000, 32_768, CHARS_PER_TOKEN);
    expect(fit.refusal).toBeNull();
    expect(fit.estimate + MIN_REPLY).toBeLessThanOrEqual(32_768);
    expect(fit.maxTokens).toBe(32_768 - fit.estimate);
    expect(32_768 - fit.estimate).toBeGreaterThanOrEqual(REPLY_RESERVE - 400);
  });

  it("refuses, and says why, when even the most pruned history cannot fit", () => {
    const skill: BetaMessageParam[] = [
      { role: "user", content: "Refine it." },
      { role: "assistant", content: [{ type: "tool_use", id: "s", name: "read_skill", input: { name: "my-rietveld-workflow" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "s", content: "m".repeat(60_000) }] },
    ];
    const fit = fitWindow(skill, fixed, 32_768, CHARS_PER_TOKEN);
    expect(fit.refusal!({ transport: "lmstudio", model: "qwen/qwen3.8-27b" })).toMatch(/^This conversation no longer fits the 32k-token context LM Studio runs qwen\/qwen3\.8-27b with, even with the old tool results shortened: it needs about \d+k \(the instructions and tools alone about 23k\)\. Nothing was sent, so the model was not handed a cut prompt\. Start a new conversation, or give the model a longer context \(lms unload qwen\/qwen3\.8-27b && lms load qwen\/qwen3\.8-27b --context-length 65536\)\.$/);
  });

  /** An LM Studio stand-in that counts each prompt as a server does (3.7 characters a token), or cuts the n-th. */
  async function countingServer(turns: string[], cutAt: number | null): Promise<{ url: string; server: Server; sizes: { tokens: number; max: number }[] }> {
    const sizes: { tokens: number; max: number }[] = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url?.startsWith("/api/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{ type: "llm", key: "qwen/qwen3.8-27b", max_context_length: 262144, loaded_instances: [{ id: "q", config: { context_length: 32768 } }], capabilities: { trained_for_tool_use: true } }] }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { system: string; tools: unknown; messages: unknown; max_tokens: number };
        const tokens = Math.round((body.system.length + JSON.stringify(body.tools).length + JSON.stringify(body.messages).length) / 3.7);
        sizes.push({ tokens, max: body.max_tokens });
        const turn = turns[sizes.length - 1] ?? sse([{ type: "text", text: "Done." }], "end_turn");
        const counted = sizes.length - 1 === cutAt ? 7000 : tokens;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(turn.replace('"input_tokens":100', `"input_tokens":${counted}`).replace('"cache_read_input_tokens":80', '"cache_read_input_tokens":0'));
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const addr = s.address();
    return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server: s, sizes };
  }

  it("never sends LM Studio more than its loaded context, however long the analysis runs", async () => {
    // Twenty-four rounds of large results, each a new call (no loop): without pruning to the window this passes 32k by the fourth.
    const turns = Array.from({ length: 24 }, (_, i) => sse([{ type: "tool_use", id: `c${i}`, name: "reflection_equivalents", input: { h: i, k: 0, l: 0 } }], "tool_use"));
    const api = await countingServer(turns, null);
    server = api.server;
    const runner = { run: async (_: string, input: { h: number }) => ({ isError: false, text: JSON.stringify({ ref: `#${input.h}`, h: input.h, pad: "x".repeat(7000) }) }) };
    const notices: string[] = [];
    await new AgentChat(runner as unknown as AgentExecutor).send("Compare them.", { transport: "lmstudio", serverUrl: api.url, model: "qwen/qwen3.8-27b", effort: "high" }, quiet(notices), new AbortController().signal);
    expect(api.sizes).toHaveLength(25);
    for (const s of api.sizes) {
      expect(s.tokens + MIN_REPLY).toBeLessThanOrEqual(32_768);
      expect(s.tokens + s.max).toBeLessThanOrEqual(32_768);
    }
    expect(notices).toEqual([]);
  });

  it("says so when the server cut the prompt after all, and runs nothing the reply asked for", async () => {
    const turns = [
      sse([{ type: "tool_use", id: "a", name: "get_state", input: {} }], "tool_use"),
      sse([{ type: "tool_use", id: "a2", name: "assess_refinement", input: {} }], "tool_use"),
      sse([{ type: "tool_use", id: "b", name: "refine", input: {} }], "tool_use"),
    ];
    // Two whole counts first: the server is known to count whole prompts; then a cut one.
    const api = await countingServer(turns, 2);
    server = api.server;
    const ran: string[] = [];
    const runner = { run: async (name: string) => (ran.push(name), { isError: false, text: "{}" }) };
    const notices: string[] = [];
    const chat = new AgentChat(runner as unknown as AgentExecutor);
    await chat.send("Refine it.", { transport: "lmstudio", serverUrl: api.url, model: "qwen/qwen3.8-27b", effort: "high" }, quiet(notices), new AbortController().signal);
    expect(ran).toEqual(["get_state", "assess_refinement"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^The server read only 7,000 of about [\d,]+ prompt tokens: it cut the prompt, so this reply did not see all of its instructions and the conversation, and nothing it asked for was run\./);
    const last = chat.history().at(-1)!.content as { tool_use_id: string; is_error: boolean }[];
    expect(last).toEqual([expect.objectContaining({ tool_use_id: "b", is_error: true })]);
  });

  it("reads LM Studio's count as it gives it: the whole prompt as the input, the cached part again beside it", async () => {
    const turns = Array.from({ length: 4 }, (_, i) => sse([{ type: "tool_use", id: `t${i}`, name: "reflection_equivalents", input: { h: i, k: 0, l: 0 } }], "tool_use"));
    const sizes: { tokens: number; max: number }[] = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url?.startsWith("/api/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{ type: "llm", key: "q", max_context_length: 262144, loaded_instances: [{ id: "q", config: { context_length: 32768 } }], capabilities: { trained_for_tool_use: true } }] }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { system: string; tools: unknown; messages: unknown; max_tokens: number };
        const tokens = Math.round((body.system.length + JSON.stringify(body.tools).length + JSON.stringify(body.messages).length) / 3.7);
        sizes.push({ tokens, max: body.max_tokens });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end((turns[sizes.length - 1] ?? sse([{ type: "text", text: "Done." }], "end_turn")).replace('"input_tokens":100', `"input_tokens":${tokens}`).replace('"cache_read_input_tokens":80', `"cache_read_input_tokens":${Math.round(tokens * 0.9)}`));
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    server = s;
    const addr = s.address();
    const runner = { run: async (_: string, input: { h: number }) => ({ isError: false, text: JSON.stringify({ h: input.h, pad: "x".repeat(3000) }) }) };
    await new AgentChat(runner as unknown as AgentExecutor).send("Compare.", { transport: "lmstudio", serverUrl: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, model: "q", effort: "high" }, quiet([]), new AbortController().signal);
    // Calibrated on the whole prompt, not on it counted twice: the reply keeps the room the window leaves.
    const last = sizes.at(-1)!;
    expect(last.max).toBeGreaterThan(32768 - 1.25 * last.tokens);
  });

  it("never calls a cache hit a cut, on a server that counts only what it had not cached", async () => {
    // Its first, cold request counts the whole prompt; every later one only the new tokens.
    const turns = Array.from({ length: 4 }, (_, i) => sse([{ type: "tool_use", id: `t${i}`, name: "reflection_equivalents", input: { h: i, k: 0, l: 0 } }], "tool_use"));
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url?.startsWith("/api/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{ type: "llm", key: "q", max_context_length: 262144, loaded_instances: [{ id: "q", config: { context_length: 32768 } }], capabilities: { trained_for_tool_use: true } }] }));
          return;
        }
        const n = served++;
        const body = Buffer.concat(chunks).toString("utf8");
        const counted = n === 0 ? Math.round(body.length / 3.7) : 300;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end((turns[n] ?? sse([{ type: "text", text: "Done." }], "end_turn")).replace('"input_tokens":100', `"input_tokens":${counted}`).replace('"cache_read_input_tokens":80', '"cache_read_input_tokens":0'));
      });
    });
    let served = 0;
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    server = s;
    const addr = s.address();
    const notices: string[] = [];
    const runner = { run: async () => ({ isError: false, text: "{\"h\":1}" }) };
    await new AgentChat(runner as unknown as AgentExecutor).send("Compare.", { transport: "lmstudio", serverUrl: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, model: "q", effort: "high" }, quiet(notices), new AbortController().signal);
    expect(notices).toEqual([]);
    expect(served).toBe(5);
  });
});

describe("the tools a request offers", () => {
  it("a local model gets the page's and the stage's tools, and grows them as it goes; Claude gets every one", async () => {
    const runner = {
      run: async () => ({ isError: false, text: "{}" }),
      situation: () => ({ page: "powder", stage: "range", stagesDone: [], magnetic: false, fingerprint: String(Math.random()), summary: "" }),
    } as unknown as AgentExecutor;
    const local = await fakeApi([ndjson([{ type: "tool_use", id: "a", name: "check_cell_symmetry", input: {} }]), ndjson([{ type: "text", text: "Done." }])], undefined, { model: "qwen3:32b", loaded: null, max: 40960 });
    const quiet = { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined };
    await new AgentChat(runner).send("Check the cell.", { transport: "ollama", serverUrl: local.url, model: "qwen3:32b", effort: "high" }, quiet, new AbortController().signal);
    await new Promise<void>((r) => local.server.close(() => r()));
    const offered = local.requests.map((r) => (r.body.tools as { function: { name: string } }[]).map((t) => t.function.name));
    const powder = LIVE_TOOLS.filter((t) => t.pages.includes("powder")).length;
    expect(offered[0]!.length).toBeLessThan(powder / 2);
    expect(offered[0]).toEqual(expect.arrayContaining(["get_state", "read_skill", "check_fit_range", "set_fit_range", "refine"]));
    // The user's words asked for the cell check, and once used it stays.
    expect(offered[0]).toContain("check_cell_symmetry");
    expect(offered[1]).toContain("check_cell_symmetry");
    expect(((local.requests[0]!.body.messages as { content: string }[])[0]!.content)).toMatch(/Tools: you are offered the tools of the page and of the method's current stage/);

    const claude = await fakeApi([sse([{ type: "text", text: "Done." }], "end_turn")]);
    await new AgentChat(runner).send("Check the cell.", { transport: "api-key", apiKey: "sk", baseURL: claude.url, model: "claude-opus-5-5", effort: "high" }, quiet, new AbortController().signal);
    await new Promise<void>((r) => claude.server.close(() => r()));
    expect((claude.requests[0]!.body.tools as { name: string }[]).map((t) => t.name)).toEqual(LIVE_TOOLS.map((t) => t.name));
  });
});

describe("a turn that fails part-way keeps the conversation valid", () => {
  const quiet = (notices: string[]) => ({ onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t: string) => notices.push(t), onUsage: () => undefined });

  it("answers a call whose tool threw with an error, and goes on", async () => {
    const api = await fakeApi([sse([{ type: "tool_use", id: "x", name: "get_state", input: {} }], "tool_use"), sse([{ type: "text", text: "The page could not be read." }], "end_turn")]);
    const chat = new AgentChat({ run: async () => { throw new Error("chunk failed to load"); } } as unknown as AgentExecutor);
    await chat.send("How is it?", { transport: "api-key", apiKey: "sk", baseURL: api.url, model: "claude-opus-5-5", effort: "high" }, quiet([]), new AbortController().signal);
    await new Promise<void>((r) => api.server.close(() => r()));
    const results = chat.history()[2]!.content as { tool_use_id: string; is_error: boolean; content: string }[];
    expect(results).toEqual([{ type: "tool_result", tool_use_id: "x", is_error: true, content: "Error: the tool failed to run: chunk failed to load" }]);
    expect(chat.history().map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("answers the calls of a declined reply", async () => {
    const api = await fakeApi([sse([{ type: "tool_use", id: "y", name: "refine", input: {} }], "refusal"), sse([{ type: "text", text: "OK." }], "end_turn")]);
    const notices: string[] = [];
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    const config = { transport: "api-key" as const, apiKey: "sk", baseURL: api.url, model: "claude-opus-5-5", effort: "high" as const };
    await chat.send("Refine.", config, quiet(notices), new AbortController().signal);
    expect(notices).toEqual(["The model declined to continue this request."]);
    expect(chat.history().at(-1)!.content).toEqual([{ type: "tool_result", tool_use_id: "y", content: "Not run: the model declined to continue this request.", is_error: true }]);
    // The next message is accepted: every tool_use has its result.
    await chat.send("Go on.", config, quiet(notices), new AbortController().signal);
    await new Promise<void>((r) => api.server.close(() => r()));
    expect(chat.history().map((m) => m.role)).toEqual(["user", "assistant", "user", "user", "assistant"]);
  });

  it("does not take an ordinary stop for a promise to act", () => {
    const names = LIVE_TOOLS.map((t) => t.name);
    // "for now" is a stop, and "refine" is not a word of "refinement".
    expect(announcedTool("The scale, background and cell refinement converged at wR 8.3 %. I'll keep the occupancies fixed for now.", names)).toBeNull();
    // A summary of what is left, with no one acting on it.
    expect(announcedTool("Scale, background and cell are refined. Positions next.", names)).toBeNull();
    // Still caught: an action in the first person.
    expect(announcedTool("The cell checks out. I'll refine the positions now.", names)).toBe("refine");
    expect(announcedTool("Let me run check_cell_symmetry.", names)).toBe("check_cell_symmetry");
  });
});

describe("a local model at work", () => {
  it("gets twice Claude's turns, and is told how to get out of refused refinements", async () => {
    const refine = (n: number) => sse([{ type: "tool_use", id: `r${n}`, name: "refine", input: {} }], "tool_use");
    const free = (n: number) => sse([{ type: "tool_use", id: `f${n}`, name: "set_free", input: { fix: [`p${n}`] } }], "tool_use");
    // Free, refine (refused), three times; then 50 more rounds of real changes.
    const turns = [free(0), refine(0), free(1), refine(1), free(2), refine(2), ...Array.from({ length: 50 }, (_, i) => free(10 + i))];
    const api = await fakeApi(turns);
    let step = 0;
    const runner = {
      run: async (name: string) => (name === "refine" ? { isError: true, text: "Error: Not refined: the free set holds parameters the data cannot separate." } : { isError: false, text: `{"step":${++step}}` }),
      situation: () => ({ page: "powder", stage: "base", stagesDone: [], magnetic: false, fingerprint: `s${step}`, summary: "" }),
    } as unknown as AgentExecutor;
    const notices: string[] = [];
    const chat = new AgentChat(runner);
    await chat.send("Refine it.", { transport: "api-key", apiKey: "sk", baseURL: api.url, model: "claude-opus-5-5", effort: "high", toolScope: "all" }, { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t) => notices.push(t), onUsage: () => undefined }, new AbortController().signal);
    await new Promise<void>((r) => api.server.close(() => r()));
    const results = chat.history().filter((m) => m.role === "user" && typeof m.content !== "string").flatMap((m) => m.content as { content: string }[]);
    expect(results.filter((r) => /3 refinements in a row were refused\. Go back to the last free set that refined/.test(r.content))).toHaveLength(1);
    // Claude: 40 turns, then the cap.
    expect(api.requests).toHaveLength(40);
    expect(notices.at(-1)).toBe('Stopped after 40 model turns for one message. Say "continue" to go on.');
  });
});

describe("a long local session's last resorts", () => {
  it("calls a sampler at the same state with the same input a repeat, though each draw differs", () => {
    const g = new LoopGuard({ countStill: true });
    const input = { compare: [["mom_Co1_0", "mom_Co1_1"]] };
    expect(g.record("sample_posterior", input, '{"p":0.61}', "s", "s").note).toBeNull();
    expect(g.record("sample_posterior", input, '{"p":0.58}', "s", "s").note).toMatch(/You already made this call \(sample_posterior/);
    expect(g.check("sample_posterior", input, "s")).not.toBeNull();
    // A deterministic read whose answer changed is not one.
    g.record("get_state", {}, '{"notes":1}', "s", "s");
    expect(g.record("get_state", {}, '{"notes":2}', "s", "s").note).toBeNull();
  });

  it("offers only the stage's tools when every tool used no longer fits", async () => {
    const powder = LIVE_TOOLS.filter((t) => t.pages.includes("powder")).map((t) => t.name);
    // The model calls every powder tool once: each stays offered from then on.
    const api = await fakeApi([ndjson(powder.map((name) => ({ type: "tool_use" as const, id: name, name, input: {} }))), ndjson([{ type: "text", text: "Done." }])], undefined, { model: "m", loaded: null, max: 20480 });
    const runner = {
      run: async () => ({ isError: false, text: "{}" }),
      situation: () => ({ page: "powder", stage: "adp", stagesDone: [], magnetic: false, fingerprint: String(Math.random()), summary: "" }),
    } as unknown as AgentExecutor;
    const notices: string[] = [];
    await new AgentChat(runner).send("Do everything.", { transport: "ollama", serverUrl: api.url, model: "m", effort: "high" }, { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: (t) => notices.push(t), onUsage: () => undefined }, new AbortController().signal);
    await new Promise<void>((r) => api.server.close(() => r()));
    expect(api.requests).toHaveLength(2);
    const offered = api.requests.map((r) => (r.body.tools as unknown[]).length);
    expect(offered[1]).toBeLessThan(powder.length / 2);
    expect(notices.filter((n) => /no longer fits/.test(n))).toEqual([]);
  });
});

describe("a refusal that says what would fit", () => {
  it("names the reload LM Studio's model takes, with nothing sent", async () => {
    const side = lmModels({ "qwen/qwen3.8-27b": 32768 });
    const api = await fakeApi([sse([{ type: "tool_use", id: "s", name: "read_skill", input: { name: "my-rietveld-workflow" } }], "tool_use"), sse([{ type: "text", text: "never" }], "end_turn")], side);
    const config = { transport: "lmstudio" as const, serverUrl: api.url, model: "qwen/qwen3.8-27b", effort: "high" as const };
    const runner = { run: async () => ({ isError: false, text: "m".repeat(90_000) }) } as unknown as AgentExecutor;
    const err = await new AgentChat(runner).send("Read your method.", config, { onAssistantStart: () => undefined, onText: () => undefined, onThinking: () => undefined, onNotice: () => undefined, onUsage: () => undefined }, new AbortController().signal).then(() => null, (e: unknown) => e);
    await new Promise<void>((r) => api.server.close(() => r()));
    expect(api.requests).toHaveLength(1);
    expect(describeChatError(err, config)).toMatch(/^This conversation no longer fits the 32k-token context LM Studio runs qwen\/qwen3\.8-27b with, even with the old tool results shortened\. Nothing was sent, so the model was not handed a cut prompt\. This conversation needs about \d+k tokens; qwen\/qwen3\.8-27b takes up to 128k, if this machine has the memory for it\. Reload it at \d+k in LM Studio/);
  });
});

describe("the run policy", () => {
  it("is the app's choice for each transport, said in full, and takes the overrides a run sets", () => {
    const claude = runPolicy({ transport: "api-key", model: "m", effort: "high" }, null);
    expect(claude).toEqual({ turnCap: 40, toolScope: "all", pruning: "server", stallStop: false, temperature: null, replyCap: 64000, thinking: "adaptive" });
    const local = runPolicy({ transport: "lmstudio", model: "m", effort: "high" }, 32768);
    expect(local).toEqual({ turnCap: 80, toolScope: "stage", pruning: "digest", stallStop: true, temperature: null, replyCap: 64000, thinking: "model" });
    // An OpenAI-compatible server: every tool only in a large window, and its replies capped.
    expect(runPolicy({ transport: "openai-compatible", model: "m", effort: "high" }, 200_000)).toMatchObject({ toolScope: "all", replyCap: 16384 });
    expect(runPolicy({ transport: "openai-compatible", model: "m", effort: "high" }, 32768).toolScope).toBe("stage");
    expect(runPolicy({ transport: "ollama", model: "m", effort: "high", toolScope: "all", policy: { turnCap: 60, stallStop: false, temperature: 0.6 } }, 32768)).toMatchObject({ turnCap: 60, toolScope: "all", stallStop: false, temperature: 0.6 });
    // Claude thinks adaptively, which takes its own temperature: none is sent.
    expect(runPolicy({ transport: "api-key", model: "m", effort: "high", policy: { temperature: 0.6 } }, null).temperature).toBeNull();
  });
});
