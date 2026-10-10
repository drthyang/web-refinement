import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { anthropicProxy, sameOrigin } from "@/agent/proxy";

/** The proxy behind a real HTTP server; the upstream API is a stubbed fetch. */
async function serve(apiKey: string | undefined): Promise<{ url: string; server: Server }> {
  const handler = anthropicProxy(apiKey);
  const server = createServer((req, res) => handler(req, res, () => {
    res.statusCode = 404;
    res.end("next");
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, server };
}

describe("Agent API proxy", () => {
  const realFetch = globalThis.fetch;
  let server: Server | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it("accepts only the app's own pages", () => {
    const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage);
    expect(sameOrigin(req({ host: "localhost:5173", origin: "http://localhost:5173" }))).toBe(true);
    expect(sameOrigin(req({ host: "localhost:5173", origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(req({ host: "localhost:5173" }))).toBe(true); // curl: no browser metadata
    expect(sameOrigin(req({ host: "localhost:5173", "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("says how to configure it when there is no key", async () => {
    const s = await serve(undefined);
    server = s.server;
    const r = await realFetch(`${s.url}/web-refinement/api/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("proxy_not_configured");
    expect(body.error.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("leaves other paths to the next handler", async () => {
    const s = await serve("k");
    server = s.server;
    expect(await (await realFetch(`${s.url}/web-refinement/data/x.txt`)).text()).toBe("next");
  });

  it("forwards with the server's key, never the page's, and streams the answer back", async () => {
    const s = await serve("sk-ant-server-key");
    server = s.server;
    let seen: { url: string; headers: Headers; body: string } | null = null;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.anthropic.com")) return realFetch(input, init);
      seen = { url, headers: new Headers(init?.headers), body: new TextDecoder().decode(init?.body as Uint8Array) };
      return new Response("event: message_stop\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } });
    }) as typeof fetch;
    const r = await realFetch(`${s.url}/web-refinement/api/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "page-placeholder", "anthropic-version": "2023-06-01", cookie: "secret=1", origin: s.url },
      body: JSON.stringify({ model: "m" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect(await r.text()).toMatch(/message_stop/);
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen!.headers.get("x-api-key")).toBe("sk-ant-server-key");
    expect(seen!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(seen!.headers.get("cookie")).toBeNull();
    expect(seen!.body).toBe("{\"model\":\"m\"}");
  });

  it("refuses another site's page", async () => {
    const s = await serve("k");
    server = s.server;
    const r = await realFetch(`${s.url}/web-refinement/api/anthropic/v1/messages`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    expect(r.status).toBe(403);
  });
});
