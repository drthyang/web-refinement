import { describe, it, expect } from "vitest";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { pruneForLocal } from "@/agent/contextWindow";

/** A session of `n` tool calls, each answered with a `size`-character result. */
function session(names: string[], size: number): BetaMessageParam[] {
  const out: BetaMessageParam[] = [{ role: "user", content: "Refine it." }];
  names.forEach((name, i) => {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name, input: {} }] });
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(size) }] });
  });
  return out;
}

const resultOf = (m: BetaMessageParam): string => {
  const b = (m.content as { type: string; content?: unknown }[])[0]!;
  return String(b.content);
};

describe("keeping a local model's history in its window", () => {
  it("leaves a history under the budget alone", () => {
    const h = session(["get_state", "refine"], 100);
    expect(pruneForLocal(h, 10_000)).toEqual(h);
  });

  it("clears all but the last results past the budget, never a skill, and never the stored history", () => {
    const names = ["read_skill", "get_state", "refine", "get_state", "assess_refinement", "refine", "get_state", "refine"];
    const h = session(names, 2000);
    const before = JSON.stringify(h);
    const pruned = pruneForLocal(h, 5000, 3);
    const results = pruned.filter((_, i) => i > 0 && i % 2 === 0).map(resultOf);
    expect(results[0]).toBe("x".repeat(2000)); // the skill stays
    expect(results.slice(1, 5).every((r) => r.startsWith("[An earlier result of"))).toBe(true);
    expect(results[1]).toBe("[An earlier result of get_state, cleared to keep the conversation in the model's window. Call get_state again if you need it.]");
    expect(results.slice(5)).toEqual(["x".repeat(2000), "x".repeat(2000), "x".repeat(2000)]);
    expect(JSON.stringify(h)).toBe(before);
    // Deterministic: the same history prunes the same way.
    expect(pruneForLocal(h, 5000, 3)).toEqual(pruned);
  });
});
