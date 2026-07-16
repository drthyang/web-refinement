import { describe, it, expect } from "vitest";
import type { Vec3 } from "@/core/math/types";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { parseFullProfInt } from "@/parsers/fullprofInt";
import { parseCif } from "@/parsers/cif";
import { parseSymmetryOperation } from "@/core/crystal/symmetry";
import { nuclearStructureFactorSquared } from "@/core/diffraction/structureFactor";
import { buildSingleCrystalSpec, singleCrystalRefinementComparison } from "@/core/workflow/singleCrystalRefinement";
import {
  magneticSupercell,
  mergeToMagneticSupercell,
  expandStructureToSupercell,
  buildModulatedMomentModel,
} from "@/core/magnetic/magneticSupercell";
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

describe("expandStructureToSupercell — exact regrouping", () => {
  // A small P-lattice structure with a 2-atom orbit: Pm-like mirror z→−z.
  const base: StructureModel = {
    id: "b",
    name: "base",
    cell: { a: 4, b: 5, c: 6, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { hermannMauguin: "P m", operations: [parseSymmetryOperation("x,y,z"), parseSymmetryOperation("x,y,-z")] },
    sites: [
      { label: "Fe1", element: "Fe", position: [0.1, 0.2, 0.3], occupancy: 1, adp: { kind: "isotropic", bIso: 0.4 } },
      { label: "O1", element: "O", position: [0.5, 0.5, 0], occupancy: 0.75, adp: { kind: "isotropic", bIso: 0.6 } },
    ],
  };
  const rad = { kind: "neutron" as const, wavelength: 1.5 };

  it("replicates the full orbit over every cell offset with exact positions", () => {
    const { structure, supercell, replicas } = expandStructureToSupercell(base, [0.25, 0, 0.25]);
    expect(supercell.multiplicity).toEqual([4, 1, 4]);
    // Fe1 orbit = 2 (general under the mirror), O1 orbit = 1 (on the mirror):
    // (2 + 1) × 16 cells = 48 atoms, all P1.
    expect(structure.sites.length).toBe(48);
    expect(replicas.length).toBe(48);
    expect(structure.spaceGroup.operations.length).toBe(1);
    expect(structure.cell).toMatchObject({ a: 16, b: 5, c: 24 });
    // A specific replica: Fe1 orbit rep 1 at offset (2,0,3).
    const r = replicas.find((x) => x.parent === "Fe1" && x.offset[0] === 2 && x.offset[2] === 3 && x.label.startsWith("Fe1_1_"));
    const site = structure.sites.find((s) => s.label === r!.label)!;
    expect(site.position[0]).toBeCloseTo((0.1 + 2) / 4, 12);
    expect(site.position[1]).toBeCloseTo(0.2, 12);
    expect(site.position[2]).toBeCloseTo((0.3 + 3) / 4, 12);
    expect(site.occupancy).toBe(1);
  });

  it("|F_super(n·hkl)|² = N²·|F_base(hkl)|² and satellites carry zero nuclear intensity", () => {
    const k: Vec3 = [0.25, 0, 0.25];
    const { structure, supercell } = expandStructureToSupercell(base, k);
    const N = supercell.multiplicity[0] * supercell.multiplicity[1] * supercell.multiplicity[2];
    const fundamentals: [number, number, number][] = [[1, 0, 0], [0, 1, 1], [1, 1, 0], [2, 1, 1], [1, 2, 3]];
    for (const [h, kk, l] of fundamentals) {
      const fBase = nuclearStructureFactorSquared(base, rad, h, kk, l);
      const fSuper = nuclearStructureFactorSquared(structure, rad, 4 * h, kk, 4 * l);
      expect(fSuper).toBeCloseTo(N * N * fBase, 6);
      // The satellite node (4h+1, k, 4l+1) is a pure-magnetic position: the
      // nuclear supercell structure factor vanishes there identically.
      const fSat = nuclearStructureFactorSquared(structure, rad, 4 * h + 1, kk, 4 * l + 1);
      expect(fSat).toBeLessThan(1e-9 * Math.max(fSuper, 1));
    }
  });
});

describe("buildModulatedMomentModel — k-tied replica moments", () => {
  const base: StructureModel = {
    id: "m",
    name: "mag base",
    cell: { a: 4, b: 4, c: 5, alpha: 90, beta: 90, gamma: 90 },
    spaceGroup: { hermannMauguin: "P 1", operations: [parseSymmetryOperation("x,y,z")] },
    sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0, 0, 0], occupancy: 1, adp: { kind: "isotropic", bIso: 0.3 } }],
  };

  it("one amplitude drives every replica with cos(2πk·L + φ) coefficients", () => {
    const k: Vec3 = [0.25, 0, 0];
    const exp4 = expandStructureToSupercell(base, k);
    const build = buildModulatedMomentModel(exp4, k, [{ site: "Fe1", direction: [1, 0, 0], phase: Math.PI / 4 }]);
    expect(build.params.length).toBe(1); // parameter count = base-cell description
    expect(build.magnetic.moments.length).toBe(4);
    expect(build.bindings.length).toBe(4);
    // Coefficients follow cos(2π·l/4 + π/4): +,−,−,+ with equal magnitude √2/2·|d̂|.
    const coef = build.bindings.map((b) => b.momentBasis![0]!);
    const m0 = Math.abs(coef[0]!);
    expect(coef[0]).toBeCloseTo(m0, 10);
    expect(coef[1]).toBeCloseTo(-m0, 10);
    expect(coef[2]).toBeCloseTo(-m0, 10);
    expect(coef[3]).toBeCloseTo(m0, 10);
    // Unit-µB direction: moment crystal components are along the NORMALIZED axes
    // (â,b̂,ĉ), so a unit direction along a has component 1 regardless of the
    // cell lengths — the stored basis is d̂·cos(φ) with |d̂| = 1.
    expect(m0).toBeCloseTo(Math.cos(Math.PI / 4), 10);
  });

  it("throws for an unknown site or zero direction", () => {
    const k: Vec3 = [0.5, 0, 0];
    const exp2 = expandStructureToSupercell(base, k);
    expect(() => buildModulatedMomentModel(exp2, k, [{ site: "Nope", direction: [1, 0, 0] }])).toThrow(/no replicas/);
    expect(() => buildModulatedMomentModel(exp2, k, [{ site: "Fe1", direction: [0, 0, 0] }])).toThrow(/zero direction/);
  });
});

