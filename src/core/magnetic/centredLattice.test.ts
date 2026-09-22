import { describe, it, expect } from "vitest";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import {
  centringOffsets,
  centringTranslations,
  isLatticeVector,
  isReciprocalLatticeVector,
  parseSymmetryOperation,
} from "@/core/crystal/symmetry";
import { generateMagneticCandidatesForK, littleGroup, rotationKey } from "@/core/magnetic/magneticGroups";
import { magneticSubgroupLattice } from "@/core/magnetic/subgroupLattice";
import { allowedMomentDirections } from "@/core/magnetic/allowedMoments";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { expandMagneticSupercell, expandSpinField, type SupercellAtom } from "@/core/crystal/cellExpansion";
import { magneticStructureFactor, satelliteArm, MAGNETIC_PREFACTOR } from "@/core/magnetic/structureFactor";
import { classifyPropagation, isSelfConjugate } from "@/core/magnetic/propagation";
import { magneticSatellites } from "@/core/magnetic/satellites";
import { magneticCellGroup } from "@/core/magnetic/supercellGroup";
import { magneticStructureToMcif } from "@/core/export/cif";
import { parseMagneticCif } from "@/parsers/cif";
import { magneticRepresentationDimension } from "@/core/magnetic/magneticRepresentation";
import { magneticTable } from "@/core/scattering/magnetic";
import { crystalComponentsToCartesian, perpendicularMoment, qCartesian } from "@/core/magnetic/moment";
import { dSpacing } from "@/core/crystal/unitCell";

/**
 * Centred parent lattices with k ≠ 0.
 *
 * A conventional centred cell lists its centring translations as operations,
 * so "the lattice" the k-formalism sees must be the TRUE lattice Λ (integer
 * translations plus centrings), not ℤ³:
 *  - the little group tests Rᵀk ≡ k modulo the reciprocal lattice of Λ, a
 *    sublattice of ℤ³ (F: h,k,l all even or all odd);
 *  - every lattice translation t, centring translations included, multiplies
 *    a site's Fourier coefficient by e^{−2πi k·t};
 *  - −k ≡ k (one arm, real coefficients) means 2k ∈ Λ*.
 *
 * MnO (Fm-3m, k = (½,½,½), the L point) is the textbook case: the single-arm
 * structure is the type-II antiferromagnet with m(r) = m₀·(−1)^{x+y+z} in
 * parent fractional coordinates, whose F centrings are anti-translations
 * (e^{2πi k·t} = −1). Treating the cell as primitive gave the little group
 * m-3m (all 192 operations, 4-fold axes that map k to another arm of its star)
 * and a structure with Mn(0,½,½) ∥ Mn(0,0,0) — a superposition of arms, which
 * FindSpinGroup identified as I_c4₁/acd instead of C_c2/c (m ∥ [001]) or
 * R_I-3c (m ∥ [111]).
 */

const iso = { kind: "isotropic", bIso: 0 } as const;

const mno: StructureModel = {
  id: "mno", name: "MnO",
  cell: { a: 4.446, b: 4.446, c: 4.446, alpha: 90, beta: 90, gamma: 90 },
  spaceGroup: buildSpaceGroup(225),
  sites: [
    { label: "Mn1", element: "Mn", oxidationState: 2, position: [0, 0, 0], occupancy: 1, adp: iso },
    { label: "O1", element: "O", position: [0.5, 0.5, 0.5], occupancy: 1, adp: iso },
  ],
};
const OPS = mno.spaceGroup.operations;
const K_L: Vec3 = [0.5, 0.5, 0.5];
const F_CENTRINGS = centringTranslations(OPS);

const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol;
const sameVec = (a: readonly number[], b: readonly number[], tol = 1e-9): boolean =>
  near(a[0]!, b[0]!, tol) && near(a[1]!, b[1]!, tol) && near(a[2]!, b[2]!, tol);

