/**
 * Representation analysis, part 2: the **irreducible representations** of an
 * abelian little group G_k and the decomposition of the magnetic representation
 * into them, with **basis-vector (magnetic-mode) projection**. This is the
 * BasIreps/Jana2020 "irrep route" (magneticGroups.ts is the complementary
 * Shubnikov route); magneticRepresentation.ts supplies the reducible character
 * and the multiplicity formula this module builds on.
 *
 * Scope (correct-by-construction, no hand-transcribed tables): little groups
 * whose **co-group is abelian** — triclinic/monoclinic/orthorhombic classes, the
 * cyclic trigonal/hexagonal/tetragonal rotation groups, and any general-position
 * (small) little group, at any k including Γ. For such a group every irrep is
 * 1-dimensional and is a product of roots of unity over a direct-product
 * generating set, which is generated directly. Non-abelian little co-groups
 * (3m, 4mm, 432, …) and the projective *small* representations for non-symmorphic
 * groups at BZ-boundary k are the remaining piece (see docs/MAGNETIC_SYMMETRY.md);
 * `abelianIrreps` returns null for a non-abelian group, and the decomposition
 * flags when the multiplicities do not come out integral (a signal that the
 * ordinary irreps used here are not the right — projective — ones).
 *
 * References: Bradley & Cracknell (1972), Ch. 3–4; Rodríguez-Carvajal & Bourée,
 * BasIreps (*EPJ Web Conf.* 22, 2012).
 */

import type { Complex, Mat3, Vec3 } from "@/core/math/types";
import type { StructureModel, SymmetryOperation } from "@/core/crystal/types";
import { mulMat, determinant, IDENTITY3 } from "@/core/math/mat3";
import { applyOperation } from "@/core/crystal/symmetry";
import { magneticRepresentationCharacter, irrepMultiplicity } from "@/core/magnetic/magneticRepresentation";

const matKey = (R: Mat3): string => R.flat().map((x) => Math.round(x)).join(",");
const ID_KEY = matKey(IDENTITY3);
const eqMat = (a: Mat3, b: Mat3): boolean => matKey(a) === matKey(b);

/** Order of a (crystallographic, integer) rotation matrix. */
function matOrder(R: Mat3): number {
  let p = R;
  let n = 1;
  while (matKey(p) !== ID_KEY) {
    p = mulMat(p, R);
    n++;
    if (n > 48) return n; // safety
  }
  return n;
}

/** A 1-D irreducible representation of an abelian little group. */
export interface Irrep {
  /** Generic label Γ1, Γ2, … (standard Mulliken/BNS labels are a later addition). */
  readonly label: string;
  /** χ_irrep(g) for each input operation, in the same order (1-D ⇒ χ *is* the rep). */
  readonly characters: readonly Complex[];
  /** True when every character is real (±1) — a real representation. */
  readonly real: boolean;
}

/**
 * The irreducible representations of the little group defined by `ops`, when its
 * co-group (the distinct rotation parts) is **abelian**; otherwise `null`.
 *
 * Method: take the co-group, verify it is abelian, decompose it as a direct
 * product of cyclic groups ⟨g₁⟩ × … × ⟨gₘ⟩ by greedily choosing independent
 * generators of maximal order, then enumerate the |G| one-dimensional irreps
 * χ_{p₁…pₘ}(g₁^{a₁}…gₘ^{aₘ}) = ∏ exp(2πi·pₖ·aₖ/nₖ).
 */
