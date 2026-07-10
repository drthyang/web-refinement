import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APP_VERSION, PROJECT_SCHEMA_VERSION } from "@/app/constants";
import { downloadText } from "@/app/download";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ProjectFile } from "@/core/project/types";
import { cellVolume } from "@/core/crystal/unitCell";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import { magneticPowderComponents, buildMagneticPowderProblem } from "@/core/workflow/magneticPowder";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { refine } from "@/core/refinement/engine";
import type { PeakShape } from "@/core/diffraction/profile";
import type { BackgroundType } from "@/core/diffraction/background";
import { extractSizeStrain } from "@/core/diffraction/microstructure";
import { buildPowderSpec, guidedPowderParams, type SiteTies, type PowderSpec, type MustrainModel } from "@/app/powderSpec";
import { buildMultiPhaseSpec } from "@/app/multiPhaseSpec";
import { multiPhaseCurves } from "@/core/workflow/multiPhase";
import { DEFAULT_STAGE_KINDS, siteGroups } from "@/core/workflow/structureRefinement";
import { powderPatternCsv, projectJson } from "@/core/export/exporters";
import { structureToCif, magneticStructureToMcif, type CifRefinementMeta } from "@/core/export/cif";
import { parseMagneticCif, parseCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parseIllD1b, looksLikeIllD1b } from "@/parsers/illPowder";
import { parseFullProfInstrm6, looksLikeInstrm6 } from "@/parsers/fullprofInstrm6";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";
import { isGsasHistogram, parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { detectDataFormat, type DetectedFormat } from "@/parsers/detectFormat";
import type { ParameterBinding } from "@/core/refinement/types";
import { isMomentParameterKind } from "@/core/refinement/types";
import { startingPowderParams, loadReflectionDataset } from "@/app/loadData";
import { SingleCrystalWorkbench } from "@/app/SingleCrystalWorkbench";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import { ComputeClient } from "@/workers/computeClient";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { KSearchPanel } from "@/components/KSearchPanel";
import { withAdpModel } from "@/core/crystal/adp";
import { momentEntriesFrom } from "@/app/ui/cellModel";
import { detectExtraPeaks } from "@/core/magnetic/extraPeaks";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";
import { normalProbabilityPlot, weightedResiduals } from "@/core/refinement/diagnostics";
import { QualityPlots } from "@/app/ui/QualityPlots";
import type { MagneticModel } from "@/core/magnetic/types";
import { buildSyntheticPowder, powderBindings } from "@/examples/synthetic";
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
import { WorkbenchHeader, type Step } from "@/app/ui/WorkbenchHeader";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { WorkbenchPlot, type FitRangeSelection } from "@/app/ui/WorkbenchPlot";
// Lazy so three.js (~550 kB) only loads when the user opens the 3D view.
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { color as theme, card as themeCard, uppercaseLabel as themeLabel, mono as themeMono, fz } from "@/app/theme";
import { applyParameters } from "@/core/workflow/apply";
import { excludedPointMask } from "@/core/refinement/factors";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { parseInstrumentParameters } from "@/parsers/instrument";

const STEPS: readonly Step[] = [
  { num: "1", label: "Refinement" },
  { num: "2", label: "Magnetic" },
];

const DEFAULT_INSTRUMENT: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };
const DEFAULT_BACKGROUND_TERMS = 4;
const DEFAULT_TIES: SiteTies = { positions: true, adp: true };

interface Session {
  structure: StructureModel;
  /** Additional crystallographic phases (multi-phase refinement). `structure` is
   *  phase 0; each extra phase adds its own scale/cell/atoms, sharing the
   *  instrument profile. Empty for a single-phase refinement. */
  extraPhases: StructureModel[];
  pattern: PowderPattern;
  powderParams: RefinementParameter[];
  /** Bindings that map the powder parameters onto the model (from buildPowderSpec). */
  powderBindings: ParameterBinding[];
  /** Peak-shape / Lorentz / background settings for display and refinement. */
  powderProfile: PowderProfile;
  /** Number of Chebyshev background coefficients in the powder model. */
  backgroundTerms: number;
  /** Tie position/ADP of atoms sharing a crystallographic site (disorder). */
  siteTies: SiteTies;
  /** Refine anisotropic (U tensor) rather than isotropic (B_iso) ADPs. */
  anisotropicAdp?: boolean;
  /** Sample microstrain (Mustrain) model: isotropic | uniaxial | generalized. */
  mustrain?: MustrainModel;
  /** GSAS-II's own calc/background overlay for a view-only (TOF) pattern. */
  powderOverlay?: { calc: number[]; background: number[] } | null;
  /** Provenance of the observed data driving the refinement. */
  powderSource: string;
  /** Optional magnetic model over `structure`, for magnetic reflection ticks. */
  magnetic?: MagneticModel;
}

const SYNTHETIC_SOURCE = "synthetic (self-consistent demo)";
const UNIT_LABEL: Record<string, string> = { twoTheta: "2θ", q: "Q (Å⁻¹)", dSpacing: "d (Å)", tof: "TOF (µs)" };

