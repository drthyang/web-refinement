import { describe, it, expect } from "vitest";
import { parseFullProfInstrm6, looksLikeInstrm6 } from "@/parsers/fullprofInstrm6";
import { looksLikeIllD1b } from "@/parsers/illPowder";

// Fixed-width (I2,I6) pair: 2-col block index + 6-col count.
const pair = (f: number, c: number): string => String(f).padStart(2) + String(c).padStart(6);
const dataLine = (pairs: [number, number][]): string => pairs.map(([f, c]) => pair(f, c)).join("");

// A minimal INSTRM=6 file (CRLF, like the real ILL/LLB exports): title, step
// line, lone 2θ_start line, monitor line, one data record, sentinels. The block
// index (I2) varies (1→2) to prove it is neither a constant flag nor a run-length.
const FILE = [
  "04-05-1996 / LaMnO3 T=50K / Ge(004) Lambda (A): 1.500",
  "     100       0   0.100      10       0       0",
  "   3.000",
  "  40000.  20000.    0.00    0.00",
  dataLine([[1, 4], [1, 2], [1, 31], [1, 211], [2, 388], [2, 549]]),
  "   -1000",
  "  -10000",
  "",
].join("\r\n");

describe("parseFullProfInstrm6 (D2B/3T2/G4.2, Ins = 6)", () => {
  it("recognises the INSTRM=6 template but not the ILL numor template", () => {
    expect(looksLikeInstrm6(FILE)).toBe(true);
    expect(looksLikeIllD1b(FILE)).toBe(false); // numor needs a DD-MON-YY line
  });

  it("reads I6 counts on a 2θ_start + i·step grid, ignoring the I2 block index", () => {
    const p = parseFullProfInstrm6(FILE, { id: "p", name: "LaMnO3", radiation: { kind: "neutron", wavelength: 1.5 } });
    expect(p.xUnit).toBe("twoTheta");
    expect(p.points.map((q) => q.yObs)).toEqual([4, 2, 31, 211, 388, 549]);
    expect(p.points.map((q) => +q.x.toFixed(1))).toEqual([3.0, 3.1, 3.2, 3.3, 3.4, 3.5]);
  });

  it("reads the wavelength from the header (Lambda …)", () => {
    const p = parseFullProfInstrm6(FILE, { id: "p", name: "x", radiation: { kind: "neutron", wavelength: 9 } });
    expect(p.wavelength).toBeCloseTo(1.5, 3);
  });
});
