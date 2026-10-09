/**
 * Single-crystal validation statistics: the SHELXL-style analysis that tells a
 * sound F² refinement from one with a systematic error.
 *
 *  - Resolution shells (equal-count, low angle first): data quality (N,
 *    completeness, ⟨I/σ⟩, R_int) beside model quality (K = ⟨Fo²⟩/⟨Fc²⟩,
 *    GooF, R1). K drifting with resolution points to the ADPs, an absorption
 *    error or wrong scattering factors; K < 1 with a high GooF only at low
 *    angle is extinction (or the beamstop).
 *  - The analysis of variance by intensity (equal-count bins of Fc/Fc(max),
 *    SHELXL's table): a flat GooF ≈ 1 means the weights fit; K < 1 in the
 *    strongest bin is extinction.
 *  - Completeness to the data's resolution, reflections per parameter, and the
 *    largest standardized residuals with where they sit (sinθ/λ, Fc/Fc(max)),
 *    so a pattern among them is visible.
 *
 * References: Sheldrick, *Acta Cryst.* A64 (2008) 112 and the SHELXL manual
 * (analysis of variance, EXTI); IUCr checkCIF (data/parameter ratio,
 * completeness).
 */

import type { SpaceGroup, UnitCell } from "@/core/crystal/types";
import { dSpacing } from "@/core/crystal/unitCell";
import { generateReflections } from "@/core/diffraction/reflections";
import { canonicalKey, laueRotations, mergeEquivalents } from "@/core/diffraction/merge";

export interface ScValidationRow {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly foSq: number;
  readonly fcSq: number;
  /** σ(Fo²); 0 or absent → unit weight and no standardized residual. */
  readonly sigma?: number;
}

export interface ScValidationInput {
  readonly rows: readonly ScValidationRow[];
  readonly cell: UnitCell;
  readonly spaceGroup: SpaceGroup;
  /** Free parameters, for the data/parameter ratio. */
  readonly nParams: number;
  /** Least-squares weights per row (default 1/σ², unit where σ is missing). */
  readonly weights?: ArrayLike<number>;
  /** Resolution shells (default 8). */
  readonly shellCount?: number;
  /** Intensity bins (default 10). */
  readonly binCount?: number;
  /** Outliers to list (default 10). */
  readonly outlierCount?: number;
}

export interface ResolutionShell {
  /** d range of the reflections in the shell (Å): largest and smallest. */
  readonly dMax: number;
  readonly dMin: number;
  /** Observations in the shell. */
  readonly n: number;
  /** Unique (Laue-merged) reflections observed. */
  readonly unique: number;
  /** Fraction of the symmetry-allowed unique reflections observed (absent if unknown). */
  readonly completeness?: number;
  /** ⟨Fo²/σ⟩ over the shell. */
  readonly iOverSigma: number;
  /** R_int of the shell's equivalents (absent without redundancy). */
  readonly rInt?: number;
  /** K = ΣFo² / ΣFc². */
  readonly k: number;
  /** √(Σw(Fo²−Fc²)² / n). */
  readonly goof: number;
  /** R1 over Fo² > 2σ. */
  readonly r1: number;
}

export interface IntensityBin {
  /** Fc/Fc(max) of the strongest reflection in the bin (the bin's upper edge). */
  readonly fcRatioMax: number;
  readonly n: number;
  readonly k: number;
  readonly goof: number;
}

export interface ScOutlier {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly sinThetaOverLambda: number;
  /** |Fc| / |Fc|max. */
  readonly fcRatio: number;
  readonly foSq: number;
  readonly fcSq: number;
  /** (Fo² − Fc²)/σ. */
  readonly z: number;
}

export interface ExtinctionCheck {
  /** Strong reflections systematically Fo² < Fc²: the extinction signature. */
  readonly suspected: boolean;
  /** K and GooF of the strongest intensity bin. */
  readonly strongBinK: number;
  readonly strongBinGoof: number;
  /** Of the listed outliers (|z| > 3), how many are strong with Fo² < Fc². */
  readonly strongUnder: number;
  readonly outliers: number;
}

export interface ScValidation {
  readonly shells: readonly ResolutionShell[];
  readonly bins: readonly IntensityBin[];
  readonly outliers: readonly ScOutlier[];
  /** Smallest d in the data (Å) and the matching sinθ/λ (Å⁻¹). */
  readonly dMin: number;
  readonly sinThetaOverLambdaMax: number;
  /** Unique reflections observed and the symmetry-allowed count to dMin. */
  readonly uniqueObserved: number;
  readonly uniqueExpected?: number;
  readonly completeness?: number;
  /** Unique observed reflections per free parameter. */
  readonly reflectionsPerParameter: number;
  /** The space group contains the inversion. */
  readonly centrosymmetric: boolean;
  readonly extinction: ExtinctionCheck;
  /** GooF with the strongest intensity bin left out (how much the strong reflections drive it). */
  readonly goofWithoutStrongest?: number;
}

