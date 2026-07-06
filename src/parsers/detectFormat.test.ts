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

  it("(3) instrument decides when the header is silent", () => {
    const tof = detectDataFormat({ text: xy, filename: "x.dat", instrument: { kind: "tof", difC: 5000 } });
    expect(tof.xUnit).toBe("tof");
    expect(tof.source).toBe("instrument");

    const cw = detectDataFormat({ text: xy, filename: "x.dat", instrument: { kind: "constantWavelength", wavelength: 2.4 } });
    expect(cw.xUnit).toBe("twoTheta");
    expect(cw.source).toBe("instrument");
    expect(cw.radiation).toEqual({ kind: "neutron", wavelength: 2.4 });
  });

  it("recognizes a GSAS-II CSV as TOF, beating even a CW instrument", () => {
    const csv = `"limits",0.5,5.2\n"masked X","X","obs","calc","bkg","diff"\n--,3390,48,45,5,-2`;
    const d = detectDataFormat({ text: csv, filename: "fitted_results.csv", instrument: { kind: "constantWavelength", wavelength: 1.54 } });
    expect(d.xUnit).toBe("tof");
    expect(d.source).toBe("header");
    expect(d.confidence).toBe("high");
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
