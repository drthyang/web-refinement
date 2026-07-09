import { describe, it, expect } from "vitest";
import { dataExists, readData } from "@/testSupport/data";
import {
  parseGsasHistogram,
  parseGsasHistogramPattern,
  isGsasHistogram,
  gsasHistogramUnit,
  slogChannelCenters,
  constChannelCenters,
} from "@/parsers/gsasHistogram";

/** Right-justify `s` in a field of `width` spaces (for fixed-column fixtures). */
const rj = (s: string | number, width: number): string => String(s).padStart(width, " ");

describe("parseGsasHistogram — TOF SLOG FXYE (POWGEN-style)", () => {
  const text = [
    "Sample Run: 48278 Wavelength: 1.5 A",
    "# Instrument: POWGEN",
    "# Total flight path 63.18m, tth 90deg, DIFC 22585.8",
    "BANK 2 4 4 SLOG      11293     248344  0.0007999 0 FXYE",
    "       11297.393716962         310.698407517          12.960285395",
    "       11306.430107977         345.051709134          13.340849307",
    "       11315.473726886         427.472775944          14.186685030",
    "       11324.524579470         427.197424390          14.239378974",
  ].join("\n");

  it("keeps TOF abscissae in µs (does NOT divide by 100)", () => {
    const pat = parseGsasHistogramPattern(text, "id", "f.gsa");
    expect(pat.xUnit).toBe("tof");
    expect(pat.radiation).toEqual({ kind: "neutron-tof" });
    expect(pat.points).toHaveLength(4);
    expect(pat.points[0]!.x).toBeCloseTo(11297.39, 2);
    expect(pat.points[3]!.x).toBeCloseTo(11324.52, 2);
  });

  it("reads Y and the explicit esd from the third column", () => {
    const pat = parseGsasHistogramPattern(text, "id", "f.gsa");
    expect(pat.points[0]!.yObs).toBeCloseTo(310.698, 2);
    expect(pat.points[0]!.sigma).toBeCloseTo(12.9603, 3);
  });

  it("exposes bank metadata via parseGsasHistogram", () => {
    const hist = parseGsasHistogram(text);
    expect(hist.title).toContain("48278");
    expect(hist.wavelength).toBeCloseTo(1.5, 6);
    expect(hist.banks).toHaveLength(1);
    expect(hist.banks[0]!.bankNumber).toBe(2);
    expect(hist.banks[0]!.binType).toBe("SLOG");
    expect(hist.banks[0]!.dataType).toBe("FXYE");
    expect(hist.banks[0]!.coefficients).toEqual([11293, 248344, 0.0007999, 0]);
  });
});

