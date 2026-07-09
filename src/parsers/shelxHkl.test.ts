import { describe, it, expect } from "vitest";
import { parseShelxHkl, parseFcf } from "@/parsers/shelxHkl";

describe("parseShelxHkl (HKLF 4)", () => {
  it("reads fixed-column 3I4,2F8 rows and stops at the 0 0 0 terminator", () => {
    // Columns: hhhhkkkkllllFFFFFFFFssssssss
    const text = [
      "   1   0   0  253.71    3.42",
      "   2   0   0  118.06    2.90",
      "  -1  -1   2   45.10    1.77",
      "   0   0   0    0.00    0.00",
      "   9   9   9  999.00    9.99", // after terminator — ignored
    ].join("\n");
    const { reflections, skipped } = parseShelxHkl(text);
    expect(reflections).toHaveLength(3);
    expect(reflections[0]).toEqual({ h: 1, k: 0, l: 0, intensity: 253.71, sigma: 3.42 });
    expect(reflections[2]).toEqual({ h: -1, k: -1, l: 2, intensity: 45.1, sigma: 1.77 });
    expect(skipped).toBe(0);
  });

  it("captures batch numbers in column 29 (multi-scan data)", () => {
    const text = [
      "   1   0   0  253.71    3.42   1",
      "   1   0   0  250.10    3.30   2",
    ].join("\n");
    const { reflections, hasBatches } = parseShelxHkl(text);
    expect(hasBatches).toBe(true);
    expect(reflections[1]!.batch).toBe(2);
  });

  it("falls back to whitespace splitting for non-fixed-width rows", () => {
    const text = "1 0 0 253.71 3.42\n2 0 0 118.06 2.90\n";
    const { reflections } = parseShelxHkl(text);
    expect(reflections).toHaveLength(2);
    expect(reflections[0]!.intensity).toBeCloseTo(253.71, 6);
  });
});

describe("parseFcf", () => {
  it("reads an F² CIF reflection loop honoring the header column order", () => {
    const text = [
      "data_test",
      "loop_",
      "_refln_index_h",
      "_refln_index_k",
      "_refln_index_l",
      "_refln_F_squared_meas",
      "_refln_F_squared_sigma",
      "_refln_F_squared_calc",
      " 1 0 0 253.71 3.42 250.0",
      " 2 0 0 118.06 2.90 120.0",
    ].join("\n");
    const { reflections } = parseFcf(text);
    expect(reflections).toHaveLength(2);
    expect(reflections[0]).toEqual({ h: 1, k: 0, l: 0, intensity: 253.71, sigma: 3.42 });
  });

  it("squares F and propagates σ for a LIST 6 (F) loop", () => {
    const text = [
      "loop_",
      "_refln_index_h",
      "_refln_index_k",
      "_refln_index_l",
      "_refln_F_meas",
      "_refln_F_sigma",
      " 1 0 0 10 0.5",
    ].join("\n");
    const { reflections } = parseFcf(text);
    // F=10 → F²=100; σ(F²)=2·F·σ(F)=2·10·0.5=10.
    expect(reflections[0]!.intensity).toBeCloseTo(100, 6);
    expect(reflections[0]!.sigma).toBeCloseTo(10, 6);
  });
});
