import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { detectDataFormat } from "@/parsers/detectFormat";
import {
  parseGsasHistogram,
  parseGsasHistogramPattern,
  slogChannelCenters,
} from "@/parsers/gsasHistogram";
import { powderCurves } from "@/core/workflow/powder";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { dataExists, readData } from "@/testSupport/data";
import type { RefinementParameter } from "@/core/refinement/types";

/**
 * Real POWGEN time-of-flight neutron data on the high-entropy tungstate AWO₄
 * (wolframite-type, monoclinic P2/c; six 3d cations disordered on one site) —
 * loaded from the raw GSAS `.gsa` histograms (BANK/SLOG/FXYE) the new parser
 * handles, across the three POWGEN detector banks (different frames → different
 * TOF ranges and channel counts). Skips when the git-ignored data/ folder is
 * absent.
 */

const DIR = "AWO4";
const CIF = `${DIR}/AWO4_HE_100K_refined.cif`;
const INSTPRM = `${DIR}/GSAS-II_2025B_HR/2025B_HighRes_60HzB3_CWL2p665.instprm`;
const GSA = {
  bank1: `${DIR}/autoreduced/PG3_61114.gsa`,
  bank2: `${DIR}/autoreduced/PG3_61102.gsa`,
  bank3: `${DIR}/autoreduced/PG3_61115.gsa`,
};
const has = dataExists(CIF) && dataExists(GSA.bank1);
const CATIONS = ["Co1", "Fe1", "Ni1", "Mn1", "Cu8", "Zn1"];

describe.skipIf(!has)("real AWO₄ — POWGEN neutron TOF, raw .gsa histograms", () => {
  it("parses the P2/c structure with six disordered cations on one 2f site", () => {
    const s = parseCif(readData(CIF), "awo4");
    expect(s.spaceGroup.hermannMauguin).toBe("P 2/c");
    expect(s.spaceGroup.operations.length).toBe(4);
    expect(s.cell.a).toBeCloseTo(4.6757, 3);
    expect(s.cell.b).toBeCloseTo(5.701, 3);
    expect(s.cell.c).toBeCloseTo(4.9367, 3);
    expect(s.cell.beta).toBeCloseTo(89.312, 3);

    const cations = CATIONS.map((l) => s.sites.find((x) => x.label === l));
    for (const c of cations) {
      expect(c).toBeDefined();
      expect(c!.occupancy).toBeCloseTo(0.167, 3);
      expect(siteMultiplicity(s.spaceGroup.operations, c!.position)).toBe(2);
    }
    const p0 = cations[0]!.position;
    for (const c of cations) expect(c!.position).toEqual(p0);
    expect(cations.reduce((a, c) => a + c!.occupancy, 0)).toBeCloseTo(1.002, 3);
    expect(s.sites.find((x) => x.label === "W1")!.occupancy).toBe(1);
    expect(s.sites.filter((x) => x.element === "O")).toHaveLength(2);
  });

  it("reads the POWGEN TOF instrument calibration (.instprm)", () => {
    const g = parseInstrumentParameters(readData(INSTPRM));
    expect(g.kind).toBe("tof");
    if (g.kind === "tof") {
      expect(g.difC).toBeCloseTo(22600, 0);
      expect(g.difA).toBeCloseTo(-6.74, 2);
      expect(g.difB).toBeCloseTo(-5.32, 2);
    }
  });

  it("parses the .gsa histograms for banks 1, 2 and 3 via the new parser", () => {
    for (const [key, rel] of Object.entries(GSA)) {
      if (!dataExists(rel)) continue;
      const text = readData(rel);
      const hist = parseGsasHistogram(text);
      expect(hist.banks).toHaveLength(1);
      const bank = hist.banks[0]!;
      expect(bank.binType).toBe("SLOG");
      expect(bank.dataType).toBe("FXYE");

      const pat = parseGsasHistogramPattern(text, key, rel);
      expect(pat.xUnit).toBe("tof");
      expect(pat.radiation).toEqual({ kind: "neutron-tof" });
      // One point per declared channel.
      expect(pat.points).toHaveLength(bank.nchan);

      const xs = pat.points.map((p) => p.x);
      // TOF microseconds, thousands+, strictly increasing.
      expect(xs[0]!).toBeGreaterThan(1000);
      for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
      expect(xs.every((x) => Number.isFinite(x))).toBe(true);
      expect(pat.points.every((p) => (p.sigma ?? 0) > 0)).toBe(true);

      // The SLOG channel-center law reproduces the explicit FXYE abscissa.
      const [c1, , c3] = bank.coefficients;
      const centers = slogChannelCenters(c1!, c3!, bank.nchan);
      let maxRel = 0;
      for (let i = 0; i < xs.length; i++) maxRel = Math.max(maxRel, Math.abs(centers[i]! - xs[i]!) / xs[i]!);
      expect(maxRel).toBeLessThan(5e-3);
    }
  });

  it("detects a .gsa as TOF from its BANK record, beating a mismatched instrument", () => {
    const fmt = detectDataFormat({
      text: readData(GSA.bank1),
      filename: "PG3_61114.gsa",
      instrument: { kind: "constantWavelength", wavelength: 1.54 },
    });
    expect(fmt.xUnit).toBe("tof");
    expect(fmt.source).toBe("header");
    expect(fmt.confidence).toBe("high");
    expect(fmt.radiation).toEqual({ kind: "neutron-tof" });
  });

  it("loads a .gsa view-only: finite calculation, no NaN (TOF profile stage-gated)", () => {
    const s = parseCif(readData(CIF), "awo4");
    const pattern = parseGsasHistogramPattern(readData(GSA.bank3), "p", "AWO4 bank3");
    const params: RefinementParameter[] = [
      { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false },
    ];
    const curves = powderCurves(s, pattern, params, [
      { parameterId: "scale", kind: "scale", targetId: pattern.id },
    ]);
    expect(curves.yCalc.length).toBe(pattern.points.length);
    expect(curves.yCalc.every((y) => Number.isFinite(y))).toBe(true);
  });
});