/** Below this K in the strongest bin, strong reflections are weak on Fo². */
const EXTINCTION_K = 0.95;

/**
 * d rounded to 1 µÅ. Distinct families that share a d (accidental
 * coincidences, e.g. (7 0 0) and (5 3 0) in a hexagonal cell) can differ in
 * the last bits depending on which indices computed them; rounding makes them
 * equal, so a shell edge never falls between them and the observed and the
 * expected lists land in the same shell.
 */
function roundD(d: number): number {
  return Math.round(d * 1e6) / 1e6;
}

function isInversion(R: SpaceGroup["operations"][number]["rotation"]): boolean {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.round(R[i]![j]!) !== (i === j ? -1 : 0)) return false;
  return true;
}

interface Prepared {
  readonly row: ScValidationRow;
  readonly d: number;
  readonly w: number;
  readonly s: number;
}

function binStats(items: readonly Prepared[]): { k: number; goof: number; r1: number; iOverSigma: number } {
  let so = 0, sc = 0, wd2 = 0, r1n = 0, r1d = 0, ios = 0, nios = 0;
  for (const it of items) {
    const { foSq, fcSq } = it.row;
    so += foSq;
    sc += fcSq;
    const diff = foSq - fcSq;
    wd2 += it.w * diff * diff;
    if (it.s > 0) {
      ios += foSq / it.s;
      nios++;
      if (foSq > 2 * it.s) {
        const fo = Math.sqrt(foSq);
        r1n += Math.abs(fo - Math.sqrt(Math.max(fcSq, 0)));
        r1d += fo;
      }
    }
  }
  return {
    k: sc > 0 ? so / sc : 0,
    goof: items.length > 0 ? Math.sqrt(wd2 / items.length) : 0,
    r1: r1d > 0 ? r1n / r1d : 0,
    iOverSigma: nios > 0 ? ios / nios : 0,
  };
}

/** Split `sorted` into `count` near-equal runs, keeping equal keys in one run. */
function equalCountRuns<T>(sorted: readonly T[], count: number, key: (t: T) => number): T[][] {
  const runs: T[][] = [];
  const k = Math.min(count, sorted.length);
  let start = 0;
  for (let s = 0; s < k && start < sorted.length; s++) {
    let end = s === k - 1 ? sorted.length : Math.round(((s + 1) * sorted.length) / k);
    while (end < sorted.length && end > start && key(sorted[end]!) === key(sorted[end - 1]!)) end++;
    if (end <= start) continue;
    runs.push(sorted.slice(start, end));
    start = end;
  }
  return runs;
}

