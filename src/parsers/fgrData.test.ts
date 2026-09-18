/**
 * PDFgui .fgr fit-export reader: header keys, column semantics (the G(r)
 * column is the CALCULATED curve; observed = Gcalc + Gdiff), signal selection,
 * and format routing. All fixture numbers are synthetic.
 */
import { describe, it, expect } from "vitest";
import { looksLikeFgr, parseFgr, fgrToPattern } from "@/parsers/fgrData";
import { detectDataFormat } from "@/parsers/detectFormat";
import * as tools from "@/mcp/tools";

const FGR = `History written: Tue Jan  6 12:00:00 2026
produced by test
##### PDFgui fit
stype=N  neutron scattering
qmax=25.00
qdamp=0.005
qbroad=0.02
dscale=0.08
fitrmin=0.1
fitrmax=20
##### start data
#L r(A) G(r) d_r d_Gr Gdiff
1.0 0.5 0.0 -0.25 -0.25
1.1 1.0 0.0 0.5 0.5
1.2 -2.0 0.0 0.75 0.75
1.3 0.0 0.0 -1.0 -1.0
`;

describe("parseFgr", () => {
  it("reads the PDFgui header keys", () => {
    const fgr = parseFgr(FGR);
    expect(fgr.scatteringType).toBe("neutron");
    expect(fgr.qmax).toBe(25);
    expect(fgr.qdamp).toBe(0.005);
    expect(fgr.qbroad).toBe(0.02);
    expect(fgr.dscale).toBe(0.08);
    expect(fgr.fitrmin).toBe(0.1);
    expect(fgr.fitrmax).toBe(20);
  });

  it("maps columns: G(r) is the CALC curve, observed = Gcalc + Gdiff", () => {
    const fgr = parseFgr(FGR);
    expect(fgr.r).toEqual([1.0, 1.1, 1.2, 1.3]);
    expect(fgr.gCalc).toEqual([0.5, 1.0, -2.0, 0.0]);
    expect(fgr.gDiff).toEqual([-0.25, 0.5, 0.75, -1.0]);
    expect(fgr.gObs).toEqual([0.25, 1.5, -1.25, -1.0]);
  });

  it("fgrToPattern: observed (default) vs difference signal", () => {
    const fgr = parseFgr(FGR);
    const obs = fgrToPattern(fgr, { filename: "toy.fgr" });
    expect(obs.points.map((p) => p.gObs)).toEqual(fgr.gObs);
    expect(obs.sourceKind).toBe("fgr");
    expect(obs.qmax).toBe(25);
    expect(obs.qdamp).toBe(0.005);
    expect(obs.scatteringType).toBe("neutron");
    const diff = fgrToPattern(fgr, { filename: "toy.fgr", signal: "difference" });
    expect(diff.points.map((p) => p.gObs)).toEqual(fgr.gDiff);
    expect(diff.sourceKind).toBe("fgr-diff");
    expect(diff.name).toContain("Gdiff");
  });
});

describe(".fgr format routing", () => {
  it("looksLikeFgr: extension or PDFgui header, but not a plain .gr", () => {
    expect(looksLikeFgr("", "fit.fgr")).toBe(true);
    expect(looksLikeFgr(FGR, "unknown.dat")).toBe(true);
    expect(looksLikeFgr("# some header\n1.0 0.5\n", "obs.gr")).toBe(false);
  });

  it("detectDataFormat routes .fgr to the PDF workbench with an fgr note", () => {
    const d = detectDataFormat({ text: FGR, filename: "fit.fgr" });
    expect(d.dataType).toBe("pdf");
    expect(d.note).toContain("PDFgui fit export");
  });

  it("parse_pdf_data (MCP): observed rebuild by default, residual on demand", () => {
    const obs = tools.parse_pdf_data({ text: FGR, filename: "fit.fgr" });
    expect(obs.pattern.sourceKind).toBe("fgr");
    expect(obs.pattern.points.map((p) => p.gObs)).toEqual([0.25, 1.5, -1.25, -1.0]);
    expect(obs.summary.dscale).toBe(0.08);
    expect(obs.summary.fitrmax).toBe(20);
    const diff = tools.parse_pdf_data({ text: FGR, filename: "fit.fgr", signal: "difference" });
    expect(diff.pattern.sourceKind).toBe("fgr-diff");
    expect(diff.detected.note).toContain("RESIDUAL");
    // `signal` is an .fgr-only knob — a plain .gr must reject it loudly.
    expect(() => tools.parse_pdf_data({ text: "1.0 0.5\n1.1 0.4\n1.2 0.3\n", filename: "x.gr", signal: "difference" }))
      .toThrow(/fgr/);
  });
});
