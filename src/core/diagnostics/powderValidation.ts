/**
 * Powder-refinement validation statistics: what the Validation view reports
 * beyond a single wR.
 *
 *  - The Rietveld agreement set over the points the fit uses, and the same set
 *    with the background subtracted. With a high background Rwp looks good even
 *    when the peaks fit badly, so the background-subtracted Rwp′ judges the
 *    peaks (Young, *The Rietveld Method* (1993), Ch. 1; Toby, *Powder Diffr.*
 *    21 (2006) 67).
 *  - The Durbin–Watson d statistic of the ordered weighted residuals and its
 *    critical value Q_D (Hill & Flack, *J. Appl. Cryst.* 20 (1987) 356).
 *    Uncorrelated residuals give d ≈ 2. d < Q_D is positive serial
 *    correlation at the 99.9 % level: neighbouring points miss together, which
 *    is a systematic (profile) misfit, and the esds from the least-squares
 *    matrix are then too small.
 *  - The normalized residual δᵢ = (y_obs − y_calc)/σᵢ and its cumulative χ²,
 *    which climbs in steps wherever the model misses and as a straight ramp
 *    where only noise is left.
 *  - χ²/N in d-shells: misfit concentrated at short d points to the ADPs or an
 *    absorption/roughness correction; at long d, to peak shape.
 *  - Per-phase R_Bragg and R_F from the Rietveld partition of the observed
 *    intensity, and the reflections that carry the most χ².
 *  - Unindexed peaks: positive residual where no reflection of any phase lies.
 */

import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import { annotateExtraPeaks, detectExtraPeaks } from "@/core/magnetic/extraPeaks";

export interface PowderValidationInput {
  /** Abscissa of every point, in the pattern's native unit and order. */
  readonly x: readonly number[];
  readonly yObs: readonly number[];
  /** The calculated pattern the fit is judged against (background included). */
  readonly yCalc: readonly number[];
  /** The refined background, for the background-subtracted agreement. */
  readonly yBackground?: readonly number[];
  /** Standard uncertainty of every observation (σ > 0). */
  readonly sigma: readonly number[];
  /** Points that enter the fit (inside the fit range, not masked). */
  readonly include: readonly boolean[];
  /** Number of free parameters, for N − P. */
  readonly nParams: number;
  /** d-spacing (Å) of every point, for the shells. Omit to shell on x. */
  readonly d?: readonly number[];
  /** Number of equal-count shells (default 10). */
  readonly shellCount?: number;
}

export interface PowderAgreementSet {
  /** Points in the fit. */
  readonly n: number;
  readonly nParams: number;
  /** R_p = Σ|y_o − y_c| / Σ|y_o|. */
  readonly rp: number;
  /** R_wp = √[Σw(y_o − y_c)² / Σw y_o²]. */
  readonly rwp: number;
  /** R_exp = √[(N − P) / Σw y_o²]. */
  readonly rexp: number;
  /** GoF = R_wp / R_exp. */
  readonly gof: number;
  /** Reduced χ² = Σwδ²/(N − P) = GoF². */
  readonly chi2nu: number;
  /** The same three with y_o − y_b in the denominators (absent without a background). */
  readonly rpBkg?: number;
  readonly rwpBkg?: number;
  readonly rexpBkg?: number;
}

export interface DurbinWatson {
  /** d = Σ(δᵢ − δᵢ₋₁)² / Σδᵢ² over the fitted points in order. */
  readonly d: number;
  /** Hill & Flack's critical value Q_D at the 99.9 % level. */
  readonly qd: number;
  /** d < Q_D: significant positive serial correlation. */
  readonly correlated: boolean;
}

export interface ResidualShell {
  /** Shell bounds on the shell axis (d in Å, or x in its native unit). */
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  /** Σwδ² / n in the shell (≈ 1 for noise alone). */
  readonly chi2PerPoint: number;
  /** Fraction of the total χ² in the shell. */
  readonly share: number;
}

