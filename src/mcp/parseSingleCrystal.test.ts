import { describe, it, expect } from "vitest";
import { parse_single_crystal_data } from "@/mcp/tools";

describe("parse_single_crystal_data — the 0 0 0 forward-beam row", () => {
  const text = "0 0 0 5000 10\n1 0 0 100 2\n1 1 0 50 2\n";

  it("drops it by default and reports the count", () => {
    const out = parse_single_crystal_data({ text });
    expect(out.kept).toBe(2);
    expect(out.forwardBeamSkipped).toBe(1);
    expect(out.dataset.reflections.some((r) => r.h === 0 && r.k === 0 && r.l === 0)).toBe(false);
  });

  it("skipForwardBeam:false keeps it (a fundamental-indexed magnetic file)", () => {
    const out = parse_single_crystal_data({ text, skipForwardBeam: false });
    expect(out.kept).toBe(3);
    expect(out.forwardBeamSkipped).toBe(0);
  });
});
