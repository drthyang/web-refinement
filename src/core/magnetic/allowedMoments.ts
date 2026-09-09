/**
 * Allowed magnetic moment directions on a site under a (magnetic) space group.
 *
 * A moment m (axial vector, crystal-axis components) is allowed only if it is
 * invariant under the site's magnetic stabilizer: for every operation g that
 * fixes the site, e^{2πi k·L_g} · θ_g · det(R_g) · R_g · m = m, where L_g is the
 * lattice translation returning the site image to the site (the k-phase couples
 * the moment to the propagation vector; for k = 0 or L = 0 the phase is 1).
 * Stacking these gives a linear system whose null space is the space of allowed
 * moments. Its dimension is the number of free moment parameters — the "proper
 * constraints" for refinement. A complex phase (k·L not a multiple of ½)
 * contributes its real and imaginary constraint rows separately, which is the
 * correct condition for a *real* moment vector.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { SymmetryOperation } from "@/core/crystal/types";
import { determinant } from "@/core/math/mat3";
import { applyOperation } from "@/core/crystal/symmetry";

/** Returning lattice translation L when `op` fixes `pos` mod lattice, else null. */
function returningTranslation(op: SymmetryOperation, pos: Vec3, tol = 1e-3): Vec3 | null {
  const p = applyOperation(op, pos);
  const L: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const raw = p[i]! - pos[i]!;
    const n = Math.round(raw);
    if (Math.abs(raw - n) > tol) return null;
    L[i] = n;
  }
  return L;
}

/**
 * Real null space of a (rows × n) matrix by Gauss–Jordan elimination with
 * partial pivoting; returns a basis of n-vectors (one per free column).
 */
function nullSpace(rows: number[][], n: number, tol = 1e-6): number[][] {
  const mat = rows.map((r) => [...r]);
  const pivotCols: number[] = [];
  let pr = 0;
  for (let col = 0; col < n && pr < mat.length; col++) {
    let sel = -1;
    let best = tol;
    for (let r = pr; r < mat.length; r++) {
      if (Math.abs(mat[r]![col]!) > best) { best = Math.abs(mat[r]![col]!); sel = r; }
    }
    if (sel === -1) continue;
    [mat[pr], mat[sel]] = [mat[sel]!, mat[pr]!];
    const pivot = mat[pr]![col]!;
    for (let c = 0; c < n; c++) mat[pr]![c]! /= pivot;
    for (let r = 0; r < mat.length; r++) {
      if (r !== pr && Math.abs(mat[r]![col]!) > tol) {
        const f = mat[r]![col]!;
        for (let c = 0; c < n; c++) mat[r]![c]! -= f * mat[pr]![c]!;
      }
    }
    pivotCols.push(col);
    pr++;
  }
  const basis: number[][] = [];
  for (let free = 0; free < n; free++) {
    if (pivotCols.includes(free)) continue;
    const v = new Array<number>(n).fill(0);
    v[free] = 1;
    for (let i = 0; i < pivotCols.length; i++) {
      const pc = pivotCols[i]!;
      v[pc] = -mat[i]![free]!;
    }
    basis.push(v);
  }
  return basis;
}

/** Real null space of a matrix (rows × 3) with tolerance; returns basis Vec3s. */
function nullSpace3(rows: number[][], tol = 1e-6): Vec3[] {
  return nullSpace(rows, 3, tol).map((v) => [v[0]!, v[1]!, v[2]!] as Vec3);
}

export interface AllowedMoments {
  /** Basis of the allowed-moment subspace (crystal-axis components). */
  readonly basis: Vec3[];
  /** Dimension: 0 (site non-magnetic), 1, 2, or 3. */
  readonly dimension: number;
}

/**
 * Compute the allowed moment directions for a site at `position` under the given
 * magnetic operations, for propagation vector `k` (default 0). Returns a basis
 * (possibly empty) of the invariant subspace.
 */