export interface PowderValidation {
  readonly agreement: PowderAgreementSet;
  /** Absent with fewer than three fitted points. */
  readonly durbinWatson?: DurbinWatson;
  /** δᵢ = (y_o − y_c)/σᵢ at every point; NaN where the point is not fitted. */
  readonly delta: Float64Array;
  /** Running Σwδ² as a fraction of the total, at every point (flat across unfitted points). */
  readonly cumulative: Float64Array;
  /** Total χ² = Σwδ² over the fitted points. */
  readonly chi2: number;
  readonly shells: readonly ResidualShell[];
  /** What the shells are binned on. */
  readonly shellAxis: "d" | "x";
}

/**
 * Hill & Flack's Q_D: the Durbin–Watson value below which positive serial
 * correlation is significant at the 99.9 % level, for N points and P
 * parameters. Q_D = 2[(N − 1)/(N − P) − 3.0902/√(N + 2)].
 */
export function durbinWatsonCritical(n: number, nParams: number): number {
  if (n <= nParams || n < 3) return 0;
  return 2 * ((n - 1) / (n - nParams) - 3.0902 / Math.sqrt(n + 2));
}

/** Durbin–Watson d of an ordered residual sequence. */
export function durbinWatson(deltas: readonly number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < deltas.length; i++) {
    const v = deltas[i]!;
    den += v * v;
    if (i > 0) {
      const dv = v - deltas[i - 1]!;
      num += dv * dv;
    }
  }
  return den > 0 ? num / den : 2;
}

/** Validation statistics for the current powder fit. */
export function powderValidation(input: PowderValidationInput): PowderValidation {
  const { x, yObs, yCalc, yBackground, sigma, include, nParams, d } = input;
  const n = Math.min(x.length, yObs.length, yCalc.length, sigma.length, include.length);
  const delta = new Float64Array(n).fill(Number.NaN);
  const cumulative = new Float64Array(n);

  let nUsed = 0;
  let sumAbsObs = 0, sumAbsDiff = 0, sumWObs2 = 0, sumWDiff2 = 0;
  let sumAbsNet = 0, sumWNet2 = 0;
  const hasBkg = yBackground !== undefined && yBackground.length >= n;
  const ordered: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = sigma[i]!;
    if (!include[i] || !(s > 0)) continue;
    const o = yObs[i]!;
    const diff = o - yCalc[i]!;
    const w = 1 / (s * s);
    nUsed++;
    sumAbsObs += Math.abs(o);
    sumAbsDiff += Math.abs(diff);
    sumWObs2 += w * o * o;
    sumWDiff2 += w * diff * diff;
    if (hasBkg) {
      const net = o - yBackground![i]!;
      sumAbsNet += Math.abs(net);
      sumWNet2 += w * net * net;
    }
    const dl = diff / s;
    delta[i] = dl;
    ordered.push(dl);
  }

  const dof = Math.max(nUsed - nParams, 1);
  const rwp = sumWObs2 > 0 ? Math.sqrt(sumWDiff2 / sumWObs2) : 0;
  const rexp = sumWObs2 > 0 ? Math.sqrt(dof / sumWObs2) : 0;
  const agreement: PowderAgreementSet = {
    n: nUsed,
    nParams,
    rp: sumAbsObs > 0 ? sumAbsDiff / sumAbsObs : 0,
    rwp,
    rexp,
    gof: rexp > 0 ? rwp / rexp : 0,
    chi2nu: sumWDiff2 / dof,
    ...(hasBkg && sumWNet2 > 0
      ? {
          rpBkg: sumAbsNet > 0 ? sumAbsDiff / sumAbsNet : 0,
          rwpBkg: Math.sqrt(sumWDiff2 / sumWNet2),
          rexpBkg: Math.sqrt(dof / sumWNet2),
        }
      : {}),
  };

  let run = 0;
  for (let i = 0; i < n; i++) {
    const v = delta[i]!;
    if (!Number.isNaN(v)) run += v * v;
    cumulative[i] = sumWDiff2 > 0 ? run / sumWDiff2 : 0;
  }

  const dwValue = ordered.length >= 3 ? durbinWatson(ordered) : undefined;
  const qd = durbinWatsonCritical(nUsed, nParams);
  const durbin = dwValue !== undefined ? { d: dwValue, qd, correlated: dwValue < qd } : undefined;

  const axis = d && d.length >= n ? d : x;
  const shells = residualShells(axis, delta, sumWDiff2, input.shellCount ?? 10);

  return {
    agreement,
    ...(durbin ? { durbinWatson: durbin } : {}),
    delta,
    cumulative,
    chi2: sumWDiff2,
    shells,
    shellAxis: d && d.length >= n ? "d" : "x",
  };
}

