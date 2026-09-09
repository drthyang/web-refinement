import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { parseSymmetryOperation, applyOperation } from "@/core/crystal/symmetry";
import { determinant } from "@/core/math/mat3";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { generateMagneticCandidatesForK } from "@/core/magnetic/magneticGroups";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { magneticStructureFactor, satelliteArm, MAGNETIC_PREFACTOR } from "@/core/magnetic/structureFactor";
import { expandSpinField } from "@/core/crystal/cellExpansion";
import { classifyPropagation, isSelfConjugate, fourierArmFactor } from "@/core/magnetic/propagation";
import { allowedFourierModes, allowedMomentDirections, quadratureOf } from "@/core/magnetic/allowedMoments";
import { fourierMagneticStructureFactor, type FourierSite } from "@/core/magnetic/fourierMoment";
import { magneticSatellites } from "@/core/magnetic/satellites";
import { magneticTable } from "@/core/scattering/magnetic";
import { qCartesian, crystalComponentsToCartesian, perpendicularMoment } from "@/core/magnetic/moment";
import { dSpacing } from "@/core/crystal/unitCell";

/**
 * Fourier (cos/sin) modulation of magnetic moments for a propagation vector
 * with two distinct arms ±k — commensurate (¼, ⅓, 3/10 …) or incommensurate.
 *
 * The central gate is CONVENTION-FREE: the magnetic structure factor computed
 * in the k-formalism (complex coefficients, orbit expansion with lattice
 * phases, the two-arm ½) must equal the brute-force sum over the REAL-SPACE
 * moment field of the magnetic supercell — the field the 3D viewer draws and
 * the mCIF exports. That sum has no Fourier convention in it, so it pins the
 * sign of every phase, the ½, and the −k arm's conjugation at once.
 */

const iso = { kind: "isotropic", bIso: 0 } as const;
const ops = (xyz: string[]): SymmetryOperation[] => xyz.map(parseSymmetryOperation);

/** P2₁ with the site chosen so the screw image lands in the NEXT cell along b
 *  (y = 0.7 → 1.2): the lattice phase k·L is then ¼·1 — the case where the sign
 *  of the phase convention is observable. */
const p21: StructureModel = {
  id: "p21", name: "P21 test",
  cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: { hermannMauguin: "P 1 21 1", operations: ops(["x,y,z", "-x,y+1/2,-z"]) },
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.7, 0.3], occupancy: 1, adp: iso }],
};

/** P3₁ (screw along c, translations ⅓ and ⅔): with z = 0.8 both images
 *  cross into the next cell, phases ⅓ and ⅔ of a turn. */
const p31: StructureModel = {
  id: "p31", name: "P31 test",
  cell: { a: 5, b: 5, c: 8, alpha: 90, beta: 90, gamma: 120 },
  spaceGroup: { hermannMauguin: "P 31", operations: ops(["x,y,z", "-y,x-y,z+1/3", "-x+y,-x,z+2/3"]) },
  sites: [{ label: "Mn1", element: "Mn", oxidationState: 2, position: [0.2, 0.1, 0.8], occupancy: 1, adp: iso }],
};

/** Deterministic, generic amplitudes for every parameter (gauge included —
 *  the oracle does not care which phase the field has). */
function genericValues(params: { id: string }[]): Record<string, number> {
  const v: Record<string, number> = {};
  params.forEach((p, i) => { v[p.id] = 0.6 + 0.37 * ((i * 7) % 5) - 0.21 * (i % 3); });
  return v;
}

function buildApplied(structure: StructureModel, k: Vec3, site: string, pickTheta?: (c: { operations: readonly SymmetryOperation[] }) => boolean) {
  const cands = generateMagneticCandidatesForK(structure.spaceGroup.operations, k);
  const cand = cands.find((c) => (pickTheta ? pickTheta(c) : true)) ?? cands[0]!;
  const build = buildMagneticModel(structure, k, [site], cand.operations, { moment: 2 });
  const values = genericValues(build.params);
  return { build, values, magnetic: applyMagneticMoments(build.magnetic, build.bindings, values) };
}

