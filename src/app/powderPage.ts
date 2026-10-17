/**
 * The powder page without React: what its controls do to the session, the
 * curves and agreement it shows, and the fits it runs, as plain functions.
 *
 * The workbench (PowderWorkbench.tsx) calls these from its handlers and hooks,
 * and the Agent's headless page (testSupport/agentHeadless.ts) calls the same
 * functions with the same compute client running in-thread. So the evals and
 * the validation run the page's own operations, not a copy of them: a copy
 * once refined the whole pattern after the Agent set a fit window, and its
 * Prefit was a plain refine (docs/AGENT_REVIEW.md).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { ParameterBinding, RefinementOptions, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { isMagneticModelParameterKind, isMomentParameterKind } from "@/core/refinement/types";
import { powderCurves, type PowderCurves } from "@/core/workflow/powder";
import { magneticComponentCurve } from "@/core/workflow/magneticPowder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { multiPhaseCurves } from "@/core/workflow/multiPhase";
import { applyParameters } from "@/core/workflow/apply";
import { withEqualTies, type EqualTieUpdate } from "@/core/refinement/constraints";
import type { PeakShape } from "@/core/diffraction/profile";
import type { BackgroundType } from "@/core/diffraction/background";
import { excludedPointMask } from "@/core/refinement/factors";
import { withConstants, type InstrumentConstants, type InstrumentParameters } from "@/core/diffraction/instrument";
import { withAntisite } from "@/core/crystal/antisite";
import { withAdpModel } from "@/core/crystal/adp";
import { momentKickFloor } from "@/core/magnetic/canonicalize";
import type { SampleOptions, SampleResult } from "@/core/refinement/bayes/sampler";
import type { ComputeClient, MagneticMultiStartResult } from "@/workers/computeClient";
import type { PowderProgress } from "@/workers/runPowder";
import type { MultiStartResult } from "@/core/refinement/multiStart";
import { powderRestraints, type CorrectionsUpdate, type MustrainModel, type SampleCorrections, type SiteTies } from "@/app/powderSpec";
import { buildSpecFor, keptBindings, keptRow, keptRows, withMagneticRows, withValidUserTies, type Session } from "@/app/powderSession";

/** The fit window on the pattern's own axis. */
export interface FitWindow {
  readonly min: number;
  readonly max: number;
}

/** What a fit on the page depends on beyond the session. */
export interface PowderPageModel {
  readonly session: Session;
  /** The instrument the parameter set is built with: the loaded one, or the default. */
  readonly instrument: InstrumentParameters;
  /** The fit window when it narrows the pattern; null: the whole pattern. */
  readonly fitRange: FitWindow | null;
  /** The last refinement's result; null before the first fit or after a model change. */
  readonly result: RefinementResult | null;
}

/** The compute client's calls the page makes. */
export type PowderCompute = Pick<
  ComputeClient,
  "refinePowderParallel" | "refineMagneticPowderParallel" | "leBailPrefit" | "refinePowderMultiStart" | "refineMagneticPowderMultiStart" | "samplePowderPosterior" | "sampleMagneticPowderPosterior"
>;

// ── what the controls do to the session ────────────────────────────────────

/** The spec rebuilt for a changed structure, ties or settings: every row keeps its value and state, new rows come in as the spec seeds them. */
function rebuilt(s: Session, instrument: InstrumentParameters, change: { structure?: StructureModel; backgroundTerms?: number; siteTies?: SiteTies; mustrain?: MustrainModel }): Session {
  const structure = change.structure ?? s.structure;
  const backgroundTerms = change.backgroundTerms ?? s.backgroundTerms;
  const siteTies = change.siteTies ?? s.siteTies;
  const mustrain = change.mustrain ?? s.mustrain ?? "isotropic";
  const spec = buildSpecFor(structure, s.extraPhases, s.pattern, instrument, s.powderProfile.lorentz ?? true, backgroundTerms, siteTies, mustrain, s.corrections);
  return {
    ...s,
    structure,
    backgroundTerms,
    siteTies,
    ...(change.mustrain ? { mustrain: change.mustrain } : {}),
    powderParams: keptRows(spec.params, s.powderParams),
    powderBindings: keptBindings(spec.bindings, s.powderBindings),
    powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
  };
}

