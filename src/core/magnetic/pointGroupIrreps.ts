/**
 * Irreducible representations of **any** crystallographic point group (little
 * co-group) — including the non-abelian classes (6/mmm, 4/mmm, m-3m, …) —
 * constructed, not transcribed.
 *
 * Method (Clifford theory / the little-group method applied internally):
 * every crystallographic point group has order 2^a·3^b and is solvable, so it
 * owns a normal subgroup H of prime index p ∈ {2, 3} (the preimage of an
 * index-p subgroup of the abelianization). Given the irreps of H (recursion;
 * the trivial group is the base), each G-orbit of them yields irreps of G:
 *
 *  - a **fixed** irrep ρ (ρ ≅ ρ∘conj_g) extends in p ways: a Schur-average
 *    intertwiner U with U·ρ(h)·U⁻¹ = ρ(g h g⁻¹) is normalized so that
 *    (c·U)^p = ρ(g^p), and the p choices of the p-th root give the p
 *    extensions ρ̃(h·g^j) = ρ(h)·(cU)^j;
 *  - an orbit of size p **induces** one irrep of dimension p·dim ρ, with the
 *    standard block formula Ind(x)_{j,i} = ρ(g^{−j}·x·g^{i}) when that element
 *    lies in H, 0 otherwise.
 *
 * The construction is verified before returning: Σ dim² = |G| and the
 * first-orthogonality relations of the characters (an exception is thrown on
 * any failure — a wrong character table is worse than none). At the Γ point
 * (k = 0) these ordinary irreps are exactly the small representations even
 * for non-symmorphic space groups, since every phase factor e^{2πik·τ}
 * degenerates to 1 (Bradley & Cracknell 1972, Ch. 3).
 *
 * References: J.-P. Serre, *Linear Representations of Finite Groups*
 * (Springer, 1977), §8 (induced representations) and §9.2 (subgroups of prime
 * index); Bradley & Cracknell (1972) for the Γ-point statement.
 */

import type { Complex, Mat3 } from "@/core/math/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import { mulMat, IDENTITY3 } from "@/core/math/mat3";

const TOL = 1e-8;

// ---------------------------------------------------------------------------
// Small complex-matrix helpers (dims ≤ 6 in practice)
// ---------------------------------------------------------------------------

type CMat = Complex[][];

const czero: Complex = { re: 0, im: 0 };
const cadd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const cmul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

function matEye(d: number): CMat {
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => ({ re: i === j ? 1 : 0, im: 0 })),
  );
}

function matMul(A: CMat, B: CMat): CMat {
  const n = A.length;
  const m = B[0]!.length;
  const k = B.length;
  const out: CMat = Array.from({ length: n }, () => Array.from({ length: m }, () => ({ ...czero })));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let acc: Complex = czero;
      for (let t = 0; t < k; t++) acc = cadd(acc, cmul(A[i]![t]!, B[t]![j]!));
      out[i]![j] = acc;
    }
  }
  return out;
}

const matScale = (A: CMat, s: Complex): CMat => A.map((row) => row.map((x) => cmul(x, s)));
const trace = (A: CMat): Complex => A.reduce((acc, row, i) => cadd(acc, row[i]!), { ...czero });

function matPow(A: CMat, n: number): CMat {
  let out = matEye(A.length);
  for (let i = 0; i < n; i++) out = matMul(out, A);
  return out;
}

// ---------------------------------------------------------------------------
// The group as an index table
// ---------------------------------------------------------------------------

const matKey = (R: Mat3): string => R.flat().map((x) => Math.round(x)).join(",");

interface GroupTable {
  readonly elements: readonly Mat3[];
  readonly comp: readonly (readonly number[])[];
  readonly inv: readonly number[];
}