function newSession(structure: StructureModel, instrument: InstrumentParameters = DEFAULT_INSTRUMENT): Session {
  const pattern = buildSyntheticPowder(structure);
  const spec = buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES);
  return {
    structure,
    extraPhases: [],
    pattern,
    powderParams: spec.params,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    siteTies: DEFAULT_TIES,
    powderSource: SYNTHETIC_SOURCE,
  };
}

/**
 * Session for a real loaded dataset (CW or TOF). `buildPowderSpec` seeds the
 * full symmetry-allowed parameter set — for TOF that includes the back-to-back-
 * exponential profile (α/β/σ) plus fixed diffractometer constants — and
 * estimates the scale from the observed counts.
 */
/** Build the powder spec for a session, branching to the multi-phase builder when
 *  the session carries extra phases (so every rebuild preserves all phases). */
function buildSpecFor(structure: StructureModel, extraPhases: readonly StructureModel[], pattern: PowderPattern, instrument: InstrumentParameters, lorentz: boolean, backgroundTerms: number, ties: SiteTies, mustrain: MustrainModel): PowderSpec {
  return extraPhases.length > 0
    ? buildMultiPhaseSpec([structure, ...extraPhases], pattern, instrument, backgroundTerms, ties, mustrain)
    : buildPowderSpec(structure, pattern, instrument, lorentz, backgroundTerms, ties, mustrain);
}

function loadedSession(structure: StructureModel, pattern: PowderPattern, instrument: InstrumentParameters, extraPhases: StructureModel[] = []): Session {
  const spec = extraPhases.length > 0
    ? buildMultiPhaseSpec([structure, ...extraPhases], pattern, instrument, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES)
    : buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES);
  return {
    structure,
    extraPhases,
    pattern,
    powderParams: spec.params,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    siteTies: DEFAULT_TIES,
    powderOverlay: null,
    powderSource: pattern.name,
  };
}

