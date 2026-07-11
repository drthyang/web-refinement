/**
 * Automatic face indexing: assign Miller indices to a crystal's observed faces
 * and recover its orientation, with no prior correspondence.
 *
 * Inputs are the observed face normals (unit vectors in the measurement frame,
 * e.g. from a photo reconstruction) and the cell. The method:
 *   1. build a catalog of candidate crystallographic normals for low-index hkl;
 *   2. seed orientations by matching one well-conditioned observed pair to every
 *      catalog pair of the same interplanar angle (angles are rotation-invariant),
 *      scoring each seed by how well *all* observed faces then land on catalog
 *      directions;
 *   3. refine the best seed by ICP — reassign each observed face to its nearest
 *      catalog normal, re-fit the orientation (Wahba/q-method), repeat.
 *
 * The recovered orientation and indices are defined only up to the crystal's
 * point-group gauge (equivalent faces give the same geometry); the result is
 * self-consistent — applying the orientation to each assigned hkl reproduces the
 * observed normal. This feeds a crystalHabit + transmission correction.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { Mat3, Vec3 } from "@/core/math/types";
import { mulVec, transpose } from "@/core/math/mat3";
import { dot, normalize } from "@/core/math/vec3";
import { faceNormalCartesian } from "@/core/absorption/habit";
import { fitOrientation } from "@/core/absorption/orientation";

/** A candidate crystallographic direction: reduced Miller indices + Cartesian normal. */
export interface CatalogEntry {
  readonly hkl: Vec3;
  readonly normal: Vec3;
}

/** One indexed face: which observed normal, its assigned hkl, and the residual angle. */
export interface FaceMatch {
  readonly observedIndex: number;
  readonly hkl: Vec3;
  readonly angleDeg: number;
}

export interface IndexingResult {
  /** Rotation mapping crystal-frame normals onto the measurement frame. */
  readonly orientation: Mat3;
  /** Per-observed-face index assignment, in input order. */
  readonly matches: readonly FaceMatch[];
  /** RMS angular residual over all faces (degrees). */
  readonly rmsAngleDeg: number;
}

export interface IndexingOptions {
  /** Largest |h|,|k|,|l| in the candidate catalog (default 3). */
  readonly maxIndex?: number;
  /** Tolerance for matching a candidate pair's interplanar angle to the seed (deg, default 3). */
  readonly angleToleranceDeg?: number;
  /** Maximum ICP refinement iterations (default 20). */
  readonly maxIcpIterations?: number;
}

/**
 * Catalog of candidate face normals for all low-index hkl up to `maxIndex`,
 * reduced to lowest terms and deduplicated by direction (so (200) collapses onto
 * (100), while the opposite face (-100) is kept).
 */