/**
 * Brute-force |F_M|² from the real-space moment field over the magnetic
 * supercell: every atom of every cell, its (already k-modulated) moment, the
 * M⊥ projection, the plain e^{2πi h·r} phase — normalized by the cell count so
 * it compares directly with the single-cell k-formalism value.
 */
function bruteForceSquared(structure: StructureModel, magnetic: MagneticModel, index: Vec3): number {
  const box = expandSpinField(structure, magnetic);
  const [n0, n1, n2] = box.n;
  const nCells = n0 * n1 * n2;
  const [h, k, l] = index;
  const d = dSpacing(structure.cell, h, k, l);
  const s = 1 / (2 * d);
  const q = qCartesian(structure.cell, h, k, l);
  const re = [0, 0, 0];
  const im = [0, 0, 0];
  for (const atom of box.atoms) {
    if (!atom.moment) continue;
    const f = atom.formFactorId && magneticTable.has(atom.formFactorId) ? magneticTable.j0(atom.formFactorId, s) : 1;
    const mPerp = perpendicularMoment(crystalComponentsToCartesian(structure.cell, atom.moment), q);
    const r = [atom.site.position[0] * n0, atom.site.position[1] * n1, atom.site.position[2] * n2];
    const phase = 2 * Math.PI * (h * r[0]! + k * r[1]! + l * r[2]!);
    const w = MAGNETIC_PREFACTOR * atom.site.occupancy * f;
    for (let a = 0; a < 3; a++) {
      re[a]! += w * mPerp[a]! * Math.cos(phase);
      im[a]! += w * mPerp[a]! * Math.sin(phase);
    }
  }
  const sq = re.reduce((acc, x) => acc + x * x, 0) + im.reduce((acc, x) => acc + x * x, 0);
  return sq / (nCells * nCells);
}

const v3 = (f: (i: number) => number): Vec3 => [f(0), f(1), f(2)];
const parents: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [2, 1, 1], [0, 2, 1], [1, -1, 2]];
const satellitesOf = (k: Vec3): Vec3[] =>
  parents.flatMap((H) => [
    [H[0] + k[0], H[1] + k[1], H[2] + k[2]] as Vec3,
    [H[0] - k[0], H[1] - k[1], H[2] - k[2]] as Vec3,
  ]);

function expectOracleAgreement(structure: StructureModel, magnetic: MagneticModel, k: Vec3): void {
  let nonzero = 0;
  for (const idx of satellitesOf(k)) {
    const formula = magneticStructureFactor(structure, magnetic, idx[0], idx[1], idx[2]).squared;
    const truth = bruteForceSquared(structure, magnetic, idx);
    expect(Math.abs(formula - truth), `index (${idx.join(", ")}): formula ${formula} vs brute force ${truth}`)
      .toBeLessThan(1e-9 * Math.max(1, truth));
    if (truth > 1e-6) nonzero += 1;
  }
  expect(nonzero).toBeGreaterThan(4); // the comparison is not vacuous
}

describe("propagation-vector classification", () => {
  it("separates k = 0, self-conjugate, two-arm commensurate, and incommensurate", () => {
    expect(classifyPropagation([0, 0, 0])).toMatchObject({ kind: "zero", selfConjugate: true, twoArms: false, armFactor: 1, supercell: [1, 1, 1] });
    expect(classifyPropagation([0, 0, 0.5])).toMatchObject({ kind: "commensurate", selfConjugate: true, armFactor: 1, supercell: [1, 1, 2] });
    expect(classifyPropagation([0.5, 0.5, 0.5])).toMatchObject({ selfConjugate: true, armFactor: 1 });
    expect(classifyPropagation([0, 0.25, 0])).toMatchObject({ kind: "commensurate", selfConjugate: false, twoArms: true, armFactor: 0.5, supercell: [1, 4, 1] });
    expect(classifyPropagation([1 / 3, 1 / 3, 0])).toMatchObject({ kind: "commensurate", twoArms: true, supercell: [3, 3, 1] });
    expect(classifyPropagation([0.137, 0, 0])).toMatchObject({ kind: "incommensurate", selfConjugate: false, twoArms: true, armFactor: 0.5, supercell: null });
    expect(isSelfConjugate([0.5, 0, 1])).toBe(true);
    expect(fourierArmFactor([0, 0.3, 0])).toBe(0.5);
  });

  it("identifies which arm a fractional index belongs to", () => {
    const k: Vec3 = [0, 0.25, 0];
    expect(satelliteArm(1, 0.25, 0, k)).toBe(1);
    expect(satelliteArm(1, -0.25, 2, k)).toBe(-1);
    expect(satelliteArm(1, 1.75, 0, k)).toBe(-1); // (1,2,0) − k
    expect(satelliteArm(1, 0, 0, k)).toBe(0);
    expect(satelliteArm(1, 0.5, 0, k)).toBe(0); // second harmonic: not this k
  });
});

