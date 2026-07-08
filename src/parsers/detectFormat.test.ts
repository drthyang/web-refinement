import { describe, expect, it } from "vitest";
import { detectDataFormat, looksLikeReflectionList } from "@/parsers/detectFormat";

describe("looksLikeReflectionList", () => {
  it("detects GSAS reflection lists by header", () => {
    expect(looksLikeReflectionList("PWDR x Reflection List\n h k l m d\n 1 0 0 6 4.6")).toBe(true);
  });
  it("detects plain h k l I lists by integer triples", () => {
    expect(looksLikeReflectionList("1 0 0 12.3 0.4\n1 1 0 8.1 0.3\n2 0 0 0.5 0.1")).toBe(true);
  });
  it("rejects two-column powder data", () => {
    expect(looksLikeReflectionList("10.0 250\n10.1 260\n10.2 255")).toBe(false);
  });
});

describe("detectDataFormat — data type", () => {
  it("classifies reflection lists as single-crystal", () => {
    const d = detectDataFormat({ text: "1 0 0 5 0.2\n1 1 0 3 0.1\n2 0 0 1 0.1", filename: "x.hkl" });
    expect(d.dataType).toBe("single-crystal");
  });
  it("classifies xy data as powder", () => {
    const d = detectDataFormat({ text: "10 100\n10.1 110\n10.2 108", filename: "x.xy" });
    expect(d.dataType).toBe("powder");
  });
});

describe("detectDataFormat — x-unit priority chain", () => {
  const xy = "10 100\n20 120\n30 108\n40 130";

  it("(1) override wins over everything", () => {
    const d = detectDataFormat({ text: "2theta obs\n10 100\n20 120", filename: "x.xy", override: { xUnit: "q" } });
    expect(d.xUnit).toBe("q");
    expect(d.source).toBe("override");
  });

  it("(2) explicit header unit beats instrument", () => {
    const d = detectDataFormat({
      text: "# Q (A^-1)  I\n0.5 100\n1.0 120\n1.5 108",
      filename: "x.dat",
      instrument: { kind: "constantWavelength", wavelength: 1.54 },
    });
    expect(d.xUnit).toBe("q");
    expect(d.source).toBe("header");
  });

  it("detects TOF from a header keyword", () => {
    const d = detectDataFormat({ text: "Flight time (us)  counts\n3390 48\n3393 50\n3396 53", filename: "p.dat" });
    expect(d.xUnit).toBe("tof");
    expect(d.radiation).toEqual({ kind: "neutron-tof" });
  });

  it("(3) instrument decides when the header is silent and the magnitude agrees", () => {
    // TOF instrument + TOF-magnitude data (thousands of µs) → tof.
    const tof = detectDataFormat({ text: "3390 48\n3393 50\n3396 53\n3400 49", filename: "x.dat", instrument: { kind: "tof", difC: 5000 } });
    expect(tof.xUnit).toBe("tof");
    expect(tof.source).toBe("instrument");

    // CW instrument + 2θ-magnitude data → twoTheta.
    const cw = detectDataFormat({ text: xy, filename: "x.dat", instrument: { kind: "constantWavelength", wavelength: 2.4 } });
    expect(cw.xUnit).toBe("twoTheta");
    expect(cw.source).toBe("instrument");
    expect(cw.radiation).toEqual({ kind: "neutron", wavelength: 2.4 });
  });

  it("does not read constant-wavelength data as TOF just because a TOF instrument is selected", () => {
    // 2θ-range data (≤ 40) cannot be TOF (thousands of µs), so a still-selected
    // TOF instrument must not force it view-only.
    const d = detectDataFormat({ text: xy, filename: "x.xy", instrument: { kind: "tof", difC: 22585.8 } });
    expect(d.xUnit).not.toBe("tof");
  });

  it("preserves X-ray radiation from a GSAS-II PXC instrument file", () => {
    const d = detectDataFormat({
      text: "1.5,100\n1.6,120\n1.7,110",
      filename: "GaNb4Se8_799_T_298.8K_gsas.dat",
      instrument: { kind: "constantWavelength", radiationKind: "xray", wavelength: 0.1665 },
    });
    expect(d.xUnit).toBe("twoTheta");
    expect(d.radiation).toEqual({ kind: "xray", wavelength: 0.1665 });
  });

  it("recognizes a GSAS-II CSV as TOF, beating even a CW instrument", () => {
    const csv = `"limits",0.5,5.2\n"masked X","X","obs","calc","bkg","diff"\n--,3390,48,45,5,-2`;
    const d = detectDataFormat({ text: csv, filename: "fitted_results.csv", instrument: { kind: "constantWavelength", wavelength: 1.54 } });
    expect(d.xUnit).toBe("tof");
    expect(d.source).toBe("header");
    expect(d.confidence).toBe("high");
  });

  it("recognizes a raw GSAS histogram: SLOG→TOF, CONST→2θ, beating a mismatched instrument", () => {
    const slog = "Run 1 Wavelength: 1.5 A\nBANK 2 3 3 SLOG 11293 248344 0.0007999 0 FXYE\n11297 310 13\n11306 345 13\n11315 427 14";
    const d = detectDataFormat({ text: slog, filename: "PG3.gsa", instrument: { kind: "constantWavelength", wavelength: 1.54 } });
    expect(d.xUnit).toBe("tof");
    expect(d.radiation).toEqual({ kind: "neutron-tof" });
    expect(d.source).toBe("header");
    expect(d.confidence).toBe("high");

    const cw = detectDataFormat({ text: "CW\nBANK 1 3 3 CONST 1000 200 0 0 FXYE\n1000 50 7\n1200 60 8\n1400 55 7", filename: "cw.gsa" });
    expect(cw.xUnit).toBe("twoTheta");
    expect(cw.source).toBe("header");
  });

  it("(5) range heuristic is the low-confidence last resort", () => {
    const big = detectDataFormat({ text: "3390 5\n50000 8\n90000 3", filename: "x.dat" });
    expect(big.xUnit).toBe("tof");
    expect(big.source).toBe("heuristic");
    expect(big.confidence).toBe("low");

    const mid = detectDataFormat({ text: "10 100\n80 120\n150 108", filename: "x.dat" });
    expect(mid.xUnit).toBe("twoTheta");
    expect(mid.confidence).toBe("low");
  });
});