/** Does the (unnormalized) basis span `v`? Gram–Schmidt residual of v. */
function spans(basis: readonly Vec3[], v: Vec3, tol = 1e-6): boolean {
  const ortho: Vec3[] = [];
  for (const b of basis) {
    let u: Vec3 = [...b];
    for (const q of ortho) {
      const d = u[0] * q[0] + u[1] * q[1] + u[2] * q[2];
      u = [u[0] - d * q[0], u[1] - d * q[1], u[2] - d * q[2]];
    }
    const n = Math.hypot(...u);
    if (n > 1e-9) ortho.push([u[0] / n, u[1] / n, u[2] / n]);
  }
  let r: Vec3 = [...v];
  for (const q of ortho) {
    const d = r[0] * q[0] + r[1] * q[1] + r[2] * q[2];
    r = [r[0] - d * q[0], r[1] - d * q[1], r[2] - d * q[2]];
  }
  return Math.hypot(...r) < tol;
}

/** A MnO model with the moment m₀ (crystal components) on Mn(0,0,0) under `ops`. */
function mnoModel(ops: readonly SymmetryOperation[], m0: Vec3): MagneticModel {
  return {
    id: "mno-mag", structureId: "mno", propagation: [K_L], operations: ops,
    moments: [{ siteLabel: "Mn1", frame: "crystallographic", components: m0, formFactorId: "Mn2" }],
  };
}

/** The magnetic subgroup candidate of the largest order whose allowed space at Mn(0,0,0) contains `dir`. */
function candidateAllowing(dir: Vec3) {
  const cands = magneticSubgroupLattice(OPS, K_L)
    .filter((c) => spans(allowedMomentDirections(c.candidate.operations, [0, 0, 0], K_L).basis, dir))
    .sort((a, b) => b.subgroupOrder - a.subgroupOrder);
  expect(cands.length).toBeGreaterThan(0);
  return cands[0]!;
}

/**
 * Brute-force |F_M|² from the real-space moment field of the magnetic
 * supercell (no Fourier convention in it) — the same oracle as
 * fourierModulation.test.ts, normalized to the single-cell k-formalism.
 */
