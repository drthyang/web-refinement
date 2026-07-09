import { describe, it, expect } from "vitest";
import { parseFullProfInt, looksLikeFullProfInt, parseFortranFields } from "@/parsers/fullprofInt";

// FullProf single-crystal .int: title, Fortran format, wavelength, then
// fixed-width `h k l I σ [domain] [6 geometry]` rows. The domain code and first
// geometry column are packed with no space ("1-0.421"), so fixed-width slicing
// (not whitespace splitting) is required.
const INT = [
  "Crystal",
  "(3i4,2f8.2,i4,6f8.0)",
  "1.0000 0 0",
  "  -4 -10   1    0.04    0.02   1-0.42101-0.15770-0.49921-0.10071-0.75733 0.98234",
  "  -3 -11   1    0.18    0.01   1-0.41794-0.01514-0.49563-0.16901-0.76136 0.98550",
  "  12   3  -2    0.74    0.03   1 0.10000 0.20000 0.30000 0.40000 0.50000 0.60000",
  "",
].join("\n");

describe("parseFortranFields", () => {
  it("expands (3i4,2f8.2,i4,6f8.0) into per-field widths", () => {
    const f = parseFortranFields("(3i4,2f8.2,i4,6f8.0)");
    expect(f.map((x) => x.width)).toEqual([4, 4, 4, 8, 8, 4, 8, 8, 8, 8, 8, 8]);
    expect(f.slice(0, 3).every((x) => x.kind === "i")).toBe(true);
  });
});

describe("parseFullProfInt (FullProf single-crystal .int)", () => {
  it("recognises the format", () => {
    expect(looksLikeFullProfInt(INT)).toBe(true);
    expect(looksLikeFullProfInt("10.0 100\n10.1 120\n")).toBe(false);
  });

  it("reads h k l I σ via the declared fixed-width format, ignoring geometry", () => {
    const p = parseFullProfInt(INT);
    expect(p.title).toBe("Crystal");
    expect(p.wavelength).toBeCloseTo(1.0, 4);
    expect(p.reflections.length).toBe(3);
    expect(p.reflections[0]).toEqual({ h: -4, k: -10, l: 1, iObs: 0.04, sigma: 0.02 });
    // The packed "1 0.74" domain+intensity must not corrupt the (12,3,-2) indices.
    expect(p.reflections[2]).toMatchObject({ h: 12, k: 3, l: -2, iObs: 0.74, sigma: 0.03 });
  });
});