/** Change the smooth-background basis (reinterprets the same coefficients). */
export function withBackgroundType(s: Session, backgroundType: BackgroundType): Session {
  // Interpolation coefficients are background *heights* at anchor points, so
  // switching to/from a polynomial basis reseeds them: flatten to the current
  // constant level for interpolation, or c0 + zeros for a polynomial.
  const isInterp = backgroundType === "linInterpolate" || backgroundType === "logInterpolate";
  const wasInterp = s.powderProfile.backgroundType === "linInterpolate" || s.powderProfile.backgroundType === "logInterpolate";
  if (isInterp === wasInterp) {
    return { ...s, powderProfile: { ...s.powderProfile, backgroundType } };
  }
  const level = s.powderParams.find((p) => p.kind === "background")?.value ?? 0;
  let bIdx = 0;
  const powderParams = s.powderParams.map((p) => {
    if (p.kind !== "background") return p;
    const v = isInterp ? level : bIdx === 0 ? level : 0;
    bIdx++;
    return { ...p, value: v, initialValue: v };
  });
  return { ...s, powderParams, powderProfile: { ...s.powderProfile, backgroundType } };
}

/** Change the number of background coefficients (0–24), keeping every other row and the background type. */
export function withBackgroundTerms(s: Session, n: number, instrument: InstrumentParameters): Session {
  return rebuilt(s, instrument, { backgroundTerms: Math.max(0, Math.min(24, Math.trunc(n))) });
}

/**
 * Antisite disorder between two sites: each element added on the other site
 * at occupancy 0, sharing its host's position and ADP, with Σ occ = 1 and
 * hold composition on. Every existing row keeps its value and state; the new
 * occupancy rows come in fixed.
 */
export function withAntisitePair(s: Session, siteA: string, siteB: string, instrument: InstrumentParameters): Session {
  return rebuilt(s, instrument, { structure: withAntisite(s.structure, siteA, siteB), siteTies: { ...s.siteTies, occupancyToUnity: true, composition: true } });
}

/** Another phase in the model (an impurity, the sample environment): its rows come in as the spec seeds them. */
export function withPhase(s: Session, phase: StructureModel, instrument: InstrumentParameters): Session {
  return withPhases(s, [...s.extraPhases, phase], instrument);
}

/** An added phase taken out again (by id), the spec rebuilt back down. */
export function withoutPhase(s: Session, id: string, instrument: InstrumentParameters): Session {
  return withPhases(s, s.extraPhases.filter((p) => p.id !== id), instrument);
}

