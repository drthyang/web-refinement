/**
 * Powder (Rietveld) refinement engine page — the peer of SingleCrystalWorkbench
 * behind the WorkbenchEngine contract. Owns all powder view state (fit range,
 * display unit, plot mode, highlight, live refinement preview), the refinement
 * orchestration against the shared compute worker, the powder exports, and both
 * step pages (setup & refinement · magnetic symmetry analysis).
 *
 * The session (structure + pattern + parameter spec) lives in the app shell —
 * whose data loaders create it — and is passed down with its setter; the
 * engine's controls (background basis/terms, ADP model, site ties, Mustrain)
 * rebuild the spec through it.
 *
 * Per the WorkbenchEngine boundary (see workbenchEngine.ts), the quality panel
 * and every agreement factor here are the powder community's own: Rwp over the
 * profile, GoF = wR/R_exp (Toby 2006) — nothing is shared with the
 * single-crystal engine's R1/wR2/GooF.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { APP_VERSION, PROJECT_SCHEMA_VERSION } from "@/app/constants";
import { downloadText, downloadBlob } from "@/app/download";
import { fullprofBundle, gsas2Bundle, type BundleOptions } from "@/core/export/bundle";
import { zipStore } from "@/core/export/zip";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter, RefinementResult, ParameterBinding } from "@/core/refinement/types";
import type { ProjectFile } from "@/core/project/types";
import { cellVolume } from "@/core/crystal/unitCell";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { magneticComponentCurve } from "@/core/workflow/magneticPowder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import type { PeakShape } from "@/core/diffraction/profile";
import type { BackgroundType } from "@/core/diffraction/background";
import { extractSizeStrain } from "@/core/diffraction/microstructure";
import { guidedPowderParams, type SiteTies, type MustrainModel } from "@/app/powderSpec";
import { multiPhaseCurves } from "@/core/workflow/multiPhase";
import { DEFAULT_STAGE_KINDS, siteGroups } from "@/core/workflow/structureRefinement";
import { powderPatternCsv, projectJson } from "@/core/export/exporters";
import { structureToCif, magneticStructureToMcif, type CifRefinementMeta } from "@/core/export/cif";
import { isMomentParameterKind } from "@/core/refinement/types";
import type { ComputeClient } from "@/workers/computeClient";
import { CANCELLED } from "@/workers/computeClient";
import { KSearchPanel, type MagneticPatternView, type ResidualPeak } from "@/components/KSearchPanel";
import { withAdpModel } from "@/core/crystal/adp";
import { momentEntriesFrom } from "@/app/ui/cellModel";
import { detectExtraPeaks, annotateExtraPeaks, type ExtraPeak } from "@/core/magnetic/extraPeaks";
import { powderReflectionObsCalc, type ReflectionObsCalc } from "@/core/workflow/obsCalc";
import { normalProbabilityPlot, weightedResiduals } from "@/core/refinement/diagnostics";
import { QualityPlots } from "@/app/ui/QualityPlots";
import type { MagneticModel } from "@/core/magnetic/types";
import {
  axisContext,
  availableDisplayUnits,
  convertAxisArray,
  convertAxisValue,
  convertInterval,
  axisLabel,
  axisShortLabel,
  type DisplayUnit,
} from "@/visualization/axisUnits";
import {
  nuclearPhaseTicks,
  magneticPhaseTicks,
  PHASE_COLORS,
  MAGNETIC_COLOR,
} from "@/visualization/reflectionTicks";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { InfoBadge } from "@/app/ui/InfoBadge";
import { WorkbenchPlot, type FitRangeSelection } from "@/app/ui/WorkbenchPlot";
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { color as theme, card as themeCard, uppercaseLabel as themeLabel, mono as themeMono, fz, toolbarBtn, resetRangeBtn } from "@/app/theme";
import { applyParameters } from "@/core/workflow/apply";
import { excludedPointMask } from "@/core/refinement/factors";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { type Session, buildSpecFor, DEFAULT_INSTRUMENT, SYNTHETIC_SOURCE, EMPTY_SOURCE } from "@/app/powderSession";
import type { EngineExportsRef } from "@/app/workbenchEngine";

// Lazy so three.js (~550 kB) only loads when the user opens the 3D view.
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));

const UNIT_LABEL: Record<string, string> = { twoTheta: "2θ", q: "Q (Å⁻¹)", dSpacing: "d (Å)", tof: "TOF (µs)" };

export interface PowderWorkbenchProps {
  session: Session;
  setSession: Dispatch<SetStateAction<Session>>;
  powderResult: RefinementResult | null;
  setPowderResult: (r: RefinementResult | null) => void;
  instrument: InstrumentParameters;
  instrumentLoaded: boolean;
  /** The user has loaded their own primary CIF (Structure card offers "Add CIF…"). */
  ownStructure: boolean;
  /** Shared compute worker — refinement runs off the main thread. */
  client: ComputeClient;
  /** False while the single-crystal engine is on screen: this engine stays
   *  mounted (all state survives mode switches) but hides its pages. */
  active: boolean;
  /** Active workflow step (0 = refinement, 1 = magnetic symmetry analysis). */
  step: number;
  onStep: (i: number) => void;
  setMessage: (text: string) => void;
  /** Shell-owned ref this engine publishes its header exports into. */
  exportsRef: EngineExportsRef;
  onLoadData: (file: File) => void;
  onLoadCif: (file: File) => void;
  onAddPhase: (file: File) => void;
  onRemovePhase: (id: string) => void;
  onClearStructures: () => void;
  onLoadInstrument: (file: File) => void;
  /** Load the bundled demo (from the empty-state prompt). */
  onLoadDemo?: (kind: "rietveld" | "pdf") => void;
}

