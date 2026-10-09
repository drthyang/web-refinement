/**
 * The `materia-live` bridge: an MCP server whose tools act on the MATERIA page
 * open in the browser, so Claude Code can drive the live analysis.
 *
 * Claude Code starts this server (stdio, .mcp.json). It serves the Agent's
 * tool list (agent/tools.ts) and listens on 127.0.0.1 for the page: the page
 * long-polls `/poll` for the next call, runs it through its own executor (the
 * user approves changes there), and posts the answer to `/result`. Nothing
 * science-related happens here — the page holds the state and does the work.
 *
 * Only pages served from this machine (localhost / 127.0.0.1 origins) may
 * connect, so another site open in the browser cannot read the calls or answer
 * them. Plain HTTP keeps it dependency-free; a long poll is enough for one
 * call at a time plus a cancel.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LIVE_TOOLS } from "@/agent/tools";

export const DEFAULT_BRIDGE_PORT = 5199;
/** How long a poll is held open before it returns empty. */
const POLL_HOLD_MS = 25_000;
/** A page not seen for this long counts as gone. */
const PAGE_TIMEOUT_MS = 35_000;
/** A change can wait on the user's approval, then a long refinement. */
const CALL_TIMEOUT_MS = 30 * 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const INSTRUCTIONS = `MATERIA live: these tools act on the MATERIA workbench open in the user's browser — the analysis they are looking at, not a copy.

Start with get_state. Read tools (get_state, assess_refinement, suggest_next_steps, rank_next_parameters, check_cell_symmetry, find_unexplained_peaks, bond_geometry, interpret_structure) run at once. Change tools (set_free, set_background, set_microstrain, set_adp_model, set_fit_range, refine, reset_parameters, go_to_step) wait until the user approves them in the app's Agent panel, unless they turned on auto-approve there; a declined change says so. Every change becomes a step in the app's history, tagged as the agent's, so the user can undo it.

You choose what to free and when to refine; the least-squares engine sets every value. There is no tool to type in a value.

For what-if work on data the user has not opened (simulate, build a magnetic model, refine headless), the separate \`materia\` MCP server holds the full toolset.

If a call says the app is not connected, ask the user to open the app (npm run dev) and choose "Claude Code" in its Agent panel.`;

