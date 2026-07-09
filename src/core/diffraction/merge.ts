/**
 * Merging of symmetry-equivalent single-crystal reflections — the data-reduction
 * step that turns a raw measured HKL list into the unique set a refinement uses,
 * with the internal agreement (R_int), redundancy, and completeness a crystal-
 * lographer reports.
 *
 * Equivalence is by the **Laue class**: the rotation parts of the space-group
 * operations, closed under inversion (Friedel's law, exact for non-anomalous
 * scattering — |F(hkl)|² = |F(h̄k̄l̄)|²). Two reflections are equivalent iff one
 * maps onto the other under h' = Rᵀ·h for some Laue operation. Each equivalence
 * class is reduced to one merged reflection at a canonical representative.
 *
 * Merged intensity is the weighted mean Ī = Σ wᵢIᵢ / Σ wᵢ with wᵢ = 1/σᵢ², and
 * σ(Ī) is the larger of the propagated error 1/√Σwᵢ and the sample scatter of
 * the group, so a discrepant equivalent inflates the merged σ (SHELX/scalepack
 * convention). Agreement statistics:
 *   R_int   = Σ_hkl Σ_i |Iᵢ − Ī| / Σ_hkl Σ_i Iᵢ        (only groups with n ≥ 2)
 *   R_sigma = Σ σ(Ī) / Σ Ī                              (all merged reflections)
 * Reference: Blessing, Acta Cryst. A51 (1995) 33; SHELX manual (R_int/R_sigma);
 * International Tables C §5 (Laue classes and equivalent reflections).
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";

/** A raw or merged single-crystal reflection intensity (I = F², not |F|). */
export interface Reflection2 {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  /** Integrated intensity I ∝ F². */
  readonly intensity: number;
  /** Standard uncertainty σ(I). */
  readonly sigma: number;
  /** Optional batch/scan number (multi-scan scaling; carried through, not merged on). */
  readonly batch?: number;
}

export interface MergedReflection extends Reflection2 {
  /** Number of observations that contributed to this unique reflection. */
  readonly redundancy: number;
}

export interface MergeStatistics {
  /** Number of raw observations merged. */
  readonly observations: number;
  /** Number of unique reflections after merging. */
  readonly unique: number;
  /** Mean redundancy = observations / unique. */
  readonly redundancy: number;
  /** R_int over groups with ≥2 members (0 when none). */
  readonly rInt: number;
  /** R_sigma = Σσ(Ī)/ΣĪ over merged reflections. */
  readonly rSigma: number;
  /** Highest-resolution d-spacing among the data (Å), if a cell was supplied. */
  readonly dMin?: number;
}

export interface MergeResult {
  readonly reflections: MergedReflection[];
  readonly statistics: MergeStatistics;
}

/** hᵀ transformed by a rotation: h' = Rᵀ·h (integer for integer h and R). */
function transformIndices(R: SymmetryOperation["rotation"], h: number, k: number, l: number): Vec3 {
  return [
    R[0]![0]! * h + R[1]![0]! * k + R[2]![0]! * l,
    R[0]![1]! * h + R[1]![1]! * k + R[2]![1]! * l,
    R[0]![2]! * h + R[1]![2]! * k + R[2]![2]! * l,
  ];
}

/**
 * Distinct rotation matrices of the Laue group implied by `operations`: the
 * rotation parts, plus their negatives (Friedel), deduplicated. Translations and
 * time-reversal are irrelevant to |F|² equivalence and are dropped.
 */
export function laueRotations(operations: readonly SymmetryOperation[]): SymmetryOperation["rotation"][] {
  const seen = new Map<string, SymmetryOperation["rotation"]>();
  const key = (R: SymmetryOperation["rotation"]): string =>
    R.map((row) => row.map((v) => Math.round(v)).join(",")).join(";");
  const add = (R: SymmetryOperation["rotation"]): void => {
    const k = key(R);
    if (!seen.has(k)) seen.set(k, R);
  };
  for (const op of operations) {
    add(op.rotation);
    const R = op.rotation;
    const neg: SymmetryOperation["rotation"] = [
      [-R[0]![0]!, -R[0]![1]!, -R[0]![2]!],
      [-R[1]![0]!, -R[1]![1]!, -R[1]![2]!],
      [-R[2]![0]!, -R[2]![1]!, -R[2]![2]!],
    ];
    add(neg);
  }
  // Guarantee the identity is present even for an empty/degenerate op list.
  add([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  return [...seen.values()];
}

/**
 * Canonical representative of a reflection's equivalence class: the
 * lexicographically largest (h, k, l) among all Laue images. Stable and cheap —
 * used only as a grouping key.
 */
function canonicalKey(rotations: readonly SymmetryOperation["rotation"][], h: number, k: number, l: number): string {
  let best: Vec3 = [h, k, l];
  for (const R of rotations) {
    const t = transformIndices(R, h, k, l);
    if (t[0] > best[0] || (t[0] === best[0] && (t[1] > best[1] || (t[1] === best[1] && t[2] > best[2])))) {
      best = t;
    }
  }
  return `${best[0]},${best[1]},${best[2]}`;
}

/**
 * Merge symmetry-equivalent reflections under the Laue group of `operations`.
 * Returns the unique set (at canonical representatives) plus R_int / R_sigma /
 * redundancy statistics. Reflections with non-positive σ get unit weight so a
 * missing error does not divide by zero.
 */
export function mergeEquivalents(
  reflections: readonly Reflection2[],
  operations: readonly SymmetryOperation[],
): MergeResult {
  const rotations = laueRotations(operations);
  const groups = new Map<string, Reflection2[]>();
  for (const r of reflections) {
    const key = canonicalKey(rotations, r.h, r.k, r.l);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const merged: MergedReflection[] = [];
  let rIntNum = 0;
  let rIntDen = 0;
  let rSigNum = 0;
  let rSigDen = 0;

  for (const [key, members] of groups) {
    const [ch, ck, cl] = key.split(",").map(Number) as [number, number, number];
    let sumW = 0;
    let sumWI = 0;
    for (const m of members) {
      const w = m.sigma > 0 ? 1 / (m.sigma * m.sigma) : 1;
      sumW += w;
      sumWI += w * m.intensity;
    }
    const mean = sumW > 0 ? sumWI / sumW : 0;
    // Propagated error and observed scatter; the merged σ is the larger.
    const sigmaProp = sumW > 0 ? 1 / Math.sqrt(sumW) : 0;
    let scatter = 0;
    if (members.length >= 2) {
      let varSum = 0;
      for (const m of members) varSum += (m.intensity - mean) ** 2;
      // Standard error of the (unweighted) mean of the group.
      scatter = Math.sqrt(varSum / (members.length - 1) / members.length);
      for (const m of members) {
        rIntNum += Math.abs(m.intensity - mean);
        rIntDen += Math.abs(m.intensity);
      }
    }
    const sigma = Math.max(sigmaProp, scatter);
    merged.push({ h: ch, k: ck, l: cl, intensity: mean, sigma, redundancy: members.length });
    rSigNum += sigma;
    rSigDen += Math.abs(mean);
  }

  // Deterministic order: descending intensity, then indices.
  merged.sort((a, b) => b.intensity - a.intensity || b.h - a.h || b.k - a.k || b.l - a.l);

  return {
    reflections: merged,
    statistics: {
      observations: reflections.length,
      unique: merged.length,
      redundancy: merged.length > 0 ? reflections.length / merged.length : 0,
      rInt: rIntDen > 0 ? rIntNum / rIntDen : 0,
      rSigma: rSigDen > 0 ? rSigNum / rSigDen : 0,
    },
  };
}
