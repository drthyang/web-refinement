import { useMemo, useRef, useState } from "react";
import { APP_NAME, APP_VERSION, PROJECT_SCHEMA_VERSION } from "@/app/constants";
import { downloadText } from "@/app/download";
import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset } from "@/core/diffraction/types";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ProjectFile } from "@/core/project/types";
import { cellVolume } from "@/core/crystal/unitCell";
import { powderCurves } from "@/core/workflow/powder";
import { singleCrystalComparison } from "@/core/workflow/singleCrystal";
import { reflectionTableCsv, powderPatternCsv, projectJson } from "@/core/export/exporters";
import { parseMagneticCif } from "@/parsers/cif";
import { parsePowderData } from "@/parsers/powderData";
import { parseGsasCsvPattern } from "@/parsers/gsasPattern";
import { detectDataFormat, type DetectedFormat } from "@/parsers/detectFormat";
import { magneticComparison } from "@/core/workflow/magnetic";
import type { ParameterBinding } from "@/core/refinement/types";
import {
  startingPowderParams,
  loadReflectionDataset,
  structuralParameters,
} from "@/app/loadData";
import { ComputeClient } from "@/workers/computeClient";
import { exampleStructure } from "@/examples/mn3ga";
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
import {
  buildSyntheticPowder,
  buildSyntheticSingleCrystal,
  powderBindings,
  powderParameters,
  singleCrystalBindings,
  singleCrystalParameters,
} from "@/examples/synthetic";
import { ParameterTable } from "@/components/ParameterTable";
import { CandidateComparison } from "@/components/CandidateComparison";
import { PatternPlot } from "@/visualization/PatternPlot";
import { ScatterPlot } from "@/visualization/ScatterPlot";
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

