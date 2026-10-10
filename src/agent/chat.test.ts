import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AgentChat, announcedTool, describeChatError, repeatingTail, stalledReply } from "@/agent/chat";
import type { AgentExecutor } from "@/agent/executor";
import { LIVE_TOOLS } from "@/agent/tools";

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

/** LM Studio's REST answers, for an LM Studio stand-in: the model list, and what a load does. */
interface LmStudioSide {
  readonly models: unknown;
  readonly load?: { status: number; json: unknown };
  readonly seen: { path: string; body: unknown }[];
}

async function fakeApi(turns: (string | { status: number; json: unknown })[], lmstudio?: LmStudioSide): Promise<{ url: string; server: Server; requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] }> {
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (lmstudio && req.url?.startsWith("/api/v1/models")) {
        const text = Buffer.concat(chunks).toString("utf8");
        lmstudio.seen.push({ path: req.url, body: text ? JSON.parse(text) : null });
        const out = req.url === "/api/v1/models" ? { status: 200, json: lmstudio.models } : (lmstudio.load ?? { status: 200, json: { status: "loaded" } });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
        return;
      }
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
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
      res.writeHead(200, { "content-type": "text/event-stream" });
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

  it("sends plain headers and only the fields Ollama reads", async () => {
    const api = await fakeApi([sse([{ type: "thinking", thinking: "Look first." }, { type: "tool_use", id: "call_1", name: "get_state", input: {} }], "tool_use"), sse([{ type: "text", text: "Fine." }], "end_turn")]);
    server = api.server;
    let thought = "";
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    await chat.send("How is it?", { transport: "ollama", serverUrl: api.url + "/", model: "qwen3:32b", effort: "high" }, { ...quiet, onThinking: (d) => (thought += d) }, new AbortController().signal);

    expect(thought).toBe("Look first.");
    const first = api.requests[0]!;
    for (const h of ["x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access", "x-stainless-lang"]) expect(first.headers[h]).toBeUndefined();
    expect(first.body.model).toBe("qwen3:32b");
    expect(first.body.stream).toBe(true);
    for (const k of ["thinking", "output_config", "cache_control", "fallbacks"]) expect(first.body[k]).toBeUndefined();
    expect(first.body.system as string).toContain("<skills>");
    expect(first.body.system as string).toMatch(/Mode: ask\. [^]*$/);
    const tools = first.body.tools as { name: string; eager_input_streaming?: boolean }[];
    expect(tools.map((t) => t.name)).toEqual(LIVE_TOOLS.map((t) => t.name));
    expect(tools.some((t) => "eager_input_streaming" in t)).toBe(false);
    // The tool loop runs as it does on Claude: the call is answered, then the reply.
    expect(chat.history().map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("moving the conversation to Claude drops Ollama's unsigned thinking from earlier replies", async () => {
    const api = await fakeApi([sse([{ type: "thinking", thinking: "unsigned" }, { type: "text", text: "Hi." }], "end_turn"), sse([{ type: "text", text: "Hello again." }], "end_turn")]);
    server = api.server;
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    const signal = new AbortController().signal;
    await chat.send("hi", { transport: "ollama", serverUrl: api.url, model: "qwen3:32b", effort: "high" }, quiet, signal);
    expect((chat.history()[1]!.content as { type: string }[]).map((b) => b.type)).toEqual(["thinking", "text"]);

    await chat.send("again", { transport: "api-key", apiKey: "sk-test", baseURL: api.url, model: "claude-opus-5-5", effort: "high" }, quiet, signal);
    const sent = api.requests[1]!.body.messages as { role: string; content: string | { type: string }[] }[];
    expect((sent[1]!.content as { type: string }[]).map((b) => b.type)).toEqual(["text"]);
  });

  it("names the missing model and how to get it", async () => {
    const api = await fakeApi([{ status: 404, json: { type: "error", error: { type: "not_found_error", message: "model 'nope:1b' not found" } } }]);
    server = api.server;
    const chat = new AgentChat({ run: async () => ({ isError: false, text: "{}" }) } as unknown as AgentExecutor);
    const config = { transport: "ollama" as const, serverUrl: api.url, model: "nope:1b", effort: "high" as const };
    const err = await chat.send("hi", config, quiet, new AbortController().signal).then(() => null, (e: unknown) => e);
    expect(describeChatError(err, config)).toBe('Ollama has no model "nope:1b". Pull it (ollama pull nope:1b) or pick another in the Agent settings.');
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
    const api = await fakeApi([sse([{ type: "thinking", thinking: "unsigned" }, { type: "text", text: "Hi." }], "end_turn"), sse([{ type: "text", text: "Hello." }], "end_turn")], lmModels({ "qwen/qwen3-32b": 40960 }));
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
    const api = await fakeApi([sse([{ type: "text", text: loop }], "end_turn"), sse([{ type: "text", text: "OK." }], "end_turn")]);
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
    expect(system[1]!.text).toMatch(/^Mode: auto\. .*while its gate passes go on to the next\. Stop and report when a gate fails/);
  });
});
