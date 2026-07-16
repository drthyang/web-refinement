import { describe, it, expect } from "vitest";
import { parseFullProfInt, looksLikeFullProfInt, parseFortranFields, writeFullProfInt } from "@/parsers/fullprofInt";

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

// Transcribed from a real HB-3A nuclear file (pycrysfml examples,
// MnWO4_nuclear_5K.int) — note the writer's "-0" index artifact.
const REAL_NUCLEAR = [
  "Single crystal data of MnWO4-17pCo (hb3a)",
  "(3i5,2f8.2,i4,3f8.2)",
  "1.53600  0   0",
  "   -0    1   -0  244.02   13.24   1",
  "   -1   -0   -0 1009.99   57.60   1",
  "    1    0   -0 1006.03   54.50   1",
  "   -1   -0    1   57.03    2.35   1",
  "",
].join("\n");

// Transcribed from the real HB-3A magnetic file with a propagation vector
// (MnWO4_magneticAF2_5K.int): count line "1", k line "1 0.217 0.5 -0.46",
// rows h k l nv F² σ cod through (4i5,2f8.2,i4,3f8.2).
const REAL_MAGNETIC_K = [
  "Single crystal data of MnWO4-17pCo (hb3a)",
  "(4i5,2f8.2,i4,3f8.2)",
  "1.53600  0   0",
  "1",
  "1 0.217 0.5 -0.46",
  "   -0    0   -0    1  415.14   14.32   1",
  "   -0    0    1    1  659.72   26.62   1",
  "   -1    0   -0    1  206.20    9.62   1",
  "   -1    0    1    1  903.42   37.02   1",
  "",
].join("\n");

describe("parseFortranFields", () => {
  it("expands (3i4,2f8.2,i4,6f8.0) into per-field widths", () => {
    const f = parseFortranFields("(3i4,2f8.2,i4,6f8.0)");
    expect(f.map((x) => x.width)).toEqual([4, 4, 4, 8, 8, 4, 8, 8, 8, 8, 8, 8]);
    expect(f.slice(0, 3).every((x) => x.kind === "i")).toBe(true);
  });

  it("keeps the declared decimals for re-emission", () => {
    const f = parseFortranFields("(4i5,2f8.2,i4,3f8.4)");
    expect(f[4]).toMatchObject({ kind: "f", width: 8, decimals: 2 });
    expect(f[8]).toMatchObject({ kind: "f", width: 8, decimals: 4 });
  });
});

