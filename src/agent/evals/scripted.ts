/**
 * A scripted stand-in for the model: a local Messages API that streams fixed
 * turns (server-sent events, as the real API does), one per request. With it
 * a scenario runs through the real chat loop, executor and tools in CI, with
 * no key and no network, and the checks are tested on transcripts whose
 * verdict is known.
 */

import { createServer, type Server } from "node:http";
import type { EvalModel } from "@/agent/evals/harness";

export interface ScriptTurn {
  readonly text?: string;
  readonly calls?: readonly { readonly name: string; readonly input?: Readonly<Record<string, unknown>> }[];
}

function sse(turn: ScriptTurn, n: number): string {
  const ev = (type: string, data: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", {
    message: { id: `msg_${n}`, type: "message", role: "assistant", model: "scripted", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  let index = 0;
  if (turn.text) {
    out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { index, delta: { type: "text_delta", text: turn.text } });
    out += ev("content_block_stop", { index });
    index++;
  }
  for (const [j, call] of (turn.calls ?? []).entries()) {
    out += ev("content_block_start", { index, content_block: { type: "tool_use", id: `tu_${n}_${j}`, name: call.name, input: {} } });
    out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) } });
    out += ev("content_block_stop", { index });
    index++;
  }
  out += ev("message_delta", { delta: { stop_reason: turn.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  out += ev("message_stop", {});
  return out;
}

export interface ScriptedModel {
  readonly model: EvalModel;
  /** Requests past the end of the script (each answered with an empty final turn). */
  readonly overrun: () => number;
  readonly close: () => Promise<void>;
}

/** Serve `turns` in order, one per request. */
export async function scriptedModel(turns: readonly ScriptTurn[]): Promise<ScriptedModel> {
  let served = 0;
  let overrun = 0;
  const server: Server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
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
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
