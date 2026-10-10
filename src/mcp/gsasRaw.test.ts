import { describe, it, expect } from "vitest";
import { parse_powder_data } from "@/mcp/tools";

/** A classic GSAS raw histogram (BANK, CONST, STD) reads as the app reads it, not as columns. */
describe("parse_powder_data on a GSAS raw histogram", () => {
  it("reads a constant-wavelength STD bank in 2θ", () => {
    const counts = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rows = [counts.slice(0, 10), counts.slice(10)].map((r) => r.map((c) => String(c).padStart(8)).join(""));
    const text = ["PbSO4 test   1.909A neutron data", "BANK 1 20 2 CONST 1000 5 0 0 STD", ...rows].join("\n");
    const p = parse_powder_data({ text, filename: "TEST.CWN" });
    expect(p.summary).toMatchObject({ points: 20, xUnit: "twoTheta" });
    expect(p.summary.xMin).toBeCloseTo(10, 6);
    expect(p.summary.xMax).toBeCloseTo(10 + 19 * 0.05, 6);
    expect(p.pattern.points[3]!.yObs).toBe(103);
  });
});
