/**
 * Per-reflection observed vs calculated integrated intensities for a powder
 * pattern (the data behind an F_obs vs F_calc plot).
 *
 * Powder intensities overlap, so |F_obs| is not measured directly — it is
 * *apportioned* from the observed profile. Two decompositions are offered:
 *
 *  - **Rietveld** (default): weight the partition by the *calculated* peak
 *    intensities, I_obs(k) = Σᵢ [ Sₖ·I_calc(k) / Σⱼ Sⱼ·I_calc(j) ]·(y_obs−bkg).
 *    Exact and cheap, but model-BIASED: overlapping reflections are pulled onto
 *    the F_obs = F_calc line (a perfect fit trivially gives I_obs = I_calc), so
 *    the plot flatters the model.
 *  - **Le Bail**: partition by the peak SHAPES with FREE intensities, seeded
 *    EQUAL (not from I_calc) and iterated to self-consistency,
 *    I_obs(k) ← Σᵢ [ Sₖ·I_obs(k) / Σⱼ Sⱼ·I_obs(j) ]·(y_obs−bkg). Structure-
 *    INDEPENDENT, so a wrong |F_calc| shows up as a genuine off-diagonal point.
 *    (Exactly coincident reflections still can't be separated — Le Bail splits
 *    them by profile alone, which for identical profiles is an even split.)
 *
 * `Sₖ` is the model's own peak profile (accurate, d-dependent), not a simplified
 * single-FWHM approximation. Returns intensities; |F| ∝ √I.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { placePeaks, reflectionDRange, type PowderProfile } from "@/core/workflow/powder";
import { phaseBindingsFor } from "@/core/workflow/multiPhase";
import { generateReflections } from "@/core/diffraction/reflections";
import { powderPeakIntensities, lorentzPolarization } from "@/core/diffraction/intensity";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { dSpacing } from "@/core/crystal/unitCell";
import { evaluateBackground } from "@/core/diffraction/background";
import { gaussian, pseudoVoigt, tofBackToBack, type ProfilePeak } from "@/core/diffraction/profile";

export interface ReflectionObsCalc {
  /** Nuclear Bragg reflection, or a magnetic satellite at G ± k. */
  readonly kind: "nuclear" | "magnetic";
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly iObs: number;
  readonly iCalc: number;
  /**
   * The crystallographic phase this reflection belongs to (multi-phase powder):
   * the primary structure is index 0, extra phases follow in load order.
   * `phaseId` matches the phase's id (and its Bragg-tick row) so a scatter click
   * spotlights the right phase; `phaseLabel` names it for the legend. Absent on
   * the single-crystal path, which passes no phase metadata.
   */
  readonly phaseId?: string;
  readonly phaseLabel?: string;
  readonly phaseIndex?: number;
}

/** One peak (nuclear or magnetic) contributing to the decomposition. */
interface Component {
  readonly kind: "nuclear" | "magnetic";
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly d: number;
  readonly iCalc: number;
  readonly sub: ProfilePeak[];
  readonly phaseIndex: number;
  readonly phaseId: string;
  readonly phaseLabel: string;
}

/** Normalized profile value of one placed peak at x (∫ ≈ 1). */
function peakValue(pk: ProfilePeak, x: number): number {
  if (pk.tof) return tofBackToBack(x - pk.center, pk.tof);
  if (pk.eta !== undefined) return pseudoVoigt(x, pk.center, pk.fwhm, pk.eta);
  return gaussian(x, pk.center, pk.fwhm);
}

/** Intensity-weighted centre (pattern x-unit) of a placed peak's sub-peaks. */
function peakCenter(sub: readonly ProfilePeak[]): number | undefined {
  if (sub.length === 0) return undefined;
  let w = 0;
  let c = 0;
  for (const pk of sub) { w += pk.intensity; c += pk.intensity * pk.center; }
  return w > 0 ? c / w : sub[0]!.center;
}

