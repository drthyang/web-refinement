/**
 * Crystal orientation from matched face normals — the core of the symmetry
 * route to an absorption correction.
 *
 * Given pairs of unit normals {observed (measurement frame), reference (crystal
 * frame)}, find the rotation R (crystal → measurement) that best maps reference
 * onto observed in the least-squares sense — Wahba's problem,
 *
 *   minimise  Σ wᵢ | oᵢ − R·rᵢ |².
 *
 * Solved in closed form by Davenport's q-method: build the 4×4 symmetric matrix
 * K from the attitude profile B = Σ wᵢ oᵢ rᵢᵀ; the optimal quaternion is K's
 * eigenvector of largest eigenvalue (reusing the core Jacobi eigensolver).
 *
 * This turns a set of *matched* faces into an orientation. Proposing the matches
 * (assigning observed faces to symmetry-equivalent lattice normals) is a
 * separate step; this module is the solver those matches feed.
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import { dot, normalize } from "@/core/math/vec3";
import { symmetricEigenDecomposition } from "@/core/math/linalg";

/** A correspondence between an observed face normal and a crystal-frame normal. */
export interface NormalPair {
  /** Observed face normal in the measurement frame (need not be unit). */
  readonly observed: Vec3;
  /** Crystallographic (crystal-frame) face normal (need not be unit). */
  readonly reference: Vec3;
  /** Optional weight (e.g. face area or confidence); defaults to 1. */
  readonly weight?: number;
}

export interface OrientationFit {
  /** Rotation mapping crystal-frame normals onto the observed frame. */
  readonly rotation: Mat3;
  /** RMS angular residual between R·reference and observed, in degrees. */
  readonly rmsAngleDeg: number;
}

/**
 * Best-fit rotation (crystal → measurement frame) for a set of matched face
 * normals, by Davenport's q-method. Needs at least two non-parallel pairs.
 */
export function fitOrientation(pairs: readonly NormalPair[]): OrientationFit {
  if (pairs.length < 2) {
    throw new Error("fitOrientation needs at least two normal pairs");
  }

  // Attitude profile matrix B = Σ wᵢ oᵢ rᵢᵀ.
  const B = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const obs: Vec3[] = [];
  const ref: Vec3[] = [];
  const wts: number[] = [];
  for (const p of pairs) {
    const o = normalize(p.observed);
    const r = normalize(p.reference);
    const w = p.weight ?? 1;
    obs.push(o);
    ref.push(r);
    wts.push(w);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) B[i]![j]! += w * o[i]! * r[j]!;
    }
  }

  const sigma = B[0]![0]! + B[1]![1]! + B[2]![2]!;
  const z: Vec3 = [B[1]![2]! - B[2]![1]!, B[2]![0]! - B[0]![2]!, B[0]![1]! - B[1]![0]!];
  // K = [[ S − σI, z ], [ zᵀ, σ ]], with S = B + Bᵀ.
  const S = [
    [2 * B[0]![0]!, B[0]![1]! + B[1]![0]!, B[0]![2]! + B[2]![0]!],
    [B[1]![0]! + B[0]![1]!, 2 * B[1]![1]!, B[1]![2]! + B[2]![1]!],
    [B[2]![0]! + B[0]![2]!, B[2]![1]! + B[1]![2]!, 2 * B[2]![2]!],
  ];
  const K = [
    [S[0]![0]! - sigma, S[0]![1]!, S[0]![2]!, z[0]],
    [S[1]![0]!, S[1]![1]! - sigma, S[1]![2]!, z[1]],
    [S[2]![0]!, S[2]![1]!, S[2]![2]! - sigma, z[2]],
    [z[0], z[1], z[2], sigma],
  ];

  const { values, vectors } = symmetricEigenDecomposition(K);
  // The optimal quaternion is the eigenvector of the algebraically largest
  // eigenvalue (not largest magnitude — K is traceless with negative modes).
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  // The eigenvector's quaternion represents the rotation taking observed onto
  // reference; conjugate it (negate the vector part) to map crystal → measured.
  const q = normalizeQuat([
    -vectors[0]![best]!,
    -vectors[1]![best]!,
    -vectors[2]![best]!,
    vectors[3]![best]!,
  ]);
  const rotation = quaternionToMatrix(q);

  // RMS angular residual.
  let sumSq = 0;
  for (let n = 0; n < obs.length; n++) {
    const rr = applyMat(rotation, ref[n]!);
    const c = Math.min(1, Math.max(-1, dot(rr, obs[n]!)));
    const ang = Math.acos(c);
    sumSq += ang * ang;
  }
  const rmsAngleDeg = Math.sqrt(sumSq / obs.length) * (180 / Math.PI);

  return { rotation, rmsAngleDeg };
}

/** Rotation matrix from a unit quaternion [x, y, z, w] (w scalar). */
export function quaternionToMatrix(q: readonly [number, number, number, number]): Mat3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

function normalizeQuat(q: readonly [number, number, number, number]): [number, number, number, number] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function applyMat(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}
