/**
 * Commensurate propagation-vector (k-vector) search from powder magnetic-peak
 * positions.
 *
 * Method (the standard powder k-search, e.g. FullProf's `k_search` /
 * Rodríguez-Carvajal): magnetic reflections appear at G ± k for reciprocal
 * lattice vectors G. Given the d-spacings of the observed magnetic-only peaks
 * (extra peaks not indexed by the nuclear cell), scan a set of candidate k
 * (commensurate rational grid + high-symmetry Brillouin-zone points), and for
 * each score how well the predicted satellite positions {|G ± k|} reproduce the
 * observed peaks. Rank by matched-peak count, then position RMSD, then
 * simplicity (smallest denominator).
 *
 * Scope: single k, commensurate, position-only scoring (no intensity fit). This
 * finds *candidate* propagation vectors; confirming one needs a magnetic
 * refinement (M4). Symmetry-equivalent k give identical powder d-sets, so they
 * tie — the cell's symmetry decides which representative is physical.
 *
 * References: Rodríguez-Carvajal, *Physica B* 192 (1993) 55 (FullProf);
 * Bertaut, *Acta Cryst.* A24 (1968) 217 (magnetic reflection conditions).
 */

import type { UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { inverseDSquared } from "@/core/crystal/unitCell";

export interface KCandidate {
  /** Propagation vector (reciprocal-lattice units), components in [0, ½]. */
  readonly k: Vec3;
  /** Pretty label, e.g. "(½ 0 0)". */
  readonly label: string;
  /** Observed peaks explained (a satellite within tolerance). */
  readonly matched: number;
  /** Total observed peaks. */
  readonly total: number;
  /** RMS |Δd| over matched peaks (Å). */
  readonly rmsd: number;
  /** Ranking score (higher is better): matched fraction penalised by RMSD. */
  readonly score: number;
  /** WHICH peaks this k explains: index into the caller's `observedD` list plus
   *  the |Δd| (Å) to the matching satellite — the per-candidate evidence. */
  readonly matches: readonly { readonly index: number; readonly delta: number }[];
}

export interface KSearchOptions {
  /** Match tolerance on d (Å). Default 0.02. */
  readonly tolerance?: number;
  /** Denominators for the commensurate grid. Default [2, 3, 4, 6]. */
  readonly denominators?: readonly number[];
  /** Half-range of integer hkl for satellite prediction. Default 4. */
  readonly hklRange?: number;
  /** Max candidates returned. Default 12. */
  readonly limit?: number;
  /**
   * Only consider observed peaks below this |Q| (Å⁻¹), with Q = 2π/d. The
   * magnetic form factor falls off fast with Q, so magnetic peaks live at low Q;
   * restricting the search there suppresses spurious high-Q matches. Default 6
   * (≈ d > 1.05 Å). Set 0 or Infinity to disable.
   */
  readonly maxQ?: number;
  /**
   * Optional per-peak weights, parallel to `observedD` (e.g. each peak's
   * statistical significance): the matched fraction in the ranking becomes
   * weight-weighted, so explaining a strong, certain peak counts for more than
   * explaining a marginal one. The reported `matched`/`total` stay plain counts.
   */
  readonly weights?: readonly number[];
}

const FRAC_LABEL: ReadonlyMap<string, string> = new Map([
  ["0.0000", "0"], ["0.5000", "½"], ["0.3333", "⅓"], ["0.6667", "⅔"],
  ["0.2500", "¼"], ["0.7500", "¾"], ["0.1667", "⅙"], ["0.8333", "⅚"],
]);

function comp(x: number): string {
  return FRAC_LABEL.get(x.toFixed(4)) ?? x.toFixed(3);
}

export function kLabel(k: Vec3): string {
  return `(${comp(k[0])} ${comp(k[1])} ${comp(k[2])})`;
}

/**
 * Candidate k set: the commensurate rational grid with the given denominators,
 * each component in [0, ½] (k and 1−k / −k give the same powder d-set), plus Γ.
 */
export function candidateKVectors(denominators: readonly number[] = [2, 3, 4, 6]): Vec3[] {
  const values = new Set<number>([0]);
  for (const n of denominators) {
    for (let i = 1; i * 2 <= n; i++) values.add(i / n); // ≤ ½
  }
  const axis = [...values].sort((a, b) => a - b);
  const out: Vec3[] = [];
  const seen = new Set<string>();
  for (const x of axis) for (const y of axis) for (const z of axis) {
    const key = [x, y, z].map((v) => v.toFixed(4)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([x, y, z]);
  }
  return out;
}

/** Predicted magnetic-satellite d-spacings (Å) for propagation vector k. */
function predictedSatelliteD(cell: UnitCell, k: Vec3, hklRange: number, dMin: number, dMax: number): number[] {
  const ds: number[] = [];
  for (let h = -hklRange; h <= hklRange; h++) {
    for (let kk = -hklRange; kk <= hklRange; kk++) {
      for (let l = -hklRange; l <= hklRange; l++) {
        // Both satellites G+k and G−k (they differ for non-½ components).
        for (const s of [1, -1]) {
          const m0 = h + s * k[0], m1 = kk + s * k[1], m2 = l + s * k[2];
          if (m0 === 0 && m1 === 0 && m2 === 0) continue; // Γ satellite has no d
          const inv = inverseDSquared(cell, m0, m1, m2);
          if (inv <= 0) continue;
          const d = 1 / Math.sqrt(inv);
          if (d >= dMin && d <= dMax) ds.push(d);
        }
      }
    }
  }
  return ds;
}

/**
 * Rank candidate propagation vectors by how well their satellites {|G ± k|}
 * reproduce the observed magnetic-peak d-spacings.
 */
export function searchPropagationVector(
  cell: UnitCell,
  observedD: readonly number[],
  options: KSearchOptions = {},
): KCandidate[] {
  const { tolerance = 0.02, denominators = [2, 3, 4, 6], hklRange = 4, limit = 12, maxQ = 6, weights } = options;
  // Q = 2π/d; keep only low-Q peaks (large d), where magnetic scattering lives.
  // Weights stay parallel through the filter.
  const dMinQ = maxQ > 0 && Number.isFinite(maxQ) ? (2 * Math.PI) / maxQ : 0;
  const obs: { d: number; w: number; index: number }[] = [];
  observedD.forEach((d, i) => {
    if (!Number.isFinite(d) || d <= 0 || d < dMinQ) return;
    const w = weights?.[i];
    obs.push({ d, w: w !== undefined && Number.isFinite(w) && w > 0 ? w : 1, index: i });
  });
  if (obs.length === 0) return [];
  const dMax = Math.max(...obs.map((o) => o.d)) * 1.05;
  const dMin = Math.min(...obs.map((o) => o.d)) * 0.95;
  const totalW = obs.reduce((s, o) => s + o.w, 0);

  const candidates: (KCandidate & { matchedW: number })[] = candidateKVectors(denominators).map((k) => {
    const predicted = predictedSatelliteD(cell, k, hklRange, dMin, dMax);
    let matched = 0;
    let matchedW = 0;
    let sumSq = 0;
    const matches: { index: number; delta: number }[] = [];
    for (const o of obs) {
      let best = Infinity;
      for (const p of predicted) {
        const e = Math.abs(p - o.d);
        if (e < best) best = e;
      }
      if (best <= tolerance) {
        matched++;
        matchedW += o.w;
        sumSq += best * best;
        matches.push({ index: o.index, delta: best });
      }
    }
    const rmsd = matched > 0 ? Math.sqrt(sumSq / matched) : Infinity;
    // Score: (weighted) fraction explained, minus a small RMSD penalty
    // (Å → fraction of tol). With no weights this is the plain matched fraction.
    const score = matchedW / totalW - (matched > 0 ? (rmsd / tolerance) * 0.05 : 0);
    return { k, label: kLabel(k), matched, total: obs.length, rmsd, score, matches, matchedW };
  });

  // Prefer simpler k (smaller denominators) among peaks that match equally well.
  const denomComplexity = (k: Vec3): number =>
    k.reduce((acc, v) => acc + (v === 0 ? 0 : minDenominator(v)), 0);

  candidates.sort((a, b) =>
    b.matchedW - a.matchedW ||
    a.rmsd - b.rmsd ||
    denomComplexity(a.k) - denomComplexity(b.k) ||
    a.k.reduce((s, v) => s + v, 0) - b.k.reduce((s, v) => s + v, 0),
  );
  return candidates.slice(0, limit).map(({ matchedW: _w, ...c }) => c);
}

/**
 * For each observed peak, the |Δd| (Å) to the nearest satellite G ± k of the
 * given propagation vector — the per-peak quantitative check of the CURRENT k
 * (the search above reports only aggregate matched counts). Infinity when no
 * satellite falls in the peaks' d-window.
 */
export function satelliteMatchDeltas(
  cell: UnitCell,
  k: Vec3,
  observedD: readonly number[],
  options: Pick<KSearchOptions, "hklRange"> = {},
): number[] {
  const { hklRange = 4 } = options;
  const valid = observedD.filter((d) => Number.isFinite(d) && d > 0);
  if (valid.length === 0) return observedD.map(() => Infinity);
  const dMax = Math.max(...valid) * 1.05;
  const dMin = Math.min(...valid) * 0.95;
  const predicted = predictedSatelliteD(cell, k, hklRange, dMin, dMax);
  return observedD.map((d) => {
    if (!Number.isFinite(d) || d <= 0) return Infinity;
    let best = Infinity;
    for (const p of predicted) {
      const e = Math.abs(p - d);
      if (e < best) best = e;
    }
    return best;
  });
}

/** Smallest denominator n such that value ≈ m/n (for complexity tie-breaking). */
function minDenominator(v: number): number {
  for (let n = 1; n <= 12; n++) if (Math.abs(v * n - Math.round(v * n)) < 1e-4) return n;
  return 12;
}
