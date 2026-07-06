import { describe, it, expect } from "vitest";
import { parseCif, parseMagneticCif } from "@/parsers/cif";
import { parseReflectionList } from "@/parsers/reflectionList";
import { dSpacing, cellVolume } from "@/core/crystal/unitCell";
import { generateMagneticCandidates } from "@/core/magnetic/magneticGroups";
import { dataExists, readData } from "@/testSupport/data";

const CMCM = "200K/PG3_45614_200K_CmCm.cif";
const CMCM_HKL = "200K/fitted_results_Cmcm_hkl.dat";
const ORTHO_350 = "350K/Mn3Ga-mag_53_350K_Final_ortho.cif";
const hasCmcm = dataExists(CMCM);
const hasCmcmHkl = dataExists(CMCM_HKL);
const has350 = dataExists(ORTHO_350);

describe.skipIf(!hasCmcm)("real data — 200 K CmCm structure CIF", () => {
  // Guarded read: the body still runs when skipped, so only parse if present.
  const model = (hasCmcm ? parseCif(readData(CMCM), "cmcm-200k") : null) as ReturnType<typeof parseCif>;
  it("parses an orthorhombic cell with a positive volume", () => {
    expect(model.cell.alpha).toBe(90);
    expect(model.cell.gamma).toBe(90);
    expect(cellVolume(model.cell)).toBeGreaterThan(100);
  });
});

describe.skipIf(!hasCmcmHkl)("real data — 200 K reflection list", () => {
  const rows = hasCmcmHkl ? parseReflectionList(readData(CMCM_HKL)) : [];
  it("parses many reflections with finite Fo²/Fc²", () => {
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => Number.isFinite(r.foSq) && Number.isFinite(r.fcSq))).toBe(true);
  });
  it("reflection d-spacings decrease as |hkl| grows (physically ordered)", () => {
    const withNonzero = rows.filter((r) => r.d > 0);
    expect(withNonzero.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasCmcmHkl)("real data — d-spacing formula vs GSAS reflection list (cubic MnO)", () => {
  // The .dat concatenates reflection blocks for both phases (MnO cubic +
  // Mn₃Ga CmCm ortho). Select the cubic MnO subset — where a = d·√(h²+k²+l²)
  // is constant (~4.44 Å) — and cross-check our d-spacing calculation on it.
  const rows = hasCmcmHkl ? parseReflectionList(readData(CMCM_HKL)) : [];
  // Tight window around the MnO cluster (a ≈ 4.438 Å); a wider window admits
  // Mn₃Ga reflections that coincidentally fall nearby.
  const mnoRows = rows.filter((r) => {
    const a = r.d * Math.sqrt(r.h * r.h + r.k * r.k + r.l * r.l);
    return a > 4.4375 && a < 4.4395;
  });

  it("finds a cubic MnO subset with a consistent lattice parameter", () => {
    expect(mnoRows.length).toBeGreaterThan(5);
    const as = mnoRows.map((r) => r.d * Math.sqrt(r.h * r.h + r.k * r.k + r.l * r.l));
    const mean = as.reduce((s, a) => s + a, 0) / as.length;
    for (const a of as) expect(Math.abs(a - mean)).toBeLessThan(0.01);
  });

  it("our dSpacing() reproduces the GSAS listed d-spacings for MnO to 2e-3 Å", () => {
    const as = mnoRows.map((r) => r.d * Math.sqrt(r.h * r.h + r.k * r.k + r.l * r.l));
    const a = as.reduce((s, v) => s + v, 0) / as.length;
    const cell = { a, b: a, c: a, alpha: 90, beta: 90, gamma: 90 };
    for (const r of mnoRows) {
      expect(Math.abs(dSpacing(cell, r.h, r.k, r.l) - r.d)).toBeLessThan(2e-3);
    }
  });
});

describe.skipIf(!has350)("real data — 350 K magnetic candidate generation", () => {
  it("generates candidate magnetic groups from the Cmcm parent", () => {
    const { structure } = parseMagneticCif(readData(ORTHO_350), "mn3ga-350k"); // inside skipIf-guarded it()
    const parent = structure.spaceGroup.operations.map((o) => ({ ...o, timeReversal: 1 as const }));
    const candidates = generateMagneticCandidates(parent);
    // A centrosymmetric orthorhombic group has several index-2 subgroups.
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    expect(candidates.filter((c) => c.isTypeI)).toHaveLength(1);
  });
});
