/**
 * DISPLACIVE (polar-vector) representation analysis at Γ — the structural
 * counterpart of the magnetic irrep route, and the group-theory core of the
 * ISODISTORT-style subgroup/mode tree (PDF distortion modes, Phase 3a).
 *
 * The displacement representation Γ_disp on the atoms of the chosen sites is
 * the permutation representation ⊗ the POLAR-vector representation:
 *   χ_disp(g) = tr(R_g) · N_fixed(g),
 * where N_fixed counts orbit atoms mapped to themselves mod lattice. A
 * displacement is a polar vector — χ_polar(R) = tr(R), odd under inversion
 * (E → +3, −1 → −3) — unlike the magnetic axial vector χ_axial = det(R)·tr(R).
 * Never reuse magnetic fixtures for centrosymmetric groups: the two differ on
 * every improper operation.
 *
 * Scope (deliberate, honest):
 *  - Γ only (k = 0, cell-preserving distortions). At Γ the ordinary point-group
 *    irreps are exact small representations even for non-symmorphic groups
 *    (every e^{2πik·τ} = 1 — Bradley & Cracknell 1972, Ch. 3), so
 *    `pointGroupIrreps` covers ALL 32 classes including non-abelian ones.
 *  - Zone-boundary k (cell-multiplying distortions — perovskite tilt R4+/M3+
 *    etc.) needs the projective small representations that neither the
 *    magnetic nor this route has; callers must refuse, not approximate.
 *
 * Consistency invariants (tested):
 *  - multiplicity of the TRIVIAL irrep = Σ_sites dim(allowedPositionShifts)
 *    — the symmetry-conserving DOF are exactly the identity-irrep content;
 *  - Σ multiplicity·dim = 3·N_atoms;
 *  - the acoustic (rigid-translation) branch lives in the irreps of the plain
 *    vector rep χ = tr(R): `acoustic` counts them per irrep so the tree can
 *    show the genuinely activatable content (multiplicity − acoustic).
 *
 * The generic group-theory machinery (abelian irrep generator, all-32
 * point-group irrep construction, the multiplicity formula) is reused from the
 * magnetic modules — it carries no magnetic content and should eventually
 * migrate to a shared home.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { applyOperation, equivalentPositions } from "@/core/crystal/symmetry";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { abelianIrreps, type Irrep } from "@/core/magnetic/irreps";
import { pointGroupIrreps } from "@/core/magnetic/pointGroupIrreps";
import { irrepMultiplicity } from "@/core/magnetic/magneticRepresentation";
import { IDENTITY3 } from "@/core/math/mat3";

/**
 * Character of the polar-vector (displacement) representation for a rotation
 * R: χ_polar(R) = tr(R). E → +3, 2-fold → −1, mirror → +1, inversion → −3
 * (a polar vector is ODD under inversion — the axial character is +3 there).
 */
export function polarCharacter(R: Mat3): number {
  return R[0]![0]! + R[1]![1]! + R[2]![2]!;
}

const isInteger = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-3;

/** Periodic (mod-1) coincidence of two fractional positions. */
function samePosition(a: Vec3, b: Vec3, tol = 1e-3): boolean {
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (Math.min(d, 1 - d) > tol) return false;
  }
  return true;
}

/** Distinct atoms in one cell: the orbit of the given sites (merged, deduped). */
export function orbitAtoms(structure: StructureModel, siteLabels: readonly string[]): Vec3[] {
  const atoms: Vec3[] = [];
  const ops = structure.spaceGroup.operations.length
    ? structure.spaceGroup.operations
    : [{ rotation: IDENTITY3, translation: [0, 0, 0] as Vec3, xyz: "x,y,z" }];
  for (const label of siteLabels) {
    const site = structure.sites.find((s) => s.label === label);
    if (!site) continue;
    for (const p of equivalentPositions(ops, site.position)) {
      if (!atoms.some((q) => samePosition(q, p))) atoms.push(p);
    }
  }
  return atoms;
}

/** χ_disp(g) per operation (real at Γ; kept as {re, im} for the shared formula). */
export function displacementRepresentationCharacter(
  structure: StructureModel,
  siteLabels: readonly string[],
  ops: readonly SymmetryOperation[],
): { op: SymmetryOperation; re: number; im: number }[] {
  const atoms = orbitAtoms(structure, siteLabels);
  return ops.map((g) => {
    const chi = polarCharacter(g.rotation);
    let fixed = 0;
    for (const r of atoms) {
      const image = applyOperation(g, r);
      const L: Vec3 = [image[0] - r[0], image[1] - r[1], image[2] - r[2]];
      if (isInteger(L[0]) && isInteger(L[1]) && isInteger(L[2])) fixed++;
    }
    return { op: g, re: chi * fixed, im: 0 };
  });
}

export interface DisplaciveIrrepTerm {
  readonly irrep: Irrep;
  /** Multiplicity in the FULL displacement rep (includes the acoustic branch). */
  readonly multiplicity: number;
  /**
   * How many of those copies are the acoustic (rigid-translation) branch —
   * the multiplicity of this irrep in the plain vector rep χ = tr(R). The
   * genuinely activatable (optic) content is `multiplicity − acoustic`.
   */
  readonly acoustic: number;
  /** True for the totally symmetric irrep: symmetry-CONSERVING modes (the
   *  existing `buildSymmetryModes` catalog), not a distortion. */
  readonly trivial: boolean;
}