export function PowderWorkbench({
  session, setSession, powderResult, setPowderResult, instrument, instrumentLoaded, ownStructure,
  client, active, step, onStep, setMessage, exportsRef,
  onLoadData, onLoadCif, onAddPhase, onRemovePhase, onClearStructures, onLoadInstrument, onLoadDemo,
}: PowderWorkbenchProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  // Incremented by the toolbar "⊡ Fit range" button; the plot zooms onto the
  // active fit window when it changes.
  const [focusFitToken, setFocusFitToken] = useState(0);
  // Bumped by "Show in pattern" (F_obs/F_calc plot) to zoom the pattern onto the
  // highlighted reflection's peak.
  const [focusPeakToken, setFocusPeakToken] = useState(0);
  // Optional refinement window; null = fit the full pattern. Reset when the
  // observed pattern changes (see effect below).
  const [fitRange, setFitRange] = useState<FitRangeSelection | null>(null);
  // Display-only x-axis unit; null = the pattern's native unit. Reset on load.
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit | null>(null);
  const [plotMode, setPlotMode] = useState<"curves" | "structure" | "validation">("curves");
  // Reflection clicked in the F_obs/F_calc plot, spotlighted in the pattern
  // plot; null = nothing highlighted.
  const [highlight, setHighlight] = useState<{ hkl: string; kind: "nuclear" | "magnetic"; phaseId?: string } | null>(null);
  // Which phase the 3D model shows (0 = primary structure, 1.. = extra phases).
  const [viewPhaseIdx, setViewPhaseIdx] = useState(0);

  // Live per-cycle refinement preview: the worker streams the calculated curve
  // each accepted cycle. We hold the latest in a ref and flush to a render tick
  // at most every ~60 ms so fast cycles don't thrash the plot — the curve
  // animates toward convergence without flicker. (A time throttle rather than
  // requestAnimationFrame, which doesn't fire in a backgrounded/headless tab.)
  const livePreview = useRef<{ yCalc: number[]; rWeighted: number } | null>(null);
  const lastFlush = useRef(0);
  const [liveTick, setLiveTick] = useState(0);
  const onPowderProgress = useCallback((yCalc: number[], rWeighted: number): void => {
    livePreview.current = { yCalc, rWeighted };
    const now = performance.now();
    if (now - lastFlush.current < 60) return;
    lastFlush.current = now;
    setLiveTick((t) => t + 1);
  }, []);

  const { structure, pattern, powderParams, powderSource } = session;
  // Clean, data-less start: the workbench renders its chrome (the Structure/Data/
  // Instrument cards + Load buttons) with an empty-state where the plot goes.
  const hasContent = powderSource !== EMPTY_SOURCE;
  // A freshly-loaded pattern is a new object; drop the window and axis choice.
  useEffect(() => {
    setFitRange(null);
    setDisplayUnit(null);
  }, [pattern]);
  const powderIsTof = pattern.xUnit === "tof";
  // A TOF pattern refines only when a back-to-back-exponential profile was built
  // (i.e. a TOF calibration was available). A GSAS overlay or an uncalibrated TOF
  // pattern keeps the shape at "gaussian" and stays view-only.
  const tofViewOnly = powderIsTof && session.powderProfile.shape !== "tof";
  const pBindings = session.powderBindings;

  // Every phase's structure with the CURRENT parameter values applied (lattice,
  // positions, occupancies, ADPs) — the refined cell each phase's Bragg ticks,
  // 3D view, and magnetic analysis should track. In multi-phase mode each phase's
  // structural bindings are routed by `targetId` (as `multiPhaseCurves` does);
  // applying the whole set to one structure would cross-apply the phases' cells.
  const refinedPhases = useMemo(() => {
    const values: Record<string, number> = {};
    for (const p of powderParams) values[p.id] = p.value;
    const multi = session.extraPhases.length > 0;
    return [structure, ...session.extraPhases].map((ph) =>
      applyParameters(ph, multi ? pBindings.filter((b) => b.targetId === ph.id) : pBindings, values).model,
    );
  }, [structure, session.extraPhases, powderParams, pBindings]);
  const refinedStructure = refinedPhases[0]!;

  const curves = useMemo(() => {
    // Clean, data-less workbench: nothing to plot (the empty-state renders instead).
    if (pattern.points.length === 0) return { x: [], yObs: [], yCalc: [], yBackground: [], diff: [] };
    // TOF patterns cannot be profile-fit by the minimal engine; show the observed
    // data with GSAS-II's own calc/background as a faithful reference overlay.
    if (powderIsTof && session.powderOverlay) {
      const x = pattern.points.map((p) => p.x);
      const yObs = pattern.points.map((p) => p.yObs);
      const yCalc = session.powderOverlay.calc;
      return { x, yObs, yCalc, yBackground: session.powderOverlay.background, diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
    }
    // Multi-phase: sum every phase's contribution (shared instrument profile).
    if (session.extraPhases.length > 0) {
      const phases = [{ structure, id: structure.id }, ...session.extraPhases.map((s) => ({ structure: s, id: s.id }))];
      const base = multiPhaseCurves(phases, pattern, powderParams, pBindings, session.powderProfile);
      // An applied magnetic model rides the primary phase: add its satellite
      // component on top of the summed nuclear phases. magneticComponentCurve
      // routes bindings so the impurity phases' cells can't graft onto the
      // primary, and skips the (already computed) nuclear synthesis.
      if (session.magnetic && session.magnetic.moments.length > 0) {
        const yMagnetic = magneticComponentCurve(structure, session.magnetic, pattern, powderParams, pBindings, {
          shape: session.powderProfile.shape,
          ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
        }, session.extraPhases.map((s) => ({ structure: s, id: s.id })));
        const yCalc = base.yCalc.map((v, i) => v + (yMagnetic[i] ?? 0));
        return { ...base, yCalc, diff: base.yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
      }
      return base;
    }
    const nuclear = powderCurves(structure, pattern, powderParams, pBindings, session.powderProfile);
    // When a magnetic model has been applied, add its contribution (satellites at
    // G ± k) on top of the nuclear calc so the refinement plot shows the total.
    if (session.magnetic && session.magnetic.moments.length > 0) {
      const yMagnetic = magneticComponentCurve(structure, session.magnetic, pattern, powderParams, pBindings, {
        shape: session.powderProfile.shape,
        ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
      });
      const yCalc = nuclear.yCalc.map((v, i) => v + (yMagnetic[i] ?? 0));
      return { ...nuclear, yCalc, diff: nuclear.yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
    }
    return nuclear;
  }, [structure, pattern, powderParams, pBindings, session.powderProfile, powderIsTof, session.powderOverlay, session.magnetic]);
  // Full pattern extent; the plot handles default to this until the user drags.
  const patternExtent = useMemo<FitRangeSelection>(() => {
    const xs = curves.x;
    if (xs.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...xs), max: Math.max(...xs) };
  }, [curves.x]);
  const effectiveFitRange = fitRange ?? patternExtent;
  const fitRangeActive =
    fitRange !== null && (fitRange.min > patternExtent.min || fitRange.max < patternExtent.max);

  // Display-axis unit conversion (view only — data/refinement stay native).
  const axisCtx = useMemo(() => axisContext(pattern, instrumentLoaded ? instrument : undefined), [pattern, instrument, instrumentLoaded]);
  // A disordered site (≥2 atoms sharing a position) enables the tie controls.
  const hasSharedSite = useMemo(
    () => siteGroups(structure.sites, true).some((g) => g.members.length > 1),
    [structure],
  );
  const displayUnits = useMemo(() => availableDisplayUnits(axisCtx), [axisCtx]);
  // Candidate magnetic peaks = positive residual the nuclear model can't explain,
  // as d-spacings, ready for the k-search (so the user needn't read them off the
  // plot). Requires a d-convertible axis; assumes the nuclear fit is refined.
  const residualPeakD = useMemo<ExtraPeak[]>(() => {
    if (!displayUnits.includes("dSpacing")) return [];
    const dArr = pattern.xUnit === "dSpacing"
      ? curves.x
      : convertAxisArray(curves.x, pattern.xUnit, "dSpacing", axisCtx);
    // Per-point σ so low-precision regions don't spray noise "peaks" into the
    // k-search once the nuclear fit has converged — but only when the data
    // actually carries uncertainties. Fabricating √yObs is valid for raw counts
    // only; on a normalized pattern (max ≈ 1) it exceeds any possible residual
    // and would silently disable detection altogether. The base cut is a
    // permissive 3σ: the k-panel's own criteria (user-adjustable) decide which
    // detections feed the search.
    const hasSigma = pattern.points.length > 0 && pattern.points.every((p) => p.sigma !== undefined);
    const pointSigma = hasSigma ? pattern.points.map((p) => p.sigma!) : undefined;
    return detectExtraPeaks(dArr, curves.yObs, curves.yCalc, {
      ...(pointSigma ? { pointSigma, minSignificance: 3 } : {}),
      limit: 24,
    });
  }, [curves, pattern.points, pattern.xUnit, axisCtx, displayUnits]);
  const effectiveUnit: DisplayUnit = displayUnit ?? pattern.xUnit;
  const displayCurves = useMemo(
    () => (effectiveUnit === pattern.xUnit ? curves : { ...curves, x: convertAxisArray(curves.x, pattern.xUnit, effectiveUnit, axisCtx) }),
    [curves, effectiveUnit, pattern.xUnit, axisCtx],
  );
  // During a refinement, overlay the live per-cycle calculated curve (streamed
  // from the worker) onto the plot so it animates toward convergence.
  const plotCurves = useMemo(() => {
    const lp = livePreview.current;
    if (!busy || !lp || lp.yCalc.length !== displayCurves.yObs.length) return displayCurves;
    return { ...displayCurves, yCalc: lp.yCalc, diff: displayCurves.yObs.map((o, i) => o - (lp.yCalc[i] ?? 0)) };
    // liveTick bumps each animation frame to pull the latest ref value.
  }, [displayCurves, busy, liveTick]);
  const displayXLabel = axisLabel(effectiveUnit);
  // Fit-range handles live in display space; convert to/from the native window.
  const displayFitRange = useMemo(
    () => convertInterval(effectiveFitRange, pattern.xUnit, effectiveUnit, axisCtx),
    [effectiveFitRange, pattern.xUnit, effectiveUnit, axisCtx],
  );
  const setFitRangeFromDisplay = useCallback(
    (r: FitRangeSelection): void => setFitRange(convertInterval(r, effectiveUnit, pattern.xUnit, axisCtx)),
    [effectiveUnit, pattern.xUnit, axisCtx],
  );

  // Bragg reflection ticks (in the current display unit). Nuclear phase always;
  // a magnetic row appears when the session carries a magnetic model. The d-range
  // is floored so very-high-Q (tiny-d) reflections don't explode the tick count.
  const phaseTicks = useMemo(() => {
    const dA = convertAxisValue(patternExtent.min, pattern.xUnit, "dSpacing", axisCtx);
    const dB = convertAxisValue(patternExtent.max, pattern.xUnit, "dSpacing", axisCtx);
    if (!Number.isFinite(dA) || !Number.isFinite(dB)) return [];
    const dMin = Math.max(Math.min(dA, dB), 0.4);
    const dMax = Math.max(dA, dB);
    const toX = (d: number): number => convertAxisValue(d, "dSpacing", effectiveUnit, axisCtx);
    // Use the *refined* cell of each phase so the ticks track the calculated
    // pattern after a refinement (the base structures keep their loaded cells).
    const base = refinedPhases[0] ?? structure;
    const phases = [
      // id = structure.id so it matches the F_obs/F_calc decomposition's phaseId
      // (obsCalc tags the primary phase with structure.id), keeping the two plots'
      // click-to-spotlight in sync per phase. Use the *refined* cell (`base`) so
      // the ticks track the calculated pattern after a refinement.
      nuclearPhaseTicks(base, dMin, dMax, toX, { id: structure.id, label: structure.name || "nuclear", color: PHASE_COLORS[0] }),
    ];
    // One Bragg-tick row per additional crystallographic phase, coloured distinctly.
    session.extraPhases.forEach((ph, i) => {
      phases.push(nuclearPhaseTicks(refinedPhases[i + 1] ?? ph, dMin, dMax, toX, { id: ph.id, label: ph.name || `phase ${i + 2}`, color: PHASE_COLORS[(i + 1) % PHASE_COLORS.length]! }));
    });
    if (session.magnetic) {
      phases.push(magneticPhaseTicks(base, session.magnetic, dMin, dMax, toX, { id: "magnetic", label: "magnetic", color: MAGNETIC_COLOR }));
    }
    return phases;
  }, [refinedPhases, structure, session.extraPhases, session.magnetic, patternExtent, pattern.xUnit, effectiveUnit, axisCtx]);

  // Manually added residual peaks (clicked on the magnetic page's pattern):
  // stored as d-spacings; height/significance are sampled from the residual at
  // the nearest data point so a hand-picked peak carries the same quantitative
  // columns as a detected one. Dropped when the observed pattern changes.
  const [manualPeakD, setManualPeakD] = useState<number[]>([]);
  useEffect(() => {
    setManualPeakD([]);
  }, [pattern]);
  const addManualPeak = useCallback((d: number): void => {
    if (!Number.isFinite(d) || d <= 0) return;
    setManualPeakD((list) => (list.some((v) => Math.abs(v - d) < 0.005) ? list : [...list, d]));
  }, []);
  const removeManualPeak = useCallback((d: number): void => {
    setManualPeakD((list) => list.filter((v) => Math.abs(v - d) > 1e-9));
  }, []);
  const manualResidualPeaks = useMemo<ExtraPeak[]>(() => {
    if (manualPeakD.length === 0 || !displayUnits.includes("dSpacing")) return [];
    const dArr = pattern.xUnit === "dSpacing"
      ? curves.x
      : convertAxisArray(curves.x, pattern.xUnit, "dSpacing", axisCtx);
    const hasSigma = pattern.points.length > 0 && pattern.points.every((p) => p.sigma !== undefined);
    return manualPeakD.map((d) => {
      let bi = 0;
      let bestErr = Infinity;
      for (let i = 0; i < dArr.length; i++) {
        const e = Math.abs(dArr[i]! - d);
        if (e < bestErr) { bestErr = e; bi = i; }
      }
      const height = (curves.yObs[bi] ?? 0) - (curves.yCalc[bi] ?? 0);
      const si = hasSigma ? pattern.points[bi]!.sigma! : undefined;
      return { d, height, ...(si !== undefined && si > 0 ? { significance: height / si } : {}) };
    });
  }, [manualPeakD, curves, pattern.points, pattern.xUnit, axisCtx, displayUnits]);

  // Detected + manual residual peaks annotated against every phase's nuclear
  // reflections (refined cells, from the tick rows): a residual apex on a
  // nuclear position is usually profile misfit (e.g. an impurity shoulder),
  // not magnetic — the k-panel shows the flag and excludes such peaks from the
  // search by default. Manual picks are flagged so the panel can mark and
  // remove them (and include them regardless of the criteria).
  const residualPeaks = useMemo<ResidualPeak[]>(() => {
    // A manual pick right on a detected apex is the same peak — don't list twice.
    const manual = manualResidualPeaks.filter((m) => !residualPeakD.some((p) => Math.abs(p.d - m.d) < 0.01));
    if (residualPeakD.length + manual.length === 0) return [];
    const nuclearRefs = phaseTicks
      .filter((p) => p.kind === "nuclear")
      .flatMap((p) => p.ticks.map((t) => ({ d: t.d, hkl: t.hkl, phaseLabel: p.label })));
    return [
      ...annotateExtraPeaks(residualPeakD, nuclearRefs),
      ...annotateExtraPeaks(manual, nuclearRefs).map((p) => ({ ...p, manual: true as const })),
    ];
  }, [residualPeakD, manualResidualPeaks, phaseTicks]);

  // Refined moment entries (per site / split orbit) for the 3D structure view.
  const sessionMoments = useMemo(
    () => (session.magnetic ? momentEntriesFrom(session.magnetic) : undefined),
    [session.magnetic],
  );

  function patchPowder(id: string, patch: Partial<RefinementParameter>): void {
    setSession((s) => ({ ...s, powderParams: s.powderParams.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }

  /** Hand the magnetic model + moment parameters to the refinement page: add the
   *  (freed) moment-mode params + bindings to the powder set and switch to the
   *  Refinement tab, where "Refine" now fits nuclear + magnetic together. */
  function continueRefinementWithMagnetic(
    magnetic: MagneticModel,
    momentParams: readonly RefinementParameter[],
    momentBindings: readonly ParameterBinding[],
  ): void {
    setSession((s) => ({
      ...s,
      magnetic,
      powderParams: [...s.powderParams.filter((p) => !isMomentParameterKind(p.kind)), ...momentParams.map((p) => ({ ...p, fixed: false }))],
      powderBindings: [...s.powderBindings.filter((b) => !isMomentParameterKind(b.kind)), ...momentBindings],
    }));
    setPowderResult(null);
    onStep(0);
    setMessage(`Magnetic model passed to the refinement page — ${momentParams.length} moment parameter${momentParams.length === 1 ? "" : "s"} added (Magnetic group). Click Refine to fit nuclear + magnetic together.`);
  }

  const profileReq = (): { shape: PeakShape; eta?: number; lorentz?: boolean; backgroundType?: BackgroundType } => ({
    shape: session.powderProfile.shape,
    ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
    ...(session.powderProfile.lorentz !== undefined ? { lorentz: session.powderProfile.lorentz } : {}),
    ...(session.powderProfile.backgroundType !== undefined ? { backgroundType: session.powderProfile.backgroundType } : {}),
  });

  /** Change the smooth-background basis (reinterprets the same coefficients). */
  function setBackgroundType(backgroundType: BackgroundType): void {
    setSession((s) => {
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
    });
    setPowderResult(null);
  }

  /** Change the number of background coefficients (rebuilds the spec, keeping
   *  every other parameter's value/free state and the chosen background type). */
  function setBackgroundTerms(n: number): void {
    const count = Math.max(0, Math.min(24, Math.trunc(n)));
    setSession((s) => {
      const spec = buildSpecFor(s.structure, s.extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, count, s.siteTies, s.mustrain ?? "isotropic");
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        backgroundTerms: count,
        powderParams: spec.params.map((p) => {
          const old = previous.get(p.id);
          return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
        }),
        powderBindings: spec.bindings,
        powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
      };
    });
    setPowderResult(null);
  }

  /** Toggle tying position/ADP across shared (disordered) sites; rebuilds the spec. */
  function setSiteTies(update: Partial<SiteTies>): void {
    setSession((s) => {
      const ties = { ...s.siteTies, ...update };
      const spec = buildSpecFor(s.structure, s.extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, ties, s.mustrain ?? "isotropic");
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        siteTies: ties,
        powderParams: spec.params.map((p) => {
          const old = previous.get(p.id);
          return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
        }),
        powderBindings: spec.bindings,
        powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
      };
    });
    setPowderResult(null);
  }

  /**
   * Set the sample microstrain (Mustrain) model: isotropic (Lorentzian Y only),
   * uniaxial (equatorial/axial Y about the c-axis), or generalized (Stephens
   * S-parameters). Rebuilds the spec — the new rows seed at the current isotropic
   * strain and are fixed on load (free the Microstructure group or run guided).
   */
  function setMustrain(model: MustrainModel): void {
    setSession((s) => {
      const spec = buildSpecFor(s.structure, s.extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, model);
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        mustrain: model,
        powderParams: spec.params.map((p) => {
          const old = previous.get(p.id);
          return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
        }),
        powderBindings: spec.bindings,
        powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
      };
    });
    setPowderResult(null);
    setMessage(model === "isotropic"
      ? "Microstrain: isotropic (Lorentzian Y). Refine the profile to fit; the microstrain readout shows its value."
      : model === "uniaxial"
        ? "Microstrain: uniaxial — equatorial/axial Y about the c-axis added, seeded from the isotropic value. Free the Microstructure rows or run guided."
        : "Microstrain: generalized (Stephens) — one S-parameter per symmetry-allowed quartic invariant, seeded at zero. Free the Microstructure rows or run guided.");
  }

  /**
   * Switch the ADP model between isotropic (B_iso) and anisotropic (U tensor)
   * and rebuild the spec. Promotion seeds each site's spherical U from its
   * *current* (refined) B_iso — so an isotropic fit is the starting point for
   * the anisotropic one — then the symmetry-allowed U modes refine. Non-ADP
   * parameter values (scale, cell, positions, background, profile) are carried
   * over unchanged; only the ADP rows are reseeded.
   */
  function setAnisotropicAdp(on: boolean): void {
    setSession((s) => {
      // Bake the current refined B_iso/U into the base structure's ADPs so the
      // conversion seeds from the converged values (positions/cell stay in the
      // preserved parameters, so they are not double-applied here).
      const values: Record<string, number> = {};
      for (const p of s.powderParams) values[p.id] = p.value;
      const refined = applyParameters(s.structure, s.powderBindings, values).model;
      const refinedAdp = new Map(refined.sites.map((rs) => [rs.label, rs.adp]));
      const seeded = { ...s.structure, sites: s.structure.sites.map((site) => ({ ...site, adp: refinedAdp.get(site.label) ?? site.adp })) };
      const promoted = withAdpModel(seeded, on ? "anisotropic" : "isotropic");
      const spec = buildSpecFor(promoted, s.extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        structure: promoted,
        anisotropicAdp: on,
        powderParams: spec.params.map((p) => {
          // ADP rows are freshly seeded by the rebuild; everything else keeps
          // its current (possibly refined) value and free/fixed state.
          if (p.kind === "bIso" || p.kind === "uAniso") return p;
          const old = previous.get(p.id);
          return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
        }),
        powderBindings: spec.bindings,
        powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
      };
    });
    setPowderResult(null);
    setMessage(on
      ? "Switched to anisotropic ADPs — each site's U tensor (symmetry-allowed modes) seeded from its B_iso. Free the ADP rows or run guided to refine them."
      : "Switched to isotropic ADPs (B_iso).");
  }

  /** Reset every powder parameter to its initial value and clear the result. */
  function resetPowderParams(): void {
    setSession((s) => ({
      ...s,
      powderParams: s.powderParams.map(({ esd: _esd, ...p }) => ({ ...p, value: p.initialValue })),
    }));
    setPowderResult(null);
    setMessage("Parameters reset to initial values.");
  }

  /** Flat co-refinement of the currently-freed parameters. */
  async function runPowder(guided = false): Promise<void> {
    setBusy(true);
    try {
      // Magnetic-aware branch: when a magnetic model + moment parameters are
      // present, refine nuclear + moments together (shared scale) with the
      // Jacobian parallelized over the evaluator-worker pool (falls back to an
      // in-thread solve when workers are unavailable).
      if (session.magnetic && powderParams.some((p) => isMomentParameterKind(p.kind))) {
        await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
        const magParams = guided ? guidedPowderParams(powderParams) : powderParams;
        const result = await client.refineMagneticPowderParallel({
          structure, magnetic: session.magnetic, pattern, parameters: [...magParams], bindings: [...pBindings],
          ...(session.extraPhases.length > 0 ? { extraPhases: session.extraPhases.map((s) => ({ structure: s, id: s.id })) } : {}),
          shape: session.powderProfile.shape,
          ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
          ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
        }, { maxIterations: guided ? 15 : 20 });
        const refinedMag = applyMagneticMoments(session.magnetic, pBindings, result.parameters);
        setSession((s) => ({
          ...s,
          magnetic: refinedMag,
          powderParams: s.powderParams.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value, ...(guided ? { fixed: false } : {}) })),
        }));
        setPowderResult(result);
        setMessage(`Nuclear + magnetic refinement ${result.status}: wR = ${(100 * (result.agreement.rWeighted ?? 0)).toFixed(2)}%.`);
        return;
      }
      // The WebGPU structure-factor kernel accelerates only the flat single-phase
      // nuclear-powder Jacobian; the client itself gates on that + WebGPU support
      // and falls back to the CPU pool otherwise, so requesting it here is safe.
      const gpuActive = !guided && session.extraPhases.length === 0 && !session.magnetic
        && typeof navigator !== "undefined" && !!(navigator as Navigator & { gpu?: unknown }).gpu;
      // Parallel-Jacobian path for the flat single-phase case; the client
      // falls back to the single-worker path for staged/multi-phase requests.
      const result = await client.refinePowderParallel({
        structure, pattern, parameters: guided ? guidedPowderParams(powderParams) : powderParams, bindings: pBindings, ...profileReq(),
        ...(session.extraPhases.length > 0 ? { extraPhases: session.extraPhases } : {}),
        ...(guided ? { staged: DEFAULT_STAGE_KINDS } : {}),
        ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
        options: { maxIterations: guided ? 15 : 20 },
        useGpu: true,
      }, onPowderProgress);
      setSession((s) => ({
        ...s,
        // Guided refinement frees parameters internally; reflect that in the table.
        powderParams: s.powderParams.map((p) => ({
          ...p,
          value: result.parameters[p.id] ?? p.value,
          ...(guided ? { fixed: false } : {}),
        })),
      }));
      setPowderResult(result);
      setMessage(`Powder ${guided ? "guided " : ""}refinement ${result.status}: wR = ${(100 * (result.agreement.rWeighted ?? 0)).toFixed(2)}%${gpuActive ? " · GPU |F|²" : ""}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessage(msg === CANCELLED ? "Refinement cancelled." : `Powder refinement failed: ${msg}`);
    } finally {
      livePreview.current = null;
      setBusy(false);
    }
  }

  /**
   * Thorough refine — the robust, local-minimum-resistant path, in two stages:
   *  1. Le Bail cell pre-fit (single-phase): refine the cell against peak
   *     positions with free intensities, so a wrong starting cell can't trap the
   *     structural solve. Only the cell is seeded back.
   *  2. Multi-start: one baseline fit plus perturbed restarts, keeping the
   *     lowest-χ² result.
   * Nuclear / multi-phase only (the magnetic co-refinement keeps the plain Refine).
   */
  async function runThorough(): Promise<void> {
    // One engine, two faces: with no fit yet it's a "Prefit" (broad cold-start
    // search + Le Bail); once a fit exists it's a light "Escape min" nudge.
    const mode: "prefit" | "escape" = powderResult ? "escape" : "prefit";
    setBusy(true);
    try {
      // Magnetic branch — moment-subspace multi-start (GAP #1): freeze the
      // nuclear scaffold, search the moment modes from several seeded starts,
      // then one joint LM; the global ±m sign is canonicalized and the
      // data-limited (flat) moment directions are reported. Prefit casts a wide
      // net (more restarts); Escape is a lighter nudge around a converged fit.
      if (session.magnetic && powderParams.some((p) => isMomentParameterKind(p.kind))) {
        await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
        const msOptions = mode === "prefit" ? { restarts: 12 } : { restarts: 6, escapeSigma: 3 };
        const ms = await client.refineMagneticPowderMultiStart({
          structure, magnetic: session.magnetic, pattern, parameters: [...powderParams], bindings: [...pBindings],
          shape: session.powderProfile.shape,
          ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
          ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
        }, msOptions, { maxIterations: 20 }, onPowderProgress);
        const refinedMag = applyMagneticMoments(session.magnetic, pBindings, ms.final.parameters);
        setSession((s) => ({
          ...s,
          magnetic: refinedMag,
          powderParams: s.powderParams.map((p) => ({ ...p, value: ms.final.parameters[p.id] ?? p.value })),
        }));
        setPowderResult(ms.final);
        const wr = (100 * (ms.final.agreement.rWeighted ?? 0)).toFixed(2);
        const degNote = ms.degeneracies.length > 0
          ? ` Data-limited: ${ms.degeneracies[0]!.message}`
          : "";
        const bestNote = ms.improved
          ? `found a lower minimum (start ${ms.bestStartIndex} of ${ms.restartsRun})`
          : `baseline held over ${ms.restartsRun + 1} starts`;
        setMessage(`Magnetic ${mode === "prefit" ? "prefit" : "escape"}: ${bestNote} — wR ${wr}%.${degNote}`);
        return;
      }
      // Stage 1 — Le Bail cell pre-fit (prefit only; single-phase, when a cell
      // parameter is free). A TOF pattern also needs the diffractometer
      // calibration (difC/A/B, Zero) to place reflections on the time axis;
      // recover it from the current parameters and pass it through.
      let workingParams = powderParams;
      const isCell = (kind: string): boolean => kind === "cellLength" || kind === "cellAngle";
      const applied = applyParameters(structure, pBindings, Object.fromEntries(powderParams.map((p) => [p.id, p.value])));
      const tofCal = powderIsTof && applied.tof ? { ...applied.tof, zero: applied.zeroShift } : undefined;
      const leBailReady = mode === "prefit"
        && session.extraPhases.length === 0
        && powderParams.some((p) => isCell(p.kind) && !p.fixed && !p.expression)
        && (!powderIsTof || tofCal !== undefined);
      if (leBailReady) {
        setMessage("Le Bail pre-fit: refining the cell against peak positions (no structure)…");
        await new Promise((r) => setTimeout(r, 0)); // let the message paint
        const pre = await client.leBailPrefit({
          structure, pattern,
          cellParameters: powderParams.filter((p) => isCell(p.kind)),
          cellBindings: pBindings.filter((b) => isCell(b.kind)),
          shape: session.powderProfile.shape,
          ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
          ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
          ...(tofCal ? { tof: tofCal } : {}),
        });
        if (pre.refined) {
          workingParams = powderParams.map((p) => (pre.cellValues[p.id] !== undefined ? { ...p, value: pre.cellValues[p.id]! } : p));
        }
      }
      // Stage 2 — multi-start from the (cell-seeded) parameters. Prefit casts a
      // wide net from a cold start (many restarts, default ~4σ kick); Escape is a
      // light nudge around an already-refined fit (few restarts, tight ~1.5σ kick).
      const msOptions = mode === "prefit" ? { restarts: 8 } : { restarts: 3, escapeSigma: 1.5 };
      const ms = await client.refinePowderMultiStart({
        structure, pattern, parameters: workingParams, bindings: pBindings, ...profileReq(),
        ...(session.extraPhases.length > 0 ? { extraPhases: session.extraPhases } : {}),
        ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
        options: { maxIterations: 20 },
      }, msOptions, onPowderProgress);
      setSession((s) => ({
        ...s,
        powderParams: s.powderParams.map((p) => ({ ...p, value: ms.final.parameters[p.id] ?? p.value })),
      }));
      setPowderResult(ms.final);
      const wr = (100 * (ms.final.agreement.rWeighted ?? 0)).toFixed(2);
      if (mode === "prefit") {
        setMessage(ms.improved
          ? `Prefit found a lower minimum (restart ${ms.bestStartIndex} of ${ms.restartsRun}) — wR ${wr}%, best of ${ms.restartsRun + 1} starts. Refine to polish.`
          : `Prefit: the starting model was already best of ${ms.restartsRun + 1} starts — wR ${wr}%. Refine to polish.`);
      } else {
        setMessage(ms.improved
          ? `Escaped a local minimum (restart ${ms.bestStartIndex} of ${ms.restartsRun}) — wR ${wr}%, best of ${ms.restartsRun + 1} starts.`
          : `Already at the best minimum — the baseline beat all ${ms.restartsRun + 1} starts, wR ${wr}%.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessage(msg === CANCELLED ? "Refinement cancelled." : `${mode === "prefit" ? "Prefit" : "Escape min"} failed: ${msg}`);
    } finally {
      livePreview.current = null;
      setBusy(false);
    }
  }

  /** Abort the running refinement (worker path); the awaited promise rejects as
   *  cancelled, so runPowder's finally clears the busy state. */
  function cancelPowder(): void {
    client.cancel();
  }

  function exportProject(): void {
    const project: ProjectFile = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      metadata: {
        title: `${structure.name} session`,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
      },
      structures: [structure],
      magneticModels: [],
      datasets: [pattern],
      parameters: [...powderParams],
      bindings: [...pBindings],
      ...(powderResult ? { lastResult: powderResult } : {}),
    };
    downloadText(`${structure.id}-project.json`, projectJson(project), "application/json");
  }

  const wRpct = (() => {
    // The page's single wR readout: the true weighted R_wp with the engine's
    // definition and point selection (1/σ² weights, excluded-sentinel plateau,
    // active fit range; for a TOF overlay only where the reference calc > 0),
    // so it matches the refinement result at convergence and stays live as
    // parameters are edited.
    const excluded = excludedPointMask(curves.yObs);
    let num = 0, den = 0;
    for (let i = 0; i < curves.yObs.length; i++) {
      const c = curves.yCalc[i] ?? 0;
      if (excluded[i]) continue;
      if (powderIsTof && c <= 0) continue;
      if (fitRangeActive && (curves.x[i]! < fitRange!.min || curves.x[i]! > fitRange!.max)) continue;
      const o = curves.yObs[i]!;
      const s = pattern.points[i]?.sigma ?? (o > 0 ? Math.sqrt(o) : 1);
      const w = s > 0 ? 1 / (s * s) : 1;
      num += w * (o - c) * (o - c);
      den += w * o * o;
    }
    return (100 * Math.sqrt(num / Math.max(den, 1e-12))).toFixed(2);
  })();

  // wR (live during a refinement) and GoF for the plot-header readouts. GoF is
  // the live wR over R_exp (Toby 2006); R_exp only exists after a refinement.
  const liveWr = busy && livePreview.current ? (100 * livePreview.current.rWeighted).toFixed(2) : wRpct;
  const rExp = powderResult?.agreement.rExpected;
  const liveGof = rExp && rExp > 0 ? Number(liveWr) / (100 * rExp) : null;
  const refinedGof = powderResult ? (powderResult.agreement.goodnessOfFit ?? null) : null;

  // Pattern preview for the Magnetic tab — the SAME view as the refinement
  // plot: refined curves in the current display unit, the fit-range window,
  // the axis-unit toggle, and every crystallographic phase's Bragg-tick row
  // (so an impurity peak indexes against its own phase, not a bogus G ± k of
  // the primary). The k-search page adds its satellite / allowed / residual
  // rows on top via `dToX`. (Declared after the wR/GoF readouts it embeds.)
  const magneticPatternView = useMemo<MagneticPatternView | undefined>(() => {
    if (pattern.points.length === 0 || !displayUnits.includes("dSpacing")) return undefined;
    const dA = convertAxisValue(patternExtent.min, pattern.xUnit, "dSpacing", axisCtx);
    const dB = convertAxisValue(patternExtent.max, pattern.xUnit, "dSpacing", axisCtx);
    if (!Number.isFinite(dA) || !Number.isFinite(dB)) return undefined;
    return {
      curves: displayCurves,
      xLabel: displayXLabel,
      dToX: (d: number): number => convertAxisValue(d, "dSpacing", effectiveUnit, axisCtx),
      xToD: (x: number): number => convertAxisValue(x, effectiveUnit, "dSpacing", axisCtx),
      // Same tiny-d floor as the refinement plot's tick rows.
      dRange: { min: Math.max(Math.min(dA, dB), 0.4), max: Math.max(dA, dB) },
      nuclearTicks: phaseTicks.filter((p) => p.kind === "nuclear"),
      fitRange: displayFitRange,
      ...(tofViewOnly ? {} : { onFitRangeChange: setFitRangeFromDisplay }),
      unitToggle: <AxisUnitToggle units={displayUnits} value={effectiveUnit} onChange={setDisplayUnit} />,
    };
  }, [pattern.points.length, pattern.xUnit, displayUnits, displayCurves, displayXLabel, phaseTicks, displayFitRange, setFitRangeFromDisplay, tofViewOnly, effectiveUnit, axisCtx, patternExtent]);

  // The magnetic pattern card's live toolbar pieces, passed OUTSIDE the memoized
  // view object: the wR chip changes every live-refinement flush (~60 ms), and
  // baking it into `magneticPatternView` would re-mint the view identity each
  // tick — cascading into the k-panel's satellite-tick recomputation. Same
  // toolbar vocabulary as the refinement plot; one shared focus token, so either
  // page's "optimize view" zooms both plots onto the fit range.
  const magneticQuality = (
    <span style={{ display: "flex", gap: 14, fontFamily: themeMono, fontSize: 12.5 }}>
      <span style={{ color: theme.secondary }} title="Weighted profile R for the current parameters, colored by wR/R_exp (Toby 2006)">
        wR <b style={{ color: qualityInk(liveGof) }}>{liveWr}%</b>
      </span>
      <span style={{ color: theme.secondary }} title="Goodness of fit = wR/R_exp at the last refinement; ≈1 = consistent with the data uncertainties">
        GoF <b style={{ color: qualityInk(refinedGof) }}>{refinedGof !== null ? refinedGof.toFixed(2) : "—"}</b>
      </span>
    </span>
  );
  const magneticFitChip = fitRangeActive && !tofViewOnly
    ? {
        label: `${displayFitRange.min.toFixed(2)}–${displayFitRange.max.toFixed(2)} ${axisShortLabel(effectiveUnit)}`,
        onReset: () => setFitRange(null),
      }
    : undefined;

  function exportCsv(): void {
    downloadText(`${pattern.id}.csv`, powderPatternCsv(curves), "text/csv");
  }

  // Refined CIF / mCIF (M5): the current structure with refined values, esds
  // merged from the last result, and agreement recorded. mCIF when a magnetic
  // model with moments is present, plain CIF otherwise.
  function exportCif(): void {
    const withEsd = powderParams.map((p) => {
      const e = powderResult?.esd[p.id];
      return e !== undefined ? { ...p, esd: e } : { ...p };
    });
    const s = powderResult?.agreement.goodnessOfFit;
    const refinement: CifRefinementMeta | undefined = powderResult
      ? { rwp: Number(wRpct), ...(s !== undefined ? { gof: s } : {}), nParam: withEsd.filter((p) => !p.fixed && !p.expression).length }
      : undefined;
    const opts = { params: withEsd, bindings: pBindings, ...(refinement ? { refinement } : {}) };
    const mag = session.magnetic;
    if (mag && mag.moments.length > 0) {
      downloadText(`${structure.id}.mcif`, magneticStructureToMcif(structure, mag, opts), "chemical/x-cif");
    } else {
      downloadText(`${structure.id}.cif`, structureToCif(structure, opts), "chemical/x-cif");
    }
  }

  // A one-click cross-check bundle (.zip) for an established package: the refined
  // model + data (+ instrument + build script), assembled and zipped in-browser.
  function exportBundle(target: "fullprof" | "gsas2"): void {
    const withEsd = powderParams.map((p) => {
      const e = powderResult?.esd[p.id];
      return e !== undefined ? { ...p, esd: e } : { ...p };
    });
    const s = powderResult?.agreement.goodnessOfFit;
    const refinement: CifRefinementMeta | undefined = powderResult
      ? { rwp: Number(wRpct), ...(s !== undefined ? { gof: s } : {}), nParam: withEsd.filter((p) => !p.fixed && !p.expression).length }
      : undefined;
    const opts: BundleOptions = {
      name: structure.name || structure.id,
      params: withEsd,
      bindings: pBindings,
      ...(instrumentLoaded ? { instrument } : {}),
      ...(refinement ? { refinement } : {}),
      // The user's original files, retained verbatim on load — bundled as-is so
      // the instrument (whose model is lossy) and data are exactly what they gave.
      ...(session.rawInstrument ? { rawInstrument: session.rawInstrument } : {}),
      ...(session.rawData ? { rawData: session.rawData } : {}),
    };
    const entries = target === "fullprof" ? fullprofBundle(structure, pattern, opts) : gsas2Bundle(structure, pattern, opts);
    const base = (structure.name || structure.id).replace(/[^A-Za-z0-9._-]+/g, "_");
    downloadBlob(`${base}_${target}.zip`, zipStore(entries), "application/zip");
  }

  // Publish this engine's header exports while it is the active mode; cleared on
  // unmount (the shell's other ref serves single-crystal mode).
  useEffect(() => {
    if (active) exportsRef.current = {
      cif: exportCif,
      csv: exportCsv,
      projectJson: exportProject,
      fullprofBundle: () => exportBundle("fullprof"),
      gsas2Bundle: () => exportBundle("gsas2"),
    };
    return () => { exportsRef.current = null; };
  });

  // Summary-card content (Structure / Data / Instrument).
  const cell = structure.cell;
  const hexish = Math.abs(cell.a - cell.b) < 1e-4 && cell.gamma === 120;
  const cellStr = hexish
    ? `a ${cell.a.toFixed(5)} · c ${cell.c.toFixed(5)} Å`
    : `a ${cell.a.toFixed(4)} · b ${cell.b.toFixed(4)} · c ${cell.c.toFixed(4)} Å`;
  const isSynthetic = powderSource === SYNTHETIC_SOURCE;

  // Microstructure readout (GSAS-II-style): crystallite size + microstrain from the
  // refined Lorentzian X (size) and Y (strain), deconvoluting the instrument seed
  // (the initial X/Y from the calibration). CW (2θ) only — needs a wavelength.
  const mustrainReadout = useMemo(() => {
    // TOF isotropic Mustrain: the `mustrainIso` parameter is µstrain (×10⁻⁶)
    // directly. Deconvolute the instrument seed in *quadrature* — the TOF strain
    // is Gaussian (variances add), unlike the CW Lorentzian (breadths add).
    if (pattern.xUnit === "tof" || pattern.radiation.kind === "neutron-tof") {
      const pm = powderParams.find((p) => p.kind === "mustrainIso");
      if (!pm) return null;
      const muSample = Math.sqrt(Math.max(pm.value * pm.value - pm.initialValue * pm.initialValue, 0));
      const esdMu = powderResult?.esd?.[pm.id];
      const esdSample = esdMu !== undefined && muSample > 1e-9 ? esdMu * (pm.value / muSample) : undefined;
      return {
        sizeNm: { value: NaN }, sizeAngstrom: { value: NaN },
        strain: { value: muSample * 1e-6 },
        strainPpm: { value: muSample, ...(esdSample !== undefined ? { esd: esdSample } : {}) },
        strainPercent: { value: muSample * 1e-4 },
        sampleX: 0, sampleY: muSample, deconvoluted: true, notes: [],
      };
    }
    if (pattern.xUnit !== "twoTheta") return null;
    const px = powderParams.find((p) => p.kind === "profileX");
    const py = powderParams.find((p) => p.kind === "profileY");
    if (!px && !py) return null;
    const wavelength = pattern.radiation.wavelength;
    const xEsd = powderResult?.esd?.[px?.id ?? ""];
    const yEsd = powderResult?.esd?.[py?.id ?? ""];
    return extractSizeStrain({
      x: px?.value ?? 0,
      y: py?.value ?? 0,
      wavelength,
      ...(xEsd !== undefined ? { xEsd } : {}),
      ...(yEsd !== undefined ? { yEsd } : {}),
      instrument: { x: px?.initialValue ?? 0, y: py?.initialValue ?? 0 },
    });
  }, [powderParams, pattern.xUnit, pattern.radiation, powderResult]);
  const instParamMeta =
    instrument.kind === "tof"
      ? `difC ${instrument.difC.toFixed(1)}${instrument.difA ? ` · difA ${instrument.difA}` : ""}${instrument.difB ? ` · difB ${instrument.difB}` : ""} · Zero ${(instrument.zero ?? 0).toFixed(2)} µs`
      : `λ ${instrument.wavelength} Å${instrument.zero ? ` · Zero ${instrument.zero}°` : ""}`;
  // Instrument identity: "Beamline · Facility" when the loaded file named a known
  // beamline (the common case). Fall back to the generic mode label + calibration
  // params only when no beamline/facility is recognised.
  const instBeamline = instrumentLoaded ? instrument.name : undefined;
  const instFacility = instrumentLoaded ? instrument.facility : undefined;
  const instIdentified = !!(instBeamline || instFacility);
  const instTitle = instIdentified
    ? [instBeamline, instFacility].filter(Boolean).join(" · ")
    : instrument.kind === "tof" ? "Time-of-flight" : "Constant wavelength";
  // Title carries the identity ("Beamline · Facility" or the mode); the meta line
  // always shows the key calibration actually loaded — the wavelength for CW
  // (e.g. 11-BM's λ 0.413909 Å), difC/Zero for TOF.
  const instMeta = instParamMeta;
  const summaryCards: SummaryCardData[] = [
    {
      label: "Structure",
      help: "Load a crystal structure from a CIF. Up to two phases are supported — load a second CIF to add an impurity or secondary phase.",
      loadLabel: ownStructure ? "Add CIF…" : "Load CIF…",
      accept: ".cif,text/plain",
      onFile: ownStructure ? onAddPhase : onLoadCif,
      muted: !hasContent,
      chip: session.extraPhases.length > 0 ? `✓ ${session.extraPhases.length + 1} phases` : "✓ parsed",
      title: !hasContent
        ? "No structure loaded"
        : session.extraPhases.length > 0
        ? `${structure.name} + ${session.extraPhases.map((p) => p.name).join(" + ")}`
        : `${structure.name}${structure.spaceGroup.hermannMauguin ? ` · ${structure.spaceGroup.hermannMauguin}` : ""}`,
      meta: !hasContent
        ? "Load a CIF to begin, or pick a demo"
        : session.extraPhases.length > 0
        ? [structure, ...session.extraPhases].map((p) => `${p.name} ${p.spaceGroup.hermannMauguin ?? ""}`.trim()).join(" · ")
        : `${cellStr} · V ${cellVolume(structure.cell).toFixed(2)} Å³ · ${structure.sites.length} sites`,
      ...(session.extraPhases.length > 0
        ? {
            // Badge every phase; the primary is the base (no ×), extras are removable.
            phaseBadges: [
              { id: structure.id, label: structure.name || "phase 1", removable: false },
              ...session.extraPhases.map((p) => ({ id: p.id, label: p.name || p.id, removable: true })),
            ],
            onRemovePhase,
          }
        : {}),
      // Once the user has loaded their own structure(s), offer a one-click reset
      // back to the bundled example (the app always needs a structure loaded).
      ...(ownStructure
        ? { headerControl: <button style={clearStructuresBtn} onClick={onClearStructures} title="Remove all loaded structures and reset to the bundled example">Clear</button> }
        : {}),
    },
    {
      label: "Data",
      help: "Loads most powder and single-crystal formats from the major facilities (POWGEN/GSAS, FullProf, ILL, .xye, .hkl, …). If your file isn't recognized, contact the author.",
      loadLabel: "Load data…", accept: ".xye,.xy,.dat,.txt,.gr,.hkl,.int,.csv,.gsa,.gss,.fxye,text/plain", onFile: onLoadData,
      muted: !hasContent,
      chip: isSynthetic ? "⚠ synthetic" : "✓ loaded",
      chipTone: isSynthetic ? "warn" : "ok",
      title: !hasContent ? "No data loaded" : isSynthetic ? "Synthetic demo pattern" : powderSource,
      meta: !hasContent
        ? "Powder or single crystal"
        : `${pattern.points.length} points · ${UNIT_LABEL[pattern.xUnit]} ${patternExtent.min.toFixed(0)}–${patternExtent.max.toFixed(0)}`,
    },
    {
      label: "Instrument",
      help: "Loads instrument files from the major facilities — GSAS-II .instprm, GSAS .prm, FullProf .irf. If your file isn't recognized, contact the author.",
      loadLabel: "Load instrument…", accept: ".instprm,.prm,.irf,text/plain", onFile: onLoadInstrument,
      muted: !hasContent && !instrumentLoaded,
      chip: instrumentLoaded ? "✓ loaded" : "default",
      title: !hasContent && !instrumentLoaded ? "No instrument loaded" : instTitle,
      meta: !hasContent && !instrumentLoaded ? "Load .instprm / .prm / .irf" : instMeta,
    },
  ];

  // Clean start: show the workbench chrome (the load cards) with an empty-state
  // where the plot/parameters go, until a structure + data are loaded.
  if (!hasContent) {
    return (
      <main className="wb-main" style={{ flex: 1, display: active ? undefined : "none" }}>
        <SummaryCards cards={summaryCards} />
        <EmptyWorkbench {...(onLoadDemo ? { onLoadDemo } : {})} />
      </main>
    );
  }

  return (
    // Both step panels stay mounted; tabs only toggle visibility, so the
    // magnetic-analysis state (k, framework, group/irrep picks) survives
    // switching to the refinement page and back — and the whole engine stays
    // mounted (hidden) in single-crystal mode so nothing here resets.
    <>
      <main className="wb-main" style={{ flex: 1, display: active && step === 0 ? undefined : "none" }}>
        {renderStep(0)}
      </main>
      <main className="wb-main" style={{ flex: 1, display: active && step === 1 ? undefined : "none" }}>
        {renderStep(1)}
      </main>
    </>
  );

  function renderStep(which: number): JSX.Element {
    switch (which) {
      case 0: // Setup & refinement: quality rail | plot | parameter panel.
        return (
          <>
            <SummaryCards cards={summaryCards} />
            <div className="wb-work2">
              <div style={{ ...themeCard, padding: "16px 18px", display: "flex", flexDirection: "column", height: "clamp(500px, 66vh, 900px)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={themeLabel}>
                    {plotMode === "structure" ? "Crystal structure — unit cell" : plotMode === "validation" ? "Validation plots" : "Powder pattern"}
                  </span>
                  {plotMode !== "structure" && (
                    <span style={{ display: "flex", gap: 14, fontFamily: themeMono, fontSize: 12.5 }}>
                      <span style={{ color: theme.secondary }} title="Weighted profile R for the current parameters, colored by wR/R_exp (Toby 2006)">
                        wR <b style={{ color: qualityInk(liveGof) }}>{liveWr}%</b>
                      </span>
                      <span style={{ color: theme.secondary }} title="Goodness of fit = wR/R_exp at the last refinement; ≈1 = consistent with the data uncertainties">
                        GoF <b style={{ color: qualityInk(refinedGof) }}>{refinedGof !== null ? refinedGof.toFixed(2) : "—"}</b>
                      </span>
                    </span>
                  )}
                  {plotMode === "curves" && !tofViewOnly && fitRangeActive && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: themeMono, fontSize: 12, color: theme.secondary }} title="The data range used for refinement (set with the blue handles)">
                      fit {displayFitRange.min.toFixed(2)}–{displayFitRange.max.toFixed(2)} {axisShortLabel(effectiveUnit)}
                      <button style={resetRangeBtn} onClick={() => setFitRange(null)} title="Refine over the full pattern again">Reset range</button>
                    </span>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, rowGap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {plotMode === "curves" && (
                      <AxisUnitToggle units={displayUnits} value={effectiveUnit} onChange={setDisplayUnit} />
                    )}
                    {plotMode === "curves" && !tofViewOnly && (
                      <button
                        style={{ ...toolbarBtn, display: "inline-flex", alignItems: "center", gap: 5, ...(fitRangeActive ? {} : { opacity: 0.45, cursor: "default" }) }}
                        disabled={!fitRangeActive}
                        title={fitRangeActive
                          ? "Zoom the plot onto the active fit range"
                          : "Set a fit range first (blue handles), then this zooms the view onto it"}
                        onClick={() => setFocusFitToken((t) => t + 1)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        optimize view
                      </button>
                    )}
                    <ViewModeToggle value={plotMode} onChange={setPlotMode} />
                  </div>
                </div>
                {plotMode === "structure" ? (() => {
                  // Multi-phase: a phase picker chooses which unit cell to show.
                  // Use the REFINED phases (parameters applied: cell, positions,
                  // ADPs) so the 3D model tracks the refinement — not the loaded
                  // starting structure. refinedPhases matches [structure,
                  // ...extraPhases] in order/id, so the phase picker is unchanged.
                  const allPhases = refinedPhases;
                  const vIdx = Math.min(viewPhaseIdx, allPhases.length - 1);
                  const viewStructure = allPhases[vIdx]!;
                  const isPrimary = vIdx === 0;
                  return (
                  <>
                    {session.extraPhases.length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 12, color: theme.secondary, fontFamily: themeMono }}>
                        Phase
                        <span style={{ display: "inline-flex", border: `1px solid ${theme.border}`, borderRadius: 6, overflow: "hidden" }}>
                          {allPhases.map((ph, i) => (
                            <button
                              key={ph.id}
                              onClick={() => setViewPhaseIdx(i)}
                              style={{ border: "none", padding: "1px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer", background: i === vIdx ? theme.primary : "#fff", color: i === vIdx ? "#fff" : theme.ink }}
                            >
                              {ph.name || `phase ${i + 1}`}
                            </button>
                          ))}
                        </span>
                      </div>
                    )}
                    <Suspense fallback={<div style={{ flex: 1, minHeight: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>Loading 3D viewer…</div>}>
                      <StructureView
                        key={viewStructure.id}
                        structure={viewStructure}
                        {...(isPrimary && sessionMoments ? { moments: sessionMoments } : {})}
                        {...(isPrimary && session.magnetic?.propagation[0] ? { propagation: session.magnetic.propagation[0] } : {})}
                        {...(isPrimary && session.magnetic?.operations ? { magneticOperations: session.magnetic.operations } : {})}
                      />
                    </Suspense>
                    <p style={{ marginTop: 8, fontSize: 12, color: theme.secondary }}>
                      {viewStructure.name || "Structure"}
                      {viewStructure.spaceGroup.hermannMauguin ? ` · ${viewStructure.spaceGroup.hermannMauguin}` : ""}
                      {` · ${viewStructure.sites.length} site${viewStructure.sites.length === 1 ? "" : "s"} · drag to rotate, scroll to zoom.`}
                    </p>
                  </>
                  );
                })() : plotMode === "validation" ? (
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                    <QualityPanel
                      structure={structure}
                      extraPhases={session.extraPhases}
                      pattern={pattern}
                      params={powderParams}
                      bindings={pBindings}
                      profile={session.powderProfile}
                      magnetic={session.magnetic ?? null}
                      onHighlight={setHighlight}
                      selected={highlight}
                      onLocate={(row) => {
                        setHighlight({ hkl: `${row.h} ${row.k} ${row.l}`, kind: row.kind, ...(row.phaseId !== undefined ? { phaseId: row.phaseId } : {}) });
                        setPlotMode("curves");
                        setFocusPeakToken((t) => t + 1);
                      }}
                      fitRange={fitRangeActive ? { min: fitRange!.min, max: fitRange!.max } : null}
                    />
                  </div>
                ) : (
                  <>
                    <WorkbenchPlot
                      curves={plotCurves}
                      xLabel={displayXLabel}
                      fitRange={displayFitRange}
                      phases={phaseTicks}
                      focusFitToken={focusFitToken}
                      focusPeakToken={focusPeakToken}
                      highlight={highlight}
                      onHighlight={setHighlight}
                      {...(tofViewOnly ? {} : { onFitRangeChange: setFitRangeFromDisplay })}
                    />
                    <p style={{ marginTop: 8, fontSize: 12, color: theme.secondary }}>
                      {tofViewOnly
                        ? session.powderOverlay
                          ? "Observed (points) with GSAS-II fit overlay."
                          : "Observed TOF pattern — view-only (load a TOF instrument with difC to refine)."
                        : "Drag across the plot to zoom, blue handles to set the fit range."}
                    </p>
                    {!tofViewOnly && mustrainReadout && (mustrainReadout.strainPpm.value > 0 || mustrainReadout.sampleY !== 0) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 14, rowGap: 5, marginTop: 6, fontSize: 12, color: theme.secondary, fontFamily: themeMono, flexWrap: "wrap" }} title="Derived from the refined Lorentzian X (size) and Y (microstrain), with the instrument seed deconvoluted (GSAS-II microstrain = LY·π/72000·10⁶ ppm).">
                        <span style={themeLabel}>Microstructure</span>
                        <span>microstrain ≈ <b style={{ color: theme.ink }}>{mustrainReadout.strainPpm.value.toFixed(0)}</b>×10⁻⁶ ({mustrainReadout.strainPercent.value.toFixed(3)}%)
                          {mustrainReadout.strainPpm.esd !== undefined ? ` ± ${mustrainReadout.strainPpm.esd.toFixed(0)}` : ""}</span>
                        {Number.isFinite(mustrainReadout.sizeNm.value) && mustrainReadout.sizeNm.value > 0 && (
                          <span>size ≈ <b style={{ color: theme.ink }}>{mustrainReadout.sizeNm.value.toFixed(0)}</b> nm</span>
                        )}
                      </div>
                    )}
                    {!tofViewOnly && hasSharedSite && (
                      <div style={{ display: "flex", alignItems: "center", gap: 12, rowGap: 5, marginTop: 6, fontSize: 12, color: theme.secondary, flexWrap: "wrap" }}>
                        <span style={{ ...themeLabel, marginRight: 2 }} title="Atoms sharing one crystallographic site (occupancy disorder)">Shared site</span>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                          <input type="checkbox" checked={session.siteTies.positions ?? true} onChange={(e) => setSiteTies({ positions: e.target.checked })} />
                          tie position
                        </label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                          <input type="checkbox" checked={session.siteTies.adp ?? true} onChange={(e) => setSiteTies({ adp: e.target.checked })} />
                          tie ADP
                        </label>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="Constrain the total occupancy of the shared site to 1 (fully occupied)">
                          <input type="checkbox" checked={session.siteTies.occupancyToUnity ?? false} onChange={(e) => setSiteTies({ occupancyToUnity: e.target.checked })} />
                          Σ occ = 1
                        </label>
                      </div>
                    )}
                  </>
                )}
              </div>
              <ParameterPanel
                params={powderParams}
                esd={powderResult?.esd}
                onChange={patchPowder}
                onRefine={() => runPowder(false)}
                onThorough={() => runThorough()}
                thoroughMode={powderResult ? "escape" as const : "prefit" as const}
                onCancel={cancelPowder}
                onReset={resetPowderParams}
                onMagnetic={() => {
                  onStep(1);
                  setMessage("Refined structure passed to the magnetic symmetry analysis — k-search and symmetry now use the current parameter values.");
                }}
                busy={busy}
                result={powderResult}
                disabled={tofViewOnly}
                groupControls={tofViewOnly ? undefined : {
                  "Background": (
                    <>
                      <span style={themeLabel}>function</span>
                      <select value={session.powderProfile.backgroundType ?? "chebyshev"} onChange={(e) => setBackgroundType(e.target.value as BackgroundType)} style={bgSelect}>
                        <option value="chebyshev">Chebyshev</option>
                        <option value="cosine">Cosine (Fourier)</option>
                        <option value="powerSeries">Power series</option>
                        <option value="linInterpolate">Linear interpolate</option>
                        <option value="logInterpolate">Log interpolate</option>
                      </select>
                      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        terms
                        <input type="number" min={1} max={24} step={1} value={session.backgroundTerms} onChange={(e) => setBackgroundTerms(Number(e.target.value))} style={bgTermsInput} />
                      </label>
                    </>
                  ),
                  "ADPs (thermal)": (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }} title="Refine the anisotropic U tensor. Each site's U is seeded from its current B_iso; symmetry fixes which components are free. Turn on after an isotropic fit converges.">
                      <input type="checkbox" checked={session.anisotropicAdp ?? false} onChange={(e) => setAnisotropicAdp(e.target.checked)} />
                      anisotropic (U tensor)
                    </label>
                  ),
                  "Microstructure": (
                    <>
                      <span style={themeLabel}>model</span>
                      <select
                        value={session.mustrain ?? "isotropic"}
                        onChange={(e) => setMustrain(e.target.value as MustrainModel)}
                        style={bgSelect}
                        title="Isotropic uses the Lorentzian Y (always present); uniaxial and generalized add anisotropic microstrain rows — free them or run guided after the isotropic profile converges."
                      >
                        <option value="isotropic">isotropic</option>
                        {session.pattern.xUnit === "twoTheta" && <option value="uniaxial">uniaxial</option>}
                        <option value="generalized">generalized</option>
                      </select>
                    </>
                  ),
                }}
              />
            </div>
          </>
        );
      case 1:
        return (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "2px 4px 0" }}>
              <h2 style={{ ...h2, margin: 0, fontSize: 15 }}>Magnetic symmetry analysis</h2>
              <span style={{ fontSize: 12.5, color: theme.secondary, fontFamily: themeMono }}>
                {structure.name || "structure"}
                {structure.spaceGroup.hermannMauguin ? ` · ${structure.spaceGroup.hermannMauguin}` : ""}
                {" · refined values"}
              </span>
              <InfoBadge
                width={320}
                text="Commensurate single-k workflow on the refined atomic structure: pick the magnetic ion(s), set or search the propagation vector k, choose a symmetry framework, select a magnetic space group, then preview and refine its symmetry-allowed moments. “Continue in refinement page” fits nuclear + magnetic together. The pattern and 3D model on the left update live as you click candidates."
              />
            </div>
            <KSearchPanel
              structure={refinedStructure}
              fitStructure={structure}
              extraPhases={session.extraPhases.map((s) => ({ structure: s, id: s.id }))}
              residualPeaks={residualPeaks}
              onAddManualPeak={addManualPeak}
              onRemoveManualPeak={removeManualPeak}
              pattern={pattern}
              {...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {})}
              {...(magneticPatternView ? { patternView: magneticPatternView } : {})}
              patternQuality={magneticQuality}
              {...(magneticFitChip ? { patternFitChip: magneticFitChip } : {})}
              {...(tofViewOnly ? {} : { onFocusFit: () => setFocusFitToken((t) => t + 1) })}
              focusFitToken={focusFitToken}
              nuclearParams={powderParams}
              nuclearBindings={pBindings}
              profile={session.powderProfile}
              onContinue={continueRefinementWithMagnetic}
            />
          </div>
        );
      default:
        return <div />;
    }
  }
}

