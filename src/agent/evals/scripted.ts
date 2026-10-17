/**
 * A scripted stand-in for the model: a local Messages API that streams fixed
 * turns (server-sent events, as the real API does), one per request. With it
 * a scenario runs through the real chat loop, executor and tools in CI, with
 * no key and no network, and the checks are tested on transcripts whose
 * verdict is known.
 */

import { createServer, type Server } from "node:http";
import type { EvalModel } from "@/agent/evals/harness";
import { sse, type ScriptTurn } from "@/agent/replay/sse";

export type { ScriptTurn };

export interface ScriptedModel {
  readonly model: EvalModel;
  /** Requests past the end of the script (each answered with an empty final turn). */
  readonly overrun: () => number;
  /** The tool names each request offered, in order. */
  readonly offered: () => readonly (readonly string[])[];
  /** Each request as the model received it (system, tools, messages), in order. */
  readonly requests: () => readonly unknown[];
  readonly close: () => Promise<void>;
}

/** Serve `turns` in order, one per request. */
export async function scriptedModel(turns: readonly ScriptTurn[]): Promise<ScriptedModel> {
  let served = 0;
  let overrun = 0;
  const offered: string[][] = [];
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: { name: string }[] };
        requests.push(body);
        offered.push((body.tools ?? []).map((t) => t.name));
      } catch {
        requests.push(null);
        offered.push([]);
      }
      const turn = turns[served];
      served++;
      if (!turn) overrun++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(turn ?? { text: "(end of script)" }, served));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    model: { transport: "api-key", apiKey: "scripted", baseURL: `http://127.0.0.1:${port}`, model: "scripted", effort: "low" },
    overrun: () => overrun,
    offered: () => offered,
    requests: () => requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