describe("parseGsasHistogram — CW CONST formats", () => {
  it("divides the FXYE abscissa by 100 (centidegrees → 2θ°) for CONST", () => {
    const text = [
      "CW neutron test Wavelength: 1.54 A",
      "BANK 1 3 3 CONST 1000 200 0 0 FXYE",
      "1000 50 7",
      "1200 60 8",
      "1400 55 7",
    ].join("\n");
    const pat = parseGsasHistogramPattern(text, "id", "f.gsa");
    expect(pat.xUnit).toBe("twoTheta");
    expect(pat.radiation).toEqual({ kind: "neutron", wavelength: 1.54 });
    expect(pat.wavelength).toBeCloseTo(1.54, 6);
    expect(pat.points.map((p) => p.x)).toEqual([10, 12, 14]);
    expect(pat.points[0]!.sigma).toBeCloseTo(7, 6);
  });

  it("FXY assigns esd = √max(Y,1) when no esd column is present", () => {
    const text = ["t", "BANK 1 2 2 CONST 500 100 0 0 FXY", "500 100", "600 400"].join("\n");
    const pat = parseGsasHistogramPattern(text, "id", "f.gsa");
    expect(pat.points.map((p) => p.x)).toEqual([5, 6]);
    expect(pat.points[0]!.sigma).toBeCloseTo(10, 6); // √100
    expect(pat.points[1]!.sigma).toBeCloseTo(20, 6); // √400
  });

  it("STD count-packing: n (2 col) + I (6 col), esd = √(I/n), X from CONST", () => {
    // Two channels: (n=4, I=100) and (n=1, I=200).
    const line = rj(4, 2) + rj("100.00", 6) + rj(1, 2) + rj("200.00", 6);
    const text = ["t", "BANK 1 2 2 CONST 1000 200 0 0 STD", line].join("\n");
    const hist = parseGsasHistogram(text);
    const pts = hist.banks[0]!.points;
    expect(pts).toHaveLength(2);
    expect(pts[0]!.x).toBeCloseTo(10, 6); // (1000)/100
    expect(pts[1]!.x).toBeCloseTo(12, 6); // (1000 + 200)/100
    expect(pts[0]!.yObs).toBeCloseTo(100, 6);
    expect(pts[0]!.sigma).toBeCloseTo(Math.sqrt(100 / 4), 6); // 5
    expect(pts[1]!.yObs).toBeCloseTo(200, 6);
    expect(pts[1]!.sigma).toBeCloseTo(Math.sqrt(200 / 1), 6);
  });

  it("ESD fixed 16-col fields: 8-col Y + 8-col esd, X from CONST", () => {
    const line = rj("100.0", 8) + rj("10.0", 8) + rj("250.0", 8) + rj("15.0", 8);
    const text = ["t", "BANK 1 2 2 CONST 2000 500 0 0 ESD", line].join("\n");
    const pts = parseGsasHistogram(text).banks[0]!.points;
    expect(pts).toHaveLength(2);
    expect(pts[0]!.x).toBeCloseTo(20, 6);
    expect(pts[1]!.x).toBeCloseTo(25, 6);
    expect(pts[0]!.yObs).toBeCloseTo(100, 6);
    expect(pts[0]!.sigma).toBeCloseTo(10, 6);
    expect(pts[1]!.sigma).toBeCloseTo(15, 6);
  });
});

describe("parseGsasHistogram — multi-bank and edge cases", () => {
  const text = [
    "two banks",
    "BANK 1 2 2 CONST 1000 200 0 0 FXYE",
    "1000 50 7",
    "1200 60 8",
    "BANK 3 2 2 SLOG 5000 9000 0.001 0 FXYE",
    "5002.5 111 10",
    "5007.5 222 15",
  ].join("\n");

  it("parses every bank and can select one by bank number", () => {
    const hist = parseGsasHistogram(text);
    expect(hist.banks.map((b) => b.bankNumber)).toEqual([1, 3]);
    const first = parseGsasHistogramPattern(text, "id", "f");
    expect(first.xUnit).toBe("twoTheta");
    expect(first.points[0]!.x).toBeCloseTo(10, 6);
    const third = parseGsasHistogramPattern(text, "id", "f", { bank: 3 });
    expect(third.xUnit).toBe("tof");
    expect(third.points[0]!.x).toBeCloseTo(5002.5, 6);
  });

  it("keeps non-positive intensities without producing a non-finite sigma", () => {
    const t = ["t", "BANK 1 2 2 CONST 1000 200 0 0 FXYE", "1000 0 0", "1200 -5 0"].join("\n");
    const pts = parseGsasHistogram(t).banks[0]!.points;
    expect(pts[0]!.yObs).toBe(0);
    expect(Number.isFinite(pts[0]!.sigma!)).toBe(true);
    expect(pts[0]!.sigma!).toBeGreaterThan(0);
    expect(pts[1]!.yObs).toBe(-5);
    expect(Number.isFinite(pts[1]!.sigma!)).toBe(true);
  });

  it("throws for STD/ESD under RALF binning (no validated implicit-X model)", () => {
    const t = ["t", "BANK 1 1 1 RALF 100 5 200 1 STD", rj(1, 2) + rj("10.0", 6)].join("\n");
    expect(() => parseGsasHistogram(t)).toThrow(/RALF/);
  });

  it("is not fooled by a prose title line that starts with 'BANK '", () => {
    // "BANK ALIGNMENT run 2024" must be treated as a header, not a data record.
    const text = [
      "BANK ALIGNMENT run 2024",
      "# comment",
      "BANK 2 3 3 SLOG 11293 248344 0.0007999 0 FXYE",
      "11297.4 310 12",
      "11306.4 345 13",
      "11315.5 427 14",
    ].join("\n");
    expect(gsasHistogramUnit(text)).toBe("tof");
    const hist = parseGsasHistogram(text);
    expect(hist.banks).toHaveLength(1);
    expect(hist.banks[0]!.binType).toBe("SLOG");
    expect(hist.banks[0]!.points).toHaveLength(3);
  });

  it("ignores a trailing comment after the DATTYP token", () => {
    const text = ["t", "BANK 2 2 2 SLOG 11293 248344 0.0007999 0 FXYE ! POWGEN bank 2", "11297.4 310 12", "11306.4 345 13"].join("\n");
    const bank = parseGsasHistogram(text).banks[0]!;
    expect(bank.dataType).toBe("FXYE");
    expect(bank.coefficients).toEqual([11293, 248344, 0.0007999, 0]);
    expect(bank.points).toHaveLength(2);
  });

  it("reads STD records wider than the nominal 80 columns (>10 fields)", () => {
    let line = "";
    for (let k = 0; k < 12; k++) line += rj(1, 2) + rj((100 + k).toFixed(0), 6); // 96 cols
    const text = ["t", "BANK 1 12 1 CONST 1000 100 0 0 STD", line].join("\n");
    const pts = parseGsasHistogram(text).banks[0]!.points;
    expect(pts).toHaveLength(12);
    expect(pts[11]!.yObs).toBeCloseTo(111, 6);
  });

  it("detects a BANK record hidden behind a long (>60-line) metadata header", () => {
    const header = ["POWGEN title"];
    for (let k = 0; k < 70; k++) header.push(`# metadata line ${k}`);
    const text = [...header, "BANK 2 2 2 SLOG 11293 248344 0.0007999 0 FXYE", "11297.4 310 12", "11306.4 345 13"].join("\n");
    // isGsasHistogram must agree with gsasHistogramUnit regardless of header size.
    expect(isGsasHistogram(text)).toBe(true);
    expect(gsasHistogramUnit(text)).toBe("tof");
  });
});