function bruteForceSquared(structure: StructureModel, magnetic: MagneticModel, index: Vec3): number {
  const box = expandSpinField(structure, magnetic);
  const [n0, n1, n2] = box.n;
  const nCells = n0 * n1 * n2;
  const [h, k, l] = index;
  const s = 1 / (2 * dSpacing(structure.cell, h, k, l));
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

function expectOracleAgreement(structure: StructureModel, magnetic: MagneticModel, parents: readonly Vec3[]): void {
  const k = magnetic.propagation[0]!;
  let nonzero = 0;
  for (const H of parents) {
    for (const sign of [1, -1]) {
      const idx: Vec3 = [H[0] + sign * k[0], H[1] + sign * k[1], H[2] + sign * k[2]];
      const formula = magneticStructureFactor(structure, magnetic, idx[0], idx[1], idx[2]).squared;
      const truth = bruteForceSquared(structure, magnetic, idx);
      expect(Math.abs(formula - truth), `index (${idx.join(", ")}): formula ${formula} vs brute force ${truth}`)
        .toBeLessThan(1e-9 * Math.max(1, truth));
      if (truth > 1e-6) nonzero += 1;
    }
  }
  expect(nonzero).toBeGreaterThan(4);
}

const atomKey = (a: SupercellAtom): string => {
  const r = (v: number): string => (Math.abs(v) < 5e-4 ? "0.000" : v.toFixed(3));
  return `${a.site.element}|${a.site.position.map(r).join(",")}|${(a.moment ?? [0, 0, 0]).map(r).join(",")}`;
};

describe("centred-lattice helpers", () => {
  it("reads the F centrings off the operation list and knows the F reciprocal lattice", () => {
    expect(F_CENTRINGS).toHaveLength(3);
    for (const t of [[0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]]) {
      expect(F_CENTRINGS.some((c) => sameVec(c, t))).toBe(true);
    }
    // h, k, l all even or all odd.
    expect(isReciprocalLatticeVector([1, 1, 1], F_CENTRINGS)).toBe(true);
    expect(isReciprocalLatticeVector([2, 0, 0], F_CENTRINGS)).toBe(true);
    expect(isReciprocalLatticeVector([1, 0, 0], F_CENTRINGS)).toBe(false);
    expect(isReciprocalLatticeVector([1, 1, 0], F_CENTRINGS)).toBe(false);
    expect(isReciprocalLatticeVector([0.5, 0.5, 0.5], F_CENTRINGS)).toBe(false);
    // Direct space: (−½,−½,0) is an F lattice vector, (0,½,0) is not.
    expect(isLatticeVector([-0.5, -0.5, 0], F_CENTRINGS)).toBe(true);
    expect(isLatticeVector([0, 0.5, 0], F_CENTRINGS)).toBe(false);
    // Primitive: nothing.
    expect(centringTranslations(["x,y,z", "-x,-y,-z"].map(parseSymmetryOperation))).toEqual([]);
  });

  it("obverse R in the hexagonal setting: −h+k+l ≡ 0 (mod 3)", () => {
    const R = centringTranslations(["x,y,z", "x+2/3,y+1/3,z+1/3", "x+1/3,y+2/3,z+2/3"].map(parseSymmetryOperation));
    expect(R).toHaveLength(2);
    expect(isReciprocalLatticeVector([0, 0, 3], R)).toBe(true);
    expect(isReciprocalLatticeVector([1, 1, 0], R)).toBe(true);
    expect(isReciprocalLatticeVector([0, 0, 1], R)).toBe(false);
    expect(isReciprocalLatticeVector([1, 0, 0], R)).toBe(false);
    // (0,0,½) is NOT self-conjugate on an R lattice: 2k = (0,0,1) is no R node.
    expect(isSelfConjugate([0, 0, 0.5], R)).toBe(false);
    expect(isSelfConjugate([0, 0, 1.5], R)).toBe(true);
  });

  it("centring offsets: the four F copies of every rotation, zero for a primitive group", () => {
    const offsets = centringOffsets(OPS);
    const identityCopies = OPS.map((op, i) => ({ op, c: offsets[i]! })).filter(({ op }) => rotationKey(op) === rotationKey(OPS[0]!));
    expect(identityCopies).toHaveLength(4);
    const seen = identityCopies.map(({ c }) => c.map((v) => v.toFixed(3)).join(",")).sort();
    expect(seen).toEqual(["0.000,0.000,0.000", "0.000,0.500,0.500", "0.500,0.000,0.500", "0.500,0.500,0.000"]);
    // The offset is the op's own translation minus its representative's, so a
    // glide/screw part is never mistaken for a centring: P2/c (AWO₄) has none.
    const p2c = buildSpaceGroup(13).operations;
    expect(centringOffsets(p2c).every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)).toBe(true);
    expect(centringTranslations(p2c)).toEqual([]);
  });
});