export function abelianIrreps(ops: readonly SymmetryOperation[]): Irrep[] | null {
  const cogroup: Mat3[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    const key = matKey(op.rotation);
    if (!seen.has(key)) {
      seen.add(key);
      cogroup.push(op.rotation);
    }
  }
  if (cogroup.length === 0) return null;

  // Abelian check.
  for (let i = 0; i < cogroup.length; i++) {
    for (let j = i + 1; j < cogroup.length; j++) {
      if (!eqMat(mulMat(cogroup[i]!, cogroup[j]!), mulMat(cogroup[j]!, cogroup[i]!))) return null;
    }
  }

  // Direct-product generators: greedily add an independent element of max order.
  const gens: { R: Mat3; n: number }[] = [];
  let H: Mat3[] = [IDENTITY3];
  const inH = (R: Mat3): boolean => H.some((h) => eqMat(h, R));
  while (H.length < cogroup.length) {
    let best: Mat3 | null = null;
    let bestN = 0;
    for (const R of cogroup) {
      if (inH(R)) continue;
      const n = matOrder(R);
      // Independent ⇔ ⟨R⟩ ∩ H = {E}: no power R¹…R^{n−1} already lies in H.
      let independent = true;
      let q: Mat3 = R;
      for (let e = 1; e < n; e++) {
        if (inH(q)) { independent = false; break; }
        q = mulMat(q, R);
      }
      if (independent && n > bestN) { best = R; bestN = n; }
    }
    if (!best) break; // cannot happen for a genuine abelian group
    gens.push({ R: best, n: bestN });
    const grown: Mat3[] = [];
    for (const h of H) {
      let q = h;
      for (let e = 0; e < bestN; e++) { grown.push(q); q = mulMat(q, best); }
    }
    const gk = new Set<string>();
    H = [];
    for (const m of grown) {
      const key = matKey(m);
      if (!gk.has(key)) { gk.add(key); H.push(m); }
    }
  }

  // Element → exponent tuple (a₁…aₘ) over the generating set.
  const m = gens.length;
  const tuples = new Map<string, number[]>();
  const buildTuples = (idx: number, acc: Mat3, tup: number[]): void => {
    if (idx === m) { tuples.set(matKey(acc), tup); return; }
    let q = acc;
    for (let e = 0; e < gens[idx]!.n; e++) { buildTuples(idx + 1, q, [...tup, e]); q = mulMat(q, gens[idx]!.R); }
  };
  buildTuples(0, IDENTITY3, []);

  // Enumerate the |G| = ∏ nₖ one-dimensional irreps.
  const irreps: Irrep[] = [];
  const charFor = (ps: number[]): Complex[] =>
    ops.map((op) => {
      const tup = tuples.get(matKey(op.rotation)) ?? new Array(m).fill(0);
      let frac = 0;
      for (let k = 0; k < m; k++) frac += (ps[k]! * tup[k]!) / gens[k]!.n;
      const t = 2 * Math.PI * frac;
      return { re: Math.cos(t), im: Math.sin(t) };
    });
  const enumerate = (idx: number, ps: number[]): void => {
    if (idx === m) {
      const characters = charFor(ps);
      irreps.push({ label: `Γ${irreps.length + 1}`, characters, real: characters.every((c) => Math.abs(c.im) < 1e-9) });
      return;
    }
    for (let p = 0; p < gens[idx]!.n; p++) enumerate(idx + 1, [...ps, p]);
  };
  if (m === 0) {
    irreps.push({ label: "Γ1", characters: ops.map(() => ({ re: 1, im: 0 })), real: true });
  } else {
    enumerate(0, []);
  }
  return irreps;
}

export interface IrrepTerm {
  readonly irrep: Irrep;
  /** How many times this irrep appears (= basis modes it carries). */
  readonly multiplicity: number;
}

export interface MagneticRepDecomposition {
  /** False when the little co-group is non-abelian (out of scope here). */
  readonly abelian: boolean;
  /** Total dimension 3·N of the magnetic representation (N magnetic atoms). */
  readonly dimension: number;
  /** Irreps that appear (multiplicity > 0). */
  readonly terms: readonly IrrepTerm[];
  /**
   * True when every multiplicity came out integral. False signals that the
   * ordinary irreps used here are not the correct (projective) small
   * representations — a non-symmorphic group at a BZ-boundary k.
   */
  readonly integerConsistent: boolean;
}

/**
 * Decompose the magnetic representation Γ_mag over the little group into the
 * irreps of its (abelian) co-group: which irreps carry the order and with what
 * multiplicity (the number of refinable basis modes per irrep).
 */