interface Session {
  structure: StructureModel;
  pattern: PowderPattern;
  powderParams: RefinementParameter[];
  scDataset: SingleCrystalDataset;
  scParams: RefinementParameter[];
  /** Custom single-crystal bindings (e.g. structural B refinement); scale-only when absent. */
  scBindings?: ParameterBinding[];
  /** GSAS-II's own calc/background overlay for a view-only (TOF) pattern. */
  powderOverlay?: { calc: number[]; background: number[] } | null;
  /** Provenance of the observed data driving each refinement. */
  powderSource: string;
  scSource: string;
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

function newSession(structure: StructureModel): Session {
  return {
    structure,
    pattern: buildSyntheticPowder(structure),
    powderParams: powderParameters(structure, 40), // start off the true value
    scDataset: buildSyntheticSingleCrystal(structure),
    scParams: singleCrystalParameters(2),
    powderSource: SYNTHETIC_SOURCE,
    scSource: SYNTHETIC_SOURCE,
  };
}

export function App(): JSX.Element {
  const [session, setSession] = useState<Session>(() => newSession(exampleStructure()));
  const [powderResult, setPowderResult] = useState<RefinementResult | null>(null);
  const [scResult, setScResult] = useState<RefinementResult | null>(null);
  const [mag, setMag] = useState(() => makeMagnetic(exampleMagnetic()));
  const [magResult, setMagResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [instrument, setInstrument] = useState<InstrumentParameters>({ kind: "constantWavelength", wavelength: 1.54 });
  const [instrumentLoaded, setInstrumentLoaded] = useState(false);
  const [message, setMessage] = useState<string>("Loaded bundled example: Mn₃Ga (P6₃/mmc).");
  const client = useRef<ComputeClient>(new ComputeClient());

  const { structure, pattern, powderParams, scDataset, scParams, powderSource, scSource } = session;
  const powderIsTof = pattern.xUnit === "tof";
  const powderXLabel = pattern.xUnit === "twoTheta" ? "2θ (°)" : UNIT_LABEL[pattern.xUnit] ?? "x";
  const pBindings = useMemo(() => powderBindings(structure.id, pattern.id), [structure.id, pattern.id]);
  const scBind = useMemo(
    () => session.scBindings ?? singleCrystalBindings(scDataset.id),
    [session.scBindings, scDataset.id],
  );

  const curves = useMemo(() => {
    // TOF patterns cannot be profile-fit by the minimal engine; show the observed
    // data with GSAS-II's own calc/background as a faithful reference overlay.
    if (powderIsTof && session.powderOverlay) {
      const x = pattern.points.map((p) => p.x);
      const yObs = pattern.points.map((p) => p.yObs);
      const yCalc = session.powderOverlay.calc;
      return { x, yObs, yCalc, diff: yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
    }
    return powderCurves(structure, pattern, powderParams, pBindings);
  }, [structure, pattern, powderParams, pBindings, powderIsTof, session.powderOverlay]);
  const scRows = useMemo(
    () => singleCrystalComparison(structure, scDataset, scParams, scBind),
    [structure, scDataset, scParams, scBind],
  );
  const magBind = useMemo(() => magneticBindings(mag.ex.magnetic), [mag.ex.magnetic]);
  const magRows = useMemo(
    () => magneticComparison(mag.ex.structure, mag.ex.magnetic, mag.dataset, mag.params, magBind),
    [mag, magBind],
  );

  function patchPowder(id: string, patch: Partial<RefinementParameter>): void {
    setSession((s) => ({ ...s, powderParams: s.powderParams.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }
  function patchSc(id: string, patch: Partial<RefinementParameter>): void {
    setSession((s) => ({ ...s, scParams: s.scParams.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }
  function patchMag(id: string, patch: Partial<RefinementParameter>): void {
    setMag((m) => ({ ...m, params: m.params.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
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

  async function runPowder(): Promise<void> {
    setBusy("powder");
    try {
      const result = await client.current.refinePowder({
        structure, pattern, parameters: powderParams, bindings: pBindings, shape: "gaussian",
        options: { maxIterations: 20 },
      });
      setSession((s) => ({
        ...s,
        powderParams: s.powderParams.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value })),
      }));
      setPowderResult(result);
      setMessage(`Powder refinement ${result.status}: wR = ${(100 * (result.agreement.rWeighted ?? 0)).toFixed(2)}%.`);
    } catch (e) {
      setMessage(`Powder refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function runSingleCrystal(): Promise<void> {
    setBusy("sc");
    try {
      const result = await client.current.refineSingleCrystal({
        structure, dataset: scDataset, parameters: scParams, bindings: scBind,
        options: { maxIterations: 20 },
      });
      setSession((s) => ({
        ...s,
        scParams: s.scParams.map((p) => ({ ...p, value: result.parameters[p.id] ?? p.value })),
      }));
      setScResult(result);
      setMessage(`Single-crystal refinement ${result.status}: R = ${(100 * result.agreement.rFactor).toFixed(2)}%.`);
    } catch (e) {
      setMessage(`Single-crystal refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function onLoadCif(file: File): void {
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
        setSession(newSession({ ...parsed, id: "loaded" }));
        setPowderResult(null);
        setScResult(null);
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
          applyReflections(text, file.name, tag);
        } else {
          applyPowder(text, file.name, fmt, tag);
        }
      } catch (e) {
        setMessage(`Data load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  function applyPowder(text: string, filename: string, fmt: DetectedFormat, tag: string): void {
    const id = `${structure.id}-powder`;
    const isGsasCsv = /(^|,)\s*"?obs"?\s*,/i.test(text) && /calc/i.test(text);
    if (fmt.xUnit === "tof") {
      // TOF: view-only (engine profile-fits constant-wavelength only).
      const overlay = isGsasCsv ? parseGsasCsvPattern(text, id, filename) : null;
      const parsed = overlay
        ? overlay.pattern
        : parsePowderData(text, { id, name: filename, xUnit: "tof", radiation: { kind: "neutron-tof" } });
      if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
      setSession((s) => ({
        ...s,
        pattern: parsed,
        powderParams: startingPowderParams(structure, parsed, powderBindings(structure.id, id)),
        powderOverlay: overlay ? { calc: overlay.calc, background: overlay.background } : null,
        powderSource: filename,
      }));
      setPowderResult(null);
      setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · unit=TOF ${tag} (view-only — TOF profile fitting not in engine). ${fmt.note}`);
      return;
    }
    const parsed = parsePowderData(text, { id, name: filename, xUnit: fmt.xUnit, radiation: fmt.radiation, ...(fmt.radiation.kind !== "neutron-tof" ? { wavelength: fmt.radiation.wavelength } : {}) });
    if (parsed.points.length < 3) throw new Error("fewer than 3 usable data rows");
    const bindings = powderBindings(structure.id, id);
    setSession((s) => ({ ...s, pattern: parsed, powderParams: startingPowderParams(structure, parsed, bindings), powderOverlay: null, powderSource: filename }));
    setPowderResult(null);
    setMessage(`Loaded powder “${filename}” · ${parsed.points.length} pts · unit=${fmt.xUnit} ${tag}. Scale auto-estimated — click “Refine powder”. ${fmt.note}`);
  }

  function applyReflections(text: string, filename: string, tag: string): void {
    const id = `${structure.id}-refl`;
    const loaded = loadReflectionDataset(text, structure, id, filename);
    if (loaded.kept < 2) throw new Error("fewer than 2 reflections matched this structure's cell");
    const { parameters, bindings } = structuralParameters(structure, loaded.dataset);
    setSession((s) => ({ ...s, scDataset: loaded.dataset, scParams: parameters, scBindings: bindings, scSource: filename }));
    setScResult(null);
    const phaseNote = loaded.dropped > 0 ? ` (${loaded.dropped} dropped — other phase, e.g. impurity)` : "";
    setMessage(`Loaded reflections “${filename}” · single-crystal ${tag} · ${loaded.kept} match phase${phaseNote}. Refining scale + B — click “Refine SX”.`);
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
      datasets: [pattern, scDataset],
      parameters: [...powderParams, ...scParams],
      bindings: [...pBindings, ...scBind],
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
          v{APP_VERSION} · atomic/nuclear refinement · single-crystal &amp; powder
        </p>
        <p style={disclaimer}>
          Not a replacement for GSAS-II, FullProf, Jana2020, or ShelX. Results for publication must be
          validated against established tools.
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
        <button style={btn} onClick={() => setSession(newSession(exampleStructure()))}>Reset to example</button>
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
              Load your <strong>observed data</strong> — the reader auto-detects powder vs
              single-crystal and the x-axis unit (2θ / Q / d / TOF) from the file header, the loaded
              instrument, or the data range. Powder is <code>x&nbsp;y&nbsp;[σ]</code>; single-crystal
              is a reflection list <code>h&nbsp;k&nbsp;l&nbsp;Iobs&nbsp;[σ]</code> (incl. GSAS-II
              <code>_hkl.dat</code>). Load an instrument file for the authoritative calibration.
              Until you load data the workbench uses a synthetic demo pattern.
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
                <tr><td style={kcell}>Reflection source</td><td><SourceTag source={scSource} synthetic={SYNTHETIC_SOURCE} /> · {scDataset.reflections.length} hkl</td></tr>
              </tbody>
            </table>
            <div style={{ overflowX: "auto" }}>
              <PatternPlot curves={curves} xLabel={powderXLabel} />
              <p style={{ fontSize: 12, color: "#666" }}>
                {powderIsTof ? "Observed (points) with GSAS-II fit overlay" : "Observed data preview"} ({pattern.points.length} points).
              </p>
            </div>
          </div>
        );
      case 2:
        return (
          <div>
            <h2 style={h2}>Step 3 — Structural refinement (with constraints)</h2>
            <p style={stepHelp}>Toggle “Refine” per parameter (fixed/free constraints). Refine scale, cell, background, coordinates.</p>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div style={{ overflowX: "auto" }}>
                <PatternPlot curves={curves} xLabel={powderXLabel} />
                <p style={{ fontSize: 12, color: "#666" }}>
                  {powderIsTof ? `Powder (TOF) · GSAS-II fit residual ≈ ${wRpct}%` : `Powder · profile R ≈ ${wRpct}% (live)`}.
                </p>
                <div style={{ marginTop: 12 }}><ScatterPlot rows={scRows} /></div>
                <p style={{ fontSize: 12, color: "#666" }}>Single crystal · I(obs) vs I(calc).</p>
              </div>
              <div style={{ minWidth: 320, flex: 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>Powder parameters</strong>
                  <SourceTag source={powderSource} synthetic={SYNTHETIC_SOURCE} />
                </div>
                <ParameterTable parameters={powderParams} esd={powderResult?.esd} onChange={patchPowder} />
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button style={btnPrimary} disabled={busy !== null || powderIsTof} onClick={runPowder}>{busy === "powder" ? "Refining…" : "Refine powder"}</button>
                  <button style={btn} onClick={() => downloadText(`${pattern.id}.csv`, powderPatternCsv(curves), "text/csv")}>Export CSV</button>
                </div>
                {powderIsTof && (
                  <p style={{ fontSize: 12, color: "#8a1f1f", marginTop: 6, maxWidth: 340 }}>
                    TOF pattern loaded — the plot shows the observed data with GSAS-II's own fit as an
                    overlay. The minimal engine profile-fits constant-wavelength data only, so powder
                    refinement is disabled here; use the reflection-intensity refinement instead.
                  </p>
                )}
                {powderResult && <Agreement result={powderResult} />}
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13 }}>Single-crystal parameters</strong>
                    <SourceTag source={scSource} synthetic={SYNTHETIC_SOURCE} />
                  </div>
                  <ParameterTable parameters={scParams} esd={scResult?.esd} onChange={patchSc} />
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <button style={btnPrimary} disabled={busy !== null} onClick={runSingleCrystal}>{busy === "sc" ? "Refining…" : "Refine SX"}</button>
                    <button style={btn} onClick={() => downloadText(`${scDataset.id}.csv`, reflectionTableCsv(scRows), "text/csv")}>Export CSV</button>
                  </div>
                  {scResult && <Agreement result={scResult} />}
                </div>
              </div>
            </div>
          </div>
        );
      case 3:
        return <QualityPanel structure={structure} powderResult={powderResult} scResult={scResult} />;
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

function QualityPanel({ structure, powderResult, scResult }: { structure: StructureModel; powderResult: RefinementResult | null; scResult: RefinementResult | null }): JSX.Element {
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
              <tr><td style={kcell}>Single crystal</td><td>{scResult ? `R ${(100 * scResult.agreement.rFactor).toFixed(2)}%` : "not refined"}</td></tr>
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
  return (
    <div style={{ marginTop: 12, fontSize: 13 }}>
      <strong>Result:</strong> {result.status} · R = {(100 * a.rFactor).toFixed(2)}%
      {a.rWeighted !== undefined && <> · wR = {(100 * a.rWeighted).toFixed(2)}%</>}
      {a.goodnessOfFit !== undefined && <> · GoF = {a.goodnessOfFit.toFixed(2)}</>}
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
const btn: React.CSSProperties = { border: "1px solid #bbb", background: "#fff", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13 };
const btnPrimary: React.CSSProperties = { ...btn, background: "#1f4e79", color: "#fff", border: "1px solid #1f4e79" };
const stepNav: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 12px" };
const stepChip: React.CSSProperties = { border: "1px solid #ccc", background: "#fff", borderRadius: 16, padding: "4px 12px", cursor: "pointer", fontSize: 12, color: "#555" };
const stepChipActive: React.CSSProperties = { background: "#1f4e79", color: "#fff", border: "1px solid #1f4e79", fontWeight: 600 };
const stepHelp: React.CSSProperties = { fontSize: 13, color: "#555", marginTop: 0 };