/**
 * Judge a fit by wR relative to R_exp — the ratio *is* the GoF (Toby 2006,
 * "R factors in Rietveld analysis", Powder Diffr. 21, 67: the absolute wR
 * depends on background and counting statistics; only the comparison with
 * R_exp is meaningful). Bands: ≈1–1.5 good (green), 1.5–2.5 mediocre (amber),
 * > 2.5 poor (red); below 1 the σ's are overestimated or the fit is
 * over-parameterized (amber, not green — "too good" is a warning).
 */
function qualityInk(gof: number | null): string {
  if (gof === null || !Number.isFinite(gof)) return theme.secondary;
  if (gof < 1) return theme.noteInk;
  if (gof <= 1.5) return theme.okInk;
  if (gof <= 2.5) return theme.noteInk;
  return theme.warnInk;
}

function QualityPanel({
  structure,
  extraPhases,
  pattern,
  params,
  bindings,
  profile,
  magnetic,
  onHighlight,
  selected,
  onLocate,
  fitRange,
}: {
  structure: StructureModel;
  /** Secondary crystallographic phases — decomposed alongside the primary so an
   *  overlapping impurity peak's counts are not credited to the primary phase. */
  extraPhases?: readonly StructureModel[];
  pattern: PowderPattern;
  params: readonly RefinementParameter[];
  bindings: readonly ParameterBinding[];
  profile: PowderProfile;
  /** Magnetic model, if any — adds magnetic satellites to the F_obs/F_calc plot. */
  magnetic?: MagneticModel | null;
  /** Spotlight a reflection (its "h k l" + kind + phase) in the pattern plot; null clears it. */
  onHighlight?: (sel: { hkl: string; kind: "nuclear" | "magnetic"; phaseId?: string } | null) => void;
  /** The shared selection, so a Bragg-tick click highlights the matching scatter point. */
  selected?: { hkl: string; kind: "nuclear" | "magnetic"; phaseId?: string } | null;
  /** Jump to a reflection's peak in the observed pattern (from the F_obs/F_calc plot). */
  onLocate?: (row: ReflectionObsCalc) => void;
  /** Active fit window (pattern x-unit); reflections outside it are hidden from the scatter. */
  fitRange?: { min: number; max: number } | null;
}): JSX.Element {
  // Validation plots (Rietveld obs/calc + normal probability) for the current fit.
  const phasesKey = (extraPhases ?? []).map((p) => p.id).join(",");
  const diagnostics = useMemo(() => {
    const extras = extraPhases ?? [];
    const obsCalc = powderReflectionObsCalc(structure, pattern, params, bindings, profile, magnetic ?? null, fitRange ?? null, extras);
    // Residuals for the normal-probability plot use the *total* calculated
    // pattern, so with impurity phases present it sums every phase (else the
    // missing impurity peaks would read as large false residuals).
    const curves = extras.length > 0
      ? multiPhaseCurves([{ structure, id: structure.id }, ...extras.map((s) => ({ structure: s, id: s.id }))], pattern, params, bindings, profile)
      : powderCurves(structure, pattern, params, bindings, profile);
    const sigmas = pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1));
    const npp = normalProbabilityPlot(weightedResiduals(curves.yObs, curves.yCalc, sigmas));
    return { obsCalc, npp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, phasesKey, pattern, params, bindings, profile, magnetic, fitRange?.min, fitRange?.max]);

  // Rendered inside the pattern-plot card's "Validation" view mode; the toggle
  // labels it, so no heading here — just the plots side by side.
  return (
    <div>
      <QualityPlots obsCalc={diagnostics.obsCalc} npp={diagnostics.npp} selected={selected ?? null} {...(onHighlight ? { onHighlight } : {})} {...(onLocate ? { onLocate } : {})} />
      <p style={{ fontSize: fz.micro, color: theme.secondary, marginTop: 8 }}>
        F_obs vs F_calc flags individual bad reflections; the normal probability plot
        (Abrahams &amp; Keve 1971) is straight with slope 1 for an ideal fit &amp; weights.
      </p>
    </div>
  );
}

