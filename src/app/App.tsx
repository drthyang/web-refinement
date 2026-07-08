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
import { buildPowderSpec, guidedPowderParams, type SiteTies } from "@/app/powderSpec";
import { DEFAULT_STAGE_KINDS, siteGroups } from "@/core/workflow/structureRefinement";
import { powderPatternCsv, projectJson } from "@/core/export/exporters";
import { parseMagneticCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";
import { isGsasHistogram, parseGsasHistogramPattern } from "@/parsers/gsasHistogram";
import { detectDataFormat, type DetectedFormat } from "@/parsers/detectFormat";
import type { ParameterBinding } from "@/core/refinement/types";
import { startingPowderParams } from "@/app/loadData";
import { ComputeClient } from "@/workers/computeClient";
import { mn3gaPowgenExample } from "@/examples/mn3gaPowgen";
import { KSearchPanel } from "@/components/KSearchPanel";
import { detectExtraPeaks } from "@/core/magnetic/extraPeaks";
import { powderReflectionObsCalc } from "@/core/workflow/obsCalc";
import { normalProbabilityPlot, weightedResiduals } from "@/core/refinement/diagnostics";
import { QualityPlots } from "@/app/ui/QualityPlots";
import type { MagneticModel } from "@/core/magnetic/types";
import type { Vec3 } from "@/core/math/types";
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
import { StatusBar } from "@/app/ui/StatusBar";
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
function loadedSession(structure: StructureModel, pattern: PowderPattern, instrument: InstrumentParameters): Session {
  const spec = buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS, DEFAULT_TIES);
  return {
    structure,
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
  const [session, setSession] = useState<Session>(() => loadedSession(example.structure, example.pattern, example.instrument));
  const [powderResult, setPowderResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refineKind, setRefineKind] = useState<"refine" | "guided" | null>(null);
  const [step, setStep] = useState(0);
  // Optional refinement window; null = fit the full pattern. Reset when the
  // observed pattern changes (see effect below).
  const [fitRange, setFitRange] = useState<FitRangeSelection | null>(null);
  // Display-only x-axis unit; null = the pattern's native unit. Reset on load.
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit | null>(null);
  const [plotMode, setPlotMode] = useState<"curves" | "structure">("curves");
  const [instrument, setInstrument] = useState<InstrumentParameters>(example.instrument);
  const [instrumentLoaded, setInstrumentLoaded] = useState(true);
  const [message, setMessage] = useState<string>(
    `Loaded Mn₃Ga POWGEN 600 K · ${example.pattern.points.length} pts · TOF (back-to-back-exponential profile) — free parameters and refine.`,
  );
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
      nuclearPhaseTicks(structure, dMin, dMax, toX, { id: "nuclear", label: structure.name || "nuclear", color: PHASE_COLORS[0] }),
    ];
    if (session.magnetic) {
      phases.push(magneticPhaseTicks(structure, session.magnetic, dMin, dMax, toX, { id: "magnetic", label: "magnetic", color: MAGNETIC_COLOR }));
    }
    return phases;
  }, [structure, session.magnetic, patternExtent, pattern.xUnit, effectiveUnit, axisCtx]);

  // Refined moments (site → crystal-axis components) for the 3D structure view.
  const sessionMoments = useMemo<Map<string, Vec3> | undefined>(() => {
    if (!session.magnetic) return undefined;
    const map = new Map<string, Vec3>();
    for (const m of session.magnetic.moments) map.set(m.siteLabel, [...m.components] as Vec3);
    return map;
  }, [session.magnetic]);

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
      powderParams: [...s.powderParams.filter((p) => p.kind !== "momentMode"), ...momentParams.map((p) => ({ ...p, fixed: false }))],
      powderBindings: [...s.powderBindings.filter((b) => b.kind !== "momentMode"), ...momentBindings],
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
    setSession((s) => ({ ...s, powderProfile: { ...s.powderProfile, backgroundType } }));
    setPowderResult(null);
  }

  /** Change the number of background coefficients (rebuilds the spec, keeping
   *  every other parameter's value/free state and the chosen background type). */
  function setBackgroundTerms(n: number): void {
    const count = Math.max(0, Math.min(24, Math.trunc(n)));
    setSession((s) => {
      const spec = buildPowderSpec(s.structure, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, count, s.siteTies);
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
      const spec = buildPowderSpec(s.structure, s.pattern, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, s.powderProfile.lorentz ?? true, s.backgroundTerms, ties);
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
    setRefineKind(guided ? "guided" : "refine");
    try {
      // Magnetic-aware branch: when a magnetic model + moment parameters are
      // present, refine nuclear + moments together (shared scale) on the main
      // thread. (A Web Worker path is a future optimization; the solve is small.)
      if (session.magnetic && powderParams.some((p) => p.kind === "momentMode")) {
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
      setRefineKind(null);
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
        setPowderResult(null);
        setMessage(`Loaded CIF: ${parsed.name} (${parsed.sites.length} sites, ${parsed.spaceGroup.operations.length} symmetry ops).`);
      } catch (e) {
        setMessage(`CIF parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // Unified, auto-detecting data loader: the resolver classifies the file
  // (powder vs single-crystal) and, for powder, its x-unit, then dispatches.
  function onLoadData(file: File): void {
    file.text().then((text) => {
      try {
        const fmt = detectDataFormat({ text, filename: file.name, instrument: instrumentLoaded ? instrument : undefined });
        const tag = `[${fmt.source}/${fmt.confidence}]`;
        if (fmt.dataType === "single-crystal") {
          setMessage(`“${file.name}” looks like a single-crystal reflection list ${tag}. Single-crystal refinement is disabled for now — load a powder pattern instead.`);
          return;
        }
        applyPowder(text, file.name, fmt, tag);
      } catch (e) {
        setMessage(`Data load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
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
      setSession((s) => ({ ...s, pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
      setPowderResult(null);
      setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag}. ${spec.params.length} parameters, back-to-back-exponential profile — click “Refine powder” or “Guided”. ${fmt.note}`);
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
    setSession((s) => ({ ...s, pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
    if (instrument.kind === "tof") {
      setInstrument(DEFAULT_INSTRUMENT);
      setInstrumentLoaded(false);
    }
    setPowderResult(null);
    const nParams = spec.params.length;
    setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · unit=${fmt.xUnit} ${tag}. ${nParams} symmetry-allowed parameters. Scale auto-estimated — click “Refine powder” or “Guided”. ${fmt.note}`);
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
          const spec = buildPowderSpec(s.structure, pattern, parsed, s.powderProfile.lorentz ?? true, s.backgroundTerms, s.siteTies);
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

  function exportCsv(): void {
    downloadText(`${pattern.id}.csv`, powderPatternCsv(curves), "text/csv");
  }

  // Summary-card content (Structure / Data / Instrument).
  const cell = structure.cell;
  const hexish = Math.abs(cell.a - cell.b) < 1e-4 && cell.gamma === 120;
  const cellStr = hexish
    ? `a ${cell.a.toFixed(5)} · c ${cell.c.toFixed(5)} Å`
    : `a ${cell.a.toFixed(4)} · b ${cell.b.toFixed(4)} · c ${cell.c.toFixed(4)} Å`;
  const isSynthetic = powderSource === SYNTHETIC_SOURCE;
  const instMeta =
    instrument.kind === "tof"
      ? `difC ${instrument.difC.toFixed(1)}${instrument.difA ? ` · difA ${instrument.difA}` : ""}${instrument.difB ? ` · difB ${instrument.difB}` : ""} · Zero ${(instrument.zero ?? 0).toFixed(2)} µs`
      : `λ ${instrument.wavelength} Å${instrument.zero ? ` · Zero ${instrument.zero}°` : ""}`;
  const summaryCards: SummaryCardData[] = [
    {
      label: "Structure", loadLabel: "Load CIF…", accept: ".cif,text/plain", onFile: onLoadCif,
      chip: "✓ parsed",
      title: `${structure.name}${structure.spaceGroup.hermannMauguin ? ` · ${structure.spaceGroup.hermannMauguin}` : ""}`,
      meta: `${cellStr} · V ${cellVolume(structure.cell).toFixed(2)} Å³ · ${structure.sites.length} sites`,
    },
    {
      label: "Data", loadLabel: "Load data…", accept: ".xye,.xy,.dat,.txt,.gr,.hkl,.csv,.gsa,.gss,.fxye,text/plain", onFile: onLoadData,
      chip: isSynthetic ? "⚠ synthetic" : "✓ loaded",
      title: isSynthetic ? "Synthetic demo pattern" : powderSource,
      meta: `${pattern.points.length} points · ${UNIT_LABEL[pattern.xUnit]} ${patternExtent.min.toFixed(0)}–${patternExtent.max.toFixed(0)}`,
    },
    {
      label: "Instrument", loadLabel: "Load instrument…", accept: ".instprm,.prm,text/plain", onFile: onLoadInstrument,
      chip: instrumentLoaded ? "✓ loaded" : "default",
      title: instrument.kind === "tof" ? "POWGEN .instprm · TOF" : "Constant wavelength",
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
      />
      <StatusBar message={message} />
      <main className="wb-main" style={{ flex: 1 }}>
        {renderStep()}
      </main>
      <div style={disclaimerBar}>
        Early browser-native refinement workbench — results for publication must be validated against established tools.
      </div>
      <footer style={copyrightBar}>© 2026 Tsung-Han Yang. All rights reserved.</footer>
    </div>
  );

  function renderStep(): JSX.Element {
    switch (step) {
      case 0: // Setup & refinement: quality rail | plot | parameter panel.
        return (
          <>
            <SummaryCards cards={summaryCards} />
            <div className="wb-work3">
              <div className="wb-card-quality" style={{ ...themeCard, padding: "14px 16px", height: "clamp(500px, 64vh, 760px)", overflowY: "auto" }}>
                <QualityPanel powderResult={powderResult} structure={structure} pattern={pattern} params={powderParams} bindings={pBindings} profile={session.powderProfile} />
              </div>
              <div style={{ ...themeCard, padding: "16px 18px", display: "flex", flexDirection: "column", height: "clamp(500px, 64vh, 760px)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={themeLabel}>
                    {plotMode === "structure" ? "Crystal structure — unit cell" : "Powder pattern — observed vs calculated"}
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                    {plotMode === "curves" && (
                      <AxisUnitToggle units={displayUnits} value={effectiveUnit} onChange={setDisplayUnit} />
                    )}
                    <ViewModeToggle value={plotMode} onChange={setPlotMode} />
                    <button
                      style={magHandoffBtn}
                      title="Open the magnetic symmetry analysis with the current refined structure (lattice, positions, occupancies)"
                      onClick={() => {
                        setStep(1);
                        setMessage("Refined structure passed to the magnetic symmetry analysis — k-search and symmetry now use the current parameter values.");
                      }}
                    >
                      Magnetic analysis →
                    </button>
                  </div>
                </div>
                {plotMode === "structure" ? (
                  <>
                    <Suspense fallback={<div style={{ flex: 1, minHeight: 360, display: "grid", placeItems: "center", color: theme.secondary, fontSize: 13 }}>Loading 3D viewer…</div>}>
                      <StructureView
                        structure={structure}
                        {...(sessionMoments ? { moments: sessionMoments } : {})}
                        {...(session.magnetic?.propagation[0] ? { propagation: session.magnetic.propagation[0] } : {})}
                        {...(session.magnetic?.operations ? { magneticOperations: session.magnetic.operations } : {})}
                      />
                    </Suspense>
                    <p style={{ marginTop: 8, fontSize: 12, color: theme.secondary }}>
                      {structure.name || "Structure"}
                      {structure.spaceGroup.hermannMauguin ? ` · ${structure.spaceGroup.hermannMauguin}` : ""}
                      {` · ${structure.sites.length} site${structure.sites.length === 1 ? "" : "s"} · drag to rotate, scroll to zoom.`}
                    </p>
                  </>
                ) : (
                  <>
                    <WorkbenchPlot
                      curves={plotCurves}
                      xLabel={displayXLabel}
                      wRpct={busy === "powder" && livePreview.current ? (100 * livePreview.current.rWeighted).toFixed(2) : wRpct}
                      fitRange={displayFitRange}
                      phases={phaseTicks}
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
                        </select>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          terms
                          <input type="number" min={1} max={24} step={1} value={session.backgroundTerms} onChange={(e) => setBackgroundTerms(Number(e.target.value))} style={bgTermsInput} />
                        </label>
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
                onGuided={() => runPowder(true)}
                onReset={resetPowderParams}
                busy={busy !== null}
                busyKind={busy === "powder" ? refineKind : null}
                result={powderResult}
                disabled={tofViewOnly}
              />
            </div>
          </>
        );
      case 1:
        return (
          <div style={{ ...themeCard, padding: 16 }}>
            <h2 style={h2}>Magnetic symmetry analysis ({structure.name})</h2>
            <p style={stepHelp}>
              Commensurate single-k workflow, on the refined atomic structure:
              magnetic ions → propagation vector k → symmetry framework → magnetic space group → preview &amp; refine → back to refinement.
            </p>
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

function QualityPanel({
  structure,
  powderResult,
  pattern,
  params,
  bindings,
  profile,
}: {
  structure: StructureModel;
  powderResult: RefinementResult | null;
  pattern: PowderPattern;
  params: readonly RefinementParameter[];
  bindings: readonly ParameterBinding[];
  profile: PowderProfile;
}): JSX.Element {
  // Validation plots (Rietveld obs/calc + normal probability) for the current fit.
  const diagnostics = useMemo(() => {
    const obsCalc = powderReflectionObsCalc(structure, pattern, params, bindings, profile);
    const curves = powderCurves(structure, pattern, params, bindings, profile);
    const sigmas = pattern.points.map((p) => p.sigma ?? (p.yObs > 0 ? Math.sqrt(p.yObs) : 1));
    const npp = normalProbabilityPlot(weightedResiduals(curves.yObs, curves.yCalc, sigmas));
    return { obsCalc, npp };
  }, [structure, pattern, params, bindings, profile]);
  return (
    <div>
      <span style={themeLabel}>Refinement quality</span>
      <table style={{ fontSize: fz.body, marginTop: 8 }}>
        <tbody>
          <tr>
            <td style={kcell}>GoF</td>
            <td>{powderResult ? (powderResult.agreement.goodnessOfFit ?? 0).toFixed(2) : "not refined"}</td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: fz.small, color: theme.secondary, marginTop: 6 }}>
        GoF near 1 = fit consistent with the data uncertainties. wR is shown live on the pattern.
      </p>
      <QualityPlots obsCalc={diagnostics.obsCalc} npp={diagnostics.npp} stacked />
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
  value: "curves" | "structure";
  onChange: (m: "curves" | "structure") => void;
}): JSX.Element {
  const opts: readonly { id: "curves" | "structure"; label: string }[] = [
    { id: "curves", label: "Refinement" },
    { id: "structure", label: "3D Model" },
  ];
  return (
    <div style={{ display: "inline-flex", gap: 2, background: theme.chipBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 2 }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          title={o.id === "structure" ? "3D crystal-structure model" : "Observed vs calculated curves"}
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
const kcell: React.CSSProperties = { padding: "2px 10px 2px 0", color: theme.secondary, verticalAlign: "top" };
const stepHelp: React.CSSProperties = { fontSize: 13, color: theme.secondary, marginTop: 0 };
const smallBtn: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "1px 9px", fontSize: 11, cursor: "pointer", marginLeft: 6 };
const magHandoffBtn: React.CSSProperties = { border: `1px solid ${theme.primary}`, background: "#fff", color: theme.primary, borderRadius: 8, padding: "3px 11px", fontSize: 11, fontWeight: 600, fontFamily: themeMono, cursor: "pointer" };
const bgSelect: React.CSSProperties = { border: `1px solid ${theme.control}`, background: "#fff", borderRadius: 7, padding: "2px 6px", fontSize: 12, color: theme.ink, cursor: "pointer" };
const bgTermsInput: React.CSSProperties = { width: 44, border: `1px solid ${theme.control}`, borderRadius: 7, padding: "2px 6px", fontSize: 12, fontFamily: themeMono };
const disclaimerBar: React.CSSProperties = { padding: "7px 24px", fontSize: 11.5, background: theme.warnBg, borderTop: `1px solid ${theme.warnBorder}`, color: theme.warnInk };
const copyrightBar: React.CSSProperties = { padding: "10px 24px", fontSize: 11, color: theme.faint, borderTop: `1px solid ${theme.border}`, background: theme.raised, textAlign: "center" };
