/**
 * Dense linear algebra for the refinement normal equations.
 *
 * Sizes are small (parameters ≤ ~50), so straightforward Gaussian elimination
 * with partial pivoting is more than adequate and easy to validate. Matrices
 * are `number[][]` (row-major) and vectors `number[]`.
 */

export type Matrix = number[][];

export interface SymmetricPseudoInverseResult {
  readonly inverse: Matrix;
  readonly singularValues: readonly number[];
  readonly zeroCount: number;
  /** Indices with the largest participation in discarded singular directions. */
  readonly droppedIndices: readonly number[];
  readonly conditionNumber: number;
}

/** Solve A·x = b for x via Gaussian elimination with partial pivoting. */
export function solveLinearSystem(a: Matrix, b: number[]): number[] {
  const n = b.length;
  // Work on augmented copies so inputs are not mutated.
  const m: Matrix = a.map((row, i) => [...row, b[i] as number]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: find the largest magnitude entry in this column.
    let pivotRow = col;
    let pivotVal = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]![col]!);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-14) {
      throw new Error("Singular matrix in solveLinearSystem");
    }
    if (pivotRow !== col) {
      const tmp = m[col]!;
      m[col] = m[pivotRow]!;
      m[pivotRow] = tmp;
    }

    const pivot = m[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        m[r]![c]! -= factor * m[col]![c]!;
      }
    }
  }

  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    x[i] = m[i]![n]! / m[i]![i]!;
  }
  return x;
}

/** Invert a square matrix via Gauss-Jordan elimination. Used for covariance. */
export function invertMatrix(a: Matrix): Matrix {
  const n = a.length;
  const m: Matrix = a.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]![col]!);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-14) {
      throw new Error("Singular matrix in invertMatrix");
    }
    if (pivotRow !== col) {
      const tmp = m[col]!;
      m[col] = m[pivotRow]!;
      m[pivotRow] = tmp;
    }

    const pivot = m[col]![col]!;
    for (let c = 0; c < 2 * n; c++) {
      m[col]![c]! /= pivot;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c++) {
        m[r]![c]! -= factor * m[col]![c]!;
      }
    }
  }

  return m.map((row) => row.slice(n));
}

/**
 * Eigen-decompose a real symmetric matrix with the Jacobi rotation method.
 * Normal-equation matrices in refinement are small, so this intentionally
 * favors clarity and determinism over cleverness.
 */
export function symmetricEigenDecomposition(
  a: Matrix,
  tol = 1e-12,
  maxSweeps = 80,
): { values: number[]; vectors: Matrix } {
  const n = a.length;
  if (n === 0) return { values: [], vectors: [] };
  if (n === 1) return { values: [a[0]?.[0] ?? 0], vectors: [[1]] };

  const m: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => {
      const aij = a[i]?.[j] ?? 0;
      const aji = a[j]?.[i] ?? aij;
      return 0.5 * (aij + aji);
    }),
  );
  const v: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)),
  );

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let p = 0;
    let q = 1;
    let maxOff = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const off = Math.abs(m[i]![j]!);
        if (off > maxOff) {
          maxOff = off;
          p = i;
          q = j;
        }
      }
    }
    if (maxOff < tol) break;

    const app = m[p]![p]!;
    const aqq = m[q]![q]!;
    const apq = m[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const mkp = m[k]![p]!;
      const mkq = m[k]![q]!;
      m[k]![p] = c * mkp - s * mkq;
      m[p]![k] = m[k]![p]!;
      m[k]![q] = s * mkp + c * mkq;
      m[q]![k] = m[k]![q]!;
    }
    m[p]![p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    m[q]![q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    m[p]![q] = 0;
    m[q]![p] = 0;

    for (let k = 0; k < n; k++) {
      const vkp = v[k]![p]!;
      const vkq = v[k]![q]!;
      v[k]![p] = c * vkp - s * vkq;
      v[k]![q] = s * vkp + c * vkq;
    }
  }

  const order = Array.from({ length: n }, (_, i) => i)
    .sort((i, j) => Math.abs(m[j]![j]!) - Math.abs(m[i]![i]!));
  return {
    values: order.map((i) => m[i]![i]!),
    vectors: Array.from({ length: n }, (_, row) => order.map((col) => v[row]![col]!)),
  };
}

/**
 * Moore-Penrose pseudo-inverse for a symmetric matrix. Small singular values
 * are truncated using `rcond * max(singularValue)`, which is the same stability
 * principle GSAS-II applies to ill-conditioned Hessian least squares.
 */
export function pseudoInverseSymmetric(a: Matrix, rcond = 1e-6): SymmetricPseudoInverseResult {
  const n = a.length;
  const { values, vectors } = symmetricEigenDecomposition(a);
  const singularValues = values.map((x) => Math.abs(x));
  const maxSingular = Math.max(...singularValues, 0);
  const cutoff = rcond * maxSingular;
  const inverse: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const droppedScore = new Array<number>(n).fill(0);
  let zeroCount = 0;
  let minKept = Infinity;

  for (let k = 0; k < n; k++) {
    const eig = values[k]!;
    const singular = singularValues[k]!;
    if (singular <= cutoff || !Number.isFinite(singular)) {
      zeroCount++;
      for (let i = 0; i < n; i++) droppedScore[i]! += Math.abs(vectors[i]![k]!);
      continue;
    }
    minKept = Math.min(minKept, singular);
    const inv = 1 / eig;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        inverse[i]![j]! += vectors[i]![k]! * inv * vectors[j]![k]!;
      }
    }
  }

  const droppedIndices = droppedScore
    .map((score, index) => ({ score, index }))
    .filter((o) => o.score > 1e-8)
    .sort((a, b) => b.score - a.score)
    .map((o) => o.index);

  return {
    inverse,
    singularValues,
    zeroCount,
    droppedIndices,
    conditionNumber: minKept < Infinity && minKept > 0 ? maxSingular / minKept : Infinity,
  };
}

/** Solve A·x=b with a symmetric pseudo-inverse. */
export function solveSymmetricPseudoInverse(
  a: Matrix,
  b: readonly number[],
  rcond = 1e-6,
): { x: number[]; diagnostics: SymmetricPseudoInverseResult } {
  const diagnostics = pseudoInverseSymmetric(a, rcond);
  const x = diagnostics.inverse.map((row) => row.reduce((acc, v, i) => acc + v * b[i]!, 0));
  return { x, diagnostics };
}