function buildTable(rotations: readonly Mat3[]): GroupTable {
  const index = new Map<string, number>();
  rotations.forEach((R, i) => index.set(matKey(R), i));
  const comp = rotations.map((a) =>
    rotations.map((b) => {
      const k = index.get(matKey(mulMat(a, b)));
      if (k === undefined) throw new Error("pointGroupIrreps: operations do not close under composition");
      return k;
    }),
  );
  const inv = rotations.map((_, i) => {
    const j = comp[i]!.findIndex((x) => x === 0);
    if (j < 0) throw new Error("pointGroupIrreps: missing inverse");
    return j;
  });
  return { elements: rotations, comp, inv };
}

/** All subgroups (as sorted index arrays) via closure BFS — |G| ≤ 48. */
function allSubgroupSets(g: GroupTable): number[][] {
  const closure = (seed: readonly number[]): number[] => {
    const inSet = new Set<number>(seed);
    inSet.add(0);
    const queue = [...inSet];
    while (queue.length > 0) {
      const a = queue.pop()!;
      for (const b of inSet) {
        for (const c of [g.comp[a]![b]!, g.comp[b]![a]!]) {
          if (!inSet.has(c)) { inSet.add(c); queue.push(c); }
        }
      }
    }
    return [...inSet].sort((x, y) => x - y);
  };
  const found = new Map<string, number[]>();
  const trivial = closure([]);
  found.set(trivial.join(","), trivial);
  const queue = [trivial];
  while (queue.length > 0) {
    const S = queue.pop()!;
    const inS = new Set(S);
    for (let e = 0; e < g.elements.length; e++) {
      if (inS.has(e)) continue;
      const T = closure([...S, e]);
      const key = T.join(",");
      if (!found.has(key)) { found.set(key, T); queue.push(T); }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Irrep construction by prime-index induction
// ---------------------------------------------------------------------------

/** An irrep of a subgroup: matrices per global element index. */
type Rep = Map<number, CMat>;

const repChar = (rep: Rep, members: readonly number[]): Complex[] =>
  members.map((e) => trace(rep.get(e)!));

function sameChar(a: readonly Complex[], b: readonly Complex[]): boolean {
  return a.every((x, i) => Math.abs(x.re - b[i]!.re) < 1e-6 && Math.abs(x.im - b[i]!.im) < 1e-6);
}

/** Normal subgroup of S with prime index p ∈ {2,3}, or null (S trivial). */
function primeIndexNormalSubgroup(
  g: GroupTable,
  S: readonly number[],
  subgroupsOfS: readonly number[][],
): number[] | null {
  const inS = new Set(S);
  for (const p of [2, 3]) {
    if (S.length % p !== 0) continue;
    for (const H of subgroupsOfS) {
      if (H.length * p !== S.length) continue;
      const inH = new Set(H);
      let normal = true;
      outer: for (const s of S) {
        for (const h of H) {
          if (!inH.has(g.comp[g.comp[s]![h]!]![g.inv[s]!]!)) { normal = false; break outer; }
        }
      }
      if (normal && [...H].every((h) => inS.has(h))) return [...H];
    }
  }
  return null;
}

/** Deterministic "random" complex matrix for the Schur average. */
function probeMatrix(d: number, seed: number): CMat {
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => ({
      re: Math.sin(seed + 3.7 * i + 1.3 * j + 0.7),
      im: Math.cos(seed * 1.7 + 2.1 * i + 5.3 * j),
    })),
  );
}

function irrepsOfSubgroup(g: GroupTable, S: readonly number[]): Rep[] {
  if (S.length === 1) {
    return [new Map([[0, [[{ re: 1, im: 0 }]]]])];
  }
  // Subgroups of S: filter the global subgroup list to subsets of S.
  const inS = new Set(S);
  const subsOfS = allSubgroupSets(g).filter((T) => T.every((e) => inS.has(e)));
  const H = primeIndexNormalSubgroup(g, S, subsOfS);
  if (!H) throw new Error("pointGroupIrreps: no prime-index normal subgroup (non-solvable input?)");
  const p = S.length / H.length;
  const inH = new Set(H);
  const gGen = S.find((e) => !inH.has(e))!;

  // Coset powers g^0..g^p (g^p ∈ H).
  const gPow: number[] = [0];
  for (let j = 1; j <= p; j++) gPow.push(g.comp[gPow[j - 1]!]![gGen]!);

  const subIrreps = irrepsOfSubgroup(g, H);
  const subChars = subIrreps.map((r) => repChar(r, H));

  const conj = (x: number, by: number): number => g.comp[g.comp[by]![x]!]![g.inv[by]!]!;
  /** Character of ρ∘conj_g (h ↦ ρ(g h g⁻¹)) over H. */
  const twistedChar = (rep: Rep): Complex[] => H.map((h) => trace(rep.get(conj(h, gGen))!));

  const out: Rep[] = [];
  const done = new Set<number>();

  for (let i = 0; i < subIrreps.length; i++) {
    if (done.has(i)) continue;
    const rho = subIrreps[i]!;
    const d = rho.get(0)!.length;
    const twisted = twistedChar(rho);
    const partner = subChars.findIndex((ch) => sameChar(ch, twisted));
    if (partner < 0) throw new Error("pointGroupIrreps: twisted irrep not found");

    if (partner === i) {
      // Fixed irrep → p extensions with a normalized intertwiner.
      done.add(i);
      let U: CMat | null = null;
      for (let seed = 1; seed <= 5 && !U; seed++) {
        const X = probeMatrix(d, seed);
        let acc: CMat = Array.from({ length: d }, () => Array.from({ length: d }, () => ({ ...czero })));
        for (const h of H) {
          const term = matMul(matMul(rho.get(conj(h, gGen))!, X), rho.get(g.inv[h]!)!);
          acc = acc.map((row, r) => row.map((x, cc) => cadd(x, term[r]![cc]!)));
        }
        // Reject a (measure-zero) degenerate probe: ‖U‖ must not vanish.
        const norm = acc.flat().reduce((s, x) => s + x.re * x.re + x.im * x.im, 0);
        if (norm > 1e-9) U = acc;
      }
      if (!U) throw new Error("pointGroupIrreps: intertwiner average degenerated");
      // U^p = λ·ρ(g^p) (both intertwine ρ with itself ⇒ scalar by Schur).
      const Up = matPow(U, p);
      const rhoGp = rho.get(gPow[p]!)!;
      const lambda = cmul(trace(matMul(Up, rho.get(g.inv[gPow[p]!]!)!)), { re: 1 / d, im: 0 });
      // c = λ^{-1/p} (principal), then the p roots of unity give the p extensions.
      const r = Math.hypot(lambda.re, lambda.im);
      const th = Math.atan2(lambda.im, lambda.re);
      const c0: Complex = { re: Math.cos(-th / p) / r ** (1 / p), im: Math.sin(-th / p) / r ** (1 / p) };
      for (let k = 0; k < p; k++) {
        const zeta: Complex = { re: Math.cos((2 * Math.PI * k) / p), im: Math.sin((2 * Math.PI * k) / p) };
        const Ug = matScale(U, cmul(c0, zeta));
        const rep: Rep = new Map();
        for (const x of S) {
          // x = h·g^j with j the coset exponent.
          let j = 0;
          let h = x;
          for (; j < p; j++) {
            h = g.comp[x]![g.inv[gPow[j]!]!]!;
            if (inH.has(h)) break;
          }
          rep.set(x, matMul(rho.get(h)!, matPow(Ug, j)));
        }
        // Consistency: ρ̃(g)^p must equal ρ(g^p).
        const check = matPow(Ug, p);
        const diff = check.flat().reduce(
          (s, x, idx) => s + Math.abs(x.re - rhoGp.flat()[idx]!.re) + Math.abs(x.im - rhoGp.flat()[idx]!.im),
          0,
        );
        if (diff > 1e-6) throw new Error("pointGroupIrreps: extension normalization failed");
        out.push(rep);
      }
    } else {
      // Orbit of size p → one induced irrep of dimension p·d.
      const orbit = [i, partner];
      if (p === 3) {
        const twisted2 = subChars.findIndex((ch) => sameChar(ch, twistedChar(subIrreps[partner]!)));
        if (twisted2 !== i) orbit.push(twisted2);
      }
      for (const o of orbit) done.add(o);
      const rep: Rep = new Map();
      for (const x of S) {
        const M: CMat = Array.from({ length: p * d }, () => Array.from({ length: p * d }, () => ({ ...czero })));
        for (let jj = 0; jj < p; jj++) {
          for (let ii = 0; ii < p; ii++) {
            // block (jj, ii) = ρ(g^{-jj}·x·g^{ii}) when that element ∈ H
            const e = g.comp[g.comp[g.inv[gPow[jj]!]!]![x]!]![gPow[ii]!]!;
            if (!inH.has(e)) continue;
            const B = rho.get(e)!;
            for (let r = 0; r < d; r++) for (let cc = 0; cc < d; cc++) M[jj * d + r]![ii * d + cc] = { ...B[r]![cc]! };
          }
        }
        rep.set(x, M);
      }
      out.push(rep);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PointGroupIrrep {
  readonly label: string;
  readonly dim: number;
  /** χ(g) for each input operation (via its rotation part). */
  readonly characters: readonly Complex[];
  readonly real: boolean;
}

/**
 * The complete irrep set of the co-group of `ops` (any crystallographic point
 * group), with characters reported per input operation. Throws if the
 * verification (Σ dim² = |G|, character orthogonality) fails — a wrong table
 * is worse than none.
 */
export function pointGroupIrreps(ops: readonly SymmetryOperation[]): PointGroupIrrep[] {
  // Distinct rotations, identity first.
  const seen = new Set<string>();
  const rotations: Mat3[] = [];
  for (const op of ops) {
    const key = matKey(op.rotation);
    if (!seen.has(key)) { seen.add(key); rotations.push(op.rotation); }
  }
  rotations.sort((a, b) => Number(matKey(b) === matKey(IDENTITY3)) - Number(matKey(a) === matKey(IDENTITY3)));

  const table = buildTable(rotations);
  const S = rotations.map((_, i) => i);
  const reps = irrepsOfSubgroup(table, S);

  // Characters per element, then verification.
  const chars = reps.map((rep) => S.map((e) => trace(rep.get(e)!)));
  const dims = reps.map((rep) => rep.get(0)!.length);
  const n = S.length;
  if (dims.reduce((s, d) => s + d * d, 0) !== n) {
    throw new Error("pointGroupIrreps: Σ dim² ≠ |G|");
  }
  for (let a = 0; a < chars.length; a++) {
    for (let b = 0; b < chars.length; b++) {
      let re = 0;
      let im = 0;
      for (let e = 0; e < n; e++) {
        const x = chars[a]![e]!;
        const y = chars[b]![e]!;
        re += x.re * y.re + x.im * y.im; // x·conj(y)
        im += x.im * y.re - x.re * y.im;
      }
      const want = a === b ? 1 : 0;
      if (Math.abs(re / n - want) > 1e-6 || Math.abs(im / n) > 1e-6) {
        throw new Error("pointGroupIrreps: character orthogonality failed");
      }
    }
  }

  // Stable order: dimension, then rounded character string.
  const order = chars
    .map((ch, i) => ({
      i,
      dim: dims[i]!,
      key: ch.map((x) => `${x.re.toFixed(4)},${x.im.toFixed(4)}`).join(";"),
    }))
    .sort((a, b) => a.dim - b.dim || a.key.localeCompare(b.key));

  const elementIndex = new Map<string, number>();
  rotations.forEach((R, i) => elementIndex.set(matKey(R), i));

  return order.map(({ i, dim }, rank) => {
    const perOp = ops.map((op) => {
      const e = elementIndex.get(matKey(op.rotation))!;
      const x = chars[i]![e]!;
      return { re: Math.abs(x.re) < TOL ? 0 : x.re, im: Math.abs(x.im) < TOL ? 0 : x.im };
    });
    return {
      label: `Γ${rank + 1}`,
      dim,
      characters: perOp,
      real: perOp.every((x) => Math.abs(x.im) < 1e-6),
    };
  });
}
