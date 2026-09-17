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

describe("parse_single_crystal_data — format routing", () => {
  it("reads a named .hkl by fixed column, so a wide intensity is not split into l", () => {
    const row = "   1   2   310000.00  100.00   1" + "\n";
    const out = parse_single_crystal_data({ text: row, name: "x.hkl" });
    expect(out.format).toBe("shelx");
    expect(out.dataset.reflections[0]).toEqual({ h: 1, k: 2, l: 3, iObs: 10000, sigma: 100 });
  });

  it("takes .fcf intensities from the loop header (LIST 4 writes calc before meas)", () => {
    const text = [
      "loop_",
      "_refln_index_h",
      "_refln_index_k",
      "_refln_index_l",
      "_refln_F_squared_calc",
      "_refln_F_squared_meas",
      "_refln_F_squared_sigma",
      "_refln_observed_status",
      "   1   2   3  950.00  1000.00  20.00 o",
    ].join("\n");
    const out = parse_single_crystal_data({ text, name: "x.fcf" });
    expect(out.format).toBe("fcf");
    expect(out.dataset.reflections[0]).toEqual({ h: 1, k: 2, l: 3, iObs: 1000, sigma: 20 });
  });

  it("leaves an unnamed plain list on the free-format reader", () => {
    const out = parse_single_crystal_data({ text: "1 0 0 100 2" + "\n" });
    expect(out.format).toBe("list");
    expect(out.dataset.reflections[0]!.iObs).toBe(100);
  });
});