describe("brute-force supercell oracle — k-formalism ≡ real-space moment field", () => {
  it("P2₁, k = (0, ¼, 0), both time-reversal assignments (cos + sin amplitudes)", () => {
    const k: Vec3 = [0, 0.25, 0];
    const cands = generateMagneticCandidatesForK(p21.spaceGroup.operations, k);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    for (const cand of cands) {
      const build = buildMagneticModel(p21, k, ["Fe1"], cand.operations, { moment: 2 });
      expect(build.fourier).toBe(true);
      expect(build.phaseGauge).toBeDefined();
      const magnetic = applyMagneticMoments(build.magnetic, build.bindings, genericValues(build.params));
      // The sine amplitude really is in play (otherwise the ½ and the −k
      // conjugation would be the only things tested).
      expect(magnetic.moments[0]!.sinComponents!.some((c) => Math.abs(c) > 0.1)).toBe(true);
      expectOracleAgreement(p21, magnetic, k);
    }
  });

  it("P3₁, k = (0, 0, ⅓): screw images with ⅓ and ⅔ lattice phases", () => {
    const k: Vec3 = [0, 0, 1 / 3];
    const { magnetic } = buildApplied(p31, k, "Mn1");
    expectOracleAgreement(p31, magnetic, k);
  });

  it("k = (0, 3/10, 0): a long-period modulation on the same code path an incommensurate k takes", () => {
    const k: Vec3 = [0, 0.3, 0];
    const { magnetic } = buildApplied(p21, k, "Fe1");
    expectOracleAgreement(p21, magnetic, k);
  });

  it("self-conjugate k = (0, ½, 0): one arm, real coefficients, no sine parameters", () => {
    const k: Vec3 = [0, 0.5, 0];
    const cands = generateMagneticCandidatesForK(p21.spaceGroup.operations, k);
    for (const cand of cands) {
      const build = buildMagneticModel(p21, k, ["Fe1"], cand.operations, { moment: 2 });
      expect(build.fourier).toBe(false);
      expect(build.phaseGauge).toBeUndefined();
      expect(build.params.every((p) => !p.id.endsWith("q"))).toBe(true);
      expect(build.bindings.every((b) => b.momentPart === undefined)).toBe(true);
      expect(build.magnetic.moments.every((m) => m.sinComponents === undefined)).toBe(true);
      const magnetic = applyMagneticMoments(build.magnetic, build.bindings, genericValues(build.params));
      expectOracleAgreement(p21, magnetic, k);
    }
  });

  it("the ½ two-arm factor is what makes the oracle agree (a factor-1 coefficient is 4× off)", () => {
    const k: Vec3 = [0, 0.25, 0];
    const { magnetic } = buildApplied(p21, k, "Fe1");
    const idx: Vec3 = [0, 0.25, 0];
    const formula = magneticStructureFactor(p21, magnetic, idx[0], idx[1], idx[2]).squared;
    const truth = bruteForceSquared(p21, magnetic, idx);
    expect(truth).toBeGreaterThan(1e-3);
    expect(formula / truth).toBeCloseTo(1, 9);
    // Pretend the coefficient were the full amplitude: 2× the coefficient, 4× the intensity.
    const doubled: MagneticModel = {
      ...magnetic,
      moments: magnetic.moments.map((m) => ({
        ...m,
        components: v3((i) => 2 * m.components[i]!),
        sinComponents: v3((i) => 2 * m.sinComponents![i]!),
      })),
    };
    expect(magneticStructureFactor(p21, doubled, idx[0], idx[1], idx[2]).squared / truth).toBeCloseTo(4, 9);
  });
});

