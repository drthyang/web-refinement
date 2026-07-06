import { describe, expect, it } from "vitest";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";

const CSV = `"limits",0.5385,5.2483
"masked X","X","obs","calc","bkg","diff"
--,3390.57,48.49,45.0,5.0,-1.5
--,3393.28,50.10,49.0,5.0,-3.9
--,3395.99,53.82,52.0,5.0,-3.2`;

describe("parseGsasCsvPattern", () => {
  it("extracts observed points plus calc/background overlays", () => {
    const { pattern, calc, background } = parseGsasCsvPattern(CSV, "id", "f.csv");
    expect(pattern.xUnit).toBe("tof");
    expect(pattern.radiation).toEqual({ kind: "neutron-tof" });
    expect(pattern.points.length).toBe(3);
    expect(pattern.points[0]!.x).toBeCloseTo(3390.57, 2);
    expect(pattern.points[0]!.yObs).toBeCloseTo(48.49, 2);
    expect(calc).toEqual([45.0, 49.0, 52.0]);
    expect(background).toEqual([5.0, 5.0, 5.0]);
  });

  it("rejects non-GSAS text", () => {
    expect(() => parseGsasCsvPattern("1 2 3\n4 5 6", "id", "n")).toThrow();
  });
});
