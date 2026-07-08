import { useEffect, useMemo, useRef, useState } from "react";
import { APP_NAME, APP_VERSION, PROJECT_SCHEMA_VERSION } from "@/app/constants";
import { downloadText } from "@/app/download";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ProjectFile } from "@/core/project/types";
import { cellVolume } from "@/core/crystal/unitCell";
import { powderCurves, type PowderProfile } from "@/core/workflow/powder";
import type { PeakShape } from "@/core/diffraction/profile";
import { buildPowderSpec, guidedPowderParams } from "@/app/powderSpec";
import { DEFAULT_STAGE_KINDS } from "@/core/workflow/structureRefinement";
import { powderPatternCsv, projectJson } from "@/core/export/exporters";
import { parseMagneticCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";
import { detectDataFormat, type DetectedFormat } from "@/parsers/detectFormat";
import { magneticComparison } from "@/core/workflow/magnetic";
import type { ParameterBinding } from "@/core/refinement/types";
import { startingPowderParams } from "@/app/loadData";
import { ComputeClient } from "@/workers/computeClient";
import { exampleStructure } from "@/examples/highEntropyWO4";
import { loadPowgenDefault } from "@/app/powgenData";
import { loadMn3GaPowgen } from "@/app/mn3gaPowgen";
import {
  buildMagneticDataset,
  exampleMagnetic,
  magneticBindings,
  magneticParameters,
  type MagneticExample,
} from "@/examples/mn3gaMagnetic";
import { MagneticPanel } from "@/components/MagneticPanel";
import type { MagneticModel } from "@/core/magnetic/types";
import type { SingleCrystalDataset as SxDataset } from "@/core/diffraction/types";
import { buildSyntheticPowder, powderBindings } from "@/examples/synthetic";
import { ParameterTable } from "@/components/ParameterTable";
import { CandidateComparison } from "@/components/CandidateComparison";
import { PatternPlot, type FitRangeSelection } from "@/visualization/PatternPlot";
import {
  axisContext,
  availableDisplayUnits,
  convertAxisArray,
  convertInterval,
  axisLabel,
  axisShortLabel,
  type DisplayUnit,
} from "@/visualization/axisUnits";
import { bondLengths } from "@/core/crystal/geometry";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import { parseInstrumentParameters } from "@/parsers/instrument";

const STEPS = [
  "1. Structure (CIF)",
  "2. Data & instrument",
  "3. Structural refinement",
  "4. Quality",
  "5. Magnetic candidates",
  "6. Magnetic refinement",
  "7. Compare groups",
] as const;

const DEFAULT_INSTRUMENT: InstrumentParameters = { kind: "constantWavelength", wavelength: 1.54 };
const DEFAULT_BACKGROUND_TERMS = 4;

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
  /** GSAS-II's own calc/background overlay for a view-only (TOF) pattern. */
  powderOverlay?: { calc: number[]; background: number[] } | null;
  /** Provenance of the observed data driving the refinement. */
  powderSource: string;
}

const SYNTHETIC_SOURCE = "synthetic (self-consistent demo)";
const UNIT_LABEL: Record<string, string> = { twoTheta: "2θ", q: "Q (Å⁻¹)", dSpacing: "d (Å)", tof: "TOF (µs)" };

interface MagState {
  ex: MagneticExample;
  dataset: SxDataset;
  params: RefinementParameter[];
}

function makeMagnetic(ex: MagneticExample): MagState {
  return { ex, dataset: buildMagneticDataset(ex), params: magneticParameters(ex.magnetic) };
}

function newSession(structure: StructureModel, instrument: InstrumentParameters = DEFAULT_INSTRUMENT): Session {
  const pattern = buildSyntheticPowder(structure);
  const spec = buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS);
  return {
    structure,
    pattern,
    powderParams: spec.params,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
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
  const spec = buildPowderSpec(structure, pattern, instrument, true, DEFAULT_BACKGROUND_TERMS);
  return {
    structure,
    pattern,
    powderParams: spec.params,
    powderBindings: spec.bindings,
    powderProfile: spec.profile,
    backgroundTerms: DEFAULT_BACKGROUND_TERMS,
    powderOverlay: null,
    powderSource: pattern.name,
  };
}

