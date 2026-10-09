import { describe, it, expect } from "vitest";
import { singleCrystalValidation, type ScValidationRow } from "@/core/diagnostics/singleCrystalValidation";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { generateReflections } from "@/core/diffraction/reflections";
import type { UnitCell } from "@/core/crystal/types";
import { exampleStructure } from "@/examples/mn3ga";

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const cell: UnitCell = { a: 7.1, b: 8.3, c: 9.2, alpha: 90, beta: 90, gamma: 90 };
const centro = buildSpaceGroup(62); // P n m a
const acentric = buildSpaceGroup(19); // P 2₁2₁2₁

/** One row per symmetry-allowed unique reflection to dMin, Wilson-like intensities. */
function dataset(opts: { seed?: number; extinction?: number; propError?: number } = {}): ScValidationRow[] {
  const r = rng(opts.seed ?? 5);
  const refl = generateReflections(cell, centro, 0.8, 20);
  return refl.map((ref) => {
    const s = 1 / (2 * ref.d);
    const mean = 4000 * Math.exp(-2 * 1.5 * s * s);
    let u = 0;
    while (u === 0) u = r();
    const fcSq = mean * -Math.log(u);
    const sigma = Math.sqrt(9 * fcSq + 400);
    const y = opts.extinction ? 1 / Math.sqrt(1 + (opts.extinction * fcSq) / 10000) : 1;
    const foSq = fcSq * y + sigma * normal(r) + (opts.propError ?? 0) * fcSq * normal(r);
    return { h: ref.h, k: ref.k, l: ref.l, foSq, fcSq, sigma };
  });
}

describe("singleCrystalValidation", () => {
  it("a complete dataset with correct σ: complete, GooF ≈ 1 everywhere, K ≈ 1, no extinction", () => {
    const rows = dataset();
    const v = singleCrystalValidation({ rows, cell, spaceGroup: centro, nParams: 40 });
    expect(v.centrosymmetric).toBe(true);
    expect(v.completeness).toBeCloseTo(1, 10);
    expect(v.uniqueObserved).toBe(rows.length);
    expect(v.reflectionsPerParameter).toBeCloseTo(rows.length / 40, 10);
    expect(v.sinThetaOverLambdaMax).toBeCloseTo(1 / (2 * v.dMin), 12);
    expect(v.shells).toHaveLength(8);
    for (const s of v.shells) {
      expect(s.completeness).toBeCloseTo(1, 10);
      expect(s.goof).toBeGreaterThan(0.75);
      expect(s.goof).toBeLessThan(1.3);
      expect(s.rInt).toBeUndefined(); // already unique: no redundancy
    }
    // Shells run low angle first and together hold every reflection.
    expect(v.shells[0]!.dMax).toBeGreaterThan(v.shells[7]!.dMax);
    expect(v.shells.reduce((a, s) => a + s.n, 0)).toBe(rows.length);
    expect(v.bins).toHaveLength(10);
    expect(v.bins[9]!.fcRatioMax).toBeCloseTo(1, 12);
    expect(Math.abs(v.bins[9]!.k - 1)).toBeLessThan(0.03);
    expect(v.extinction.suspected).toBe(false);
  });

  it("dropping reflections lowers completeness in the shell they came from", () => {
    const rows = dataset();
    const dOf = (r: ScValidationRow): number => {
      const inv = (r.h / cell.a) ** 2 + (r.k / cell.b) ** 2 + (r.l / cell.c) ** 2;
      return 1 / Math.sqrt(inv);
    };
    // A beamstop: lose every reflection with d > 3 Å.
    const kept = rows.filter((r) => dOf(r) <= 3);
    const v = singleCrystalValidation({ rows: kept, cell, spaceGroup: centro, nParams: 40 });
    expect(v.completeness!).toBeLessThan(1);
    expect(v.shells[0]!.completeness!).toBeLessThan(1);
    expect(v.shells[7]!.completeness).toBeCloseTo(1, 10);
  });

  it("extinction: strong reflections weak on Fo² are flagged, with K < 1 in the strongest bin", () => {
    const v = singleCrystalValidation({ rows: dataset({ extinction: 1.2 }), cell, spaceGroup: centro, nParams: 40 });
    expect(v.extinction.suspected).toBe(true);
    expect(v.extinction.strongBinK).toBeLessThan(0.95);
    expect(v.bins[9]!.goof).toBeGreaterThan(v.bins[0]!.goof);
    expect(v.outliers[0]!.z).toBeLessThan(0);
    expect(v.outliers[0]!.fcRatio).toBeGreaterThan(0.4);
    expect(v.goofWithoutStrongest!).toBeLessThan(v.bins[9]!.goof);
  });

  it("redundant data report R_int per shell; equivalents count once", () => {
    const rows = dataset();
    // Measure every reflection twice: as is and as its Friedel mate.
    const doubled = [...rows, ...rows.map((r) => ({ ...r, h: -r.h, k: -r.k, l: -r.l, foSq: r.foSq * 1.02 }))];
    const v = singleCrystalValidation({ rows: doubled, cell, spaceGroup: centro, nParams: 40 });
    expect(v.uniqueObserved).toBe(rows.length);
    expect(v.completeness).toBeCloseTo(1, 10);
    for (const s of v.shells) expect(s.rInt).toBeGreaterThan(0);
  });

  it("knows a non-centrosymmetric group", () => {
    const v = singleCrystalValidation({ rows: dataset().slice(0, 50), cell, spaceGroup: acentric, nParams: 10 });
    expect(v.centrosymmetric).toBe(false);
  });
});

describe("singleCrystalValidation — accidental d coincidences", () => {
  it("a complete hexagonal dataset is complete in every shell", () => {
    // Mn₃Ga, P6₃/mmc: families such as (7 0 0)/(5 3 0) share a d exactly.
    const s = exampleStructure();
    const rows = generateReflections(s.cell, s.spaceGroup, 0.6, 20)
      .map((r) => ({ h: r.h, k: r.k, l: r.l, foSq: 100, fcSq: 100, sigma: 10 }));
    const v = singleCrystalValidation({ rows, cell: s.cell, spaceGroup: s.spaceGroup, nParams: 5 });
    expect(v.completeness).toBeCloseTo(1, 12);
    for (const sh of v.shells) expect(sh.completeness).toBeCloseTo(1, 12);
  });
});
