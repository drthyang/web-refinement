import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { listLmStudioModels, lmstudioBase, lmstudioUnreachableHint } from "@/agent/lmstudio";

/**
 * The LM Studio helpers against a stand-in server that answers
 * /api/v1/models in the shape LM Studio's REST API documents (a `models`
 * array with `key`, `params_string`, `max_context_length`,
 * `loaded_instances[].config.context_length` and
 * `capabilities.trained_for_tool_use`).
 */

const MODELS = {
  models: [
    {
      type: "llm", publisher: "google", key: "google/gemma-4-26b-a4b", display_name: "Gemma 4 26B A4B", params_string: "26B-A4B",
      loaded_instances: [{ id: "google/gemma-4-26b-a4b", config: { context_length: 4096 } }],
      max_context_length: 262144, format: "gguf", capabilities: { vision: true, trained_for_tool_use: true },
    },
    {
      type: "llm", publisher: "qwen", key: "qwen/qwen3-32b", params_string: "32B",
      loaded_instances: [], max_context_length: 40960, capabilities: { vision: false, trained_for_tool_use: true },
    },
    {
      type: "llm", publisher: "someone", key: "someone/plain-7b", params_string: null,
      loaded_instances: [{ id: "a", config: { context_length: 65536 } }, { id: "b", config: { context_length: 32768 } }],
      max_context_length: 131072, capabilities: { vision: false, trained_for_tool_use: false },
    },
    { type: "embedding", publisher: "nomic", key: "text-embedding-nomic-embed-text-v1.5", loaded_instances: [], max_context_length: 2048 },
  ],
};

async function fakeLmStudio(handler: (path: string) => { status: number; body: unknown }): Promise<{ url: string; server: Server; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    const out = handler(req.url ?? "");
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server, seen };
}

describe("LM Studio helpers", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it("lists the language models, those trained for tools first, with their loaded context", async () => {
    const api = await fakeLmStudio((path) => (path === "/api/v1/models" ? { status: 200, body: MODELS } : { status: 404, body: {} }));
    server = api.server;
    const models = await listLmStudioModels(api.url + "/");
    expect(models.map((m) => [m.key, m.toolUse, m.loadedContext, m.maxContext, m.parameterSize])).toEqual([
      ["google/gemma-4-26b-a4b", true, 4096, 262144, "26B-A4B"],
      ["qwen/qwen3-32b", true, null, 40960, "32B"],
      // Two loaded copies: the smaller context counts.
      ["someone/plain-7b", false, 32768, 131072, null],
    ]);
    expect(api.seen).toEqual(["/api/v1/models"]);
  });

  it("says when the server is too old for the Agent, or is not LM Studio", async () => {
    const old = await fakeLmStudio(() => ({ status: 404, body: { error: "Unexpected endpoint or method." } }));
    server = old.server;
    await expect(listLmStudioModels(old.url)).rejects.toThrow(/needs LM Studio 0\.4\.1 or later/);
    await new Promise<void>((r) => old.server.close(() => r()));

    const other = await fakeLmStudio(() => ({ status: 200, body: { data: [] } }));
    server = other.server;
    await expect(listLmStudioModels(other.url)).rejects.toThrow(/did not answer as an LM Studio server/);
  });

  it("normalizes the address, and the hint names the CORS switch", () => {
    expect(lmstudioBase("  http://box:1234///  ")).toBe("http://box:1234");
    expect(lmstudioBase("")).toBe("http://localhost:1234");
    expect(lmstudioUnreachableHint("")).toMatch(/http:\/\/localhost:1234.*Enable CORS.*lms server start --cors/);
  });
});