describe("gauge and cross-checks", () => {
  const k: Vec3 = [0, 0.25, 0];
  const { magnetic } = buildApplied(p21, k, "Fe1");

  it("a global modulation phase shift leaves every satellite intensity unchanged", () => {
    const psi = 0.7;
    const shifted: MagneticModel = {
      ...magnetic,
      moments: magnetic.moments.map((m) => {
        const c = m.components;
        const s = m.sinComponents ?? [0, 0, 0];
        return {
          ...m,
          components: v3((i) => c[i]! * Math.cos(psi) + s[i]! * Math.sin(psi)),
          sinComponents: v3((i) => -c[i]! * Math.sin(psi) + s[i]! * Math.cos(psi)),
        };
      }),
    };
    for (const idx of satellitesOf(k)) {
      const a = magneticStructureFactor(p21, magnetic, idx[0], idx[1], idx[2]).squared;
      const b = magneticStructureFactor(p21, shifted, idx[0], idx[1], idx[2]).squared;
      expect(Math.abs(a - b)).toBeLessThan(1e-10 * Math.max(1, a));
    }
  });

  it("the orbit-expanded structure factor equals the explicit-coefficient Fourier formula", () => {
    // Expand the representative's coefficient over the magnetic operations by
    // hand — S′ = ½·θ·det(R)·R·(Mcos + i·Msin)·e^{2πi k·n_g} at the wrapped
    // image position — and feed the explicit list to fourierMoment.ts.
    const sites: FourierSite[] = [];
    const wrap = (x: number): number => ((x % 1) + 1) % 1;
    for (const m of magnetic.moments) {
      const site = p21.sites.find((s) => s.label === m.siteLabel)!;
      const seen: Vec3[] = [];
      for (const op of magnetic.operations!) {
        const p = applyOperation(op, m.position ?? site.position);
        const w: Vec3 = [wrap(p[0]), wrap(p[1]), wrap(p[2])];
        if (seen.some((q) => q.every((x, i) => Math.abs(x - w[i]!) < 1e-6))) continue;
        seen.push(w);
        const ng = [p[0] - w[0], p[1] - w[1], p[2] - w[2]];
        const axial = determinant(op.rotation) * (op.timeReversal ?? 1);
        const R = op.rotation;
        const rot = (v: Vec3): Vec3 => [
          axial * (R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2]),
          axial * (R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2]),
          axial * (R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]),
        ];
        const cRe = rot(m.components).map((x) => 0.5 * x);
        const cIm = rot(m.sinComponents ?? [0, 0, 0]).map((x) => 0.5 * x);
        const phi = 2 * Math.PI * (k[0] * ng[0]! + k[1] * ng[1]! + k[2] * ng[2]!);
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        sites.push({
          position: w,
          sReal: v3((i) => cRe[i]! * cp - cIm[i]! * sp),
          sImag: v3((i) => cRe[i]! * sp + cIm[i]! * cp),
          formFactorId: m.formFactorId!,
        });
      }
    }
    for (const H of parents) {
      const plus: Vec3 = [H[0] + k[0], H[1] + k[1], H[2] + k[2]];
      const minus: Vec3 = [H[0] - k[0], H[1] - k[1], H[2] - k[2]];
      const a1 = magneticStructureFactor(p21, magnetic, plus[0], plus[1], plus[2]).squared;
      const b1 = fourierMagneticStructureFactor(p21.cell, sites, plus).squared;
      expect(Math.abs(a1 - b1)).toBeLessThan(1e-9 * Math.max(1, a1));
      const a2 = magneticStructureFactor(p21, magnetic, minus[0], minus[1], minus[2]).squared;
      const b2 = fourierMagneticStructureFactor(p21.cell, sites, minus, magneticTable, -1).squared;
      expect(Math.abs(a2 - b2)).toBeLessThan(1e-9 * Math.max(1, a2));
    }
  });
});