/**
 * Rietveld-decomposed observed vs calculated intensities per reflection for the
 * current parameters. Reflections whose peaks fall outside the measured abscissa
 * are dropped. When `fitRange` (in the pattern's x-unit) is given, reflections
 * whose peak centre lies outside that window are also dropped — the F_obs/F_calc
 * scatter then shows only the reflections actually being fitted.
 *
 * Multi-phase aware: pass the impurity/secondary phases in `extraPhases` and the
 * apportionment denominator sums every phase's peaks, so an observed peak shared
 * by two phases is split between them instead of being credited wholesale to the
 * primary phase (which inflated its F_obs). Each returned reflection is tagged
 * with its phase (`phaseId`/`phaseLabel`/`phaseIndex`) so the plot can colour it.
 * The phases share one instrument/background (bindings are routed per phase
 * exactly as `computePattern` does), so the decomposition matches the real
 * multi-phase pattern.
 */
/** Le Bail intensity-extraction cycles for the structure-independent F_obs. */
const LEBAIL_CYCLES = 12;

export function powderReflectionObsCalc(
  structure: StructureModel,
  pattern: PowderPattern,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  profile: PowderProfile = { shape: "gaussian" },
  magnetic: MagneticModel | null = null,
  fitRange: { readonly min: number; readonly max: number } | null = null,
  extraPhases: readonly StructureModel[] = [],
  method: "rietveld" | "leBail" = "rietveld",
): ReflectionObsCalc[] {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const resolved = resolveTies(parameters, values);
  const multiPhase = extraPhases.length > 0;
  // Route each phase's bindings the way the real multi-phase pattern does (own
  // parameters + shared instrument). Single-phase: every binding acts on the one
  // structure, so no filtering (the scale binding targets the pattern, not the
  // structure id, and must not be dropped).
  const bindingsFor = (phaseId: string): readonly ParameterBinding[] =>
    multiPhase ? phaseBindingsFor(bindings, phaseId) : bindings;

  const phaseList = [structure, ...extraPhases].map((s, i) => ({
    structure: s,
    index: i,
    id: s.id,
    label: s.name || (i === 0 ? "nuclear" : `phase ${i + 1}`),
  }));

  const applyLorentz = profile.lorentz ?? true;
  const x = pattern.points.map((p) => p.x);
  const yObs = pattern.points.map((p) => p.yObs);
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const bgType = profile.backgroundType ?? "chebyshev";

  // Primary applied model — carries the shared background + the shared d-range,
  // and is the model the magnetic satellites ride on.
  const appliedPrimary = applyParameters(structure, bindingsFor(structure.id), resolved);
  const bkg = x.map((xv) => evaluateBackground(xv, appliedPrimary.background, bgType, xMin, xMax));
  const { dMin, dMax } = reflectionDRange(pattern, appliedPrimary);

  // Nuclear peaks for every phase. Each phase gets its own cell, atoms, and any
  // per-phase anisotropic microstrain; the profile/background are shared. Pass
  // h,k,l so the apportioning sub-peak carries the *same* hkl-dependent
  // broadening the real pattern gives this reflection (Stephens / uniaxial
  // microstrain, uniaxial size) — omitting them placed an isotropic peak here
  // while `buildPeaks` placed an anisotropic one, drifting F_obs off F_calc.
  const components: Component[] = [];
  for (const ph of phaseList) {
    const applied = ph.index === 0 ? appliedPrimary : applyParameters(ph.structure, bindingsFor(ph.id), resolved);
    const reflections = generateReflections(applied.model.cell, applied.model.spaceGroup, dMin, dMax);
    const intensities = powderPeakIntensities(applied.model, pattern.radiation, reflections, applied.scale, applied.po, applyLorentz);
    reflections.forEach((r, i) => {
      components.push({
        kind: "nuclear",
        h: r.h, k: r.k, l: r.l, d: r.d,
        iCalc: intensities[i]!.intensity,
        sub: placePeaks(pattern, applied, [{ d: r.d, intensity: 1, h: r.h, k: r.k, l: r.l }]),
        phaseIndex: ph.index, phaseId: ph.id, phaseLabel: ph.label,
      });
    });
  }

  // Magnetic satellites at G ± k (single commensurate k) on the *primary* phase,
  // on the same scale as its nuclear peaks — mirrors buildCombinedPeaks in
  // magneticPowder.ts. Only reflections carrying a non-negligible |F_M|² are
  // kept, matching the magnetic Bragg tick row.
  if (magnetic && magnetic.moments.length > 0) {
    const appliedMag = applyMagneticMoments(magnetic, bindingsFor(structure.id), resolved);
    const magScaleBinding = bindings.find((b) => b.kind === "magneticScale");
    const magFactor = magScaleBinding ? resolved[magScaleBinding.parameterId] ?? 1 : 1;
    const magScale = appliedPrimary.scale * magFactor;
    const kVec = appliedMag.propagation[0] ?? [0, 0, 0];
    const isK0 = kVec.every((v) => Math.abs(v) < 1e-9);
    const primaryReflections = generateReflections(appliedPrimary.model.cell, appliedPrimary.model.spaceGroup, dMin, dMax);
    const mags: Component[] = [];
    for (const r of primaryReflections) {
      const sats: [number, number, number][] = isK0
        ? [[r.h, r.k, r.l]]
        : [[r.h + kVec[0]!, r.k + kVec[1]!, r.l + kVec[2]!], [r.h - kVec[0]!, r.k - kVec[1]!, r.l - kVec[2]!]];
      for (const [mh, mk, ml] of sats) {
        const dSat = dSpacing(appliedPrimary.model.cell, mh, mk, ml);
        if (!Number.isFinite(dSat) || dSat <= 0 || dSat < dMin || dSat > dMax) continue;
        const fm2 = magneticStructureFactor(appliedPrimary.model, appliedMag, mh, mk, ml).squared;
        const lp = lorentzPolarization(pattern.radiation, dSat);
        mags.push({
          kind: "magnetic", h: mh, k: mk, l: ml, d: dSat,
          iCalc: magScale * r.multiplicity * lp * fm2,
          // No hkl here on purpose: the real magnetic satellites in
          // `buildCombinedPeaks` are also placed without hkl (no anisotropic
          // strain on satellites), so the decomposition must match that to stay
          // on the F_obs = F_calc line.
          sub: placePeaks(pattern, appliedPrimary, [{ d: dSat, intensity: 1 }]),
          phaseIndex: 0, phaseId: "magnetic", phaseLabel: "magnetic",
        });
      }
    }
    const maxMag = mags.reduce((m, c) => (c.iCalc > m ? c.iCalc : m), 0);
    if (maxMag > 0) {
      const eps = maxMag * 1e-4;
      for (const c of mags) if (c.iCalc > eps) components.push(c);
    }
  }

  // Calc profile Sₖ·I_calc per reflection, summed to the total calc intensity
  // (background excluded) at each point. For the Le Bail decomposition also keep
  // the unit-intensity SHAPE Sₖ(xᵢ) and its nonzero index span (the default
  // Rietveld path never needs them, so they are only built when requested).
  const buildShapes = method === "leBail";
  const total = new Float64Array(x.length);
  const shapes: Float64Array[] = [];
  const shapeSpan: [number, number][] = [];
  const contrib = components.map((cmp) => {
    const arr = new Float64Array(x.length);
    const shp = buildShapes ? new Float64Array(x.length) : null;
    let lo = x.length, hi = -1;
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (const pk of cmp.sub) s += pk.intensity * peakValue(pk, x[i]!);
      if (shp) {
        shp[i] = s;
        if (s > 0) { if (i < lo) lo = i; hi = i; }
      }
      const c = s * cmp.iCalc;
      arr[i] = c;
      total[i]! += c;
    }
    if (shp) {
      shapes.push(shp);
      shapeSpan.push([lo, hi]);
    }
    return arr;
  });

  // Le Bail free-intensity decomposition (structure-independent F_obs): partition
  // (y_obs − bkg) among the SHAPES with intensities seeded EQUAL and iterated to
  // self-consistency, then put on the iCalc scale with one global least-squares
  // factor so the F_obs = F_calc diagonal stays meaningful.
  const leBailIObs = new Float64Array(components.length);
  if (method === "leBail" && components.length > 0) {
    const yNet = x.map((_, i) => Math.max(yObs[i]! - bkg[i]!, 0));
    const shapeSum = shapes.map((shp, ri) => {
      const [lo, hi] = shapeSpan[ri]!;
      let s = 0;
      for (let i = lo; i <= hi; i++) s += shp[i]!;
      return s;
    });
    let inten = new Float64Array(components.length).fill(1);
    for (let cycle = 0; cycle < LEBAIL_CYCLES; cycle++) {
      const yc = new Float64Array(x.length);
      for (let ri = 0; ri < components.length; ri++) {
        const shp = shapes[ri]!; const [lo, hi] = shapeSpan[ri]!;
        for (let i = lo; i <= hi; i++) yc[i]! += inten[ri]! * shp[i]!;
      }
      const next = new Float64Array(components.length);
      for (let ri = 0; ri < components.length; ri++) {
        const shp = shapes[ri]!; const [lo, hi] = shapeSpan[ri]!;
        let acc = 0;
        for (let i = lo; i <= hi; i++) {
          const denom = yc[i]!;
          if (denom > 1e-12) acc += (inten[ri]! * shp[i]! / denom) * yNet[i]!;
        }
        next[ri] = Math.max(acc, 0);
      }
      inten = next;
    }
    // Integrated observed intensity per peak (I_k·∫Sₖ), matching the accumulated
    // iCalc convention (Σᵢ Sₖ·I_calc = I_calc·∫Sₖ); one global scale to iCalc.
    const raw = shapeSum.map((sum, ri) => inten[ri]! * sum);
    let num = 0, den = 0;
    for (let ri = 0; ri < components.length; ri++) {
      const icInt = components[ri]!.iCalc * shapeSum[ri]!;
      num += icInt * raw[ri]!;
      den += raw[ri]! * raw[ri]!;
    }
    const gScale = den > 0 ? num / den : 1;
    for (let ri = 0; ri < components.length; ri++) leBailIObs[ri] = gScale * raw[ri]!;
  }

  // A reflection the model computes as (near-)absent — |F_calc|² a negligible
  // fraction of the strongest — cannot have its observed intensity recovered by
  // this calc-weighted Rietveld apportionment: the apportionment weight cₖ/total
  // is ~0 there, so iObs is pinned to ~0 regardless of the real data. Left in, it
  // piles up at the plot origin reading a misleading "F_obs = 0" even when the
  // pattern has a peak at that d (belonging to an overlapping allowed
  // reflection). Omit it as *unmeasurable here*, not observed-to-be-zero — the
  // difference curve, not this scatter, is where a genuine model absence shows.
  // (The magnetic satellites above are already filtered this way.) The floor is
  // per phase: a genuinely weak impurity phase must not be wiped out just because
  // a dominant main phase sets a high global maximum.
  const maxByPhase = new Map<number, number>();
  for (const cmp of components) {
    if (cmp.kind !== "nuclear") continue;
    maxByPhase.set(cmp.phaseIndex, Math.max(maxByPhase.get(cmp.phaseIndex) ?? 0, cmp.iCalc));
  }

  const out: ReflectionObsCalc[] = [];
  components.forEach((cmp, ri) => {
    if (cmp.kind === "nuclear" && cmp.iCalc <= (maxByPhase.get(cmp.phaseIndex) ?? 0) * 1e-6) return; // near-absent → F_obs not measurable
    if (fitRange) {
      const center = peakCenter(cmp.sub);
      if (center === undefined || center < fitRange.min || center > fitRange.max) return; // outside the fit window
    }
    const c = contrib[ri]!;
    // I_calc and I_obs are both the peak's summed calc profile: I_calc = Σᵢ cₖ(i),
    // and I_obs apportions the observed point intensity by the same weights, so
    // they are on one scale (iObs = iCalc for a perfect fit) and the ratio is
    // meaningful. This is proportional to the integrated intensity.
    let iObs = 0;
    let iCalc = 0;
    let inRange = false;
    for (let i = 0; i < x.length; i++) {
      const t = total[i]!;
      if (c[i]! <= 0) continue;
      iCalc += c[i]!;
      if (t > 0) {
        inRange = true;
        if (method === "rietveld") iObs += (c[i]! / t) * (yObs[i]! - bkg[i]!);
      }
    }
    if (method === "leBail") iObs = leBailIObs[ri]!; // structure-independent (precomputed)
    if (!inRange || iCalc <= 0) return; // peak outside the measured range
    out.push({
      kind: cmp.kind, h: cmp.h, k: cmp.k, l: cmp.l, d: cmp.d, iObs, iCalc,
      phaseId: cmp.phaseId, phaseLabel: cmp.phaseLabel, phaseIndex: cmp.phaseIndex,
    });
  });
  return out;
}