describe("MnO (Fm-3m, Mn at 0,0,0, a = 4.446 Å), k = (½,½,½) — the L point", () => {
  it("k is self-conjugate on the F lattice (2k = (1,1,1) is an F node)", () => {
    expect(isSelfConjugate(K_L, F_CENTRINGS)).toBe(true);
    expect(classifyPropagation(K_L, { centrings: F_CENTRINGS })).toMatchObject({
      kind: "commensurate", selfConjugate: true, twoArms: false, armFactor: 1, supercell: [2, 2, 2],
    });
  });

  it("little group is -3m × the four centrings (48 operations, 12 rotations), no 4-fold axis", () => {
    const lg = littleGroup(OPS, K_L);
    expect(lg).toHaveLength(48);
    expect(new Set(lg.map(rotationKey)).size).toBe(12);
    // A 4-fold about z carries (½,½,½) to (½,−½,½) ≡ k + (0,−1,0): a ℤ³
    // vector but not an F reciprocal-lattice vector → excluded.
    expect(lg.some((op) => op.xyz === "-y,x,z")).toBe(false);
    expect(lg.some((op) => op.xyz === "y,x,-z")).toBe(false);
    // The 3-fold along [111], inversion, and the 2-fold along [1-10] stay.
    expect(lg.some((op) => op.xyz === "z,x,y")).toBe(true);
    expect(lg.some((op) => op.xyz === "-x,-y,-z")).toBe(true);
    expect(lg.some((op) => op.xyz === "-y,-x,-z")).toBe(true);
    // Every kept rotation leaves k invariant modulo Λ*, not just modulo ℤ³.
    for (const op of lg) {
      const R = op.rotation;
      const kp = [0, 1, 2].map((i) => R[0]![i]! * K_L[0] + R[1]![i]! * K_L[1] + R[2]![i]! * K_L[2]);
      expect(isReciprocalLatticeVector([kp[0]! - K_L[0], kp[1]! - K_L[1], kp[2]! - K_L[2]], F_CENTRINGS)).toBe(true);
    }
    // The subgroup lattice is that of -3m: its largest subgroup has 12 rotations.
    const lattice = magneticSubgroupLattice(OPS, K_L);
    expect(Math.max(...lattice.map((c) => c.subgroupOrder))).toBe(12);
    expect(lattice.every((c) => c.subgroupOrder <= 12)).toBe(true);
  });

  it("allowed moments: type I forbids a moment at Mn; the -3m′ decoration admits only m ∥ [111]", () => {
    // Under -3m the 3-fold confines m to [111]; the 2-folds perpendicular to
    // it then need θ = −1 (2′), as do the mirrors that contain it (m′).
    const typeI = generateMagneticCandidatesForK(OPS, K_L).find((c) => c.isTypeI)!;
    expect(allowedMomentDirections(typeI.operations, [0, 0, 0], K_L).dimension).toBe(0);
    const cand = candidateAllowing([1, 1, 1]);
    expect(cand.subgroupOrder).toBe(12);
    const theta = (xyz: string): number => cand.candidate.operations.find((o) => o.xyz === xyz)!.timeReversal ?? 1;
    expect(theta("z,x,y")).toBe(1); // 3-fold
    expect(theta("-x,-y,-z")).toBe(1); // inversion
    expect(theta("-y,-x,-z")).toBe(-1); // 2-fold along [1-10], primed
    const allowed = allowedMomentDirections(cand.candidate.operations, [0, 0, 0], K_L);
    expect(allowed.dimension).toBe(1);
    expect(spans(allowed.basis, [1, 1, 1])).toBe(true);
    expect(spans(allowed.basis, [0, 0, 1])).toBe(false);
    // The centred copy Mn(0,½,½) is the same site: operations whose image is a
    // centred copy are stabilizer elements, and with the centring phase −1
    // folded into the returning translation their constraints agree with the
    // origin's instead of killing the moment.
    const copy = allowedMomentDirections(cand.candidate.operations, [0, 0.5, 0.5], K_L);
    expect(copy.dimension).toBe(1);
    expect(spans(copy.basis, [1, 1, 1])).toBe(true);
    // m ∥ [001] breaks the 3-fold: it lives in a 2′/m′ subgroup (order 4).
    expect(candidateAllowing([0, 0, 1]).subgroupOrder).toBe(4);
  });

  for (const [label, dir] of [["m ∥ [111]", [1, 1, 1]], ["m ∥ [001]", [0, 0, 1]]] as [string, Vec3][]) {
    describe(label, () => {
      const cand = candidateAllowing(dir);
      const m0: Vec3 = [dir[0] * 4.6, dir[1] * 4.6, dir[2] * 4.6];
      const model = mnoModel(cand.candidate.operations, m0);

      it("the 2×2×2 expansion obeys m(r) = m₀·(−1)^{x+y+z} in parent fractional coordinates", () => {
        const box = expandSpinField(mno, model);
        expect(box.n).toEqual([2, 2, 2]);
        const mn = box.atoms.filter((a) => a.parentLabel === "Mn1");
        expect(mn).toHaveLength(32);
        let up = 0;
        for (const a of mn) {
          const x = a.site.position.map((v) => v * 2); // parent fractional
          const sum = x[0]! + x[1]! + x[2]!;
          expect(near(sum, Math.round(sum), 1e-6)).toBe(true);
          const sign = Math.round(sum) % 2 === 0 ? 1 : -1;
          expect(a.moment, `Mn at parent (${x.map((v) => v.toFixed(2)).join(", ")})`).toBeDefined();
          expect(sameVec(a.moment!, [sign * m0[0], sign * m0[1], sign * m0[2]], 1e-9)).toBe(true);
          if (sign > 0) up += 1;
        }
        expect(up).toBe(16); // fully compensated
        // In particular Mn(0,½,½) is ANTIparallel to Mn(0,0,0).
        const origin = mn.find((a) => sameVec(a.site.position, [0, 0, 0]))!;
        const copy = mn.find((a) => sameVec(a.site.position, [0, 0.25, 0.25]))!;
        const o = origin.moment!;
        expect(sameVec(copy.moment!, [-o[0], -o[1], -o[2]])).toBe(true);
      });

      it("the structure factor carries the F condition on H: (³⁄₂,−½,−½) scatters, (³⁄₂,½,½) does not", () => {
        const sq = (h: number, k: number, l: number): number => magneticStructureFactor(mno, model, h, k, l).squared;
        // (½½½) is silent for m ∥ [111] (m ∥ Q, nothing perpendicular) and
        // strong for m ∥ [001]: the classic MnO in-plane vs along-k distinction.
        if (label === "m ∥ [001]") expect(sq(0.5, 0.5, 0.5)).toBeGreaterThan(1);
        else expect(sq(0.5, 0.5, 0.5)).toBeLessThan(1e-12);
        expect(sq(1.5, -0.5, -0.5)).toBeGreaterThan(1); // H = (1,−1,−1): all odd
        expect(sq(1.5, 0.5, 0.5)).toBe(0); // H = (1,0,0): not an F node → another arm of the star
        expect(satelliteArm(1.5, 0.5, 0.5, K_L, 1e-6, F_CENTRINGS)).toBe(0);
        expect(satelliteArm(1.5, -0.5, -0.5, K_L, 1e-6, F_CENTRINGS)).toBe(1);
      });

      it("the k-formalism |F_M|² equals the brute-force sum over the magnetic supercell", () => {
        expectOracleAgreement(mno, model, [
          [0, 0, 0], [1, 1, 1], [2, 0, 0], [1, -1, -1], [2, 2, 0], [3, 1, 1], [2, 2, 2],
          [1, 0, 0], [1, 1, 0], [2, 1, 0], // no F nodes: zero on both sides
        ]);
      });

      it("the mCIF is the 2×2×2 cell in a type-IV group with anti-centrings and round-trips to the same field", () => {
        const sup = expandMagneticSupercell(mno, model)!;
        const group = magneticCellGroup(mno, sup);
        expect(group.hasAntiTranslations).toBe(true);
        // 8 integer × 4 centring translations of the parent inside the box, each
        // pure or anti — the 32 centerings MAGNDATA 1.31 lists for C_c2/c.
        expect(group.centerings).toHaveLength(32);
        expect(group.centerings.filter((c) => c.timeReversal === -1)).toHaveLength(16);
        expect(group.representatives).toHaveLength(label === "m ∥ [111]" ? 12 : 4);
        const text = magneticStructureToMcif(mno, model, { blockName: "mno" });
        const parsed = parseMagneticCif(text, "rt");
        const back = expandSpinField(parsed.structure, parsed.magnetic!);
        expect(back.atoms.map(atomKey).sort()).toEqual(sup.atoms.map(atomKey).sort());
      });
    });
  }

  it("satellite multiplicities count the members of the single arm: (½½½) 2 of 8, (³⁄₂½½) 6 of 24", () => {
    const sats = magneticSatellites(mno.cell, mno.spaceGroup, K_L, 1.2, 10);
    const at = (h: number, k: number, l: number) => sats.find((s) => near(s.d, dSpacing(mno.cell, h, k, l), 1e-9))!;
    expect(at(0.5, 0.5, 0.5).multiplicity).toBe(2);
    const fam = at(1.5, 0.5, 0.5);
    expect(fam.multiplicity).toBe(6);
    // The representative is a member the single arm actually populates.
    expect(satelliteArm(fam.h, fam.k, fam.l, K_L, 1e-6, F_CENTRINGS)).not.toBe(0);
    // Summed over the family, the single-arm |F_M|² equals the domain-averaged
    // powder intensity for any population of the four arms of the star; the
    // representative approximation is multiplicity × |F_M|² at an arm member.
  });

  it("Route B counts one Mn per primitive cell (3 magnetic degrees of freedom)", () => {
    expect(magneticRepresentationDimension(mno, ["Mn1"])).toBe(3);
  });
});

