import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { parseFullProfInt } from "@/parsers/fullprofInt";
import { magneticSupercell, mergeToMagneticSupercell } from "@/core/magnetic/magneticSupercell";
import { dataExists, readData } from "@/testSupport/data";

/**
 * Phase 3 — the nuclear+magnetic → magnetic-supercell merge. The CI part checks
 * the axis-diagonal transform arithmetic; the data-gated part validates it
 * byte-exactly against the real Eu₃In₂Te₄ HB-3A goldens (k = (¼,0,¼)):
 * `_nuc.int` + `_mag.int` (both nuclear cell) merged must reproduce the reference
 * `_ALL_magcell.int` produced by the user's FullProf workflow — matched on the
 * (h,k,l, I, σ) the reader keeps. Skips when the git-ignored data/ folder is absent.
 */
describe("magneticSupercell — commensurate transform", () => {
  it("resolves the supercell + integer k for k = (1/4,0,1/4)", () => {
    const sc = magneticSupercell([0.25, 0, 0.25]);
    expect(sc.multiplicity).toEqual([4, 1, 4]);
    expect(sc.kInteger).toEqual([1, 0, 1]);
  });

  it("handles other commensurate k", () => {
    expect(magneticSupercell([0.5, 0.5, 0]).multiplicity).toEqual([2, 2, 1]);
    expect(magneticSupercell([0.5, 0.5, 0]).kInteger).toEqual([1, 1, 0]);
    expect(magneticSupercell([1 / 3, 0, 0]).multiplicity).toEqual([3, 1, 1]);
    expect(magneticSupercell([1 / 3, 0, 0]).kInteger).toEqual([1, 0, 0]);
  });

  it("throws on an incommensurate component", () => {
    expect(() => magneticSupercell([0.137, 0, 0])).toThrow(/not commensurate/);
  });

  it("maps nuclear to n·hkl and satellites to n·hkl + K", () => {
    const ds = (refl: { h: number; k: number; l: number }[]): SingleCrystalDataset =>
      ({ id: "d", name: "d", radiation: { kind: "neutron", wavelength: 1 }, reflections: refl.map((r) => ({ ...r, iObs: 1 })) });
    const { dataset } = mergeToMagneticSupercell(ds([{ h: -4, k: -10, l: 1 }]), ds([{ h: -3, k: -11, l: 1 }]), [0.25, 0, 0.25]);
    // nuclear (-4,-10,1) → (-16,-10,4); magnetic (-3,-11,1) → (-12+1?,…) = (-11,-11,5).
    expect(dataset.reflections[0]).toMatchObject({ h: -16, k: -10, l: 4 });
    expect(dataset.reflections[1]).toMatchObject({ h: -11, k: -11, l: 5 });
  });
});

const DIR = "fullprof_int_handles";
const NUC = `${DIR}/Eu3In2Te4_1p5K0T_nuc.int`;
const MAG = `${DIR}/Eu3In2Te4_1p5K0T_mag.int`;
const ALL = `${DIR}/Eu3In2Te4_1p5K0T_ALL_magcell.int`;
const hasData = dataExists(NUC) && dataExists(MAG) && dataExists(ALL);

describe.skipIf(!hasData)("magneticSupercell — Eu₃In₂Te₄ golden (k = 1/4,0,1/4)", () => {
  const rad = { kind: "neutron" as const, wavelength: 1.0 };
  const load = (rel: string): SingleCrystalDataset => ({
    id: rel, name: rel, radiation: rad, reflections: parseFullProfInt(readData(rel), { strict: true }).reflections,
  });

  it("the reader parses all three real files without problems", () => {
    for (const rel of [NUC, MAG, ALL]) {
      const p = parseFullProfInt(readData(rel), { strict: true });
      expect(p.problems).toEqual([]);
      expect(p.reflections.length).toBeGreaterThan(0);
      expect(p.title).toBe("Crystal");
    }
    expect(parseFullProfInt(readData(NUC)).reflections.length).toBe(50);
    expect(parseFullProfInt(readData(MAG)).reflections.length).toBe(148);
    expect(parseFullProfInt(readData(ALL)).reflections.length).toBe(198);
  });

  it("merging _nuc + _mag reproduces the reference _ALL_magcell reflections", () => {
    const k: Vec3 = [0.25, 0, 0.25];
    const { dataset, supercell } = mergeToMagneticSupercell(load(NUC), load(MAG), k);
    expect(supercell.multiplicity).toEqual([4, 1, 4]);

    const golden = load(ALL).reflections;
    expect(dataset.reflections.length).toBe(golden.length);
    // The reference preserves source order (nuclear block, then magnetic); every
    // row must match on (h,k,l, I, σ) — the fields the reader retains.
    const key = (r: { h: number; k: number; l: number; iObs: number; sigma?: number }): string =>
      `${r.h} ${r.k} ${r.l} ${r.iObs.toFixed(2)} ${(r.sigma ?? 0).toFixed(2)}`;
    for (let i = 0; i < golden.length; i++) {
      expect(key(dataset.reflections[i]!), `row ${i}`).toBe(key(golden[i]!));
    }
  });
});