export function allowedMomentDirections(
  operations: readonly SymmetryOperation[],
  position: Vec3,
  k: Vec3 = [0, 0, 0],
): AllowedMoments {
  const rows: number[][] = [];
  for (const op of operations) {
    const L = returningTranslation(op, position);
    if (!L) continue;
    const R: Mat3 = op.rotation;
    const factor = determinant(R) * (op.timeReversal ?? 1);
    const phase = 2 * Math.PI * (k[0]! * L[0]! + k[1]! * L[1]! + k[2]! * L[2]!);
    const c = Math.cos(phase) * factor;
    const s = Math.sin(phase) * factor;
    // Real part: (cos·factor·R − I)·m = 0.
    for (let i = 0; i < 3; i++) {
      const row = [c * R[i]![0], c * R[i]![1], c * R[i]![2]];
      row[i]! -= 1;
      rows.push(row);
    }
    // Imaginary part (only when the k·L phase is complex): sin·factor·R·m = 0.
    if (Math.abs(s) > 1e-9) {
      for (let i = 0; i < 3; i++) {
        rows.push([s * R[i]![0], s * R[i]![1], s * R[i]![2]]);
      }
    }
  }
  if (rows.length === 0) {
    // No stabilizer constraints beyond identity: all three components free.
    return { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], dimension: 3 };
  }
  const basis = nullSpace3(rows);
  return { basis, dimension: basis.length };
}

// ---------------------------------------------------------------------------
// Complex (two-arm) Fourier coefficients
// ---------------------------------------------------------------------------

/**
 * One symmetry-allowed complex Fourier mode: a (cosine, sine) pair of
 * crystal-axis amplitudes. The site's modulation is
 *   m(n) = Σ_i [ aᵢ·cosᵢ + bᵢ·(−sinᵢ) ]·cos(2π k·n) + [ aᵢ·sinᵢ + bᵢ·cosᵢ ]·sin(2π k·n)
 * over the modes i, where aᵢ is the mode's amplitude and bᵢ the amplitude of
 * its quadrature partner {@link quadratureOf}; (aᵢ, bᵢ) = |Sᵢ|·(cos δᵢ, sin δᵢ)
 * is the polar form of the complex coefficient along mode i.
 */
export interface FourierMode {
  /** Cosine (in-phase) amplitude direction, crystal-axis components. */
  readonly cos: Vec3;
  /** Sine (quadrature) amplitude direction, crystal-axis components. */
  readonly sin: Vec3;
}

export interface AllowedFourierModes {
  /** Complex dimension: the number of independent complex modes. */
  readonly dimension: number;
  /**
   * The modes. Each stands for the complex coefficient S ∝ ½(cos + i·sin); its
   * quadrature partner (multiplication of S by i, i.e. a 90° modulation phase
   * shift) is {@link quadratureOf}(mode), so the real parameter count is
   * 2·dimension — minus one global modulation phase, which is a gauge.
   * A mode whose `sin` part is nonzero is a symmetry-FORCED elliptical/helical
   * coupling; a pure-cosine mode is an ordinary direction.
   */
  readonly modes: FourierMode[];
}

/** The quadrature partner of a mode: S → i·S, (cos, sin) → (−sin, cos). */
export function quadratureOf(mode: FourierMode): FourierMode {
  const neg = (x: number): number => (x === 0 ? 0 : -x); // no −0 in a basis
  return {
    cos: [neg(mode.sin[0]!), neg(mode.sin[1]!), neg(mode.sin[2]!)],
    sin: [mode.cos[0]!, mode.cos[1]!, mode.cos[2]!],
  };
}

const clean = (x: number): number => (Math.abs(x) < 1e-10 ? 0 : x);

/**
 * Allowed COMPLEX Fourier coefficients on a site under the magnetic
 * operations, for a propagation vector k whose ±k arms are distinct.
 *
 * The stabilizer condition e^{2πi k·L}·θ·det(R)·R·S = S is complex-linear in
 * S = ½(M^cos + i·M^sin), so on the real 6-vector x = [M^cos; M^sin] it reads
 *   (cos φ·A − I)·M^cos − sin φ·A·M^sin = 0,
 *    sin φ·A·M^cos + (cos φ·A − I)·M^sin = 0,       A = θ·det(R)·R, φ = 2π k·L.
 * Its null space is closed under J: x ↦ [M^sin; −M^cos] (S ↦ −i·S), so it has
 * even real dimension and splits into (mode, quadrature) pairs. The
 * {@link allowedMomentDirections} result is the M^sin = 0 slice of this space —
 * identical whenever every stabilizer phase is real, which is why the real
 * version stays exact for self-conjugate k and for k = 0.
 *
 * Mode choice: pure-cosine directions are preferred (projected from the
 * crystal axes) so the ordinary case reads "Mx cos / Mx sin"; symmetry-forced
 * helical couplings (a nonzero `sin` part) appear only when no pure-cosine
 * direction remains. Vectors are unnormalized, like `AllowedMoments.basis`.
 */
