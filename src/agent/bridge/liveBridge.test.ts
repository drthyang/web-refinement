import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLiveBridge, isLocalOrigin, type LiveBridge } from "@/agent/bridge/liveBridge";
import { LIVE_TOOLS } from "@/agent/tools";

/**
 * The bridge end to end, minus the browser: an MCP client plays Claude Code,
 * and plain fetch plays the page's long-poll client (bridgeClient.ts).
 */
describe("materia-live bridge", () => {
  let bridge: LiveBridge;
  let base: string;
  let client: Client;
  const PAGE = "http://localhost:5173";

  beforeEach(async () => {
    bridge = createLiveBridge({ port: 0 });
    const port = await bridge.listening;
    base = `http://127.0.0.1:${port}`;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "bridge-test", version: "0" });
    await Promise.all([bridge.mcp.connect(a), client.connect(b)]);
  });

  afterEach(async () => {
    await client.close();
    await bridge.close();
  });

  const page = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(base + path, { ...init, headers: { Origin: PAGE, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const hello = (session: string): Promise<Response> => page("/hello", { method: "POST", body: JSON.stringify({ session }) });
  const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]!.text);

  it("serves the Agent's tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(LIVE_TOOLS.map((t) => t.name).sort());
  });

  it("explains that the app is not connected", async () => {
    const r = await client.callTool({ name: "get_state", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/app is not connected.*Claude Code/);
  });

  it("forwards a call to the page and returns the page's answer", async () => {
    expect((await hello("tab1")).status).toBe(200);
    const answered = client.callTool({ name: "set_free", arguments: { free: ["scale"] } });
    const poll = await page("/poll?session=tab1");
    expect(poll.status).toBe(200);
    expect(poll.headers.get("access-control-allow-origin")).toBe(PAGE);
    const call = (await poll.json()) as { id: string; name: string; input: unknown };
    expect(call.name).toBe("set_free");
    expect(call.input).toEqual({ free: ["scale"] });
    const post = await page("/result", { method: "POST", body: JSON.stringify({ session: "tab1", id: call.id, isError: false, text: "{\"free\":[\"scale\"]}" }) });
    expect(post.status).toBe(200);
    const r = await answered;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("{\"free\":[\"scale\"]}");
  });

  it("passes the page's errors through as tool errors", async () => {
    await hello("tab1");
    const answered = client.callTool({ name: "refine", arguments: {} });
    const call = (await (await page("/poll?session=tab1")).json()) as { id: string };
    await page("/result", { method: "POST", body: JSON.stringify({ session: "tab1", id: call.id, isError: true, text: "Error: no parameter is free" }) });
    const r = await answered;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Error: no parameter is free");
  });

  it("refuses pages from other sites", async () => {
    const r = await fetch(base + "/hello", { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: JSON.stringify({ session: "x" }) });
    expect(r.status).toBe(403);
    expect(isLocalOrigin("http://127.0.0.1:4173")).toBe(true);
    expect(isLocalOrigin("http://localhost.evil.com")).toBe(false);
  });

  it("answers a CORS preflight for the page", async () => {
    const r = await fetch(base + "/result", { method: "OPTIONS", headers: { Origin: PAGE, "Access-Control-Request-Method": "POST" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toMatch(/POST/);
  });

  it("hands the bridge to the newest tab", async () => {
    await hello("old");
    const oldPoll = page("/poll?session=old");
    await new Promise((r) => setTimeout(r, 50));
    await hello("new");
    expect((await oldPoll).status).toBe(409);
    expect((await page("/poll?session=old")).status).toBe(409);
  });
});