export function App(): JSX.Element {
  const [session, setSession] = useState<Session>(() => newSession(exampleStructure()));
  const [powderResult, setPowderResult] = useState<RefinementResult | null>(null);
  const [mag, setMag] = useState(() => makeMagnetic(exampleMagnetic()));
  const [magResult, setMagResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  // Optional refinement window; null = fit the full pattern. Reset when the
  // observed pattern changes (see effect below).
  const [fitRange, setFitRange] = useState<FitRangeSelection | null>(null);
  // Display-only x-axis unit; null = the pattern's native unit. Reset on load.
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit | null>(null);
  const [instrument, setInstrument] = useState<InstrumentParameters>({ kind: "constantWavelength", wavelength: 1.54 });
  const [instrumentLoaded, setInstrumentLoaded] = useState(false);
  const [message, setMessage] = useState<string>("High-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄ (P2/c). Checking for the POWGEN pattern…");
  const client = useRef<ComputeClient>(new ComputeClient());
  // Set once the user loads a CIF/data or resets, so the async startup POWGEN
  // load never clobbers a session the user has already taken over.
  const userTookOver = useRef(false);

  // On startup, try to open a real POWGEN dataset from the local (git-ignored)
  // data/ folder — served by the dev-only Vite plugin. The Mn₃Ga 600 K TOF set
  // is preferred (it exercises the time-of-flight refinement path); otherwise
  // fall back to the high-entropy POWGEN set, then the bundled synthetic demo.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mn3ga = await loadMn3GaPowgen();
      if (cancelled || userTookOver.current) return;
      if (mn3ga) {
        setInstrument(mn3ga.instrument);
        setInstrumentLoaded(true);
        setSession(loadedSession(mn3ga.structure, mn3ga.pattern, mn3ga.instrument));
        setPowderResult(null);
        setMessage(
          `Loaded Mn₃Ga POWGEN 600 K · ${mn3ga.pattern.points.length} pts · TOF (back-to-back-exponential profile) — click “Refine powder” or “Guided”.`,
        );
        return;
      }
      const loaded = await loadPowgenDefault();
      if (cancelled || userTookOver.current) return;
      if (!loaded) {
        setMessage("High-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄ (P2/c) — bundled structure (POWGEN pattern not found in data/).");
        return;
      }
      const { structure: st, pattern: pt, instrument: inst } = loaded;
      setInstrument(inst);
      setInstrumentLoaded(true);
      setSession(loadedSession(st, pt, inst));
      setPowderResult(null);
      setMessage(`Loaded POWGEN high-entropy (Co,Cu,Fe,Mn,Ni,Zn)WO₄ · ${pt.points.length} pts · ${pt.xUnit === "tof" ? "TOF" : pt.xUnit}.`);
    })();
    return () => {
      cancelled = true;
    };
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

  const curves = useMemo(() => {
    // TOF patterns cannot be profile-fit by the minimal engine; show the observed
    // data with GSAS-II's own calc/background as a faithful reference overlay.
    if (powderIsTof && session.powderOverlay) {
      const x = pattern.points.map((p) => p.x);
      const yObs = pattern.points.map((p) => p.yObs);
      const yCalc = session.powderOverlay.calc;
      return { x, yObs, yCalc, yBackground: session.powderOverlay.background, diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
    }
    return powderCurves(structure, pattern, powderParams, pBindings, session.powderProfile);
  }, [structure, pattern, powderParams, pBindings, session.powderProfile, powderIsTof, session.powderOverlay]);
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
  const displayUnits = useMemo(() => availableDisplayUnits(axisCtx), [axisCtx]);
  const effectiveUnit: DisplayUnit = displayUnit ?? pattern.xUnit;
  const displayCurves = useMemo(
    () => (effectiveUnit === pattern.xUnit ? curves : { ...curves, x: convertAxisArray(curves.x, pattern.xUnit, effectiveUnit, axisCtx) }),
    [curves, effectiveUnit, pattern.xUnit, axisCtx],
  );
  const displayXLabel = axisLabel(effectiveUnit);
  // Fit-range handles live in display space; convert to/from the native window.
  const displayFitRange = useMemo(
    () => convertInterval(effectiveFitRange, pattern.xUnit, effectiveUnit, axisCtx),
    [effectiveFitRange, pattern.xUnit, effectiveUnit, axisCtx],
  );
  const setFitRangeFromDisplay = (r: FitRangeSelection): void =>
    setFitRange(convertInterval(r, effectiveUnit, pattern.xUnit, axisCtx));
  const magBind = useMemo(() => magneticBindings(mag.ex.magnetic), [mag.ex.magnetic]);
  const magRows = useMemo(
    () => magneticComparison(mag.ex.structure, mag.ex.magnetic, mag.dataset, mag.params, magBind),
    [mag, magBind],
  );

  function patchPowder(id: string, patch: Partial<RefinementParameter>): void {
    setSession((s) => ({ ...s, powderParams: s.powderParams.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }
  function patchMag(id: string, patch: Partial<RefinementParameter>): void {
    setMag((m) => ({ ...m, params: m.params.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }

  function setBackgroundTerms(backgroundTerms: number): void {
    const count = Math.max(0, Math.min(20, Math.trunc(backgroundTerms)));
    setSession((s) => {
      const spec = buildPowderSpec(
        s.structure,
        s.pattern,
        instrumentLoaded ? instrument : DEFAULT_INSTRUMENT,
        s.powderProfile.lorentz,
        count,
      );
      const previous = new Map(s.powderParams.map((p) => [p.id, p]));
      return {
        ...s,
        backgroundTerms: count,
        powderParams: spec.params.map((p) => {
          const old = previous.get(p.id);
          return old
            ? {
                ...p,
                value: old.value,
                initialValue: old.initialValue,
                fixed: old.fixed,
                ...(old.esd !== undefined ? { esd: old.esd } : {}),
              }
            : p;
        }),
        powderBindings: spec.bindings,
        powderProfile: spec.profile,
      };
    });
    setPowderResult(null);
  }

  async function runMagnetic(): Promise<void> {
    setBusy("mag");
    try {
      const result = await client.current.refineMagnetic({
        structure: mag.ex.structure, magnetic: mag.ex.magnetic, dataset: mag.dataset,
        parameters: mag.params, bindings: magBind, options: { maxIterations: 30 },
      });
      setMag((m) => ({ ...m, params: m.params.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value })) }));
      setMagResult(result);
      setMessage(`Magnetic refinement ${result.status}: R = ${(100 * result.agreement.rFactor).toFixed(2)}%.`);
    } catch (e) {
      setMessage(`Magnetic refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const profileReq = (): { shape: PeakShape; eta?: number; lorentz?: boolean } => ({
    shape: session.powderProfile.shape,
    ...(session.powderProfile.eta !== undefined ? { eta: session.powderProfile.eta } : {}),
    ...(session.powderProfile.lorentz !== undefined ? { lorentz: session.powderProfile.lorentz } : {}),
  });

  /** Flat co-refinement of the currently-freed parameters. */
  async function runPowder(guided = false): Promise<void> {
    setBusy("powder");
    try {
      const result = await client.current.refinePowder({
        structure, pattern, parameters: guided ? guidedPowderParams(powderParams) : powderParams, bindings: pBindings, ...profileReq(),
        ...(guided ? { staged: DEFAULT_STAGE_KINDS } : {}),
        ...(fitRangeActive ? { fitRange: { min: fitRange!.min, max: fitRange!.max } } : {}),
        options: { maxIterations: guided ? 15 : 20 },
      });
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
      setBusy(null);
    }
  }

  function onLoadCif(file: File): void {
    userTookOver.current = true;
    file.text().then((text) => {
      try {
        const { structure: parsed, magnetic } = parseMagneticCif(text, "loaded");
        if (magnetic) {
          const ex: MagneticExample = { structure: { ...parsed, id: "loaded-mag" }, magnetic: { ...magnetic, structureId: "loaded-mag" } as MagneticModel };
          setMag(makeMagnetic(ex));
          setMagResult(null);
          setMessage(`Loaded magnetic CIF: ${parsed.name} · ${magnetic.moments.length} moments · ${parsed.spaceGroup.hermannMauguin ?? "BNS"}.`);
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
    userTookOver.current = true;
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
    if (fmt.xUnit === "tof") {
      const overlay = isGsasCsv ? parseGsasCsvPattern(text, id, filename) : null;
      const parsed = overlay
        ? overlay.pattern
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
      const spec = buildPowderSpec(structure, parsed, tofInstrument, true, session.backgroundTerms);
      setSession((s) => ({ ...s, pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
      setPowderResult(null);
      setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · TOF ${tag}. ${spec.params.length} parameters, back-to-back-exponential profile — click “Refine powder” or “Guided”. ${fmt.note}`);
      return;
    }
    const parsed = parsePowderData(text, { id, name: filename, xUnit: fmt.xUnit, radiation: fmt.radiation, ...(fmt.radiation.kind !== "neutron-tof" ? { wavelength: fmt.radiation.wavelength } : {}) });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    // Full symmetry-allowed parameter set, seeded from the loaded instrument
    // (Caglioti profile + zero when the .instprm carries them).
    const spec = buildPowderSpec(structure, parsed, instrumentLoaded ? instrument : DEFAULT_INSTRUMENT, session.powderProfile.lorentz, session.backgroundTerms);
    setSession((s) => ({ ...s, pattern: parsed, powderParams: spec.params, powderBindings: spec.bindings, powderProfile: spec.profile, powderOverlay: null, powderSource: filename }));
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
        setMessage(
          parsed.kind === "tof"
            ? `Loaded TOF instrument: difC=${parsed.difC.toFixed(2)}, Zero=${(parsed.zero ?? 0).toFixed(3)}.`
            : `Loaded CW instrument: λ=${parsed.wavelength} Å.`,
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
    // For a TOF overlay, only measure the fit region (where GSAS-II's calc > 0);
    // points outside the refined range would otherwise inflate the residual.
    let num = 0, den = 0;
    for (let i = 0; i < curves.yObs.length; i++) {
      const c = curves.yCalc[i] ?? 0;
      if (powderIsTof && c <= 0) continue;
      // Match the refined window: exclude points outside an active fit range.
      if (fitRangeActive && (curves.x[i]! < fitRange!.min || curves.x[i]! > fitRange!.max)) continue;
      num += Math.abs(curves.yObs[i]! - c);
      den += Math.abs(curves.yObs[i]!);
    }
    return (100 * num / Math.max(den, 1e-9)).toFixed(1);
  })();

  return (
    <div style={page}>
      <header>
        <h1 style={{ margin: "0 0 4px" }}>{APP_NAME}</h1>
        <p style={{ margin: 0, color: "#555" }}>
          v{APP_VERSION} · atomic/nuclear refinement · powder
        </p>
        <p style={disclaimer}>
          Early browser-native refinement workbench. Results for publication must be validated against
          established tools.
        </p>
      </header>

      <div style={{ ...bar }}>
        <label style={btn}>
          Load CIF…
          <input
            type="file"
            accept=".cif,text/plain"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadCif(f); }}
          />
        </label>
        <button style={btn} onClick={() => { userTookOver.current = true; setSession(newSession(exampleStructure(), instrument)); }}>Reset to example</button>
        <button style={btn} onClick={exportProject}>Export project JSON</button>
        <span style={{ color: "#1f4e79", marginLeft: 8 }}>{message}</span>
      </div>

      <nav style={stepNav}>
        {STEPS.map((label, i) => (
          <button
            key={label}
            onClick={() => setStep(i)}
            style={{ ...stepChip, ...(i === step ? stepChipActive : {}) }}
          >
            {label}
          </button>
        ))}
      </nav>

      <section style={card}>{renderStep()}</section>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <button style={btn} disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>← Back</button>
        <button style={btnPrimary} disabled={step === STEPS.length - 1} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>Next →</button>
      </div>

      <footer style={{ color: "#888", fontSize: 12, marginTop: 24 }}>
        Guided workflow mirrors the practical refinement procedure. Bundled example structures from
        GSAS-II validation data. See docs/REFINEMENT_PROCEDURE.md and docs/VALIDATION.md.
      </footer>
    </div>
  );

  function renderStep(): JSX.Element {
    const magSiteLabels = mag.ex.magnetic.moments.map((m) => m.siteLabel);
    switch (step) {
      case 0:
        return (
          <div>
            <h2 style={h2}>Step 1 — Structure ({structure.name})</h2>
            <p style={stepHelp}>Load a structural CIF (nuclear model). Use “Load CIF…” above.</p>
            <table style={{ fontSize: 13 }}>
              <tbody>
                <tr><td style={kcell}>Space group</td><td>{structure.spaceGroup.hermannMauguin ?? "(from ops)"} · {structure.spaceGroup.operations.length} ops</td></tr>
                <tr><td style={kcell}>Cell</td><td>a={structure.cell.a.toFixed(4)} b={structure.cell.b.toFixed(4)} c={structure.cell.c.toFixed(4)} Å · α={structure.cell.alpha} β={structure.cell.beta} γ={structure.cell.gamma}°</td></tr>
                <tr><td style={kcell}>Volume</td><td>{cellVolume(structure.cell).toFixed(3)} Å³</td></tr>
                <tr><td style={kcell}>Sites</td><td>{structure.sites.map((s) => `${s.label}(${s.element}) occ ${s.occupancy.toFixed(3)}`).join(", ")}</td></tr>
              </tbody>
            </table>
          </div>
        );
      case 1:
        return (
          <div>
            <h2 style={h2}>Step 2 — Experimental data &amp; instrument</h2>
            <p style={stepHelp}>
              Load your <strong>observed powder data</strong> — the reader auto-detects the x-axis
              unit (2θ / Q / d / TOF) from the file header, the loaded instrument, or the data range.
              Powder is <code>x&nbsp;y&nbsp;[σ]</code>. Load an instrument file for the authoritative
              calibration. Until you load data the workbench uses a synthetic demo pattern.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={btn}>
                Load data…
                <input type="file" accept=".xye,.xy,.dat,.txt,.gr,.hkl,.csv,text/plain" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadData(f); }} />
              </label>
              <label style={btn}>
                Load instrument…
                <input type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onLoadInstrument(f); }} />
              </label>
              <span style={{ fontSize: 13, color: "#444" }}>
                {instrument.kind === "tof"
                  ? `TOF · difC=${instrument.difC.toFixed(1)} · Zero=${(instrument.zero ?? 0).toFixed(3)}`
                  : `Constant wavelength · λ=${instrument.wavelength} Å`}
              </span>
            </div>
            <table style={{ fontSize: 12, marginBottom: 10 }}>
              <tbody>
                <tr><td style={kcell}>Powder source</td><td><SourceTag source={powderSource} synthetic={SYNTHETIC_SOURCE} /> · {pattern.points.length} points · unit={UNIT_LABEL[pattern.xUnit]}</td></tr>
              </tbody>
            </table>
            <div style={{ overflowX: "auto" }}>
              <AxisUnitToggle units={displayUnits} value={effectiveUnit} onChange={setDisplayUnit} />
              <PatternPlot
                curves={displayCurves}
                xLabel={displayXLabel}
                fitRange={displayFitRange}
                {...(tofViewOnly ? {} : { onFitRangeChange: setFitRangeFromDisplay })}
              />
              <p style={{ fontSize: 12, color: "#666" }}>
                {tofViewOnly
                  ? session.powderOverlay
                    ? "Observed (points) with GSAS-II fit overlay"
                    : "Observed TOF pattern (view-only — no calc overlay)"
                  : `Observed${powderIsTof ? " TOF" : ""} data with calculated profile`} ({pattern.points.length} points).
                {!tofViewOnly && " Drag the blue handles to set the fit range."}
              </p>
            </div>
          </div>
        );
      case 2:
        return (
          <div>
            <h2 style={h2}>Step 3 — Structural refinement (with constraints)</h2>
            <p style={stepHelp}>
              The full <strong>symmetry-allowed</strong> parameter set is listed: scale, Chebyshev
              background, symmetry-reduced cell, instrument profile (Caglioti U/V/W + zero), per-site
              ADP, and symmetry-adapted atomic positions. Structural rows start fixed — free them per
              row and click <strong>Refine selected</strong>, or click <strong>Guided (staged)</strong>
              to unlock them in the expert order automatically.
            </p>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div style={{ overflowX: "auto" }}>
                <AxisUnitToggle units={displayUnits} value={effectiveUnit} onChange={setDisplayUnit} />
                <PatternPlot
                  curves={displayCurves}
                  xLabel={displayXLabel}
                  fitRange={displayFitRange}
                  {...(tofViewOnly ? {} : { onFitRangeChange: setFitRangeFromDisplay })}
                />
                <p style={{ fontSize: 12, color: "#666" }}>
                  {tofViewOnly
                    ? session.powderOverlay
                      ? `Powder (TOF) · GSAS-II fit residual ≈ ${wRpct}%`
                      : "Powder (TOF) · view-only (no TOF calibration loaded)"
                    : `Powder${powderIsTof ? " (TOF)" : ""} · profile R ≈ ${wRpct}% (live)`}
                  {fitRangeActive && ` · fit range ${displayFitRange.min.toFixed(2)}–${displayFitRange.max.toFixed(2)} ${axisShortLabel(effectiveUnit)}`}.
                  {!tofViewOnly && (
                    <>
                      {" "}Drag the blue handles to set the fit range.
                      {fitRangeActive && (
                        <button style={{ ...btn, padding: "1px 8px", marginLeft: 6, fontSize: 11 }} onClick={() => setFitRange(null)}>
                          Reset range
                        </button>
                      )}
                    </>
                  )}
                </p>
              </div>
              <div style={{ minWidth: 320, flex: 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>Powder parameters</strong>
                  <SourceTag source={powderSource} synthetic={SYNTHETIC_SOURCE} />
                </div>
                <ParameterTable parameters={powderParams} esd={powderResult?.esd} onChange={patchPowder} />
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button style={btnPrimary} disabled={busy !== null || tofViewOnly} onClick={() => runPowder(false)}>{busy === "powder" ? "Refining…" : "Refine selected"}</button>
                  <button style={btn} disabled={busy !== null || tofViewOnly} onClick={() => runPowder(true)} title="Staged: scale → background → cell → profile → ADP → positions">Guided (staged)</button>
                  <label style={controlLabel}>
                    Background terms
                    <input
                      type="number"
                      min={0}
                      max={20}
                      step={1}
                      value={session.backgroundTerms}
                      disabled={busy !== null || tofViewOnly}
                      onChange={(e) => setBackgroundTerms(Number(e.target.value))}
                      style={numberInput}
                    />
                  </label>
                  <label style={{ fontSize: 12, color: "#444", display: "flex", gap: 4, alignItems: "center" }}>
                    <input type="checkbox" checked={session.powderProfile.lorentz !== false} onChange={(e) => setSession((s) => ({ ...s, powderProfile: { ...s.powderProfile, lorentz: e.target.checked } }))} /> Lorentz
                  </label>
                  <button style={btn} onClick={() => downloadText(`${pattern.id}.csv`, powderPatternCsv(curves), "text/csv")}>Export CSV</button>
                </div>
                {powderIsTof && !tofViewOnly && (
                  <p style={{ fontSize: 12, color: "#1f5e1f", marginTop: 6, maxWidth: 360 }}>
                    TOF pattern — refined with a <strong>back-to-back-exponential</strong> profile
                    (α rise, β tail, σ Gaussian) placed by difC/difA/difB. The α/β/σ coefficients
                    refine in the profile stage; difC is held at the instrument calibration.
                  </p>
                )}
                {tofViewOnly && (
                  <p style={{ fontSize: 12, color: "#8a1f1f", marginTop: 6, maxWidth: 340 }}>
                    TOF pattern — <strong>view-only</strong>. {session.powderOverlay
                      ? "A GSAS-II CSV was loaded, so its own calc/background is shown as a reference."
                      : "Load a TOF instrument file (.instprm with difC) to place peaks and enable refinement."}
                  </p>
                )}
                {powderResult && <Agreement result={powderResult} />}
              </div>
            </div>
          </div>
        );
      case 3:
        return <QualityPanel structure={structure} powderResult={powderResult} />;
      case 4:
        return (
          <div>
            <h2 style={h2}>Step 5 — Allowed magnetic space groups ({mag.ex.structure.name})</h2>
            <CandidateComparison structure={mag.ex.structure} dataset={mag.dataset} magneticSiteLabels={magSiteLabels} mode="generate" />
          </div>
        );
      case 5:
        return (
          <div>
            <h2 style={h2}>Step 6 — Magnetic refinement ({mag.ex.structure.name})</h2>
            <p style={stepHelp}>Refine moment components (μB, crystal axes) with proper constraints; nuclear and magnetic intensities kept separate.</p>
            <MagneticPanel
              structure={mag.ex.structure}
              magnetic={mag.ex.magnetic}
              parameters={mag.params}
              bindings={magBind}
              rows={magRows}
              result={magResult}
              busy={busy !== null}
              onChange={patchMag}
              onRefine={runMagnetic}
            />
          </div>
        );
      case 6:
        return (
          <div>
            <h2 style={h2}>Step 7 — Compare magnetic space groups</h2>
            <CandidateComparison structure={mag.ex.structure} dataset={mag.dataset} magneticSiteLabels={magSiteLabels} mode="compare" />
          </div>
        );
      default:
        return <div />;
    }
  }
}