/**
 * χ² per point in equal-count shells of the fitted points along `axis`,
 * ordered from the smallest axis value up. Points sharing an axis value stay
 * in one shell.
 */
function residualShells(axis: readonly number[], delta: Float64Array, total: number, count: number): ResidualShell[] {
  const idx: number[] = [];
  for (let i = 0; i < delta.length; i++) if (!Number.isNaN(delta[i]!) && Number.isFinite(axis[i]!)) idx.push(i);
  if (idx.length === 0 || count < 1) return [];
  idx.sort((a, b) => axis[a]! - axis[b]!);
  const k = Math.min(count, idx.length);
  const shells: ResidualShell[] = [];
  let start = 0;
  for (let s = 0; s < k; s++) {
    let end = s === k - 1 ? idx.length : Math.round(((s + 1) * idx.length) / k);
    // Keep equal axis values together so a shell edge never splits them.
    while (end < idx.length && end > start && axis[idx[end]!] === axis[idx[end - 1]!]) end++;
    if (end <= start) continue;
    let sum = 0;
    for (let j = start; j < end; j++) {
      const v = delta[idx[j]!]!;
      sum += v * v;
    }
    shells.push({
      lo: axis[idx[start]!]!,
      hi: axis[idx[end - 1]!]!,
      n: end - start,
      chi2PerPoint: sum / (end - start),
      share: total > 0 ? sum / total : 0,
    });
    start = end;
    if (start >= idx.length) break;
  }
  return shells;
}

export interface PhaseAgreement {
  /** The phase's id ("magnetic" for the magnetic satellites). */
  readonly phaseId: string;
  readonly label: string;
  /** Load order of the crystallographic phase (0 = primary); magnetic rides on 0. */
  readonly phaseIndex: number;
  readonly kind: "nuclear" | "magnetic";
  /** R_Bragg = Σ|I_o − I_c| / Σ I_o over the phase's reflections. */
  readonly rBragg: number;
  /** R_F = Σ|√I_o − √I_c| / Σ√I_o. */
  readonly rF: number;
  readonly reflections: number;
}

/**
 * Per-phase Bragg agreement from the Rietveld partition. I_obs is apportioned
 * by the calculated intensities, so overlapping reflections lean toward the
 * model: compare phases with these, never quote them as an independent test.
 */
