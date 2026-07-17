import { describe, it, expect } from "vitest";
import { parsePdfData, looksLikePdf, classifyReducedKind } from "@/parsers/pdfData";
import { dataExists, readData } from "@/testSupport/data";
import type { StructureModel, AtomSite, UnitCell } from "@/core/crystal/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { expandStructureAtoms } from "@/core/diffraction/structureFactor";
import { computeGofR, makeRGrid } from "@/core/pdf/forwardModel";
import { bandLimit } from "@/core/pdf/termination";

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

describe("classifyReducedKind", () => {
  it("extension wins", () => {
    expect(classifyReducedKind("", "x.sq")).toBe("sq");
    expect(classifyReducedKind("", "x.fq")).toBe("fq");
    expect(classifyReducedKind("", "x.gr")).toBe("gr");
  });
  it("header outputtype and #L labels", () => {
    expect(classifyReducedKind("outputtype = fq\n1 0.5", "x.dat")).toBe("fq");
    expect(classifyReducedKind("#L Q S(Q)\n1 1.02", "x.dat")).toBe("sq");
    expect(classifyReducedKind("#L r G(r)\n1 0.02", "x.dat")).toBe("gr");
  });
  it("baseline heuristic: y ≈ 1 at high Q reads as S(Q)", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [i * 0.5, 1 + 0.02 * Math.sin(i)]);
    expect(classifyReducedKind("", "x.dat", rows)).toBe("sq");
    const grRows = Array.from({ length: 40 }, (_, i) => [i * 0.5, 0.4 * Math.sin(i)]);
    expect(classifyReducedKind("", "x.dat", grRows)).toBe("gr");
  });
});

describe("S(Q)/F(Q) auto-transform to G(r)", () => {
  // Truth: a band-limited G(r) from the forward model; F(Q) by the forward
  // sine transform; the parser must invert it back to the truth.
  const IDENTITY_OP = { rotation: IDENTITY3, translation: [0, 0, 0] as const, xyz: "x,y,z" };
  const CELL: UnitCell = { a: 4.0, b: 4.0, c: 4.0, alpha: 90, beta: 90, gamma: 90 };
  const QMAX = 20;

  function truthG(): { r: Float64Array; g: Float64Array } {
    const sites: AtomSite[] = [{ label: "Ni1", element: "Ni", position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.6 } }];
    const model: StructureModel = { id: "s", name: "s", cell: CELL, spaceGroup: { operations: [IDENTITY_OP] }, sites };
    const r = makeRGrid(0.01, 30, 0.01);
    const raw = computeGofR(CELL, expandStructureAtoms(model), r, {
      scatteringType: "neutron", scale: 1, qdamp: 0.06, qbroad: 0, delta1: 0, delta2: 0,
    });
    return { r, g: bandLimit(raw, r[0]!, 0.01, QMAX) };
  }

  function forwardF(r: Float64Array, g: Float64Array): { q: number[]; f: number[] } {
    const q = Array.from({ length: 1000 }, (_, i) => (i + 1) * 0.02); // to Q = 20
    const f = q.map((qi) => {
      let acc = 0;
      for (let j = 0; j < r.length; j++) acc += g[j]! * Math.sin(qi * r[j]!) * 0.01;
      return acc;
    });
    return { q, f };
  }

  const { r, g } = truthG();
  const { q, f } = forwardF(r, g);

  function agreement(parsed: { points: readonly { r: number; gObs: number }[] }): number {
    // Compare on the common lattice (both grids are 0.01-step, 0-aligned).
    let num = 0;
    let den = 0;
    const byR = new Map(parsed.points.map((p) => [Math.round(p.r * 100), p.gObs]));
    for (let j = 0; j < r.length; j++) {
      const gp = byR.get(Math.round(r[j]! * 100));
      if (gp === undefined) continue;
      num += (gp - g[j]!) ** 2;
      den += g[j]! ** 2;
    }
    return Math.sqrt(num / den);
  }

  it(".fq parses, transforms, and recovers the truth G(r)", () => {
    const text = `outputtype = fq\nmode = neutron\nqmax = ${QMAX}\n#### start data\n${q.map((qi, i) => `${qi.toFixed(3)} ${f[i]!.toPrecision(8)}`).join("\n")}\n`;
    const p = parsePdfData(text, { filename: "t.fq" });
    expect(p.sourceKind).toBe("fq");
    expect(p.qmax).toBe(QMAX);
    expect(p.points.length).toBeGreaterThan(1000);
    expect(agreement(p)).toBeLessThan(0.05);
  });

  it(".sq parses via S = 1 + F/Q and recovers the same G(r)", () => {
    const s = q.map((qi, i) => 1 + f[i]! / qi);
    const text = `mode = neutron\nqmax = ${QMAX}\n#### start data\n${q.map((qi, i) => `${qi.toFixed(3)} ${s[i]!.toPrecision(8)}`).join("\n")}\n`;
    const p = parsePdfData(text, { filename: "t.sq" });
    expect(p.sourceKind).toBe("sq");
    expect(agreement(p)).toBeLessThan(0.05);
  });

  it("a plain .gr is untouched (sourceKind gr, points verbatim)", () => {
    const text = `mode = neutron\n#### start data\n0.01 0.5\n0.02 0.4\n0.03 0.3\n`;
    const p = parsePdfData(text, { filename: "t.gr" });
    expect(p.sourceKind).toBe("gr");
    expect(p.points).toHaveLength(3);
    expect(p.points[0]).toEqual({ r: 0.01, gObs: 0.5 });
  });
});

const GANB = "PDF/GaNb4Se8_28ID/GaNb4Se8_796_T_base_299.5K_T_FC0.0K_Sample_X_5.78mm_DetZ_3674.0mm_new_masked_L1_U98_q.dat_bgsub_scale_0.28_shift_110.gr";
const POWGEN = "PDF/Fe1Co9Sn_PG3/PG3_48288_PDF_1p7K_Q30.gr";

describe.skipIf(!dataExists(GANB))("real NSLS-II 28-ID synchrotron X-ray PDF (GaNb4Se8)", () => {
  // Read lazily inside the test: a skipped suite still executes this callback
  // at collection time, so a top-level readData would fail on machines/CI
  // without the git-ignored data/ folder (and break the deploy's test gate).
  it("parses composition, Q-range and a full G(r) with negative lobes", () => {
    const p = parsePdfData(readData(GANB), { filename: "GaNb4Se8_28ID.gr" });
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
  it("detects neutron, reads Qmax≈29.99 and carries per-point sigma", () => {
    const p = parsePdfData(readData(POWGEN), { filename: "PG3_48288_PDF_1p7K_Q30.gr" });
    expect(p.scatteringType).toBe("neutron");
    expect(p.qmax).toBeCloseTo(29.9866, 3);
    expect(p.points.length).toBeGreaterThan(1000);
    expect(p.points[0]!.r).toBeCloseTo(0.015, 6);
    expect(p.points.every((pt) => typeof pt.sigma === "number")).toBe(true);
  });
});