export function allowedFourierModes(
  operations: readonly SymmetryOperation[],
  position: Vec3,
  k: Vec3,
  tol = 1e-6,
): AllowedFourierModes {
  const rows: number[][] = [];
  for (const op of operations) {
    const L = returningTranslation(op, position);
    if (!L) continue;
    const R: Mat3 = op.rotation;
    const factor = determinant(R) * (op.timeReversal ?? 1);
    const phase = 2 * Math.PI * (k[0]! * L[0]! + k[1]! * L[1]! + k[2]! * L[2]!);
    const c = Math.cos(phase) * factor;
    const s = Math.sin(phase) * factor;
    for (let i = 0; i < 3; i++) {
      const cA = [c * R[i]![0], c * R[i]![1], c * R[i]![2]];
      const sA = [s * R[i]![0], s * R[i]![1], s * R[i]![2]];
      // Real part: (c·A − I)·Mcos − s·A·Msin = 0
      const re = [cA[0]!, cA[1]!, cA[2]!, -sA[0]!, -sA[1]!, -sA[2]!];
      re[i]! -= 1;
      rows.push(re);
      // Imaginary part: s·A·Mcos + (c·A − I)·Msin = 0
      const im = [sA[0]!, sA[1]!, sA[2]!, cA[0]!, cA[1]!, cA[2]!];
      im[3 + i]! -= 1;
      rows.push(im);
    }
  }

  const space = rows.length === 0
    ? [[1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 1]]
    : nullSpace(rows, 6, tol);
  if (space.length === 0) return { dimension: 0, modes: [] };

  // Orthonormal basis of the null space (Euclidean, crystal components) so
  // candidates can be projected into it.
  const dot6 = (a: number[], b: number[]): number => a.reduce((acc, x, i) => acc + x * b[i]!, 0);
  const orthonormalize = (vs: number[][], against: number[][] = []): number[][] => {
    const out: number[][] = [];
    for (const raw of vs) {
      const v = [...raw];
      for (const u of [...against, ...out]) {
        const p = dot6(v, u);
        for (let i = 0; i < 6; i++) v[i]! -= p * u[i]!;
      }
      const n = Math.sqrt(dot6(v, v));
      if (n > 1e-8) out.push(v.map((x) => x / n));
    }
    return out;
  };
  const basis = orthonormalize(space);
  const project = (c: number[]): number[] => {
    const out = new Array<number>(6).fill(0);
    for (const b of basis) {
      const p = dot6(c, b);
      for (let i = 0; i < 6; i++) out[i]! += p * b[i]!;
    }
    return out;
  };
  const J = (x: number[]): number[] => [x[3]!, x[4]!, x[5]!, -x[0]!, -x[1]!, -x[2]!];

  // Pick modes: prefer pure-cosine crystal-axis directions, then whatever the
  // null space still holds; each chosen v brings its partner J·v (also in the
  // space, always ⊥ v), so the pairs exhaust the space two at a time.
  const candidates: number[][] = [
    project([1, 0, 0, 0, 0, 0]), project([0, 1, 0, 0, 0, 0]), project([0, 0, 1, 0, 0, 0]),
    ...basis,
  ];
  const chosen: number[][] = [];
  const modes: FourierMode[] = [];
  for (const cand of candidates) {
    if (chosen.length >= basis.length) break;
    const [v] = orthonormalize([cand], chosen);
    if (!v) continue;
    const jv = J(v);
    // J·v lies in the space and is orthogonal to v; guard numerically.
    const [w] = orthonormalize([jv], [...chosen, v]);
    chosen.push(v);
    if (w) chosen.push(w);
    modes.push({
      cos: [clean(v[0]!), clean(v[1]!), clean(v[2]!)],
      sin: [clean(v[3]!), clean(v[4]!), clean(v[5]!)],
    });
  }
  return { dimension: modes.length, modes };
}