export function App(): JSX.Element {
  // The bundled Mn₃Ga POWGEN 600 K TOF dataset (published) is the default the
  // workbench opens with — embedded in the build, so it works on the deployed
  // site with no runtime fetch or local data/ folder.
  const example = mn3gaPowgenExample();
  const [session, setSession] = useState<Session>(() => loadedSession(example.structure, example.pattern, example.instrument, example.extraPhases));
  const [powderResult, setPowderResult] = useState<RefinementResult | null>(null);
  // Single-crystal mode: set when hkl/fcf reflection data is loaded; the app
  // then renders the single-crystal workbench instead of the powder panels.
  // Cleared when powder data is loaded (auto-switch back).
  const [scDataset, setScDataset] = useState<SingleCrystalDataset | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  // Incremented by the toolbar "⊡ Fit range" button; the plot zooms onto the
  // active fit window when it changes.
  const [focusFitToken, setFocusFitToken] = useState(0);
  // Optional refinement window; null = fit the full pattern. Reset when the
  // observed pattern changes (see effect below).
  const [fitRange, setFitRange] = useState<FitRangeSelection | null>(null);
  // Display-only x-axis unit; null = the pattern's native unit. Reset on load.
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit | null>(null);
  const [plotMode, setPlotMode] = useState<"curves" | "structure" | "validation">("curves");
  // Reflection clicked in the F_obs/F_calc plot, spotlighted in the pattern
  // plot; null = nothing highlighted.
  const [highlight, setHighlight] = useState<{ hkl: string; kind: "nuclear" | "magnetic"; phaseId?: string } | null>(null);
  const [instrument, setInstrument] = useState<InstrumentParameters>(example.instrument);
  const [instrumentLoaded, setInstrumentLoaded] = useState(true);
  // Once the user has loaded their own primary structure (replacing the bundled
  // example), the Structure card's load button becomes "Add CIF…" and appends a
  // phase instead of replacing — the multi-phase entry point.
  const [ownStructure, setOwnStructure] = useState(false);
  // Which phase the 3D model shows (0 = primary structure, 1.. = extra phases).
  const [viewPhaseIdx, setViewPhaseIdx] = useState(0);
  // The status bar under the header is gone (results and diagnostics live in
  // the parameter panel / quality rail); status texts go to the console so
  // load/refine errors are still traceable.
  const setMessage = useCallback((text: string): void => {
    console.info(`[status] ${text}`);
  }, []);
  const client = useRef<ComputeClient>(new ComputeClient());

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

  // Structure with the CURRENT parameter values applied (lattice, positions,
  // occupancies, ADPs) — what the magnetic symmetry analysis works on, so a
  // refined cell feeds the k-search and little-group machinery directly.
  const refinedStructure = useMemo(() => {
    const values: Record<string, number> = {};
    for (const p of powderParams) values[p.id] = p.value;
    return applyParameters(structure, pBindings, values).model;
  }, [structure, powderParams, pBindings]);

  const curves = useMemo(() => {
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
      return multiPhaseCurves(phases, pattern, powderParams, pBindings, session.powderProfile);
    }
    const nuclear = powderCurves(structure, pattern, powderParams, pBindings, session.powderProfile);
    // When a magnetic model has been applied, add its contribution (satellites at
    // G ± k) on top of the nuclear calc so the refinement plot shows the total.
    if (session.magnetic && session.magnetic.moments.length > 0) {
      const comp = magneticPowderComponents(structure, session.magnetic, pattern, powderParams, pBindings, {
        shape: session.powderProfile.shape,
        ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
      });
      const yCalc = nuclear.yCalc.map((v, i) => v + (comp.yMagnetic[i] ?? 0));
      return { ...nuclear, yCalc, diff: nuclear.yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
    }
    return nuclear;
  }, [structure, pattern, powderParams, pBindings, session.powderProfile, powderIsTof, session.powderOverlay, session.magnetic]);
  // Full pattern extent; the plot handles default to this until the user drags.
  const patternExtent = useMemo<FitRangeSelection>(() => {
    const xs = curves.x;
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
  const magneticPeakD = useMemo<number[]>(() => {
    if (!displayUnits.includes("dSpacing")) return [];
    const dArr = pattern.xUnit === "dSpacing"
      ? curves.x
      : convertAxisArray(curves.x, pattern.xUnit, "dSpacing", axisCtx);
    return detectExtraPeaks(dArr, curves.yObs, curves.yCalc).map((p) => p.d);
  }, [curves, pattern.xUnit, axisCtx, displayUnits]);
  const effectiveUnit: DisplayUnit = displayUnit ?? pattern.xUnit;
  const displayCurves = useMemo(
    () => (effectiveUnit === pattern.xUnit ? curves : { ...curves, x: convertAxisArray(curves.x, pattern.xUnit, effectiveUnit, axisCtx) }),
    [curves, effectiveUnit, pattern.xUnit, axisCtx],
  );
  // During a refinement, overlay the live per-cycle calculated curve (streamed
  // from the worker) onto the plot so it animates toward convergence.
  const plotCurves = useMemo(() => {
    const lp = livePreview.current;
    if (busy !== "powder" || !lp || lp.yCalc.length !== displayCurves.yObs.length) return displayCurves;
    return { ...displayCurves, yCalc: lp.yCalc, diff: displayCurves.yObs.map((o, i) => o - (lp.yCalc[i] ?? 0)) };
    // liveTick bumps each animation frame to pull the latest ref value.
  }, [displayCurves, busy, liveTick]);
  const displayXLabel = axisLabel(effectiveUnit);
  // Fit-range handles live in display space; convert to/from the native window.
  const displayFitRange = useMemo(
    () => convertInterval(effectiveFitRange, pattern.xUnit, effectiveUnit, axisCtx),
    [effectiveFitRange, pattern.xUnit, effectiveUnit, axisCtx],
  );
  const setFitRangeFromDisplay = (r: FitRangeSelection): void =>
    setFitRange(convertInterval(r, effectiveUnit, pattern.xUnit, axisCtx));

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
    const phases = [
      // id = structure.id so it matches the F_obs/F_calc decomposition's phaseId
      // (obsCalc tags the primary phase with structure.id), keeping the two plots'
      // click-to-spotlight in sync per phase.
      nuclearPhaseTicks(structure, dMin, dMax, toX, { id: structure.id, label: structure.name || "nuclear", color: PHASE_COLORS[0] }),
    ];
    // One Bragg-tick row per additional crystallographic phase, coloured distinctly.
    session.extraPhases.forEach((ph, i) => {
      phases.push(nuclearPhaseTicks(ph, dMin, dMax, toX, { id: ph.id, label: ph.name || `phase ${i + 2}`, color: PHASE_COLORS[(i + 1) % PHASE_COLORS.length]! }));
    });
    if (session.magnetic) {
      phases.push(magneticPhaseTicks(structure, session.magnetic, dMin, dMax, toX, { id: "magnetic", label: "magnetic", color: MAGNETIC_COLOR }));
    }
    return phases;
  }, [structure, session.extraPhases, session.magnetic, patternExtent, pattern.xUnit, effectiveUnit, axisCtx]);

  // Refined moment entries (per site / split orbit) for the 3D structure view.
  const sessionMoments = useMemo(
    () => (session.magnetic ? momentEntriesFrom(session.magnetic) : undefined),
    [session.magnetic],
  );

  function patchPowder(id: string, patch: Partial<RefinementParameter>): void {
    setSession((s) => ({ ...s, powderParams: s.powderParams.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }

  /** Apply the magnetic model built in the Magnetic tab onto the session so the
   *  refinement plot shows the magnetic pattern + satellite ticks. null clears it. */
  function applyMagneticToSession(magnetic: MagneticModel | null): void {
    setSession((s) => {
      const next = { ...s };
      if (magnetic) next.magnetic = magnetic; else delete next.magnetic;
      return next;
    });
    setMessage(magnetic ? `Magnetic model applied — pattern now includes the magnetic contribution (${magnetic.moments.length} moment${magnetic.moments.length === 1 ? "" : "s"}).` : "Magnetic contribution cleared from the pattern.");
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
    setStep(0);
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
      const spec = buildSpecFor(s.structure, s.extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true,count, s.siteTies, s.mustrain ?? "isotropic");
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
      const spec = buildSpecFor(s.structure, s.extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true,s.backgroundTerms, ties, s.mustrain ?? "isotropic");
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
    setBusy("powder");
    try {
      // Magnetic-aware branch: when a magnetic model + moment parameters are
      // present, refine nuclear + moments together (shared scale) on the main
      // thread. (A Web Worker path is a future optimization; the solve is small.)
      if (session.magnetic && powderParams.some((p) => isMomentParameterKind(p.kind))) {
        await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
        const magParams = guided ? guidedPowderParams(powderParams) : powderParams;
        const problem = buildMagneticPowderProblem(structure, session.magnetic, pattern, magParams, pBindings, {
          shape: session.powderProfile.shape,
          ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
        });
        const result = refine(problem, { maxIterations: guided ? 15 : 20 });
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
      const result = await client.current.refinePowder({
        structure, pattern, parameters: guided ? guidedPowderParams(powderParams) : powderParams, bindings: pBindings, ...profileReq(),
        ...(session.extraPhases.length > 0 ? { extraPhases: session.extraPhases } : {}),
        ...(guided ? { staged: DEFAULT_STAGE_KINDS } : {}),
        ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
        options: { maxIterations: guided ? 15 : 20 },
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
      setMessage(`Powder ${guided ? "guided " : ""}refinement ${result.status}: wR = ${(100 * (result.agreement.rWeighted ?? 0)).toFixed(2)}%.`);
    } catch (e) {
      setMessage(`Powder refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      livePreview.current = null;
      setBusy(null);
    }
  }

  function onLoadCif(file: File): void {
    file.text().then((text) => {
      try {
        const { structure: parsed, magnetic } = parseMagneticCif(text, "loaded");
        if (magnetic) {
          // Drive the powder view from the magnetic structure so the plot shows
          // the nuclear + magnetic pattern and reflection ticks.
          const magStructure = { ...parsed, id: "loaded" };
          setSession({ ...newSession(magStructure, instrument), magnetic: { ...magnetic, structureId: "loaded" } as MagneticModel });
          setPowderResult(null);
          setMessage(`Loaded magnetic CIF: ${parsed.name} · ${magnetic.moments.length} moments · ${parsed.spaceGroup.hermannMauguin ?? "BNS"}. Nuclear + magnetic pattern shown.`);
          return;
        }
        setSession(newSession({ ...parsed, id: "loaded" }, instrument));
        setOwnStructure(true);
        setPowderResult(null);
        setMessage(`Loaded CIF: ${parsed.name} (${parsed.sites.length} sites, ${parsed.spaceGroup.operations.length} symmetry ops). Load button is now "Add CIF…" to add impurity/secondary phases.`);
      } catch (e) {
        setMessage(`CIF parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** Append a CIF as an additional crystallographic phase (multi-phase refinement),
   *  rebuilding the spec while preserving every existing parameter value/state. */
  function onAddPhase(file: File): void {
    file.text().then((text) => {
      try {
        const raw = parseCif(text, `phase-${Date.now().toString(36)}`);
        // Fall back to a composition name (e.g. "MnO") when the CIF omits _pd_phase_name.
        const name = raw.name && raw.name !== "structure"
          ? raw.name
          : [...new Set(raw.sites.map((st) => st.element))].join("") || raw.id;
        const parsed = { ...raw, name };
        setSession((s) => {
          const extraPhases = [...s.extraPhases, parsed];
          const spec = buildSpecFor(s.structure, extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
          const previous = new Map(s.powderParams.map((p) => [p.id, p]));
          return {
            ...s,
            extraPhases,
            powderParams: spec.params.map((p) => {
              const old = previous.get(p.id);
              return old ? { ...p, value: old.value, initialValue: old.initialValue, fixed: old.fixed } : p;
            }),
            powderBindings: spec.bindings,
            powderProfile: { ...spec.profile, ...(s.powderProfile.backgroundType ? { backgroundType: s.powderProfile.backgroundType } : {}) },
          };
        });
        setPowderResult(null);
        setMessage(`Added phase "${parsed.name}" (${parsed.spaceGroup.hermannMauguin ?? "?"}). Refine to fit its scale/cell.`);
      } catch (e) {
        setMessage(`Add phase failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** Remove an added phase (by id) and rebuild the spec back down. */
  function onRemovePhase(id: string): void {
    setSession((s) => {
      const extraPhases = s.extraPhases.filter((p) => p.id !== id);
      const spec = buildSpecFor(s.structure, extraPhases, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        extraPhases,
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

  // Unified, auto-detecting data loader: the resolver classifies the file
  // (powder vs single-crystal) and, for powder, its x-unit, then dispatches.
  function onLoadData(file: File): void {
    file.text().then((text) => {
      try {
        // FullProf's ILL `.dat` templates share the extension but differ in
        // header — route each to its own reader before the generic detector.
        if (looksLikeInstrm6(text)) {
          applyInstrm6Powder(text, file.name);
          return;
        }
        if (looksLikeIllD1b(text)) {
          applyIllPowder(text, file.name);
          return;
        }
        const fmt = detectDataFormat({ text, filename: file.name, instrument: instrumentLoaded ? instrument : undefined });
        const tag = `[${fmt.source}/${fmt.confidence}]`;
        if (fmt.dataType === "single-crystal") {
          const loaded = loadReflectionDataset(text, structure, `${structure.id}-hkl`, file.name);
          if (loaded.kept < 1) throw new Error("no usable reflections in the file");
          setScDataset(loaded.dataset);
          setMessage(
            `Loaded single-crystal “${file.name}” · ${loaded.kept} reflections [${loaded.format}]` +
            `${loaded.dropped > 0 ? ` (${loaded.dropped} dropped)` : ""}. Merge report + F² refinement ready.`,
          );
          return;
        }
        setScDataset(null); // powder data → leave single-crystal mode
        applyPowder(text, file.name, fmt, tag);
      } catch (e) {
        setMessage(`Data load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // ILL D1B/D20 constant-wavelength neutron powder (numor format). Uses the
  // loaded CW instrument (e.g. the D1B .irf → λ + Caglioti U/V/W) when present;
  // otherwise a neutron default at the D1B wavelength, and loading the .irf
  // afterwards re-seeds the widths (onLoadInstrument rebuilds the spec).
  // FullProf INSTRM=6 (D2B/3T2/G4.2) CW neutron powder. The wavelength comes
  // from the file header (or the loaded CW instrument, which then supplies the
  // Caglioti widths when its .irf is loaded).
  function applyInstrm6Powder(text: string, filename: string): void {
    const id = `${structure.id}-powder`;
    const cw = instrumentLoaded && instrument.kind === "constantWavelength" ? instrument : null;
    const parsed = parseFullProfInstrm6(text, {
      id, name: filename,
      radiation: { kind: "neutron", wavelength: cw?.wavelength ?? 2.5 },
      ...(cw ? { wavelength: cw.wavelength } : {}),
    });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    setScDataset(null);
    const wavelength = parsed.wavelength ?? cw?.wavelength ?? 2.5;
    const inst: InstrumentParameters = cw ?? { kind: "constantWavelength", radiationKind: "neutron", wavelength };
    const spec = buildPowderSpec(structure, parsed, inst, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") { setInstrument(DEFAULT_INSTRUMENT); setInstrumentLoaded(false); }
    setPowderResult(null);
    const last = parsed.points[parsed.points.length - 1]!;
    setMessage(`Loaded FullProf INSTRM=6 powder “${filename}” · ${parsed.points.length} pts · 2θ ${parsed.points[0]!.x.toFixed(2)}–${last.x.toFixed(2)}° · neutron λ=${wavelength} Å.`);
  }

  function applyIllPowder(text: string, filename: string): void {
    const id = `${structure.id}-powder`;
    const cw = instrumentLoaded && instrument.kind === "constantWavelength" ? instrument : null;
    const wavelength = cw?.wavelength ?? 2.52; // D1B graphite λ
    const parsed = parseIllD1b(text, { id, name: filename, radiation: { kind: "neutron", wavelength }, wavelength });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    setScDataset(null);
    const inst: InstrumentParameters = cw ?? { kind: "constantWavelength", radiationKind: "neutron", wavelength };
    const spec = buildPowderSpec(structure, parsed, inst, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") { setInstrument(DEFAULT_INSTRUMENT); setInstrumentLoaded(false); }
    setPowderResult(null);
    const last = parsed.points[parsed.points.length - 1]!;
    setMessage(
      `Loaded ILL powder “${filename}” · ${parsed.points.length} pts · 2θ ${parsed.points[0]!.x.toFixed(2)}–${last.x.toFixed(2)}° · neutron λ=${wavelength} Å` +
      `${cw ? " (Caglioti widths from instrument)" : " — load the .irf for Caglioti widths"}.`,
    );
  }

  function applyPowder(text: string, filename: string, fmt: DetectedFormat, tag: string): void {
    const id = `${structure.id}-powder`;
    const isGsasCsv = /(^|,)\s*"?obs"?\s*,/i.test(text) && /calc/i.test(text);
    const isGsasHist = isGsasHistogram(text);
    if (fmt.xUnit === "tof") {
      const overlay = isGsasCsv ? parseGsasCsvPattern(text, id, filename) : null;
      const parsed = overlay
        ? overlay.pattern
        : isGsasHist
          ? parseGsasHistogramPattern(text, id, filename, { radiation: { kind: "neutron-tof" } })
          : parsePowderData(text, { id, name: filename, xUnit: "tof", radiation: { kind: "neutron-tof" } });
      if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
      const tofInstrument = instrumentLoaded && instrument.kind === "tof" ? instrument : null;
      // A GSAS-II CSV carries its own calc/background (shown as a reference
      // overlay); and without a TOF calibration (difC) we cannot place peaks —
      // both stay view-only. A plain TOF pattern with a loaded TOF instrument is
      // refined with the back-to-back-exponential profile.
      if (overlay || !tofInstrument) {
        const tofBindings = powderBindings(structure, id);
        setSession((s) => ({
          ...s,
          extraPhases: [],
          pattern: parsed,
          powderParams: startingPowderParams(structure, parsed, tofBindings),
          powderBindings: tofBindings,
          powderProfile: { shape: "gaussian" },
          powderOverlay: overlay ? { calc: overlay.calc, background: overlay.background } : null,
          powderSource: filename,
        }));
        setPowderResult(null);
        setMessage(
          overlay
            ? `Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag} with GSAS-II calc overlay (reference). ${fmt.note}`
            : `Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag}. Load a TOF instrument (.instprm with difC) to refine. ${fmt.note}`,
        );
        return;
      }
      const spec = buildPowderSpec(structure, parsed, tofInstrument, true, session.backgroundTerms, session.siteTies);
      setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
      setPowderResult(null);
      setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag}. ${spec.params.length} parameters, back-to-back-exponential profile — click “Refine”. ${fmt.note}`);
      return;
    }
    const parsed = isGsasHist
      ? parseGsasHistogramPattern(text, id, filename, { radiation: fmt.radiation })
      : parsePowderData(text, { id, name: filename, xUnit: fmt.xUnit, radiation: fmt.radiation, ...(fmt.radiation.kind !== "neutron-tof" ? { wavelength: fmt.radiation.wavelength } : {}) });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    // Constant-wavelength data: a still-selected TOF instrument (e.g. the bundled
    // default) doesn't apply, so fall back to a constant-wavelength default and
    // reset the instrument — loading a different dataset type auto-switches the
    // workbench into the matching mode instead of staying view-only.
    const cwInstrument = instrumentLoaded && instrument.kind === "constantWavelength" ? instrument : DEFAULT_INSTRUMENT;
    const spec = buildPowderSpec(structure, parsed, cwInstrument, session.powderProfile.lorentz, session.backgroundTerms, session.siteTies);
    setSession((s) => ({ ...s, extraPhases: [], pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") {
      setInstrument(DEFAULT_INSTRUMENT);
      setInstrumentLoaded(false);
    }
    setPowderResult(null);
    const nParams = spec.params.length;
    setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · unit=${fmt.xUnit} ${tag}. ${nParams} symmetry-allowed parameters. Scale auto-estimated — click “Refine”. ${fmt.note}`);
  }

  function onLoadInstrument(file: File): void {
    file.text().then((text) => {
      try {
        const parsed = parseInstrumentParameters(text);
        setInstrument(parsed);
        setInstrumentLoaded(true);
        // Rebuild the powder spec so the profile reflects the new instrument —
        // otherwise loading structure-then-instrument would leave the old
        // (default) profile in place, making load order matter.
        setSession((s) => {
          // For a constant-wavelength instrument on a non-TOF pattern, adopt its
          // radiation (X-ray vs neutron) and wavelength so the physics is correct
          // regardless of whether the data or the instrument was loaded first.
          const pattern =
            parsed.kind === "constantWavelength" && s.pattern.xUnit !== "tof"
              ? { ...s.pattern, radiation: { kind: parsed.radiationKind ?? "neutron", wavelength: parsed.wavelength }, wavelength: parsed.wavelength }
              : s.pattern;
          const spec = buildSpecFor(s.structure, s.extraPhases, pattern, parsed, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies, s.mustrain ?? "isotropic");
          return { ...s, pattern, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile };
        });
        setPowderResult(null);
        setMessage(
          parsed.kind === "tof"
            ? `Loaded TOF instrument: difC=${parsed.difC.toFixed(2)}, Zero=${(parsed.zero ?? 0).toFixed(3)}. Profile re-seeded.`
            : `Loaded CW instrument: λ=${parsed.wavelength} Å. Profile re-seeded.`,
        );
      } catch (e) {
        setMessage(`Instrument parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
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
  const liveWr = busy === "powder" && livePreview.current ? (100 * livePreview.current.rWeighted).toFixed(2) : wRpct;
  const rExp = powderResult?.agreement.rExpected;
  const liveGof = rExp && rExp > 0 ? Number(liveWr) / (100 * rExp) : null;
  const refinedGof = powderResult ? (powderResult.agreement.goodnessOfFit ?? null) : null;

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
      loadLabel: ownStructure ? "Add CIF…" : "Load CIF…",
      accept: ".cif,text/plain",
      onFile: ownStructure ? onAddPhase : onLoadCif,
      chip: session.extraPhases.length > 0 ? `✓ ${session.extraPhases.length + 1} phases` : "✓ parsed",
      title: session.extraPhases.length > 0
        ? `${structure.name} + ${session.extraPhases.map((p) => p.name).join(" + ")}`
        : `${structure.name}${structure.spaceGroup.hermannMauguin ? ` · ${structure.spaceGroup.hermannMauguin}` : ""}`,
      meta: session.extraPhases.length > 0
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
    },
    {
      label: "Data", loadLabel: "Load data…", accept: ".xye,.xy,.dat,.txt,.gr,.hkl,.int,.csv,.gsa,.gss,.fxye,text/plain", onFile: onLoadData,
      chip: isSynthetic ? "⚠ synthetic" : "✓ loaded",
      chipTone: isSynthetic ? "warn" : "ok",
      title: isSynthetic ? "Synthetic demo pattern" : powderSource,
      meta: `${pattern.points.length} points · ${UNIT_LABEL[pattern.xUnit]} ${patternExtent.min.toFixed(0)}–${patternExtent.max.toFixed(0)}`,
    },
    {
      label: "Instrument", loadLabel: "Load instrument…", accept: ".instprm,.prm,.irf,text/plain", onFile: onLoadInstrument,
      chip: instrumentLoaded ? "✓ loaded" : "default",
      title: instTitle,
      meta: instMeta,
    },
  ];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <WorkbenchHeader
        steps={STEPS}
        active={step}
        onStep={setStep}
        version={`v${APP_VERSION}`}
        onExportCsv={exportCsv}
        onExportProject={exportProject}
        onExportCif={exportCif}
        cifLabel={session.magnetic && session.magnetic.moments.length > 0 ? "Export mCIF" : "Export CIF"}
      />
      {scDataset ? (
        // Single-crystal mode (auto-switched on loading hkl/fcf data). Keyed on
        // the dataset id so a new file remounts with a fresh parameter set.
        <main className="wb-main" style={{ flex: 1 }}>
          <SingleCrystalWorkbench key={scDataset.id} structure={structure} dataset={scDataset} onLoadData={onLoadData} onLoadCif={onLoadCif} />
        </main>
      ) : (
        // Both powder step panels stay mounted; tabs only toggle visibility, so
        // the magnetic-analysis state (k, framework, group/irrep picks) survives
        // switching to the refinement page and back.
        <>
          <main className="wb-main" style={{ flex: 1, display: step === 0 ? undefined : "none" }}>
            {renderStep(0)}
          </main>
          <main className="wb-main" style={{ flex: 1, display: step === 1 ? undefined : "none" }}>
            {renderStep(1)}
          </main>
        </>
      )}
      <div style={disclaimerBar}>
        Early browser-native refinement workbench — results for publication must be validated against established tools.
      </div>
      <footer style={copyrightBar}>© 2026 Tsung-Han Yang. All rights reserved.</footer>
    </div>
  );

  function renderStep(which: number): JSX.Element {
    switch (which) {
      case 0: // Setup & refinement: quality rail | plot | parameter panel.
        return (
          <>
            <SummaryCards cards={summaryCards} />
            <div className="wb-work2">
              <div style={{ ...themeCard, padding: "16px 18px", display: "flex", flexDirection: "column", height: "clamp(500px, 64vh, 760px)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={themeLabel}>
                    {plotMode === "structure" ? "Crystal structure — unit cell" : plotMode === "validation" ? "Validation plots" : "Powder pattern"}
                  </span>
                  {plotMode !== "structure" && (
                    <span style={{ display: "flex", gap: 14, fontFamily: themeMono, fontSize: 12.5 }}>
                      <span style={{ color: theme.secondary }} title="Weighted profile R for the current parameters, coloured by wR/R_exp (Toby 2006)">
                        wR <b style={{ color: qualityInk(liveGof) }}>{liveWr}%</b>
                      </span>
                      <span style={{ color: theme.secondary }} title="Goodness of fit = wR/R_exp at the last refinement; ≈1 = consistent with the data uncertainties">
                        GoF <b style={{ color: qualityInk(refinedGof) }}>{refinedGof !== null ? refinedGof.toFixed(2) : "—"}</b>
                      </span>
                    </span>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
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
                  const allPhases = [structure, ...session.extraPhases];
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
                      highlight={highlight}
                      onHighlight={setHighlight}
                      {...(tofViewOnly ? {} : { onFitRangeChange: setFitRangeFromDisplay })}
                    />
                    <p style={{ marginTop: 8, fontSize: 12, color: theme.secondary }}>
                      {tofViewOnly
                        ? session.powderOverlay
                          ? "Observed (points) with GSAS-II fit overlay."
                          : "Observed TOF pattern — view-only (load a TOF instrument with difC to refine)."
                        : `Powder${powderIsTof ? " (TOF) · back-to-back-exponential profile" : ""}`}
                      {fitRangeActive && ` · fit range ${displayFitRange.min.toFixed(2)}–${displayFitRange.max.toFixed(2)} ${axisShortLabel(effectiveUnit)}`}
                      {!tofViewOnly && " · drag across the plot to zoom, blue handles to set the fit range."}
                      {fitRangeActive && (
                        <button style={smallBtn} onClick={() => setFitRange(null)}>Reset range</button>
                      )}
                    </p>
                    {!tofViewOnly && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 12, color: theme.secondary }}>
                        <span style={{ ...themeLabel, marginRight: 2 }}>Background</span>
                        <select
                          value={session.powderProfile.backgroundType ?? "chebyshev"}
                          onChange={(e) => setBackgroundType(e.target.value as BackgroundType)}
                          style={bgSelect}
                        >
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
                        <span style={{ ...themeLabel, marginLeft: 8, marginRight: 2 }} title="Displacement-parameter model: one isotropic B_iso per site, or the full anisotropic U tensor (symmetry-allowed modes)">ADPs</span>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="Refine the anisotropic U tensor. Each site's U is seeded from its current B_iso; symmetry fixes which components are free. Turn on after an isotropic fit converges.">
                          <input type="checkbox" checked={session.anisotropicAdp ?? false} onChange={(e) => setAnisotropicAdp(e.target.checked)} />
                          anisotropic
                        </label>
                        <span style={{ ...themeLabel, marginLeft: 8, marginRight: 2 }} title="Sample microstrain (Mustrain) model, GSAS-II-style: isotropic (Lorentzian Y), uniaxial (Y about a unique axis, 2θ only), or generalized (Stephens anisotropic).">Mustrain</span>
                        <select
                          value={session.mustrain ?? "isotropic"}
                          onChange={(e) => setMustrain(e.target.value as MustrainModel)}
                          style={bgSelect}
                          title="Isotropic uses the Lorentzian Y (always present); uniaxial and generalized add anisotropic microstrain rows — free them (Microstructure) or run guided after the isotropic profile converges."
                        >
                          <option value="isotropic">isotropic</option>
                          {session.pattern.xUnit === "twoTheta" && <option value="uniaxial">uniaxial</option>}
                          <option value="generalized">generalized</option>
                        </select>
                      </div>
                    )}
                    {!tofViewOnly && mustrainReadout && (mustrainReadout.strainPpm.value > 0 || mustrainReadout.sampleY !== 0) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6, fontSize: 12, color: theme.secondary, fontFamily: themeMono }} title="Derived from the refined Lorentzian X (size) and Y (microstrain), with the instrument seed deconvoluted (GSAS-II microstrain = LY·π/72000·10⁶ ppm).">
                        <span style={themeLabel}>Microstructure</span>
                        <span>microstrain ≈ <b style={{ color: theme.ink }}>{mustrainReadout.strainPpm.value.toFixed(0)}</b>×10⁻⁶ ({mustrainReadout.strainPercent.value.toFixed(3)}%)
                          {mustrainReadout.strainPpm.esd !== undefined ? ` ± ${mustrainReadout.strainPpm.esd.toFixed(0)}` : ""}</span>
                        {Number.isFinite(mustrainReadout.sizeNm.value) && mustrainReadout.sizeNm.value > 0 && (
                          <span>size ≈ <b style={{ color: theme.ink }}>{mustrainReadout.sizeNm.value.toFixed(0)}</b> nm</span>
                        )}
                      </div>
                    )}
                    {!tofViewOnly && hasSharedSite && (
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, fontSize: 12, color: theme.secondary }}>
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
                onReset={resetPowderParams}
                onMagnetic={() => {
                  setStep(1);
                  setMessage("Refined structure passed to the magnetic symmetry analysis — k-search and symmetry now use the current parameter values.");
                }}
                busy={busy !== null}
                result={powderResult}
                disabled={tofViewOnly}
              />
            </div>
          </>
        );
      case 1:
        return (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ ...themeCard, padding: "14px 16px" }}>
              <h2 style={{ ...h2, marginBottom: 4 }}>Magnetic symmetry analysis ({structure.name})</h2>
              <p style={{ ...stepHelp, marginBottom: 0 }}>
                Commensurate single-k workflow, on the refined atomic structure:
                magnetic ions → propagation vector k → symmetry framework → magnetic space group → preview &amp; refine → back to refinement.
                The 3D model (left) shows the magnetic unit cell with the selected group&rsquo;s moments.
              </p>
            </div>
            <KSearchPanel
              structure={refinedStructure}
              autoPeaks={magneticPeakD}
              pattern={pattern}
              nuclearParams={powderParams}
              nuclearBindings={pBindings}
              profile={session.powderProfile}
              onApply={applyMagneticToSession}
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
      <QualityPlots obsCalc={diagnostics.obsCalc} npp={diagnostics.npp} selected={selected ?? null} {...(onHighlight ? { onHighlight } : {})} />
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
const stepHelp: React.CSSProperties = { fontSize: 13, color: theme.secondary, marginTop: 0 };
const smallBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "1px 9px", fontSize: 11, cursor: "pointer", marginLeft: 6 };
const toolbarBtn: React.CSSProperties = { border: `1px solid ${theme.primary}`, background: "#fff", color: theme.primary, borderRadius: 8, padding: "3px 11px", fontSize: 11, fontWeight: 600, fontFamily: themeMono, cursor: "pointer" };
const bgSelect: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "2px 6px", fontSize: 12, color: theme.ink, cursor: "pointer" };
const bgTermsInput: React.CSSProperties = { width: 44, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "2px 6px", fontSize: 12, fontFamily: themeMono };
const disclaimerBar: React.CSSProperties = { padding: "7px 24px", fontSize: 11.5, background: theme.warnBg, borderTop: `1px solid ${theme.warnBorder}`, color: theme.warnInk };
const copyrightBar: React.CSSProperties = { padding: "10px 24px", fontSize: 11, color: theme.faint, borderTop: `1px solid ${theme.border}`, background: theme.raised, textAlign: "center" };