function AxisUnitToggle({
  units,
  value,
  onChange,
}: {
  units: readonly DisplayUnit[];
  value: DisplayUnit;
  onChange: (u: DisplayUnit) => void;
}): JSX.Element | null {
  if (units.length <= 1) return null;
  return (
    <div style={{ display: "inline-flex", gap: 2, background: theme.chipBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 2 }}>
      {units.map((u) => (
        <button
          key={u}
          onClick={() => onChange(u)}
          title={axisLabel(u)}
          style={{
            border: "none",
            borderRadius: 6,
            padding: "3px 11px",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: themeMono,
            background: u === value ? theme.primary : "transparent",
            color: u === value ? "#fff" : theme.secondary,
          }}
        >
          {axisShortLabel(u)}
        </button>
      ))}
    </div>
  );
}

function ViewModeToggle({
  value,
  onChange,
}: {
  value: "curves" | "structure" | "validation";
  onChange: (m: "curves" | "structure" | "validation") => void;
}): JSX.Element {
  const opts: readonly { id: "curves" | "structure" | "validation"; label: string; title: string }[] = [
    { id: "curves", label: "Refinement", title: "Observed vs calculated pattern" },
    { id: "validation", label: "Validation", title: "F_obs vs F_calc + normal-probability plot" },
    { id: "structure", label: "3D Model", title: "3D crystal-structure model" },
  ];
  return (
    <div style={{ display: "inline-flex", gap: 2, background: theme.chipBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 2 }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          title={o.title}
          style={{
            border: "none",
            borderRadius: 6,
            padding: "3px 11px",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: themeMono,
            background: o.id === value ? theme.primary : "transparent",
            color: o.id === value ? "#fff" : theme.secondary,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const h2: React.CSSProperties = { margin: "0 0 12px", fontSize: 16, fontWeight: 700, color: theme.ink };
const clearStructuresBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "3px 10px", fontSize: 11.5, color: theme.secondary, cursor: "pointer" };
const bgSelect: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "2px 6px", fontSize: 12, color: theme.ink, cursor: "pointer" };
const bgTermsInput: React.CSSProperties = { width: 44, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "2px 6px", fontSize: 12, fontFamily: themeMono };

/** Empty-state panel shown in place of the plot/parameters on a clean start.
 *  The two converged demos (one per technique, matching the header chips) are
 *  the visual focus; the load cards above handle the user's own files. */
function EmptyWorkbench({ onLoadDemo }: { onLoadDemo?: (kind: "rietveld" | "pdf") => void }): JSX.Element {
  return (
    <div style={{ ...themeCard, padding: "clamp(36px, 9vh, 96px) 24px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12 }}>
      <div style={{ fontSize: fz.title, fontWeight: 650, color: theme.ink, letterSpacing: "-0.01em" }}>Start with a demo</div>
      <p style={{ margin: 0, maxWidth: 460, fontSize: fz.small, lineHeight: 1.55, color: theme.secondary }}>
        Each opens a converged refinement — or load your own CIF and data above; the
        app routes to the right technique automatically.
      </p>
      {onLoadDemo && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: 8 }}>
          <DemoCard
            kicker="Rietveld · reciprocal space"
            title="Mn₃Ga neutron TOF"
            blurb="Two-phase POWGEN fit with a refined magnetic structure · wR 3.9%"
            onClick={() => onLoadDemo("rietveld")}
          />
          <DemoCard
            kicker="PDF · real space"
            title="GaTa₄Se₈ X-ray G(r)"
            blurb="Synchrotron total-scattering fit at 299 K · Rw 8.1%"
            onClick={() => onLoadDemo("pdf")}
          />
        </div>
      )}
    </div>
  );
}

function DemoCard({ kicker, title, blurb, onClick }: { kicker: string; title: string; blurb: string; onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 290,
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "18px 20px",
        borderRadius: 12,
        border: `1.5px solid ${hover ? theme.primary : theme.control}`,
        background: hover ? theme.primaryTintBg : "#fff",
        boxShadow: hover ? "0 4px 14px rgba(31,79,216,0.12)" : "0 1px 4px rgba(25,23,20,0.05)",
        cursor: "pointer",
        transition: "border-color 120ms, background 120ms, box-shadow 120ms",
      }}
    >
      <span style={{ fontFamily: themeMono, fontSize: fz.micro, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: hover ? theme.primary : theme.faint }}>{kicker}</span>
      <span style={{ fontSize: fz.large, fontWeight: 650, color: theme.ink }}>{title}</span>
      <span style={{ fontSize: fz.small, lineHeight: 1.45, color: theme.secondary }}>{blurb}</span>
    </button>
  );
}