const DIR = "fullprof_int_handles";
const NUC = `${DIR}/Eu3In2Te4_1p5K0T_nuc.int`;
const MAG = `${DIR}/Eu3In2Te4_1p5K0T_mag.int`;
const ALL = `${DIR}/Eu3In2Te4_1p5K0T_ALL_magcell.int`;
const CIF = `${DIR}/Eu3In2As4_1p5K_Nuc_Refined.cif`;
const hasData = dataExists(NUC) && dataExists(MAG) && dataExists(ALL);
const load = (rel: string): SingleCrystalDataset => ({
  id: rel, name: rel, radiation: { kind: "neutron", wavelength: 1.0 },
  reflections: parseFullProfInt(readData(rel), { strict: true }).reflections,
});

describe.skipIf(!hasData)("magneticSupercell — Eu₃In₂Te₄ golden (k = 1/4,0,1/4)", () => {

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

describe.skipIf(!hasData || !dataExists(CIF))("supercell expansion — Eu₃In₂As₄ refined CIF (k = ¼,0,¼)", () => {
  const k: Vec3 = [0.25, 0, 0.25];
  const rad = { kind: "neutron" as const, wavelength: 1.0 };
  const base = (): StructureModel => parseCif(readData(CIF), "eu324");

  it("expands the Pnnm structure exactly: N² fundamentals, zero-nuclear satellites", () => {
    const structure = base();
    const { structure: superS, supercell } = expandStructureToSupercell(structure, k);
    expect(supercell.multiplicity).toEqual([4, 1, 4]);
    const N = 16;
    const nucRefl = parseFullProfInt(readData(NUC), { strict: true }).reflections;
    let maxFund = 0;
    for (const r of nucRefl) {
      const fBase = nuclearStructureFactorSquared(structure, rad, r.h, r.k, r.l);
      const fSuper = nuclearStructureFactorSquared(superS, rad, 4 * r.h, r.k, 4 * r.l);
      // Exact regrouping: the supercell F² at the mapped node is N²× the base F².
      expect(fSuper).toBeCloseTo(N * N * fBase, 4);
      maxFund = Math.max(maxFund, fSuper);
    }
    // Every measured satellite position carries ZERO nuclear intensity in the
    // supercell — the purely-magnetic-supercell precondition, proven on the
    // real refined structure at the real measured positions.
    const magRefl = parseFullProfInt(readData(MAG), { strict: true }).reflections;
    for (const r of magRefl) {
      const fSat = nuclearStructureFactorSquared(superS, rad, 4 * r.h + 1, r.k, 4 * r.l + 1);
      expect(fSat).toBeLessThan(1e-8 * maxFund);
    }
  });

  it("scale relation: k_super = k_base / N² at identical fit quality", () => {
    // Refine (auto-estimate) the scale of the SAME nuclear observations in both
    // settings: against the base cell at (h,k,l), and against the expanded
    // supercell at (4h,k,4l) — the nuclear block of the merged file. The scale
    // is linear, so the least-squares optimum is exact in one pass, and the
    // shared-scale story requires k_super·N² = k_base with the same R factors.
    const structure = base();
    const { structure: superS } = expandStructureToSupercell(structure, k);
    const nucBase = load(NUC);
    const nucSuper: SingleCrystalDataset = {
      ...nucBase,
      id: "nuc-super",
      reflections: nucBase.reflections.map((r) => ({ ...r, h: 4 * r.h, l: 4 * r.l })),
    };

    const specBase = buildSingleCrystalSpec(structure, nucBase, {});
    const specSuper = buildSingleCrystalSpec(superS, nucSuper, {});
    const kBase = specBase.params.find((p) => p.id === "scale")!.value;
    const kSuper = specSuper.params.find((p) => p.id === "scale")!.value;
    expect(kSuper * 256).toBeCloseTo(kBase, Math.max(0, -Math.floor(Math.log10(kBase * 1e-6))));
    expect(kSuper * 256 / kBase).toBeCloseTo(1, 6);

    const agBase = singleCrystalRefinementComparison(structure, nucBase, specBase.params, specBase.bindings).agreement;
    const agSuper = singleCrystalRefinementComparison(superS, nucSuper, specSuper.params, specSuper.bindings).agreement;
    expect(agSuper.r1).toBeCloseTo(agBase.r1, 8);
    expect(agSuper.wr2).toBeCloseTo(agBase.wr2, 8);
  });
});
