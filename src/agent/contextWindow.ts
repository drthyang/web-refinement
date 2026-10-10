/**
 * Keeping a long session inside the model's window.
 *
 * Claude: the API clears old tool results itself (context editing,
 * `CONTEXT_EDITING`) once the prompt passes a threshold, keeping the last few
 * and every skill read. Server-side clearing is not an edit of the history the
 * model's thinking is bound to, so it is the safe way to clear there.
 *
 * Local models (Ollama, LM Studio): their window is far smaller (32k), so the
 * app sends a pruned copy of the history (`pruneForLocal`) — old tool results
 * replaced by a line saying what they were — and keeps the full history. A
 * pure function of the history, so the same history always prunes the same
 * way and the server's prefix cache keeps working between clears.
 */

import type { BetaContextManagementConfig, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** Results never cleared: a skill is the method the Agent works by. */
export const KEEP_TOOLS: readonly string[] = ["read_skill"];

/** Claude: clear old tool results past 60k input tokens, in batches of 15k or more, keeping the last 6. */
export const CONTEXT_EDITING: BetaContextManagementConfig = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 60_000 },
      keep: { type: "tool_uses", value: 6 },
      clear_at_least: { type: "input_tokens", value: 15_000 },
      exclude_tools: [...KEEP_TOOLS],
    },
  ],
};
export const CONTEXT_EDITING_BETA = "context-management-2025-06-27";

/** Local models: start pruning past this many characters of history (~15k tokens). */
export const LOCAL_BUDGET_CHARS = 60_000;
/** The most recent tool results a pruned history keeps whole. */
export const LOCAL_KEEP = 6;

const size = (m: BetaMessageParam): number => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length);

/**
 * The history as a local model gets it: under the budget, unchanged; over it,
 * every tool result but the last `keep` (and every KEEP_TOOLS result)
 * replaced by a line naming the tool, so the model knows to call it again.
 */
export function pruneForLocal(messages: readonly BetaMessageParam[], budget = LOCAL_BUDGET_CHARS, keep = LOCAL_KEEP): BetaMessageParam[] {
  if (messages.reduce((n, m) => n + size(m), 0) <= budget) return [...messages];
  const toolOf = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_use") toolOf.set(b.id, b.name);
  }
  // The results to keep: the last `keep`, counted from the end.
  const results: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "tool_result") results.push(b.tool_use_id);
  }
  const kept = new Set(results.slice(-keep));
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    if (!m.content.some((b) => b.type === "tool_result" && !kept.has(b.tool_use_id) && !KEEP_TOOLS.includes(toolOf.get(b.tool_use_id) ?? ""))) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type !== "tool_result" || kept.has(b.tool_use_id)) return b;
        const tool = toolOf.get(b.tool_use_id) ?? "a tool";
        if (KEEP_TOOLS.includes(tool)) return b;
        return { ...b, content: `[An earlier result of ${tool}, cleared to keep the conversation in the model's window. Call ${tool} again if you need it.]` };
      }),
    };
  });
}
