import { describe, it, expect } from "vitest";
import { parseHkl, parseHklRows } from "@/parsers/hkl";

describe("parseHkl (free-format h k l I [σ]) — the 0 0 0 row", () => {
  it("stops at the all-zero SHELX terminator; nothing after it is data", () => {
    const p = parseHklRows("1 0 0 100 2\n0 0 0 0 0\n2 0 0 50 2\n");
    expect(p.reflections.map((r) => r.h)).toEqual([1]);
    expect(p.forwardBeamSkipped).toBe(0);
    expect(parseHkl("1 0 0 100 2\n   0   0   0    0.00    0.00\n")).toHaveLength(1);
  });

  it("keeps a 0 0 0 row that carries an intensity by default (the satellite at k in a magnetic file)", () => {
    const p = parseHklRows("0 0 0 5000 10\n1 0 0 100 2\n");
    expect(p.reflections).toHaveLength(2);
    expect(p.forwardBeamSkipped).toBe(0);
  });

  it("skipForwardBeam drops it and counts it", () => {
    const p = parseHklRows("0 0 0 5000 10\n1 0 0 100 2\n", { skipForwardBeam: true });
    expect(p.reflections.map((r) => r.h)).toEqual([1]);
    expect(p.forwardBeamSkipped).toBe(1);
  });

  it("a 0 0 0 row with zero intensity but a real σ is a measurement, not the terminator", () => {
    expect(parseHkl("0 0 0 0 0.02\n1 0 0 100 2\n")).toHaveLength(2);
    const p = parseHklRows("0 0 0 0 0.02\n1 0 0 100 2\n", { skipForwardBeam: true });
    expect(p.reflections).toHaveLength(1);
    expect(p.forwardBeamSkipped).toBe(1);
  });
});