describe("allowedFourierModes — symmetry-allowed complex coefficients", () => {
  it("a general position gives three pure-cosine modes with pure-sine quadratures", () => {
    const k: Vec3 = [0, 0.25, 0];
    const r = allowedFourierModes(p21.spaceGroup.operations, [0.1, 0.7, 0.3], k);
    expect(r.dimension).toBe(3);
    for (const m of r.modes) expect(m.sin).toEqual([0, 0, 0]);
    const q = quadratureOf(r.modes[0]!);
    expect(q.cos).toEqual([0, 0, 0]);
    expect(q.sin).toEqual(r.modes[0]!.cos);
  });

  it("a real stabilizer constraint restricts cos and sin identically (matches the real basis)", () => {
    // P2: site (0, y, 0) on the 2-fold along b; k = (0, ¼, 0) is invariant.
    const twoFold = ops(["x,y,z", "-x,y,-z"]);
    const k: Vec3 = [0, 0.25, 0];
    const real = allowedMomentDirections(twoFold, [0, 0.3, 0], k);
    const complex = allowedFourierModes(twoFold, [0, 0.3, 0], k);
    expect(real.dimension).toBe(1);
    expect(complex.dimension).toBe(1);
    expect(complex.modes[0]!.sin).toEqual([0, 0, 0]);
    expect(Math.abs(complex.modes[0]!.cos[1]!)).toBeCloseTo(1, 9);
    // θ = −1 on the 2-fold: the moment ⊥ b — two modes, both pure cosine.
    const flipped = [twoFold[0]!, { ...twoFold[1]!, timeReversal: -1 as const }];
    expect(allowedFourierModes(flipped, [0, 0.3, 0], k).dimension).toBe(2);
  });

  it("a complex stabilizer phase forces a helix a real moment cannot carry (P3, K point)", () => {
    // Site (⅓, ⅔, z) of P3 is fixed by the 3-fold with returning translations
    // (−1,−1,0) and (0,−1,0); at k = (⅓,⅓,0) those phases are e^{±2πi/3}.
    const p3 = ops(["x,y,z", "-y,x-y,z", "-x+y,-x,z"]);
    const k: Vec3 = [1 / 3, 1 / 3, 0];
    const pos: Vec3 = [1 / 3, 2 / 3, 0.25];
    expect(allowedMomentDirections(p3, pos, k).dimension).toBe(0);
    const r = allowedFourierModes(p3, pos, k);
    expect(r.dimension).toBe(1);
    const m = r.modes[0]!;
    expect(Math.hypot(...m.cos)).toBeGreaterThan(0.1);
    expect(Math.hypot(...m.sin)).toBeGreaterThan(0.1);
    expect(m.cos[2]).toBeCloseTo(0, 9); // in-plane helix, nothing along c
    expect(m.sin[2]).toBeCloseTo(0, 9);
    // Direct check of the stabilizer condition e^{iφ}·A·S = S on the mode.
    for (const op of p3) {
      const p = applyOperation(op, pos);
      const L = p.map((x, i) => Math.round(x - pos[i]!));
      if (p.some((x, i) => Math.abs(x - pos[i]! - L[i]!) > 1e-6)) continue;
      const phi = 2 * Math.PI * (k[0] * L[0]! + k[1] * L[1]! + k[2] * L[2]!);
      const R = op.rotation;
      const A = (v: Vec3): Vec3 => [
        R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
        R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
        R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
      ];
      const ac = A(m.cos);
      const as = A(m.sin);
      for (let i = 0; i < 3; i++) {
        // (cos φ + i sin φ)(ac + i as) = cos φ·ac − sin φ·as + i(sin φ·ac + cos φ·as)
        expect(Math.cos(phi) * ac[i]! - Math.sin(phi) * as[i]!).toBeCloseTo(m.cos[i]!, 9);
        expect(Math.sin(phi) * ac[i]! + Math.cos(phi) * as[i]!).toBeCloseTo(m.sin[i]!, 9);
      }
    }
  });
});