export function phaseAgreement(rows: readonly ReflectionObsCalc[]): PhaseAgreement[] {
  const groups = new Map<string, { label: string; index: number; kind: "nuclear" | "magnetic"; rows: ReflectionObsCalc[] }>();
  for (const r of rows) {
    const key = r.kind === "magnetic" ? "magnetic" : r.phaseId ?? "phase-0";
    let g = groups.get(key);
    if (!g) {
      g = {
        label: r.kind === "magnetic" ? "magnetic" : r.phaseLabel ?? "nuclear",
        index: r.phaseIndex ?? 0,
        kind: r.kind,
        rows: [],
      };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const out: PhaseAgreement[] = [];
  for (const [phaseId, g] of groups) {
    let bNum = 0, bDen = 0, fNum = 0, fDen = 0;
    for (const r of g.rows) {
      const io = Math.max(r.iObs, 0);
      bNum += Math.abs(r.iObs - r.iCalc);
      bDen += io;
      const fo = Math.sqrt(io);
      fNum += Math.abs(fo - Math.sqrt(Math.max(r.iCalc, 0)));
      fDen += fo;
    }
    out.push({
      phaseId,
      label: g.label,
      phaseIndex: g.index,
      kind: g.kind,
      rBragg: bDen > 0 ? bNum / bDen : 0,
      rF: fDen > 0 ? fNum / fDen : 0,
      reflections: g.rows.length,
    });
  }
  // Crystallographic phases in load order, the magnetic satellites last.
  return out.sort((a, b) => (a.kind === b.kind ? a.phaseIndex - b.phaseIndex : a.kind === "magnetic" ? 1 : -1));
}

export type MisfitSignature = "shape" | "under" | "over";

export interface ReflectionMisfit {
  readonly row: ReflectionObsCalc;
  /** Fraction of the total χ² this reflection carries. */
  readonly share: number;
  /**
   * How the residual sits under the peak: "shape" when it changes sign across
   * the peak (position, width or asymmetry), "under" when the observed peak is
   * stronger than calculated, "over" when it is weaker.
   */
  readonly signature: MisfitSignature;
}

/** Read a reflection's residual moments as a misfit signature. */
export function misfitSignature(mean: number, lobe: number): MisfitSignature {
  if (Math.abs(lobe) > Math.abs(mean)) return "shape";
  return mean >= 0 ? "under" : "over";
}

/**
 * The reflections carrying the most χ², most first. Needs rows built with χ²
 * attribution (`powderReflectionObsCalc(..., { yCalc, sigma, include })`).
 */
export function worstReflections(rows: readonly ReflectionObsCalc[], totalChi2: number, limit = 8): ReflectionMisfit[] {
  if (!(totalChi2 > 0)) return [];
  return rows
    .filter((r) => r.chi2 !== undefined && r.chi2 > 0)
    .sort((a, b) => b.chi2! - a.chi2!)
    .slice(0, limit)
    .map((row) => ({
      row,
      share: row.chi2! / totalChi2,
      signature: misfitSignature(row.misfitMean ?? 0, row.misfitLobe ?? 0),
    }));
}

export interface UnindexedPeak {
  /** d-spacing of the residual apex (Å). */
  readonly d: number;
  /** Index of the apex point in the pattern. */
  readonly index: number;
  /** Apex height / σ, when the data carry σ. */
  readonly significance?: number;
  /** Fraction of the total χ² in the positive-residual run around the apex. */
  readonly share: number;
}

export interface UnindexedOptions {
  /** Per-point σ for the significance test — pass only when the data carry σ. */
  readonly pointSigma?: readonly number[];
  /** Relative |Δd|/d within which a peak counts as indexed (default 0.01). */
  readonly relTolerance?: number;
  /** Most peaks to report (default 6). */
  readonly limit?: number;
}

/**
 * Positive residual peaks with no reflection of any phase near them: the
 * missing-phase / impurity signal. `reflections` should list every allowed
 * reflection of every phase (and the magnetic satellites, when a magnetic
 * model is on), so a shoulder of a known peak is not reported.
 */
export function unindexedPeaks(
  d: readonly number[],
  yObs: readonly number[],
  yCalc: readonly number[],
  validation: Pick<PowderValidation, "delta" | "chi2">,
  reflections: readonly { readonly d: number; readonly hkl: string; readonly phaseLabel: string }[],
  options: UnindexedOptions = {},
): UnindexedPeak[] {
  const { delta, chi2 } = validation;
  // Only fitted points: hand the detector the fitted subset, then map back.
  const map: number[] = [];
  for (let i = 0; i < delta.length; i++) if (!Number.isNaN(delta[i]!)) map.push(i);
  if (map.length < 5) return [];
  const sub = (arr: readonly number[]): number[] => map.map((i) => arr[i]!);
  const peaks = detectExtraPeaks(sub(d), sub(yObs), sub(yCalc), {
    ...(options.pointSigma ? { pointSigma: sub(options.pointSigma) } : {}),
    limit: 40,
  });
  const annotated = annotateExtraPeaks(peaks, reflections, options.relTolerance ?? 0.01);
  const out: UnindexedPeak[] = [];
  for (const p of annotated) {
    if (p.nearNuclear) continue;
    // Apex = the fitted point nearest the reported d.
    let best = -1;
    let bestDist = Infinity;
    for (const i of map) {
      const dist = Math.abs(d[i]! - p.d);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    if (best < 0) continue;
    // The contiguous positive-residual run around the apex.
    let sum = 0;
    for (let i = best; i < delta.length && delta[i]! > 0; i++) sum += delta[i]! * delta[i]!;
    for (let i = best - 1; i >= 0 && delta[i]! > 0; i--) sum += delta[i]! * delta[i]!;
    out.push({
      d: p.d,
      index: best,
      ...(p.significance !== undefined ? { significance: p.significance } : {}),
      share: chi2 > 0 ? sum / chi2 : 0,
    });
  }
  return out.sort((a, b) => b.share - a.share).slice(0, options.limit ?? 6);
}
