import { describe, it, expect } from "vitest";
import { parseCif } from "@/parsers/cif";
import { parseInstrumentParameters } from "@/parsers/instrument";
import { parsePowderData } from "@/parsers/powderData";
import { detectDataFormat } from "@/parsers/detectFormat";
import { generateReflections } from "@/core/diffraction/reflections";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { dSpacing } from "@/core/crystal/unitCell";
import { powderCurves } from "@/core/workflow/powder";
import { dataExists, readData } from "@/testSupport/data";
import type { RefinementParameter } from "@/core/refinement/types";

/**
 * Real POWGEN time-of-flight neutron data (100 K) on the high-entropy tungstate
 * (Co,Cu,Fe,Mn,Ni,Zn)WO₄ — wolframite-type, monoclinic P2/c, with six 3d cations
 * disordered on one site at occ ≈ 1/6 each. This is the app's default dataset
 * (loaded from data/ at runtime; see app/powgenData.ts), replacing the
 * self-consistent Mn₃Ga synthetic demo as the primary real-data check.
 *
 * TOF profile refinement is not in the engine yet (roadmap M1), so the pattern is
 * exercised **view-only** here: parsing, indexing, and a crash-free calculation
 * that (correctly) produces no Bragg peaks on a TOF abscissa. Skips when the
 * git-ignored data/ folder is absent.
 */

const DIR = "POWGEN_HighEntropy_100K";
const CIF = `${DIR}/100K_HR_Co1_Fe1_Mn1_Ni1_O1_W1_Zn1.cif`;
const GSAS = `${DIR}/GSAS2_2025B_HighRes_60HzB3_CWL2p665.instprm`;
const JANA = `${DIR}/JANA_2025B_HighRes_60Hz_CWL2p665_Frame3.instprm`;
const DAT = `${DIR}/PG3_61133-3.dat`;
const has = dataExists(CIF) && dataExists(DAT);

const CATIONS = ["Co1", "Fe1", "Ni1", "Mn1", "Cu8", "Zn1"];

describe.skipIf(!has)("real powder TOF — POWGEN high-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄", () => {
  it("parses the P2/c structure with six disordered cations on one 2f site", () => {
    const s = parseCif(readData(CIF), "powgen");
    expect(s.spaceGroup.operations.length).toBe(4);
    expect(s.spaceGroup.hermannMauguin).toBe("P 2/c");
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
    // All six cations share the same crystallographic position (the disordered site).
    const p0 = cations[0]!.position;
    for (const c of cations) expect(c!.position).toEqual(p0);
    // Their occupancies sum to ≈ 1 on the shared site.
    expect(cations.reduce((a, c) => a + c!.occupancy, 0)).toBeCloseTo(1.002, 3);
    // W and O sites are ordered.
    expect(s.sites.find((x) => x.label === "W1")!.occupancy).toBe(1);
    expect(s.sites.filter((x) => x.element === "O")).toHaveLength(2);
  });

  it("reads both the GSAS and JANA TOF instrument calibrations", () => {
    const g = parseInstrumentParameters(readData(GSAS));
    expect(g.kind).toBe("tof");
    if (g.kind === "tof") {
      expect(g.difC).toBeCloseTo(22600, 0);
      expect(g.difA).toBeCloseTo(-6.74, 2);
      expect(g.difB).toBeCloseTo(-5.32, 2);
      expect(g.zero ?? 0).toBeCloseTo(0, 3);
    }
    const j = parseInstrumentParameters(readData(JANA));
    expect(j.kind).toBe("tof");
    if (j.kind === "tof") {
      expect(j.difC).toBeCloseTo(22596.65, 1);
      expect(j.zero).toBeCloseTo(0.7284, 3);
    }
  });

  it("detects TOF from the Mantid header and loads 3670 points with errors", () => {
    const text = readData(DAT);
    const fmt = detectDataFormat({ text, filename: "PG3_61133-3.dat" });
    expect(fmt.xUnit).toBe("tof");
    expect(fmt.source).toBe("header");
    expect(fmt.radiation.kind).toBe("neutron-tof");

    const pattern = parsePowderData(text, { id: "p", name: "POWGEN", xUnit: "tof", radiation: { kind: "neutron-tof" } });
    expect(pattern.points.length).toBe(3670);
    expect(pattern.points[0]!.sigma).toBeGreaterThan(0);
    const xs = pattern.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeGreaterThan(20000);
    expect(Math.max(...xs)).toBeGreaterThan(400000);
  });

  it("generates monoclinic reflections with β-split (hkl)/(hk-l) peaks", () => {
    const s = parseCif(readData(CIF), "powgen");
    const refl = generateReflections(s.cell, s.spaceGroup, 0.5, 5.0);
    expect(refl.length).toBeGreaterThan(500);
    // β ≠ 90 breaks the l → −l degeneracy: (111) and (11-1) have distinct d.
    const has111 = refl.some((r) => r.h === 1 && r.k === 1 && r.l === 1);
    const has11m1 = refl.some((r) => r.h === 1 && r.k === 1 && r.l === -1);
    expect(has111).toBe(true);
    expect(has11m1).toBe(true);
    const d111 = dSpacing(s.cell, 1, 1, 1);
    const d11m1 = dSpacing(s.cell, 1, 1, -1);
    expect(Math.abs(d111 - d11m1)).toBeGreaterThan(0.005);
  });

  it("loads TOF view-only: finite calculation, no Bragg peaks (not modelled)", () => {
    const s = parseCif(readData(CIF), "powgen");
    const pattern = parsePowderData(readData(DAT), { id: "p", name: "POWGEN", xUnit: "tof", radiation: { kind: "neutron-tof" } });
    const params: RefinementParameter[] = [
      { id: "scale", label: "s", kind: "scale", value: 1, initialValue: 1, fixed: false },
    ];
    const curves = powderCurves(s, pattern, params, [{ parameterId: "scale", kind: "scale", targetId: pattern.id }]);
    expect(curves.yCalc.length).toBe(pattern.points.length);
    // No NaN poisoning from the un-modelled TOF centers, and no calculated peaks.
    expect(curves.yCalc.every((y) => Number.isFinite(y))).toBe(true);
    expect(Math.max(...curves.yCalc)).toBe(0);
  });
});