export function crystallographicNormalCatalog(cell: UnitCell, maxIndex = 3): CatalogEntry[] {
  const seen = new Map<string, CatalogEntry>();
  for (let h = -maxIndex; h <= maxIndex; h++) {
    for (let k = -maxIndex; k <= maxIndex; k++) {
      for (let l = -maxIndex; l <= maxIndex; l++) {
        if (h === 0 && k === 0 && l === 0) continue;
        const g = gcd3(Math.abs(h), Math.abs(k), Math.abs(l));
        const hkl: Vec3 = [h / g, k / g, l / g];
        const key = hkl.join(",");
        if (seen.has(key)) continue;
        seen.set(key, { hkl, normal: faceNormalCartesian(cell, hkl) });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Index observed face normals against the cell: assign Miller indices and
 * recover the crystal orientation. Needs at least two non-parallel faces.
 */
export function indexFaces(cell: UnitCell, observed: readonly Vec3[], options: IndexingOptions = {}): IndexingResult {
  if (observed.length < 2) {
    throw new Error("indexFaces needs at least two observed face normals");
  }
  const maxIndex = options.maxIndex ?? 3;
  const angleTol = (options.angleToleranceDeg ?? 3) * (Math.PI / 180);
  const maxIcp = options.maxIcpIterations ?? 20;

  const catalog = crystallographicNormalCatalog(cell, maxIndex);
  const obs = observed.map((o) => normalize(o));

  // Seed pair: the most-orthogonal observed pair is best conditioned.
  let si = 0;
  let sj = 1;
  let bestOrtho = Infinity;
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const c = Math.abs(dot(obs[i]!, obs[j]!));
      if (c < bestOrtho) {
        bestOrtho = c;
        si = i;
        sj = j;
      }
    }
  }
  const seedAngle = Math.acos(clamp(dot(obs[si]!, obs[sj]!)));

  // Score each catalog pair whose interplanar angle matches the seed; keep the
  // cheapest, then ICP-refine only that winner.
  let bestRot: Mat3 | null = null;
  let bestRms = Infinity;
  for (let a = 0; a < catalog.length; a++) {
    for (let b = 0; b < catalog.length; b++) {
      if (a === b) continue;
      const ang = Math.acos(clamp(dot(catalog[a]!.normal, catalog[b]!.normal)));
      if (Math.abs(ang - seedAngle) > angleTol) continue;
      const R = fitOrientation([
        { observed: obs[si]!, reference: catalog[a]!.normal },
        { observed: obs[sj]!, reference: catalog[b]!.normal },
      ]).rotation;
      const rms = assignmentRms(R, obs, catalog);
      if (rms < bestRms) {
        bestRms = rms;
        bestRot = R;
      }
    }
  }
  if (bestRot === null) {
    throw new Error("indexFaces could not seed an orientation; try a larger angleToleranceDeg or maxIndex");
  }

  // ICP: reassign nearest catalog normals, re-fit, repeat until stable.
  let rotation = bestRot;
  let prevRms = Infinity;
  for (let iter = 0; iter < maxIcp; iter++) {
    const pairs = obs.map((o) => ({ observed: o, reference: nearestEntry(rotation, o, catalog).normal }));
    rotation = fitOrientation(pairs).rotation;
    const rms = assignmentRms(rotation, obs, catalog);
    if (Math.abs(prevRms - rms) < 1e-12) break;
    prevRms = rms;
  }

  const matches: FaceMatch[] = obs.map((o, i) => {
    const entry = nearestEntry(rotation, o, catalog);
    const angleDeg = Math.acos(clamp(dot(mulVec(rotation, entry.normal), o))) * (180 / Math.PI);
    return { observedIndex: i, hkl: entry.hkl, angleDeg };
  });
  return { orientation: rotation, matches, rmsAngleDeg: rootMeanSquare(matches.map((m) => m.angleDeg)) };
}

/** Catalog entry whose normal best aligns with observed `o` under rotation `R` (crystal→measured). */
function nearestEntry(R: Mat3, o: Vec3, catalog: readonly CatalogEntry[]): CatalogEntry {
  // Bring the observed normal into the crystal frame (Rᵀ = R⁻¹ for a rotation).
  const crystal = mulVec(transpose(R), o);
  let best = catalog[0]!;
  let bestDot = -Infinity;
  for (const entry of catalog) {
    const d = dot(crystal, entry.normal);
    if (d > bestDot) {
      bestDot = d;
      best = entry;
    }
  }
  return best;
}

/** RMS residual angle (deg) when each observed face is assigned its nearest catalog normal. */
function assignmentRms(R: Mat3, obs: readonly Vec3[], catalog: readonly CatalogEntry[]): number {
  const angles = obs.map((o) => {
    const entry = nearestEntry(R, o, catalog);
    return Math.acos(clamp(dot(mulVec(R, entry.normal), o))) * (180 / Math.PI);
  });
  return rootMeanSquare(angles);
}

function rootMeanSquare(xs: readonly number[]): number {
  return Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
}

function clamp(x: number): number {
  return Math.min(1, Math.max(-1, x));
}

function gcd3(a: number, b: number, c: number): number {
  const g = gcd(gcd(a, b), c);
  return g === 0 ? 1 : g;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