export interface DisplaciveDecomposition {
  /** Always at Γ in this module. */
  readonly available: boolean;
  readonly method: "abelian" | "induced" | null;
  /** Total dimension 3·N over the orbit atoms. */
  readonly dimension: number;
  readonly terms: readonly DisplaciveIrrepTerm[];
  /** False would signal a non-integral multiplicity — must not happen at Γ. */
  readonly integerConsistent: boolean;
}

/**
 * Decompose the Γ-point displacement representation of the given sites (all
 * sites when omitted) over the structure's space group: which irreps carry
 * displacive order and with what multiplicity. The trivial-irrep content is
 * the symmetry-conserving coordinate freedom; every other term is a potential
 * SYMMETRY-BREAKING distortion whose activation lowers the space group to the
 * irrep's isotropy subgroup.
 */
export function decomposeDisplacementRepresentation(
  structure: StructureModel,
  siteLabels?: readonly string[],
): DisplaciveDecomposition {
  const labels = siteLabels ?? structure.sites.map((s) => s.label);
  const ops = structure.spaceGroup.operations;
  const chi = displacementRepresentationCharacter(structure, labels, ops);
  const eIdx = ops.findIndex((op) => op.rotation.every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0))));
  const dimension = Math.round(chi[eIdx >= 0 ? eIdx : 0]?.re ?? 0);

  let irreps: Irrep[] | null = abelianIrreps(ops);
  let method: "abelian" | "induced" | null = irreps ? "abelian" : null;
  if (!irreps) {
    try {
      irreps = pointGroupIrreps(ops).map((g) => ({
        label: g.label,
        characters: g.characters,
        real: g.real,
        dim: g.dim,
      }));
      method = "induced";
    } catch {
      irreps = null;
    }
  }
  if (!irreps) return { available: false, method: null, dimension, terms: [], integerConsistent: false };

  // Merge complex conjugate pairs into PHYSICALLY irreducible reps: a real
  // displacement field cannot transform as one member of a conjugate pair
  // alone (the real span combines both), so listing χ and χ* separately would
  // show the same physical distortion twice with double-counted mode bases.
  // The merged term carries the PAIR characters χ+χ* (real — this is what the
  // isotypic projector must use) and dim = 2d, while multiplicity and acoustic
  // content are counted per PAIR (from a single member: n_pair = n_χ = n_χ*),
  // keeping Σ multiplicity·dim = 3N.
  const isConj = (a: Irrep, b: Irrep): boolean =>
    a.characters.length === b.characters.length &&
    a.characters.every((c, i) => Math.abs(c.re - b.characters[i]!.re) < 1e-9 && Math.abs(c.im + b.characters[i]!.im) < 1e-9);
  const merged: { irrep: Irrep; multChars: readonly { re: number; im: number }[] }[] = [];
  const used = new Set<number>();
  irreps.forEach((a, i) => {
    if (used.has(i)) return;
    if (a.real) {
      merged.push({ irrep: a, multChars: a.characters });
      return;
    }
    const j = irreps!.findIndex((b, bi) => bi > i && !used.has(bi) && !b.real && isConj(a, b));
    if (j >= 0) {
      used.add(j);
      const b = irreps![j]!;
      merged.push({
        irrep: {
          label: `${a.label}⊕${b.label}`,
          characters: a.characters.map((c, k) => ({ re: c.re + b.characters[k]!.re, im: c.im + b.characters[k]!.im })),
          real: true,
          dim: (a.dim ?? 1) + (b.dim ?? 1),
        },
        multChars: a.characters, // per-pair count = single-member multiplicity
      });
    } else {
      merged.push({ irrep: a, multChars: a.characters });
    }
  });

  // Plain vector rep χ = tr(R): its irrep content is the acoustic branch.
  const vectorChi = ops.map((op) => ({ re: polarCharacter(op.rotation), im: 0 }));
  const reducible = chi.map((c) => ({ re: c.re, im: c.im }));

  const terms: DisplaciveIrrepTerm[] = [];
  let integerConsistent = true;
  for (const { irrep, multChars } of merged) {
    const nRaw = irrepMultiplicity(reducible, multChars);
    const n = Math.round(nRaw);
    if (Math.abs(nRaw - n) > 0.05) integerConsistent = false;
    if (n <= 0) continue;
    const aRaw = irrepMultiplicity(vectorChi, multChars);
    const acoustic = Math.min(n, Math.max(0, Math.round(aRaw)));
    const trivial = irrep.characters.every((c) => Math.abs(c.re - 1) < 1e-9 && Math.abs(c.im) < 1e-9);
    terms.push({ irrep, multiplicity: n, acoustic, trivial });
  }
  return { available: true, method, dimension, terms, integerConsistent };
}

/**
 * The symmetry-conserving DOF count the trivial irrep must reproduce —
 * Σ_sites dim(allowedPositionShifts). Exposed for the consistency gate.
 */
export function symmetryConservingDof(structure: StructureModel, siteLabels?: readonly string[]): number {
  const labels = siteLabels ?? structure.sites.map((s) => s.label);
  let dof = 0;
  for (const label of labels) {
    const site = structure.sites.find((s) => s.label === label);
    if (!site) continue;
    dof += allowedPositionShifts(structure.spaceGroup.operations, site.position).dimension;
  }
  return dof;
}