function QualityPanel({ structure, powderResult }: { structure: StructureModel; powderResult: RefinementResult | null }): JSX.Element {
  const bonds = bondLengths(structure).slice(0, 12);
  return (
    <div>
      <h2 style={h2}>Step 4 — Refinement quality &amp; structure investigation</h2>
      <p style={stepHelp}>Assess fit quality (R, wR, GoF) and inspect the refined geometry (bond lengths) before proceeding to magnetism.</p>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <div>
          <strong style={{ fontSize: 13 }}>Agreement factors</strong>
          <table style={{ fontSize: 13, marginTop: 6 }}>
            <tbody>
              <tr><td style={kcell}>Powder</td><td>{powderResult ? `wR ${(100 * (powderResult.agreement.rWeighted ?? 0)).toFixed(2)}% · GoF ${(powderResult.agreement.goodnessOfFit ?? 0).toFixed(2)}` : "not refined"}</td></tr>
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: "#666", maxWidth: 320 }}>
            GoF near 1 indicates a fit consistent with the data uncertainties. Much larger values mean an
            incomplete model or underestimated errors.
          </p>
        </div>
        <div>
          <strong style={{ fontSize: 13 }}>Bond lengths (≤ 3.2 Å)</strong>
          <table style={{ fontSize: 12, marginTop: 6 }}>
            <thead><tr><th style={kcell}>pair</th><th style={kcell}>d (Å)</th></tr></thead>
            <tbody>
              {bonds.map((b, i) => (
                <tr key={i}><td style={kcell}>{b.from}–{b.to}</td><td style={kcell}>{b.distance.toFixed(3)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
    <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: "#666", marginRight: 2 }}>x-axis:</span>
      {units.map((u) => (
        <button
          key={u}
          onClick={() => onChange(u)}
          style={{ ...unitChip, ...(u === value ? unitChipActive : {}) }}
          title={axisLabel(u)}
        >
          {axisShortLabel(u)}
        </button>
      ))}
    </div>
  );
}

