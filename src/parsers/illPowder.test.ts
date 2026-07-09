import { describe, it, expect } from "vitest";
import { parseIllD1b, looksLikeIllD1b } from "@/parsers/illPowder";

// A miniature ILL D1B/D20 numor file: header, one line of (flag,count) pairs,
// negative sentinels. Fields mirror the real layout (2θ_start at index 2, step
// at index 8 of the parameter line; NPTS on the comment line).
const ILL = [
  "    1",
  " 12-OCT-90 15:55:51  TESTUSER  MyPhase",
  "  1  11039    11040",
  "     1000.     600.   10.000  -69.110    0.000    0.000    0.000    0.000    0.500    1.400    1.488    1.422",
  " 4 0.0 0.0 0.0 0.0 0.0 CALIBRATED WITH VANA NUMORS : 1 TO 4",
  " 1  100 1  200 1  300 1  400",
  "    -1000",
  "   -10000",
  "",
].join("\n");

describe("parseIllD1b (ILL D1B/D20 CW powder format)", () => {
  it("recognises the format", () => {
    expect(looksLikeIllD1b(ILL)).toBe(true);
    expect(looksLikeIllD1b("10.0 100\n10.1 120\n")).toBe(false);
  });

  it("reads counts from the (flag, count) pairs on a 2θ_start + i·step grid", () => {
    const p = parseIllD1b(ILL, { id: "p", name: "MyPhase", radiation: { kind: "neutron", wavelength: 2.52 } });
    expect(p.xUnit).toBe("twoTheta");
    expect(p.points.map((q) => q.yObs)).toEqual([100, 200, 300, 400]);
    expect(p.points.map((q) => q.x)).toEqual([10.0, 10.5, 11.0, 11.5]);
    // σ = √counts (raw-count Poisson weight).
    expect(p.points[3]!.sigma).toBeCloseTo(20, 6);
  });

  it("throws (rather than mis-parsing) if the parameter line is missing", () => {
    const broken = "    1\n 12-OCT-90 00:00:00 U T\n 4 x CALIBRATED\n 1 100\n -1000\n";
    expect(() => parseIllD1b(broken, { id: "p", name: "x", radiation: { kind: "neutron", wavelength: 2.52 } })).toThrow();
  });
});