interface Pending {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly resolve: (r: { isError: boolean; text: string }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LiveBridge {
  readonly mcp: McpServer;
  readonly http: Server;
  /** Resolves with the port once listening (rejects if it is taken). */
  readonly listening: Promise<number>;
  readonly close: () => Promise<void>;
}

export function createLiveBridge(opts: { port?: number; version?: string } = {}): LiveBridge {
  const queue: Pending[] = [];
  const inFlight = new Map<string, Pending>();
  let session: string | null = null;
  let lastSeen = 0;
  let waiting: { res: ServerResponse; timer: ReturnType<typeof setTimeout> } | null = null;
  let nextId = 1;
  let listenError: Error | null = null;

  const connected = (): boolean => session !== null && Date.now() - lastSeen < PAGE_TIMEOUT_MS;

  /** Hand the next queued call to the waiting poll, if there is one of each. */
  const dispatch = (): void => {
    if (!waiting || queue.length === 0) return;
    const call = queue.shift()!;
    inFlight.set(call.id, call);
    const { res, timer } = waiting;
    waiting = null;
    clearTimeout(timer);
    json(res, 200, { id: call.id, name: call.name, input: call.input });
  };

  const forward = (name: string, input: unknown): Promise<{ isError: boolean; text: string }> => {
    if (listenError) {
      return Promise.resolve({ isError: true, text: `Error: the bridge could not listen for the app (${listenError.message}). Another Claude Code session may be running it; close that one or set MATERIA_LIVE_PORT.` });
    }
    if (!connected()) {
      return Promise.resolve({ isError: true, text: "Error: the MATERIA app is not connected. Ask the user to open the app (npm run dev) and choose \"Claude Code\" in its Agent panel, then try again." });
    }
    return new Promise((resolve) => {
      const id = `b${nextId++}`;
      const timer = setTimeout(() => {
        inFlight.delete(id);
        const at = queue.findIndex((c) => c.id === id);
        if (at >= 0) queue.splice(at, 1);
        resolve({ isError: true, text: "Error: the app did not answer in 30 minutes (an approval left waiting, or the tab was closed)." });
      }, CALL_TIMEOUT_MS);
      queue.push({ id, name, input, resolve, timer });
      dispatch();
    });
  };

  const mcp = new McpServer({ name: "materia-live", version: opts.version ?? "0" }, { instructions: INSTRUCTIONS });
  for (const tool of LIVE_TOOLS) {
    mcp.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => {
        const out = await forward(tool.name, args ?? {});
        return { content: [{ type: "text" as const, text: out.text }], ...(out.isError ? { isError: true } : {}) };
      },
    );
  }

  const http = createServer((req, res) => {
    void handle(req, res).catch((e) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!isLocalOrigin(origin)) return json(res, 403, { error: "only a page served from this machine may connect" });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/hello") {
      const body = await readJson(req);
      const s = typeof body.session === "string" ? body.session : null;
      if (!s) return json(res, 400, { error: "session missing" });
      if (session !== s && waiting) {
        // A new tab takes over: the old one's poll learns it was replaced.
        clearTimeout(waiting.timer);
        json(waiting.res, 409, { error: "another tab took over" });
        waiting = null;
      }
      session = s;
      lastSeen = Date.now();
      return json(res, 200, { server: "materia-live", tools: LIVE_TOOLS.length });
    }
    if (req.method === "GET" && url.pathname === "/poll") {
      if (url.searchParams.get("session") !== session) return json(res, 409, { error: "another tab took over" });
      lastSeen = Date.now();
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.res.writeHead(204);
        waiting.res.end();
      }
      const timer = setTimeout(() => {
        if (waiting?.res === res) waiting = null;
        res.writeHead(204);
        res.end();
      }, POLL_HOLD_MS);
      waiting = { res, timer };
      req.on("close", () => {
        if (waiting?.res === res) {
          clearTimeout(timer);
          waiting = null;
        }
      });
      dispatch();
      return;
    }
    if (req.method === "POST" && url.pathname === "/result") {
      const body = await readJson(req);
      if (body.session !== session) return json(res, 409, { error: "another tab took over" });
      lastSeen = Date.now();
      const call = typeof body.id === "string" ? inFlight.get(body.id) : undefined;
      if (!call) return json(res, 404, { error: "no such call (it may have timed out)" });
      inFlight.delete(call.id);
      clearTimeout(call.timer);
      call.resolve({ isError: body.isError === true, text: typeof body.text === "string" ? body.text : JSON.stringify(body.text) });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return json(res, 200, { server: "materia-live", connected: connected(), queued: queue.length, inFlight: inFlight.size });
    }
    json(res, 404, { error: "not found" });
  }

  const port = opts.port ?? DEFAULT_BRIDGE_PORT;
  const listening = new Promise<number>((resolve, reject) => {
    http.once("error", (e) => {
      listenError = e;
      reject(e);
    });
    http.listen(port, "127.0.0.1", () => {
      const addr = http.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });

  const close = async (): Promise<void> => {
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.res.writeHead(204);
      waiting.res.end();
      waiting = null;
    }
    for (const call of [...queue, ...inFlight.values()]) {
      clearTimeout(call.timer);
      call.resolve({ isError: true, text: "Error: the bridge shut down" });
    }
    queue.length = 0;
    inFlight.clear();
    await new Promise<void>((r) => http.close(() => r()));
    await mcp.close();
  };

  return { mcp, http, listening, close };
}

/** http(s) on localhost, 127.0.0.1 or [::1], any port. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text ? JSON.parse(text) : {};
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