describe("centring translations with a complex k-phase", () => {
  const c2m: StructureModel = {
    id: "c2m", name: "C2/m test",
    cell: { a: 5.2, b: 6.1, c: 7.3, alpha: 90, beta: 100, gamma: 90 },
    spaceGroup: buildSpaceGroup(12),
    sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.13, 0.21, 0.37], occupancy: 1, adp: iso }],
  };
  const C = centringTranslations(c2m.spaceGroup.operations);

  /** Deterministic generic amplitudes for every parameter (gauge included). */
  function genericValues(params: { id: string }[]): Record<string, number> {
    const v: Record<string, number> = {};
    params.forEach((p, i) => { v[p.id] = 0.6 + 0.37 * ((i * 7) % 5) - 0.21 * (i % 3); });
    return v;
  }
  function built(structure: StructureModel, k: Vec3, site: string) {
    const cands = generateMagneticCandidatesForK(structure.spaceGroup.operations, k);
    const cand = cands.find((c) => c.isTypeI) ?? cands[0]!;
    const build = buildMagneticModel(structure, k, [site], cand.operations, { moment: 2 });
    return applyMagneticMoments(build.magnetic, build.bindings, genericValues(build.params));
  }

  it("k = (½,0,0) in a C lattice has two arms; (½,½,0) is self-conjugate", () => {
    expect(C).toHaveLength(1);
    expect(isSelfConjugate([0.5, 0, 0], C)).toBe(false);
    expect(isSelfConjugate([0.5, 0.5, 0], C)).toBe(true);
    expect(classifyPropagation([0.5, 0, 0], { centrings: C }).twoArms).toBe(true);
    expect(classifyPropagation([0.5, 0, 0]).twoArms).toBe(false); // primitive reading
    // Little group of (½,0,0): only E and m_y keep k modulo the C reciprocal lattice.
    expect(littleGroup(c2m.spaceGroup.operations, [0.5, 0, 0])).toHaveLength(4);
    // (½,½,0): E and −1 (2_y carries it to (−½,½,0) ≡ k + (−1,0,0), not a C node).
    expect(littleGroup(c2m.spaceGroup.operations, [0.5, 0.5, 0])).toHaveLength(4);
  });

  it("C2/m, k = (½,0,0): the centring copy carries the quadrature amplitude and the oracle agrees", () => {
    const magnetic = built(c2m, [0.5, 0, 0], "Fe1");
    expect(magnetic.moments.some((m) => m.sinComponents)).toBe(true);
    expectOracleAgreement(c2m, magnetic, [
      [0, 0, 0], [1, 1, 0], [2, 0, 0], [0, 2, 1], [1, 1, 1], [2, 0, 2], [1, -1, 2],
      [1, 0, 0], [0, 1, 0], [2, 1, 1], // h+k odd: no C nodes, zero on both sides
    ]);
  });

  it("C2/m, k = (½,½,0): a real (−1) centring phase — the anti-centring case", () => {
    const magnetic = built(c2m, [0.5, 0.5, 0], "Fe1");
    expectOracleAgreement(c2m, magnetic, [
      [0, 0, 0], [1, 1, 0], [2, 0, 0], [0, 2, 1], [1, 1, 1], [2, 0, 2], [1, -1, 2], [1, 0, 0], [0, 1, 0],
    ]);
  });

  it("I4/mmm, k = (0,0,½): two arms on the I lattice, oracle agrees", () => {
    const i4: StructureModel = {
      id: "i4", name: "I4/mmm test",
      cell: { a: 4.0, b: 4.0, c: 10.0, alpha: 90, beta: 90, gamma: 90 },
      spaceGroup: buildSpaceGroup(139),
      sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }],
    };
    const I = centringTranslations(i4.spaceGroup.operations);
    expect(isSelfConjugate([0, 0, 0.5], I)).toBe(false);
    const magnetic = built(i4, [0, 0, 0.5], "Fe1");
    expect(magnetic.moments.some((m) => m.sinComponents)).toBe(true);
    expectOracleAgreement(i4, magnetic, [
      [0, 0, 0], [1, 1, 0], [2, 0, 0], [1, 0, 1], [0, 1, 1], [2, 1, 1], [1, 1, 2],
      [1, 0, 0], [0, 0, 1], [2, 1, 0], // h+k+l odd: no I nodes
    ]);
  });
});