describe("satellite enumeration — exact Laue families, every position once", () => {
  const p222: StructureModel["spaceGroup"] = { hermannMauguin: "P 2 2 2", operations: ops(["x,y,z", "-x,-y,z", "-x,y,-z", "x,-y,-z"]) };
  const p4: StructureModel["spaceGroup"] = { hermannMauguin: "P 4", operations: ops(["x,y,z", "-x,-y,z", "-y,x,z", "y,-x,z"]) };
  const ortho = { a: 4, b: 5, c: 6, alpha: 90, beta: 90, gamma: 90 };
  const tetra = { a: 4, b: 4, c: 6, alpha: 90, beta: 90, gamma: 90 };

  /** Distinct positions of the Laue closure of {G ± k}, counted by brute force. */
  function countPositions(cell: typeof ortho, sg: StructureModel["spaceGroup"], k: Vec3, dMin: number, dMax: number): number {
    const seen = new Set<string>();
    const key = (v: Vec3): string => v.map((x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(6)).join(",");
    for (let h = -8; h <= 8; h++) for (let kk = -8; kk <= 8; kk++) for (let l = -8; l <= 8; l++) {
      for (const sgn of [1, -1]) {
        const s: Vec3 = [h + sgn * k[0], kk + sgn * k[1], l + sgn * k[2]];
        for (const op of sg.operations) {
          const R = op.rotation;
          const t: Vec3 = [
            R[0][0] * s[0] + R[1][0] * s[1] + R[2][0] * s[2],
            R[0][1] * s[0] + R[1][1] * s[1] + R[2][1] * s[2],
            R[0][2] * s[0] + R[1][2] * s[1] + R[2][2] * s[2],
          ];
          for (const m of [t, [-t[0], -t[1], -t[2]] as Vec3]) {
            const d = dSpacing(cell, m[0], m[1], m[2]);
            if (Number.isFinite(d) && d >= dMin && d <= dMax) seen.add(key(m));
          }
        }
      }
    }
    return seen.size;
  }

  it("self-conjugate k = (0,0,½): the (0,0,½) family enters once with multiplicity 2", () => {
    const sats = magneticSatellites(ortho, p222, [0, 0, 0.5], 1.3, 20);
    const half = sats.filter((s) => s.h === 0 && s.k === 0 && Math.abs(Math.abs(s.l) - 0.5) < 1e-9);
    expect(half).toHaveLength(1);
    expect(half[0]!.multiplicity).toBe(2);
    const total = sats.reduce((acc, s) => acc + s.multiplicity, 0);
    expect(total).toBe(countPositions(ortho, p222, [0, 0, 0.5], 1.3, 20));
  });

  it("two-arm k = (0,0,⅓): total multiplicity equals the number of distinct satellite positions", () => {
    const k: Vec3 = [0, 0, 1 / 3];
    const sats = magneticSatellites(ortho, p222, k, 1.3, 20);
    const total = sats.reduce((acc, s) => acc + s.multiplicity, 0);
    expect(total).toBe(countPositions(ortho, p222, k, 1.3, 20));
    // The ±k arms of one parent are Friedel-related: one family, multiplicity ≥ 2.
    const pure = sats.filter((s) => s.h === 0 && s.k === 0 && Math.abs(Math.abs(s.l) - 1 / 3) < 1e-9);
    expect(pure).toHaveLength(1);
    expect(pure[0]!.multiplicity).toBe(2);
  });

  it("k off the Laue-invariant lines (tetragonal, k = (⅓,0,0)): the star's other arms are counted at their own d", () => {
    const k: Vec3 = [1 / 3, 0, 0];
    const sats = magneticSatellites(tetra, p4, k, 1.3, 20);
    const total = sats.reduce((acc, s) => acc + s.multiplicity, 0);
    expect(total).toBe(countPositions(tetra, p4, k, 1.3, 20));
    // (⅓, 1, 0) — the satellite of parent (0,1,0) — lies at a different d
    // than (1⅓, 0, 0) and must be present.
    const dA = dSpacing(tetra, 1 / 3, 1, 0);
    expect(sats.some((s) => Math.abs(s.d - dA) < 1e-9)).toBe(true);
  });

  it("k = 0 keeps the nuclear list and its multiplicities", () => {
    const sats = magneticSatellites(ortho, p222, [0, 0, 0], 1.3, 20);
    expect(sats.length).toBeGreaterThan(5);
    expect(sats.every((s) => Number.isInteger(s.h) && Number.isInteger(s.k) && Number.isInteger(s.l))).toBe(true);
  });
});
