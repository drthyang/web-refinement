/**
 * The page's end of the Claude Code bridge (bridge/server.ts). Claude Code runs
 * the `materia-live` MCP server; it listens on a local port, and this client
 * long-polls it for tool calls, runs each one through the executor (approval
 * cards included), and posts the answer back. Plain HTTP on 127.0.0.1, so it
 * needs no dependency and survives the server restarting with Claude Code.
 */

import type { ToolRunner } from "@/agent/executor";

/** Where the bridge listens unless the user changes it (MATERIA_LIVE_PORT on the server). */
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:5199";

export type BridgeStatus =
  | { readonly state: "off" }
  /** Polling, but no bridge answers: Claude Code is not running the server yet. */
  | { readonly state: "searching"; readonly detail?: string }
  | { readonly state: "connected"; readonly server: string }
  /** Another tab of the app took the bridge over. */
  | { readonly state: "replaced" };

interface BridgeCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export class BridgeClient {
  private readonly session = Math.random().toString(36).slice(2);
  private abort: AbortController | null = null;

  constructor(
    private readonly url: string,
    private readonly executor: ToolRunner,
    private readonly onStatus: (s: BridgeStatus) => void,
  ) {}

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    void this.loop(this.abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.onStatus({ state: "off" });
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let connected = false;
    while (!signal.aborted) {
      try {
        if (!connected) {
          this.onStatus({ state: "searching" });
          const hello = await this.post("/hello", { session: this.session, app: "materia" }, signal);
          const info = (await hello.json()) as { server?: string };
          connected = true;
          this.onStatus({ state: "connected", server: info.server ?? "materia-live" });
        }
        const res = await fetch(`${this.url}/poll?session=${this.session}`, { signal, cache: "no-store" });
        if (res.status === 204) continue; // nothing to do this time; poll again
        if (res.status === 409) {
          this.onStatus({ state: "replaced" });
          this.abort?.abort();
          this.abort = null;
          return;
        }
        if (!res.ok) throw new Error(`bridge answered ${res.status}`);
        const call = (await res.json()) as BridgeCall;
        // Run it without holding up the next poll: a cancel must get through
        // while a refinement is running.
        void this.answer(call, signal);
      } catch (e) {
        if (signal.aborted) return;
        connected = false;
        this.onStatus({ state: "searching", detail: e instanceof Error ? e.message : String(e) });
        await sleep(3000, signal);
      }
    }
  }

  private async answer(call: BridgeCall, signal: AbortSignal): Promise<void> {
    const outcome = await this.executor.run(call.name, call.input, "claude-code");
    try {
      await this.post("/result", { session: this.session, id: call.id, ...outcome }, signal);
    } catch {
      // The bridge went away; Claude Code sees its call fail and can retry.
    }
  }

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`bridge answered ${res.status} to ${path}`);
    return res;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