export function decomposeMagneticRepresentation(
  structure: StructureModel,
  k: Vec3,
  siteLabels: readonly string[],
  littleGroupOps: readonly SymmetryOperation[],
): MagneticRepDecomposition {
  const chi = magneticRepresentationCharacter(structure, k, siteLabels, littleGroupOps);
  const eTerm = chi.find((c) => eqMat(c.op.rotation, IDENTITY3));
  const dimension = Math.round(eTerm ? eTerm.re : 0);
  const irreps = abelianIrreps(littleGroupOps);
  if (!irreps) return { abelian: false, dimension, terms: [], integerConsistent: false };

  const reducible = chi.map((c) => ({ re: c.re, im: c.im }));
  const terms: IrrepTerm[] = [];
  let integerConsistent = true;
  for (const irrep of irreps) {
    const nRaw = irrepMultiplicity(reducible, irrep.characters);
    const n = Math.round(nRaw);
    if (Math.abs(nRaw - n) > 0.05) integerConsistent = false;
    if (n > 0) terms.push({ irrep, multiplicity: n });
  }
  return { abelian: true, dimension, terms, integerConsistent };
}

/**
 * Project the magnetic representation onto one irrep, restricted to the
 * **reference site** (the first magnetic site), giving the moment basis
 * vectors (crystal-axis, real) the irrep allows there — the refinable modes:
 *
 *   basis ⊂ image of  Σ_{g fixing r₀} χ_Γ(g)* · e^{2πi k·L_g} · det(R_g)·R_g
 *
 * (the axial-vector projection operator restricted to the site stabilizer). The
 * number of independent vectors returned is the irrep's multiplicity on that
 * site. Returns [] when the irrep does not act on the site.
 */
export function projectIrrepModes(
  structure: StructureModel,
  k: Vec3,
  siteLabels: readonly string[],
  littleGroupOps: readonly SymmetryOperation[],
  irrep: Irrep,
): Vec3[] {
  const site = structure.sites.find((s) => s.label === siteLabels[0]);
  if (!site) return [];

  // Complex 3×3 projection operator on the reference site.
  const P = [
    [{ re: 0, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }],
    [{ re: 0, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }],
    [{ re: 0, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }],
  ].map((row) => row.map((c) => ({ ...c })));

  littleGroupOps.forEach((op, gi) => {
    const image = applyOperation(op, site.position);
    const L: Vec3 = [image[0] - site.position[0], image[1] - site.position[1], image[2] - site.position[2]];
    const isInt = L.every((v) => Math.abs(v - Math.round(v)) < 1e-3);
    if (!isInt) return; // op does not fix the reference site → no contribution
    const chi = irrep.characters[gi] ?? { re: 1, im: 0 };
    const phase = 2 * Math.PI * (k[0] * Math.round(L[0]) + k[1] * Math.round(L[1]) + k[2] * Math.round(L[2]));
    // weight w = conj(χ)·e^{iφ}
    const cphi = Math.cos(phase), sphi = Math.sin(phase);
    const wRe = chi.re * cphi + chi.im * sphi;
    const wIm = chi.re * sphi - chi.im * cphi;
    const R = op.rotation;
    const det = determinant(R);
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const v = det * R[a]![b]!; // (det·R)_{ab}, real
        P[a]![b]!.re += wRe * v;
        P[a]![b]!.im += wIm * v;
      }
    }
  });

  // Real modes: the column space of [Re(P) | Im(P)] gives the allowed directions
  // (a real magnetic structure uses real basis vectors). Extract an orthonormal
  // real basis by Gram–Schmidt over the six candidate columns.
  const candidates: Vec3[] = [];
  for (let b = 0; b < 3; b++) {
    candidates.push([P[0]![b]!.re, P[1]![b]!.re, P[2]![b]!.re]);
    candidates.push([P[0]![b]!.im, P[1]![b]!.im, P[2]![b]!.im]);
  }
  const basis: Vec3[] = [];
  for (const c of candidates) {
    let v: Vec3 = [...c];
    for (const q of basis) {
      const dot = v[0] * q[0] + v[1] * q[1] + v[2] * q[2];
      v = [v[0] - dot * q[0], v[1] - dot * q[1], v[2] - dot * q[2]];
    }
    const norm = Math.hypot(v[0], v[1], v[2]);
    if (norm > 1e-6) basis.push([v[0] / norm, v[1] / norm, v[2] / norm]);
    if (basis.length === 3) break;
  }
  // Round tiny components to zero for readable directions.
  return basis.map((v) => v.map((x) => (Math.abs(x) < 1e-9 ? 0 : x)) as unknown as Vec3);
}