describe("gsasHistogram detection + binning math", () => {
  it("isGsasHistogram recognizes a BANK record and rejects other formats", () => {
    expect(isGsasHistogram("t\nBANK 2 4 4 SLOG 1 2 0.001 0 FXYE\n1 2 3")).toBe(true);
    expect(isGsasHistogram('"limits",5,120\n"X","obs","calc"\n--,5,10,9')).toBe(false);
    expect(isGsasHistogram("10.0 250 15\n10.1 260 15")).toBe(false);
  });

  it("gsasHistogramUnit maps SLOG→tof and CONST→twoTheta", () => {
    expect(gsasHistogramUnit("t\nBANK 2 4 4 SLOG 1 2 0.001 0 FXYE")).toBe("tof");
    expect(gsasHistogramUnit("t\nBANK 1 3 3 CONST 1000 200 0 0 FXYE")).toBe("twoTheta");
    expect(gsasHistogramUnit("10 20 30")).toBeNull();
  });

  it("SLOG centers follow start·(1+Δ)^(i+½); CONST centers are (start+step·i)/100", () => {
    const s = slogChannelCenters(11293, 0.0007999, 3);
    expect(s[0]).toBeCloseTo(11293 * Math.pow(1.0007999, 0.5), 6);
    expect(s[1]! / s[0]!).toBeCloseTo(1.0007999, 9);
    expect(constChannelCenters(1000, 200, 3)).toEqual([10, 12, 14]);
  });
});

// ---- Validation against the real local POWGEN .gsa files (git-ignored) -------
const REAL = "FeCoSn/PG3_48278.gsa";
const hasReal = dataExists(REAL);