describe("parseFullProfInt (FullProf single-crystal .int)", () => {
  it("recognises the format", () => {
    expect(looksLikeFullProfInt(INT)).toBe(true);
    expect(looksLikeFullProfInt(REAL_MAGNETIC_K)).toBe(true);
    expect(looksLikeFullProfInt("10.0 100\n10.1 120\n")).toBe(false);
  });

  it("reads h k l I σ via the declared fixed-width format, ignoring geometry", () => {
    const p = parseFullProfInt(INT);
    expect(p.title).toBe("Crystal");
    expect(p.wavelength).toBeCloseTo(1.0, 4);
    expect(p.format).toBe("(3i4,2f8.2,i4,6f8.0)");
    expect(p.itypdata).toBe(0);
    expect(p.ipow).toBe(0);
    expect(p.reflections.length).toBe(3);
    expect(p.reflections[0]).toMatchObject({ h: -4, k: -10, l: 1, iObs: 0.04, sigma: 0.02 });
    // The packed "1 0.74" domain+intensity must not corrupt the (12,3,-2) indices.
    expect(p.reflections[2]).toMatchObject({ h: 12, k: 3, l: -2, iObs: 0.74, sigma: 0.03 });
    expect(p.problems).toEqual([]);
  });

  it("parses a real HB-3A nuclear file, normalising '-0' indices to 0", () => {
    const p = parseFullProfInt(REAL_NUCLEAR);
    expect(p.wavelength).toBeCloseTo(1.536, 4);
    expect(p.kVectors).toBeUndefined();
    expect(p.reflections.length).toBe(4);
    expect(p.reflections[0]).toMatchObject({ h: 0, k: 1, l: 0, iObs: 244.02, sigma: 13.24, code: 1 });
    expect(Object.is(p.reflections[0]!.h, -0)).toBe(false);
  });

  it("parses the propagation-vector variant: k block + per-row nv index", () => {
    const p = parseFullProfInt(REAL_MAGNETIC_K);
    expect(p.kVectors).toEqual([[0.217, 0.5, -0.46]]);
    expect(p.reflections.length).toBe(4);
    // Every row is the H + k_1 satellite (addition convention).
    expect(p.reflections.every((r) => r.kIndex === 1)).toBe(true);
    expect(p.reflections[3]).toMatchObject({ h: -1, k: 0, l: 1, kIndex: 1, iObs: 903.42, sigma: 37.02, code: 1 });
    expect(p.problems).toEqual([]);
  });

  it("records line-numbered problems for malformed rows (lenient default)", () => {
    const bad = [
      "Crystal",
      "(3i4,2f8.2)",
      "1.0000 0 0",
      "   1   1   1   10.00    1.00",
      "   a   b   c   10.00    1.00", // non-integer hkl
      "   2   2   2", // missing intensity
      "",
    ].join("\n");
    const p = parseFullProfInt(bad);
    expect(p.reflections.length).toBe(1);
    expect(p.skipped).toBe(2);
    expect(p.problems.length).toBe(2);
    expect(p.problems[0]).toMatchObject({ line: 5 });
    expect(p.problems[0]!.expected).toContain("integer h k l");
    expect(p.problems[1]).toMatchObject({ line: 6 });
    expect(p.problems[1]!.expected).toContain("intensity");
  });

  it("strict mode rejects a malformed file with line + expected vs found", () => {
    const bad = [
      "Magnetic",
      "(4i4,2f8.2,i4)", // 4 leading ints declare an nv column → k block expected
      "1.5000 0 0",
      "not-a-count",
      "",
    ].join("\n");
    expect(() => parseFullProfInt(bad, { strict: true })).toThrow(/line 4: expected the propagation-vector count.*found not-a-count/);
  });

  it("strict mode rejects an out-of-range k index", () => {
    const bad = [
      "Magnetic",
      "(4i4,2f8.2,i4)",
      "1.5000 0 0",
      "1",
      "1 0.5 0 0",
      "   1   1   1   2   10.00    1.00   1", // nv=2 but only 1 k declared
      "",
    ].join("\n");
    expect(() => parseFullProfInt(bad, { strict: true })).toThrow(/line 6: expected a 1-based k index/);
  });
});

