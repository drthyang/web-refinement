import { describe, it, expect } from "vitest";
import { parsePdfData, looksLikePdf } from "@/parsers/pdfData";
import { dataExists, readData } from "@/testSupport/data";

const DIFFPY_XRAY = `[DEFAULT]

version = diffpy.pdfgetx-2.2.1

mode = xray
composition = Ga Nb4 Se8
qmaxinst = 34.2231
qmin = 0.5
qmax = 28
rmin = 0
rmax = 100
rstep = 0.01
rpoly = 0.8

#### start data
#S 1
#L r(Å)  G(Å$^{-2}$)
0 0
0.01 0.382597
0.02 0.731326
0.03 1.01823
`;

const MANTID_NEUTRON = `#Comment: neutron, Qmin=0.910607, Qmax=34.9906
##### start data
#S 1 - PDF from Mantid 6.10.0.1
#L r G(r) dr dG(r)
  0.015  1166.69  0  0.0368321
  0.025  2275.72  0  0.0713245
  0.185  -407.453  0  0.124302
`;

describe("parsePdfData — diffpy PDFgetX3 (X-ray) dialect", () => {
  const p = parsePdfData(DIFFPY_XRAY, { filename: "sample.gr" });

  it("detects X-ray from mode= and reads composition + Q metadata", () => {
    expect(p.scatteringType).toBe("xray");
    expect(p.composition).toBe("Ga Nb4 Se8");
    expect(p.qmax).toBe(28);
    expect(p.qmaxInst).toBeCloseTo(34.2231, 4); // must NOT be swallowed by qmax
    expect(p.qmin).toBe(0.5);
    expect(p.rpoly).toBe(0.8);
    expect(p.rstep).toBe(0.01);
  });

  it("reads the two-column r/G table (no sigma), keeping the r=0 origin", () => {
    expect(p.points).toHaveLength(4);
    expect(p.points[0]).toEqual({ r: 0, gObs: 0 });
    expect(p.points[3]!.r).toBeCloseTo(0.03, 6);
    expect(p.points[3]!.gObs).toBeCloseTo(1.01823, 5);
    expect(p.points[1]!.sigma).toBeUndefined();
  });
});

describe("parsePdfData — Mantid (neutron) dialect", () => {
  const p = parsePdfData(MANTID_NEUTRON, { filename: "PG3.gr" });

  it("detects neutron from the #Comment and reads Qmin/Qmax", () => {
    expect(p.scatteringType).toBe("neutron");
    expect(p.qmin).toBeCloseTo(0.910607, 5);
    expect(p.qmax).toBeCloseTo(34.9906, 4);
  });

  it("maps the 4-column #L header so sigma comes from dG(r), not dr", () => {
    expect(p.points).toHaveLength(3);
    expect(p.points[0]!.r).toBeCloseTo(0.015, 6);
    expect(p.points[0]!.gObs).toBeCloseTo(1166.69, 2);
    expect(p.points[0]!.sigma).toBeCloseTo(0.0368321, 6); // dG col, not the dr=0 col
    expect(p.points[2]!.gObs).toBeLessThan(0); // signed ordinate preserved
  });
});

describe("looksLikePdf", () => {
  it("fires on .gr filenames and known header signatures", () => {
    expect(looksLikePdf("", "foo.gr")).toBe(true);
    expect(looksLikePdf(DIFFPY_XRAY, "x.dat")).toBe(true);
    expect(looksLikePdf(MANTID_NEUTRON, "x.dat")).toBe(true);
  });
  it("does not fire on a plain 2θ powder pattern", () => {
    expect(looksLikePdf("10.0 1234\n10.1 1250\n", "scan.xy")).toBe(false);
  });
});

const GANB = "PDF/GaNb4Se8_28ID/GaNb4Se8_796_T_base_299.5K_T_FC0.0K_Sample_X_5.78mm_DetZ_3674.0mm_new_masked_L1_U98_q.dat_bgsub_scale_0.28_shift_110.gr";
const POWGEN = "PDF/Fe1Co9Sn_PG3/PG3_48288_PDF_1p7K_Q30.gr";

describe.skipIf(!dataExists(GANB))("real NSLS-II 28-ID synchrotron X-ray PDF (GaNb4Se8)", () => {
  const p = parsePdfData(readData(GANB), { filename: "GaNb4Se8_28ID.gr" });
  it("parses composition, Q-range and a full G(r) with negative lobes", () => {
    expect(p.scatteringType).toBe("xray");
    expect(p.composition).toBe("Ga Nb4 Se8");
    expect(p.qmax).toBe(28);
    expect(p.qmaxInst).toBeCloseTo(34.2231, 3);
    expect(p.points.length).toBeGreaterThan(5000);
    expect(p.points[0]).toEqual({ r: 0, gObs: 0 });
    // r strictly increasing on the reduced grid
    expect(p.points[10]!.r).toBeGreaterThan(p.points[9]!.r);
    expect(p.points.some((pt) => pt.gObs < 0)).toBe(true);
  });
});

describe.skipIf(!dataExists(POWGEN))("real POWGEN neutron PDF (Fe0.1Co0.9Sn, Q30)", () => {
  const p = parsePdfData(readData(POWGEN), { filename: "PG3_48288_PDF_1p7K_Q30.gr" });
  it("detects neutron, reads Qmax≈29.99 and carries per-point sigma", () => {
    expect(p.scatteringType).toBe("neutron");
    expect(p.qmax).toBeCloseTo(29.9866, 3);
    expect(p.points.length).toBeGreaterThan(1000);
    expect(p.points[0]!.r).toBeCloseTo(0.015, 6);
    expect(p.points.every((pt) => typeof pt.sigma === "number")).toBe(true);
  });
});