describe.skipIf(!hasReal)("real .gsa — POWGEN FeCoSn (SLOG FXYE, bank 2)", () => {
  const text = hasReal ? readData(REAL) : "";

  it("parses the full histogram: nchan points, TOF µs, strictly increasing", () => {
    const hist = parseGsasHistogram(text);
    const bank = hist.banks[0]!;
    expect(bank.binType).toBe("SLOG");
    expect(bank.dataType).toBe("FXYE");
    expect(bank.points).toHaveLength(bank.nchan); // 3866
    const xs = bank.points.map((p) => p.x);
    expect(xs[0]!).toBeGreaterThan(11000);
    expect(xs[0]!).toBeLessThan(12000); // µs, not centidegrees
    expect(xs[xs.length - 1]!).toBeGreaterThan(240000);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(xs.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("SLOG recurrence reproduces the explicit FXYE abscissa (validates the model)", () => {
    const bank = parseGsasHistogram(text).banks[0]!;
    const [c1, , c3] = bank.coefficients;
    const centers = slogChannelCenters(c1!, c3!, bank.nchan);
    const xs = bank.points.map((p) => p.x);
    // The reconstructed centers track the file's explicit column to < 0.5%.
    let maxRel = 0;
    for (let i = 0; i < xs.length; i++) maxRel = Math.max(maxRel, Math.abs(centers[i]! - xs[i]!) / xs[i]!);
    expect(maxRel).toBeLessThan(5e-3);
    // The half-channel offset (i+½) is real: it fits X[0] far better than (i).
    const withHalf = Math.abs(c1! * Math.pow(1 + c3!, 0.5) - xs[0]!);
    const without = Math.abs(c1! - xs[0]!);
    expect(withHalf).toBeLessThan(without);
  });
});

/**
 * Mantid "Y multiplied by the bin widths" (counts-per-bin) must be undone on
 * load — for SLOG (log-spaced) TOF the bin width grows ∝ TOF, so leaving it
 * produces a spurious rising ("tilted") background. Dividing Y and σ by the
 * local bin width recovers the flat intensity density the refinement expects.
 */
describe("GSAS SLOG: undo Mantid 'Y × bin width' (tilted-background fix)", () => {
  // 4 SLOG channels; widths (central diff of centres): [100, 105, 115.5, 121].
  const body = [
    "BANK 1 4 4 SLOG 1000 1400 0.1 0 FXYE",
    "1000 100 10",
    "1100 110 10.5",
    "1210 121 11",
    "1331 133 11.5",
  ].join("\n");
  const marked = "Sample\n# with Y multiplied by the bin widths\n" + body;
  const plain = "Sample\n# raw counts\n" + body;

  it("divides Y (and σ) by the local bin width when the header declares it", () => {
    const p = parseGsasHistogramPattern(marked, "g", "g");
    // point 1: y = 110 / 105 ≈ 1.0476; σ = 10.5 / 105 = 0.1.
    expect(p.points[1]!.yObs).toBeCloseTo(110 / 105, 4);
    expect(p.points[1]!.sigma).toBeCloseTo(10.5 / 105, 4);
    // Relative error is preserved by dividing both by the same width.
    expect(p.points[1]!.sigma! / p.points[1]!.yObs).toBeCloseTo(10.5 / 110, 6);
  });

  it("leaves intensities untouched without the marker", () => {
    const p = parseGsasHistogramPattern(plain, "g", "g");
    expect(p.points[1]!.yObs).toBe(110);
    expect(p.points[1]!.sigma).toBe(10.5);
  });

  it("flattens a background that rises with the bin width", () => {
    // Flat density 2.0 stored as counts-per-bin (2·Δx) should read back ≈ 2.0
    // at every channel despite the growing bin width.
    const widths = [100, 105, 115.5, 121];
    const centres = [1000, 1100, 1210, 1331];
    const lines = centres.map((x, i) => `${x} ${2 * widths[i]!} ${Math.sqrt(2 * widths[i]!).toFixed(4)}`);
    const text = "Sample\n# with Y multiplied by the bin widths\nBANK 1 4 4 SLOG 1000 1400 0.1 0 FXYE\n" + lines.join("\n");
    const p = parseGsasHistogramPattern(text, "g", "g");
    for (const pt of p.points) expect(pt.yObs).toBeCloseTo(2.0, 3);
  });
});