describe("writeFullProfInt (writer + round-trips)", () => {
  it("writes a plain nuclear file that re-parses to identical content", () => {
    const refl = [
      { h: 1, k: 0, l: 0, iObs: 100.25, sigma: 2.5, code: 1 },
      { h: -2, k: 3, l: 1, iObs: 55.1, sigma: 1.1, code: 1 },
    ];
    const text = writeFullProfInt(refl, { title: "T", wavelength: 1.54 });
    const p = parseFullProfInt(text, { strict: true });
    expect(p.title).toBe("T");
    expect(p.wavelength).toBeCloseTo(1.54, 4);
    expect(p.reflections).toEqual(refl.map((r) => ({ ...r })));
  });

  it("writes the k-vector variant that re-parses to identical content", () => {
    const refl = [
      { h: 0, k: 0, l: 1, iObs: 659.72, sigma: 26.62, kIndex: 1, code: 1 },
      { h: -1, k: 0, l: 1, iObs: 903.42, sigma: 37.02, kIndex: 2, code: 1 },
    ];
    const kVectors: [number, number, number][] = [[0.217, 0.5, -0.46], [-0.217, -0.5, 0.46]];
    const text = writeFullProfInt(refl, { title: "Mag", wavelength: 1.536, kVectors });
    const p = parseFullProfInt(text, { strict: true });
    expect(p.kVectors).toEqual(kVectors);
    expect(p.reflections).toEqual(refl.map((r) => ({ ...r })));
  });

  it("parse → write is byte-identical on writer output (fixed point)", () => {
    const refl = [{ h: 1, k: 2, l: 3, iObs: 10.5, sigma: 0.5, kIndex: 1, code: 1 }];
    const text = writeFullProfInt(refl, { title: "X", wavelength: 1.0, kVectors: [[0, 0, 0.5]] });
    const p = parseFullProfInt(text, { strict: true });
    const again = writeFullProfInt(p.reflections, {
      title: p.title,
      wavelength: p.wavelength!,
      itypdata: p.itypdata ?? 0,
      ipow: p.ipow ?? 0,
      format: p.format,
      ...(p.kVectors ? { kVectors: p.kVectors } : {}),
    });
    expect(again).toBe(text);
  });

  it("semantic round-trip on the real magnetic-k file", () => {
    const p = parseFullProfInt(REAL_MAGNETIC_K, { strict: true });
    const rewritten = writeFullProfInt(p.reflections, {
      title: p.title, wavelength: p.wavelength!, format: p.format,
      ...(p.kVectors ? { kVectors: p.kVectors } : {}),
    });
    const p2 = parseFullProfInt(rewritten, { strict: true });
    expect(p2.reflections).toEqual(p.reflections);
    expect(p2.kVectors).toEqual(p.kVectors);
    expect(p2.wavelength).toBeCloseTo(p.wavelength!, 4);
  });

  it("throws when a value cannot fit its declared field width", () => {
    expect(() =>
      writeFullProfInt([{ h: 1, k: 1, l: 1, iObs: 123456789.12, sigma: 1 }], { wavelength: 1.0, format: "(3i4,2f8.2)" }),
    ).toThrow(/does not fit/);
  });

  it("throws when k vectors are given but the format lacks the nv column", () => {
    expect(() =>
      writeFullProfInt([{ h: 1, k: 1, l: 1, iObs: 1 }], { wavelength: 1.0, format: "(3i4,2f8.2)", kVectors: [[0, 0, 0.5]] }),
    ).toThrow(/leading integer fields/);
  });

  it("throws when the format declares an nv column but no k vectors are given", () => {
    // Review regression: a 4-leading-int format with no kVectors used to silently
    // map the intensity into the nv slot (truncated to an int) and produce a file
    // the reader parsed as zero reflections. It must fail loudly instead.
    expect(() =>
      writeFullProfInt([{ h: 1, k: 2, l: 3, iObs: 100.5, sigma: 2.5, code: 1 }], { wavelength: 1.5, format: "(4i5,2f8.2,i4)" }),
    ).toThrow(/nv column.*no kVectors/);
  });

  it("round-trips a TOF file whose R_lambda line is 0", () => {
    // Review regression: writer emits "0.0000 0 0"; the reader's old w>0 guard
    // rejected it, so the header line was mis-read as a reflection (wavelength
    // lost / strict throw). The header must now be consumed and rows preserved.
    const refl = [{ h: 1, k: 0, l: 0, iObs: 250.5, sigma: 5.1, code: 1 }, { h: 0, k: 2, l: 0, iObs: 88.2, sigma: 2.2, code: 1 }];
    const text = writeFullProfInt(refl, { title: "TOF", wavelength: 0 });
    expect(text.split("\n")[2]).toBe("0.0000 0 0");
    const p = parseFullProfInt(text, { strict: true });
    expect(p.wavelength).toBeUndefined(); // 0 is not a usable λ
    expect(p.reflections).toEqual(refl.map((r) => ({ ...r })));
  });

  it("normalizes a signed-zero propagation-vector component to +0", () => {
    const p = parseFullProfInt([
      "Mag", "(4i4,2f8.2,i4)", "1.5000 0 0", "1", "1 -0.0 0.5 -0.46",
      "   1   1   1   1   10.00    1.00   1", "",
    ].join("\n"), { strict: true });
    expect(Object.is(p.kVectors![0]![0], -0)).toBe(false);
    expect(p.kVectors).toEqual([[0, 0.5, -0.46]]);
  });

  it("preserves X (blank) descriptors so writer output re-slices correctly", () => {
    const refl = [{ h: 1, k: 2, l: 3, iObs: 12345.67, sigma: 234.56, code: 1 }];
    const text = writeFullProfInt(refl, { title: "X", wavelength: 1.0, format: "(3i4,2x,2f8.2,i4)" });
    const p = parseFullProfInt(text, { strict: true });
    expect(p.reflections[0]).toMatchObject({ h: 1, k: 2, l: 3, iObs: 12345.67, sigma: 234.56, code: 1 });
  });
});
