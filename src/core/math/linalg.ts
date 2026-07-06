/**
 * Dense linear algebra for the refinement normal equations.
 *
 * Sizes are small (parameters ≤ ~50), so straightforward Gaussian elimination
 * with partial pivoting is more than adequate and easy to validate. Matrices
 * are `number[][]` (row-major) and vectors `number[]`.
 */

export type Matrix = number[][];

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