function withPhases(s: Session, extraPhases: readonly StructureModel[], instrument: InstrumentParameters): Session {
  const spec = buildSpecFor(s.structure, extraPhases, s.pattern, instrument, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic", s.corrections);
  return {
    ...s,
    extraPhases: [...extraPhases],
    powderParams: keptRows(spec.params, s.powderParams),
    powderBindings: keptBindings(spec.bindings, s.powderBindings),
    powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
  };
}

/** An X-ray instrument's constants (polarization, Kα₂ ratio) on the pattern's radiation; a neutron pattern has none. */
export function withInstrumentConstants(s: Session, update: InstrumentConstants): Session {
  return s.pattern.radiation.kind === "xray" ? { ...s, pattern: { ...s.pattern, radiation: withConstants(s.pattern.radiation, update) } } : s;
}

/**
 * The primary phase refines U tensors: some site is anisotropic. Read from
 * the structure, not from the toggle alone — a CIF with U_aniso columns loads
 * tensors without anyone ticking the box (round 10, NAC on 11-BM).
 */
export function hasTensorAdp(structure: StructureModel): boolean {
  return structure.sites.some((site) => site.adp.kind === "anisotropic");
}

/** Tie parameters of one kind to one refined value, or release such ties (the rows come back fixed at their value). */
export function withParameterTies(s: Session, update: EqualTieUpdate): Session {
  return { ...s, powderParams: withEqualTies(s.powderParams, update) };
}

/** Toggle tying position/ADP across shared (disordered) sites. */
export function withSiteTies(s: Session, update: Partial<SiteTies>, instrument: InstrumentParameters): Session {
  return rebuilt(s, instrument, { siteTies: { ...s.siteTies, ...update } });
}

/**
 * The microstrain model: isotropic (Lorentzian Y only), uniaxial (equatorial
 * and axial Y about c), or generalized (Stephens). The new rows seed at the
 * current isotropic strain and come in fixed.
 */
export function withMustrain(s: Session, model: MustrainModel, instrument: InstrumentParameters): Session {
  return rebuilt(s, instrument, { mustrain: model });
}

/**
 * Sample and geometry corrections on or off (peak asymmetry, preferred
 * orientation, displacement, transparency, absorption, roughness). The rows a
 * correction adds come in fixed at their seeds; every other row keeps its
 * value and state. A changed preferred-orientation axis restarts its ratio at 1.
 */
export function withCorrections(s: Session, update: CorrectionsUpdate, instrument: InstrumentParameters): Session {
  const was = s.corrections ?? {};
  const asymmetry = update.asymmetry ?? was.asymmetry ?? false;
  const preferredOrientation = update.preferredOrientation === undefined ? was.preferredOrientation : update.preferredOrientation ?? undefined;
  const peak = update.peak ?? was.peak ?? [];
  const corrections: SampleCorrections = {
    ...(asymmetry ? { asymmetry: true } : {}),
    ...(preferredOrientation ? { preferredOrientation } : {}),
    ...(peak.length > 0 ? { peak } : {}),
  };
  const spec = buildSpecFor(s.structure, s.extraPhases, s.pattern, instrument, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic", corrections);
  const previous = new Map(s.powderParams.map((p) => [p.id, p]));
  const axisChanged = update.preferredOrientation !== undefined;
  return {
    ...s,
    corrections,
    powderParams: withValidUserTies(withMagneticRows(spec.params.map((p) => {
      const old = previous.get(p.id);
      if (!old || (axisChanged && p.kind === "poRatio")) return { ...p, fixed: true };
      return keptRow(p, old);
    }), s.powderParams)),
    powderBindings: keptBindings(spec.bindings, s.powderBindings),
    powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
  };
}

/**
 * The ADP model, isotropic (B_iso) or anisotropic (U tensor). Promotion seeds
 * each site's spherical U from its current (refined) B_iso, so an isotropic
 * fit is the start of the anisotropic one; every other row keeps its value and
 * state, and only the ADP rows are reseeded.
 */
export function withAnisotropicAdp(s: Session, on: boolean, instrument: InstrumentParameters): Session {
  // Bake the current refined B_iso/U into the base structure's ADPs so the
  // conversion seeds from the converged values (positions/cell stay in the
  // preserved parameters, so they are not double-applied here).
  const values: Record<string, number> = {};
  for (const p of s.powderParams) values[p.id] = p.value;
  const refined = applyParameters(s.structure, s.powderBindings, values).model;
  const refinedAdp = new Map(refined.sites.map((rs) => [rs.label, rs.adp]));
  const seeded = { ...s.structure, sites: s.structure.sites.map((site) => ({ ...site, adp: refinedAdp.get(site.label) ?? site.adp })) };
  const promoted = withAdpModel(seeded, on ? "anisotropic" : "isotropic");
  const spec = buildSpecFor(promoted, s.extraPhases, s.pattern, instrument, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic", s.corrections);
  const previous = new Map(s.powderParams.map((p) => [p.id, p]));
  return {
    ...s,
    structure: promoted,
    anisotropicAdp: on,
    powderParams: withValidUserTies(withMagneticRows(spec.params.map((p) => {
      // ADP rows are freshly seeded by the rebuild (their ties with them);
      // everything else keeps its current (possibly refined) value and state.
      if (p.kind === "bIso" || p.kind === "uAniso") return p;
      return keptRow(p, previous.get(p.id));
    }), s.powderParams)),
    powderBindings: keptBindings(spec.bindings, s.powderBindings),
    powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
  };
}

/** Every parameter, or those named, back to its starting value (its esd dropped). */
export function withReset(s: Session, ids?: readonly string[]): Session {
  const only = ids ? new Set(ids) : null;
  return {
    ...s,
    powderParams: s.powderParams.map((p) => {
      if (only && !only.has(p.id)) return p;
      const { esd: _esd, ...rest } = p;
      return { ...rest, value: p.initialValue };
    }),
  };
}

/** Free or fix rows by id. */
export function withFixed(s: Session, changes: readonly { readonly id: string; readonly fixed: boolean }[]): Session {
  const fixed = new Map(changes.map((c) => [c.id, c.fixed]));
  return { ...s, powderParams: s.powderParams.map((p) => (fixed.has(p.id) ? { ...p, fixed: fixed.get(p.id)! } : p)) };
}

// ── what the page shows ────────────────────────────────────────────────────

/** A magnetic model on the session is part of the calculated pattern, whether or not its moments are refinable. */
export function magneticApplied(s: Session): boolean {
  return !!s.magnetic && s.magnetic.moments.length > 0;
}

/** Moment rows are present: the moments themselves refine. */
export function momentRowsFree(s: Session): boolean {
  return s.powderParams.some((p) => isMomentParameterKind(p.kind));
}

/** The profile a fit and the curves use. */
export function profileRequest(s: Session): { shape: PeakShape; eta?: number; lorentz?: boolean; backgroundType?: BackgroundType } {
  return {
    shape: s.powderProfile.shape,
    ...(s.powderProfile.eta !== undefined ? { eta: s.powderProfile.eta } : {}),
    ...(s.powderProfile.lorentz !== undefined ? { lorentz: s.powderProfile.lorentz } : {}),
    ...(s.powderProfile.backgroundType !== undefined ? { backgroundType: s.powderProfile.backgroundType } : {}),
  };
}

/** The profile the magnetic component is synthesized with (the background basis is the nuclear curve's business). */
export function magneticProfileOf(s: Session): { shape: PeakShape; eta?: number } {
  return { shape: s.powderProfile.shape, ...(s.powderProfile.eta !== undefined ? { eta: s.powderProfile.eta } : {}) };
}

/** The occupancy restraints the site ties ask for, over every phase (the magnetic path takes none). */
export function restraintRequest(s: Session): { restraints?: ReturnType<typeof powderRestraints> } {
  const restraints = powderRestraints([s.structure, ...s.extraPhases], s.siteTies, s.powderParams);
  return restraints.length > 0 ? { restraints } : {};
}

const phaseListOf = (s: Session): { structure: StructureModel; id: string }[] => s.extraPhases.map((st) => ({ structure: st, id: st.id }));

/** Every phase with the current parameter values applied, primary first; each phase's bindings routed by phase. */
export function refinedPhasesOf(s: Session): StructureModel[] {
  const values: Record<string, number> = {};
  for (const p of s.powderParams) values[p.id] = p.value;
  const multi = s.extraPhases.length > 0;
  return [s.structure, ...s.extraPhases].map((ph) => applyParameters(ph, multi ? s.powderBindings.filter((b) => b.targetId === ph.id) : s.powderBindings, values).model);
}

/**
 * The nuclear curves (every phase, no magnetic term: the magnetic step draws
 * its candidate on these), and what the page plots and scores: the nuclear
 * plus the applied magnetic model's contribution. A TOF pattern with GSAS-II's
 * overlay shows that overlay.
 */
export function powderPageCurves(s: Session): { nuclear: PowderCurves; curves: PowderCurves } {
  const pattern = s.pattern;
  const tofOverlay = pattern.xUnit === "tof" && s.powderOverlay;
  let nuclear: PowderCurves;
  if (pattern.points.length === 0) {
    nuclear = { x: [], yObs: [], yCalc: [], yBackground: [], diff: [] };
  } else if (tofOverlay) {
    const x = pattern.points.map((p) => p.x);
    const yObs = pattern.points.map((p) => p.yObs);
    const yCalc = s.powderOverlay!.calc;
    nuclear = { x, yObs, yCalc, yBackground: s.powderOverlay!.background, diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
  } else if (s.extraPhases.length > 0) {
    nuclear = multiPhaseCurves([{ structure: s.structure, id: s.structure.id }, ...phaseListOf(s)], pattern, s.powderParams, s.powderBindings, s.powderProfile);
  } else {
    nuclear = powderCurves(s.structure, pattern, s.powderParams, s.powderBindings, s.powderProfile);
  }
  const mag = s.magnetic;
  if (!mag || mag.moments.length === 0 || pattern.points.length === 0 || tofOverlay) return { nuclear, curves: nuclear };
  // The applied model's moments are driven by its moment rows in the session, so the full parameter set applies.
  const yMagnetic = magneticComponentCurve(s.structure, mag, pattern, s.powderParams, s.powderBindings, magneticProfileOf(s), phaseListOf(s));
  const yCalc = nuclear.yCalc.map((v, i) => v + (yMagnetic[i] ?? 0));
  return { nuclear, curves: { ...nuclear, yCalc, diff: nuclear.yObs.map((o, i) => o - (yCalc[i] ?? 0)) } };
}

/**
 * The weighted R_wp with the engine's definition and point selection (1/σ²
 * weights, the excluded-sentinel plateau, the fit window; for a TOF overlay
 * only where the reference calc > 0), so it matches the refinement's at
 * convergence and stays live as parameters are edited.
 */
export function weightedR(s: Session, c: { readonly x: readonly number[]; readonly yObs: readonly number[]; readonly yCalc: readonly number[] }, window: FitWindow | null): number {
  const tof = s.pattern.xUnit === "tof";
  const excluded = excludedPointMask(c.yObs);
  let num = 0, den = 0;
  for (let i = 0; i < c.yObs.length; i++) {
    const calc = c.yCalc[i] ?? 0;
    if (excluded[i]) continue;
    if (tof && calc <= 0) continue;
    if (window && (c.x[i]! < window.min || c.x[i]! > window.max)) continue;
    const o = c.yObs[i]!;
    const sigma = s.pattern.points[i]?.sigma ?? (o > 0 ? Math.sqrt(o) : 1);
    const w = sigma > 0 ? 1 / (sigma * sigma) : 1;
    num += w * (o - calc) * (o - calc);
    den += w * o * o;
  }
  return Math.sqrt(num / Math.max(den, 1e-12));
}

/** The points a fit uses: not excluded, inside the window. */
export function observationsIn(c: { readonly x: readonly number[]; readonly yObs: readonly number[] }, window: FitWindow | null): number {
  const excluded = excludedPointMask(c.yObs);
  let n = 0;
  c.x.forEach((x, i) => {
    if (!excluded[i] && !(window && (x < window.min || x > window.max))) n++;
  });
  return n;
}

/** The pattern's full extent on its own axis, by a loop (a TOF file's 10⁵–10⁶ points overflow a spread into Math.min). */
export function extentOf(xs: readonly number[]): FitWindow {
  if (xs.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max };
}

// ── the fits the page runs ─────────────────────────────────────────────────

const windowRequest = (page: PowderPageModel): { fitRange?: FitWindow } => (page.fitRange ? { fitRange: { min: page.fitRange.min, max: page.fitRange.max } } : {});

/** The magnetic co-refinement's spec: nuclear + the applied magnetic model on the shared scale. */
function magneticSpec(page: PowderPageModel) {
  const s = page.session;
  return {
    structure: s.structure, magnetic: s.magnetic!, pattern: s.pattern, parameters: [...s.powderParams], bindings: [...s.powderBindings],
    ...(s.extraPhases.length > 0 ? { extraPhases: s.extraPhases.map((st) => ({ structure: st, id: st.id })) } : {}),
    ...profileRequest(s),
    ...windowRequest(page),
  };
}

/** The nuclear refinement's request (multi-phase when there are extra phases). */
function nuclearRequest(page: PowderPageModel, parameters: readonly RefinementParameter[] = page.session.powderParams) {
  const s = page.session;
  return {
    structure: s.structure, pattern: s.pattern, parameters: [...parameters], bindings: s.powderBindings, ...profileRequest(s), ...restraintRequest(s),
    ...(s.extraPhases.length > 0 ? { extraPhases: s.extraPhases } : {}),
    ...windowRequest(page),
  };
}

/**
 * The Refine button's fit of the current free set: with an applied magnetic
 * model, nuclear + magnetic on the shared scale; otherwise the nuclear
 * pattern. Applies nothing: the caller does, or (the Agent's correlation
 * probe) only reads it.
 */
export function powderFit(client: PowderCompute, page: PowderPageModel, options: Partial<RefinementOptions>, gpu = false, onProgress?: PowderProgress): Promise<RefinementResult> {
  if (magneticApplied(page.session)) return client.refineMagneticPowderParallel(magneticSpec(page), options);
  return client.refinePowderParallel({ ...nuclearRequest(page), options, useGpu: gpu }, onProgress);
}

/** A fit's values on the session, and with a magnetic model applied, its refined moments. */
export function withFitResult(s: Session, result: RefinementResult): Session {
  const powderParams = s.powderParams.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value }));
  return magneticApplied(s)
    ? { ...s, magnetic: applyMagneticMoments(s.magnetic!, s.powderBindings, result.parameters), powderParams }
    : { ...s, powderParams };
}

/** What Prefit or Escape-minimum found: the session with it applied, its result, and the page's message. */
export interface ThoroughOutcome {
  readonly mode: "prefit" | "escape";
  readonly magnetic: boolean;
  readonly session: Session;
  readonly result: RefinementResult;
  readonly message: string;
}

/**
 * Prefit (no fit yet) or Escape minimum (after one): the robust path, in two
 * stages for a nuclear model.
 *  1. A Le Bail cell pre-fit (single phase, a cell row free; on TOF with the
 *     diffractometer's calibration): the cell against peak positions with free
 *     intensities, so a wrong starting cell cannot trap the structural solve.
 *     Its cell is seeded back, and on 2θ its zero seeds a free zero.
 *  2. Multi-start: a baseline fit and perturbed restarts, the lowest χ² kept.
 * With a magnetic model applied, the search runs over the moment subspace
 * instead. `onStage` says when the Le Bail stage starts (the page shows it before the fit runs).
 */
export async function thoroughFit(client: PowderCompute, page: PowderPageModel, onProgress?: PowderProgress, onStage?: (message: string) => void | Promise<void>): Promise<ThoroughOutcome> {
  const s = page.session;
  const mode: "prefit" | "escape" = page.result ? "escape" : "prefit";
  if (magneticApplied(s)) {
    const msOptions = mode === "prefit" ? { restarts: 12, minKick: momentKickFloor(s.powderParams) } : { restarts: 6, escapeSigma: 3 };
    const ms: MagneticMultiStartResult = await client.refineMagneticPowderMultiStart(magneticSpec(page), msOptions, { maxIterations: 20 }, onProgress);
    const wr = (100 * (ms.final.agreement.rWeighted ?? 0)).toFixed(2);
    const degNote = ms.degeneracies.length > 0 ? ` Data-limited: ${ms.degeneracies[0]!.message}` : "";
    // restartsRun 0 = no free moment row to perturb (a previewed model): the
    // engine went straight to the joint solve, so no search is reported.
    const bestNote = ms.restartsRun === 0
      ? "no free moment row to search — joint solve with the magnetic model held"
      : ms.improved
        ? `found a lower minimum (start ${ms.bestStartIndex} of ${ms.restartsRun})`
        : `baseline held over ${ms.restartsRun + 1} starts`;
    return {
      mode, magnetic: true, session: withFitResult(s, ms.final), result: ms.final,
      message: `Magnetic ${mode === "prefit" ? "prefit" : "escape"}: ${bestNote} — wR ${wr}%.${degNote}`,
    };
  }
  let workingParams: readonly RefinementParameter[] = s.powderParams;
  const isCell = (kind: string): boolean => kind === "cellLength" || kind === "cellAngle";
  const tof = s.pattern.xUnit === "tof";
  const applied = applyParameters(s.structure, s.powderBindings, Object.fromEntries(s.powderParams.map((p) => [p.id, p.value])));
  const tofCal = tof && applied.tof ? { ...applied.tof, zero: applied.zeroShift } : undefined;
  const leBailReady = mode === "prefit"
    && s.extraPhases.length === 0
    && s.powderParams.some((p) => isCell(p.kind) && !p.fixed && !p.expression)
    && (!tof || tofCal !== undefined);
  if (leBailReady) {
    await onStage?.("Le Bail pre-fit: refining the cell against peak positions (no structure)…");
    const pre = await client.leBailPrefit({
      structure: s.structure, pattern: s.pattern,
      cellParameters: s.powderParams.filter((p) => isCell(p.kind)),
      cellBindings: s.powderBindings.filter((b) => isCell(b.kind)),
      shape: s.powderProfile.shape,
      ...(s.powderProfile.eta !== undefined ? { eta: s.powderProfile.eta } : {}),
      ...windowRequest(page),
      ...(tofCal ? { tof: tofCal } : {}),
    });
    if (pre.refined) {
      // The Le Bail fit refines its own zero on a 2θ pattern, so its cell is
      // free of the zero error: a free zero starts at the same value.
      workingParams = s.powderParams.map((p) => (pre.cellValues[p.id] !== undefined
        ? { ...p, value: pre.cellValues[p.id]! }
        : p.kind === "zeroShift" && pre.zero !== undefined && !p.fixed && !p.expression ? { ...p, value: pre.zero } : p));
    }
  }
  // Prefit casts a wide net from a cold start (many restarts, the default ~4σ
  // kick); Escape is a light nudge around a refined fit (few restarts, ~1.5σ).
  const msOptions = mode === "prefit" ? { restarts: 8 } : { restarts: 3, escapeSigma: 1.5 };
  const ms: MultiStartResult = await client.refinePowderMultiStart({ ...nuclearRequest(page, workingParams), options: { maxIterations: 20 } }, msOptions, onProgress);
  const wr = (100 * (ms.final.agreement.rWeighted ?? 0)).toFixed(2);
  const message = mode === "prefit"
    ? ms.improved
      ? `Prefit found a lower minimum (restart ${ms.bestStartIndex} of ${ms.restartsRun}) — wR ${wr}%, best of ${ms.restartsRun + 1} starts. Refine to polish.`
      : `Prefit: the starting model was already best of ${ms.restartsRun + 1} starts — wR ${wr}%. Refine to polish.`
    : ms.improved
      ? `Escaped a local minimum (restart ${ms.bestStartIndex} of ${ms.restartsRun}) — wR ${wr}%, best of ${ms.restartsRun + 1} starts.`
      : `Already at the best minimum — the baseline beat all ${ms.restartsRun + 1} starts, wR ${wr}%.`;
  return { mode, magnetic: false, session: withFitResult(s, ms.final), result: ms.final, message };
}

/**
 * The posterior sampler over the page's problem as it stands (the free rows,
 * the window, every phase, the restraints, an applied magnetic model), seeded
 * at the present values with the last fit's esds. A continued run reuses the
 * closure this returns, so the chain keeps targeting the same posterior.
 */
export function posteriorRun(client: PowderCompute, page: PowderPageModel): (options: SampleOptions) => Promise<SampleResult> {
  const esd = page.result?.esd;
  if (magneticApplied(page.session)) {
    const spec = magneticSpec(page);
    return (o) => client.sampleMagneticPowderPosterior(spec, { ...o, ...(esd ? { linearizedEsd: esd } : {}) });
  }
  const req = nuclearRequest(page);
  return (o) => client.samplePowderPosterior(req, { ...o, ...(esd ? { linearizedEsd: esd } : {}) });
}

/** The rows a magnetic model hands the refinement page replace any earlier model's. */
export function withMagneticModelRows(s: Session, magnetic: NonNullable<Session["magnetic"]>, momentParams: readonly RefinementParameter[], momentBindings: readonly ParameterBinding[]): Session {
  return {
    ...s,
    magnetic,
    powderParams: [...s.powderParams.filter((p) => !isMagneticModelParameterKind(p.kind)), ...momentParams.map((p) => ({ ...p, fixed: !!p.expression }))],
    powderBindings: [...s.powderBindings.filter((b) => !isMagneticModelParameterKind(b.kind)), ...momentBindings],
  };
}