export function singleCrystalValidation(input: ScValidationInput): ScValidation {
  const { rows, cell, spaceGroup, nParams } = input;
  const rotations = laueRotations(spaceGroup.operations);
  const prepared: Prepared[] = rows.map((row, i) => {
    const s = row.sigma ?? 0;
    const w = input.weights ? input.weights[i]! : s > 0 ? 1 / (s * s) : 1;
    return { row, d: roundD(dSpacing(cell, row.h, row.k, row.l)), w, s };
  }).filter((p) => Number.isFinite(p.d));

  const dMin = prepared.reduce((m, p) => Math.min(m, p.d), Infinity);
  const centrosymmetric = spaceGroup.operations.some((op) => isInversion(op.rotation));

  // Symmetry-allowed unique reflections to the data's resolution, by d.
  let expected: { key: string; d: number }[] | undefined;
  if (Number.isFinite(dMin)) {
    try {
      const dTop = 2 * Math.max(cell.a, cell.b, cell.c);
      expected = generateReflections(cell, spaceGroup, dMin * (1 - 1e-9), dTop)
        .map((r) => ({ key: canonicalKey(rotations, r.h, r.k, r.l), d: roundD(r.d) }));
    } catch {
      expected = undefined; // cell too large to enumerate — completeness stays unknown
    }
  }
  const expectedKeys = expected ? new Set(expected.map((e) => e.key)) : undefined;
  const observedKeys = new Set(prepared.map((p) => canonicalKey(rotations, p.row.h, p.row.k, p.row.l)));
  const observedAllowed = expectedKeys ? [...observedKeys].filter((k) => expectedKeys.has(k)).length : undefined;

  // Resolution shells: equal-count in d, low angle (large d) first. The edges
  // are midpoints between neighbouring shells, applied to the expected list too.
  const byD = [...prepared].sort((a, b) => b.d - a.d);
  const runs = equalCountRuns(byD, input.shellCount ?? 8, (p) => p.d);
  const shells: ResolutionShell[] = runs.map((run, j) => {
    const upper = j === 0 ? Infinity : (runs[j - 1]![runs[j - 1]!.length - 1]!.d + run[0]!.d) / 2;
    const lower = j === runs.length - 1 ? 0 : (run[run.length - 1]!.d + runs[j + 1]![0]!.d) / 2;
    const keys = new Set(run.map((p) => canonicalKey(rotations, p.row.h, p.row.k, p.row.l)));
    const inShell = expected?.filter((e) => e.d < upper && e.d >= lower);
    const shellExpected = inShell ? new Set(inShell.map((e) => e.key)) : undefined;
    const seen = shellExpected ? [...keys].filter((k) => shellExpected.has(k)).length : 0;
    const merged = mergeEquivalents(run.map((p) => ({ h: p.row.h, k: p.row.k, l: p.row.l, intensity: p.row.foSq, sigma: p.s })), spaceGroup.operations);
    const st = binStats(run);
    return {
      dMax: run[0]!.d,
      dMin: run[run.length - 1]!.d,
      n: run.length,
      unique: keys.size,
      ...(shellExpected && shellExpected.size > 0 ? { completeness: seen / shellExpected.size } : {}),
      iOverSigma: st.iOverSigma,
      ...(merged.statistics.redundancy > 1 ? { rInt: merged.statistics.rInt } : {}),
      k: st.k,
      goof: st.goof,
      r1: st.r1,
    };
  });

  // Analysis of variance by intensity: equal-count bins of Fc, weakest first.
  const byFc = [...prepared].sort((a, b) => a.row.fcSq - b.row.fcSq);
  const fcMax = Math.sqrt(Math.max(byFc[byFc.length - 1]?.row.fcSq ?? 0, 0));
  const fcRuns = equalCountRuns(byFc, input.binCount ?? 10, (p) => p.row.fcSq);
  const bins: IntensityBin[] = fcRuns.map((run) => {
    const st = binStats(run);
    return {
      fcRatioMax: fcMax > 0 ? Math.sqrt(Math.max(run[run.length - 1]!.row.fcSq, 0)) / fcMax : 0,
      n: run.length,
      k: st.k,
      goof: st.goof,
    };
  });
  const goofWithoutStrongest = fcRuns.length > 1 ? binStats(fcRuns.slice(0, -1).flat()).goof : undefined;

  // Largest standardized residuals.
  const outliers: ScOutlier[] = prepared
    .filter((p) => p.s > 0)
    .map((p) => ({ p, z: (p.row.foSq - p.row.fcSq) / p.s }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, input.outlierCount ?? 10)
    .map(({ p, z }) => ({
      h: p.row.h, k: p.row.k, l: p.row.l,
      d: p.d,
      sinThetaOverLambda: 1 / (2 * p.d),
      fcRatio: fcMax > 0 ? Math.sqrt(Math.max(p.row.fcSq, 0)) / fcMax : 0,
      foSq: p.row.foSq,
      fcSq: p.row.fcSq,
      z,
    }));

  // Extinction: the strongest bin reads low on Fo² AND the significant
  // outliers are mostly strong reflections with Fo² < Fc².
  const strong = bins[bins.length - 1];
  const strongFloor = byFc.length > 0 ? byFc[Math.floor(0.7 * (byFc.length - 1))]!.row.fcSq : Infinity;
  const significant = outliers.filter((o) => Math.abs(o.z) > 3).slice(0, 8);
  const strongUnder = significant.filter((o) => o.z < 0 && o.fcSq >= strongFloor).length;
  const extinction: ExtinctionCheck = {
    suspected: strong !== undefined && strong.k < EXTINCTION_K && significant.length >= 3 && strongUnder >= Math.max(3, Math.ceil(0.6 * significant.length)),
    strongBinK: strong?.k ?? 1,
    strongBinGoof: strong?.goof ?? 0,
    strongUnder,
    outliers: significant.length,
  };

  const uniqueObserved = observedKeys.size;
  return {
    shells,
    bins,
    outliers,
    dMin,
    sinThetaOverLambdaMax: Number.isFinite(dMin) ? 1 / (2 * dMin) : 0,
    uniqueObserved,
    ...(expected ? { uniqueExpected: expectedKeys!.size } : {}),
    ...(expected && expectedKeys!.size > 0 ? { completeness: observedAllowed! / expectedKeys!.size } : {}),
    reflectionsPerParameter: nParams > 0 ? uniqueObserved / nParams : Infinity,
    centrosymmetric,
    extinction,
    ...(goofWithoutStrongest !== undefined ? { goofWithoutStrongest } : {}),
  };
}