function SourceTag({ source, synthetic }: { source: string; synthetic: string }): JSX.Element {
  const isSynthetic = source === synthetic;
  return (
    <span style={{
      fontSize: 12,
      padding: "1px 8px",
      borderRadius: 10,
      background: isSynthetic ? "#fff4f4" : "#eaf4ea",
      border: `1px solid ${isSynthetic ? "#f0c0c0" : "#bcdcbc"}`,
      color: isSynthetic ? "#8a1f1f" : "#1f5e1f",
    }}>
      {isSynthetic ? "⚠ synthetic demo" : `✓ loaded: ${source}`}
    </span>
  );
}

function Agreement({ result }: { result: RefinementResult }): JSX.Element {
  const a = result.agreement;
  const d = result.diagnostics;
  const hasDiagnostics =
    d !== undefined && (d.svdZeroCount > 0 || d.highCorrelations.length > 0 || d.atBounds.length > 0);
  return (
    <div style={{ marginTop: 12, fontSize: 13 }}>
      <strong>Result:</strong> {result.status} · R = {(100 * a.rFactor).toFixed(2)}%
      {a.rWeighted !== undefined && <> · wR = {(100 * a.rWeighted).toFixed(2)}%</>}
      {a.goodnessOfFit !== undefined && <> · GoF = {a.goodnessOfFit.toFixed(2)}</>}
      {d && hasDiagnostics && (
        <div style={diagnosticsBox}>
          {d.svdZeroCount > 0 && (
            <div>
              SVD dropped {d.svdZeroCount} near-null direction{d.svdZeroCount === 1 ? "" : "s"}
              {d.singularParameterIds.length > 0 ? `: ${d.singularParameterIds.join(", ")}` : ""}.
            </div>
          )}
          {d.highCorrelations.length > 0 && (
            <div>
              High correlation: {d.highCorrelations.slice(0, 4).map((c) =>
                `${c.parameterIdA}/${c.parameterIdB} ${c.coefficient.toFixed(3)}`,
              ).join("; ")}
            </div>
          )}
          {d.atBounds.length > 0 && (
            <div>
              At bound (not converged — value/esd unreliable): {d.atBounds.map((b) =>
                `${b.parameterId} (${b.bound})`,
              ).join(", ")}.
            </div>
          )}
        </div>
      )}
      <details style={{ marginTop: 6 }}>
        <summary>Refinement history ({result.history.length} cycles)</summary>
        <table style={{ fontSize: 12, marginTop: 4 }}>
          <thead><tr><th style={kcell}>cycle</th><th style={kcell}>χ²</th><th style={kcell}>wR %</th></tr></thead>
          <tbody>
            {result.history.map((h) => (
              <tr key={h.iteration}>
                <td style={kcell}>{h.iteration}</td>
                <td style={kcell}>{h.chiSquared.toPrecision(5)}</td>
                <td style={kcell}>{(100 * (h.agreement.rWeighted ?? 0)).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const page: React.CSSProperties = { fontFamily: "system-ui, sans-serif", maxWidth: 1120, margin: "0 auto", padding: "24px 20px", color: "#222" };
const disclaimer: React.CSSProperties = { background: "#fff4f4", border: "1px solid #f0c0c0", color: "#8a1f1f", padding: "6px 10px", borderRadius: 6, fontSize: 12, marginTop: 8 };
const bar: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "16px 0" };
const card: React.CSSProperties = { border: "1px solid #e3e3e3", borderRadius: 10, padding: 16, marginBottom: 16, background: "#fafafa" };
const h2: React.CSSProperties = { margin: "0 0 12px", fontSize: 17 };
const kcell: React.CSSProperties = { padding: "2px 10px 2px 0", color: "#444", verticalAlign: "top" };
const diagnosticsBox: React.CSSProperties = { marginTop: 6, padding: "6px 8px", background: "#fff8e7", border: "1px solid #ead49b", borderRadius: 6, color: "#5a4100", lineHeight: 1.4 };
const controlLabel: React.CSSProperties = { fontSize: 12, color: "#444", display: "flex", gap: 6, alignItems: "center" };
const numberInput: React.CSSProperties = { width: 54, padding: "4px 6px", border: "1px solid #bbb", borderRadius: 6, fontSize: 12 };
const btn: React.CSSProperties = { border: "1px solid #bbb", background: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13 };
const btnPrimary: React.CSSProperties = { ...btn, background: "#1f4e79", color: "#fff", border: "1px solid #1f4e79" };
const stepNav: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 12px" };
const stepChip: React.CSSProperties = { border: "1px solid #ccc", background: "#fff", borderRadius: 16, padding: "4px 12px", cursor: "pointer", fontSize: 12, color: "#555" };
const stepChipActive: React.CSSProperties = { background: "#1f4e79", color: "#fff", border: "1px solid #1f4e79", fontWeight: 600 };
const stepHelp: React.CSSProperties = { fontSize: 13, color: "#555", marginTop: 0 };
const unitChip: React.CSSProperties = { border: "1px solid #ccc", background: "#fff", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12, color: "#555", minWidth: 30 };
const unitChipActive: React.CSSProperties = { background: "#1f4e79", color: "#fff", border: "1px solid #1f4e79", fontWeight: 600 };
