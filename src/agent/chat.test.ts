import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AgentChat } from "@/agent/chat";
import type { AgentExecutor } from "@/agent/executor";
import { LIVE_TOOLS } from "@/agent/tools";

/**
 * The chat loop against a stand-in Messages API that streams scripted turns
 * (server-sent events, as the real API does). It checks what the SDK sends and
 * that the loop runs tools, answers them, and stops — no network, no key.
 */

type Block =
  | { type: "text"; text: string }
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

async function fakeApi(turns: string[]): Promise<{ url: string; server: Server; requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] }> {
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const turn = turns[requests.length - 1];
      if (!turn) {
        res.statusCode = 500;
        res.end("no more turns");
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
      run: async (name: string, _input: unknown, source: string) => {
        ran.push(`${name}/${source}`);
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

    expect(ran).toEqual(["get_state/chat", "assess_refinement/chat"]);
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
    expect(first.headers["anthropic-beta"]).toBeUndefined();
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
    expect(system[0]!.text).toContain("<user_method>");
    expect(system[0]!.text).toContain("My Rietveld workflow");
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
    expect(api.requests[0]!.headers["anthropic-beta"]).toBeUndefined();
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
