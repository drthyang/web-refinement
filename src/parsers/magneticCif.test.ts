import { describe, it, expect } from "vitest";
import type { MagneticCifResult } from "@/parsers/cif";
import { parseMagneticCif } from "@/parsers/cif";
import { parseReflectionList } from "@/parsers/reflectionList";
import { cellVolume } from "@/core/crystal/unitCell";
import { momentCartesian } from "@/core/magnetic/moment";
import { norm } from "@/core/math/vec3";
import { dataExists, readData } from "@/testSupport/data";

// Read/parse only when present; suites are skipped (values never dereferenced)
// when the git-ignored data/ folder is absent (e.g. on CI).
const parseIfPresent = (present: boolean, rel: string, id: string): MagneticCifResult =>
  (present ? parseMagneticCif(readData(rel), id) : { structure: null, magnetic: null }) as MagneticCifResult;

const MCIF_30K = "30K/Mn3Ga_monoclinic-mag_1_30K_SatoshiModel_FitMoment_Final_magneticUnit.cif";
const ORTHO_350K = "350K/Mn3Ga-mag_53_350K_Final_ortho.cif";
const HKL_30K = "30K/fitted_results_hkl.dat";
const has30k = dataExists(MCIF_30K);
const has350k = dataExists(ORTHO_350K);
const hasHkl = dataExists(HKL_30K);

describe.skipIf(!has30k)("parseMagneticCif — 30 K monoclinic magnetic structure", () => {
  const { structure, magnetic } = parseIfPresent(has30k, MCIF_30K, "mn3ga-30k");

  it("reads the monoclinic magnetic cell", () => {
    expect(structure.cell.a).toBeCloseTo(5.420057, 5);
    expect(structure.cell.beta).toBeCloseTo(60.6939, 3);
    expect(cellVolume(structure.cell)).toBeCloseTo(109.165, 1);
  });

  it("reads the BNS magnetic space group with 4 time-reversal operations", () => {
    expect(structure.spaceGroup.hermannMauguin).toContain("P 21'/m'");
    expect(structure.spaceGroup.operations).toHaveLength(4);
    // Operation 2 (-x,1/2+y,-z,-1) carries time reversal −1.
    expect(structure.spaceGroup.operations[1]!.timeReversal).toBe(-1);
    expect(structure.spaceGroup.operations[0]!.timeReversal).toBe(1);
  });

  it("reads 3 magnetic moments (zero Ga moment skipped)", () => {
    expect(magnetic).not.toBeNull();
    expect(magnetic!.moments).toHaveLength(3);
    const mn1 = magnetic!.moments.find((m) => m.siteLabel === "Mn1_0")!;
    expect(mn1.components[0]).toBeCloseTo(-1.57, 2);
    expect(mn1.components[2]).toBeCloseTo(-1.34, 2);
  });
});

describe.skipIf(!has30k)("magnetic moment magnitudes — validated against GSAS-II .lst", () => {
  // GSAS-II .lst (30 K) reports total moments: Mn1_0 2.527, Mn2_1 2.829, Mn3_2 2.530 μB.
  // Moment components in crystal axes, magnitude via the normalized-axis metric.
  const { structure } = parseIfPresent(has30k, MCIF_30K, "mn3ga-30k");
  const mag = (comps: [number, number, number]): number =>
    norm(momentCartesian(structure.cell, { siteLabel: "x", frame: "crystallographic", components: comps }));

  it("Mn1_0 (−1.57657, 0, −1.34917) → 2.527 μB", () => {
    expect(mag([-1.57657, 0, -1.34917])).toBeCloseTo(2.527, 2);
  });
  it("Mn2_1 (−2.77619, 0, 2.82225) → 2.829 μB", () => {
    expect(mag([-2.77619, 0, 2.82225])).toBeCloseTo(2.829, 2);
  });
  it("Mn3_2 (2.71668, 0, −2.21750) → 2.530 μB", () => {
    expect(mag([2.71668, 0, -2.2175])).toBeCloseTo(2.53, 2);
  });
});

describe.skipIf(!has350k)("parseMagneticCif — 350 K orthorhombic (Cm'cm')", () => {
  const { structure, magnetic } = parseIfPresent(has350k, ORTHO_350K, "mn3ga-350k");
  it("reads the orthorhombic cell and 16 magnetic operations", () => {
    expect(structure.cell.a).toBeCloseTo(5.407891, 5);
    expect(structure.cell.gamma).toBe(90);
    expect(structure.spaceGroup.operations).toHaveLength(16);
    expect(structure.spaceGroup.hermannMauguin).toContain("C m' c m'");
  });
  it("reads the Mn moment (1.6, −1.35, 0)", () => {
    const mn = magnetic!.moments[0]!;
    expect(mn.components[0]).toBeCloseTo(1.6, 2);
    expect(mn.components[1]).toBeCloseTo(-1.35, 2);
  });
});

describe.skipIf(!hasHkl)("parseReflectionList — GSAS Fo²/Fc² export", () => {
  const rows = hasHkl ? parseReflectionList(readData(HKL_30K)) : [];
  it("parses the reflection table skipping headers", () => {
    expect(rows.length).toBeGreaterThan(20);
    const first = rows[0]!;
    expect([first.h, first.k, first.l]).toEqual([1, 0, 0]);
    expect(first.multiplicity).toBe(2);
    expect(first.d).toBeCloseTo(4.72638, 4);
    expect(first.foSq).toBeCloseTo(1.497, 3);
    expect(first.fcSq).toBeCloseTo(1.387, 3);
  });
});
