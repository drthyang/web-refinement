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
import { magneticComparison } from "@/core/workflow/magnetic";
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
}

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
  const [message, setMessage] = useState<string>("Loaded bundled example: Mn₃Ga (P6₃/mmc).");
  const client = useRef<ComputeClient>(new ComputeClient());

  const { structure, pattern, powderParams, scDataset, scParams } = session;
  const pBindings = useMemo(() => powderBindings(structure.id, pattern.id), [structure.id, pattern.id]);
  const scBind = useMemo(() => singleCrystalBindings(scDataset.id), [scDataset.id]);

  const curves = useMemo(
    () => powderCurves(structure, pattern, powderParams, pBindings),
    [structure, pattern, powderParams, pBindings],
  );
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

  function onLoadInstrument(file: File): void {
    file.text().then((text) => {
      try {
        const parsed = parseInstrumentParameters(text);
        setInstrument(parsed);
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

  const wRpct = (100 * (curves.yObs.reduce((a, o, i) => a + Math.abs(o - (curves.yCalc[i] ?? 0)), 0) /
    Math.max(curves.yObs.reduce((a, o) => a + Math.abs(o), 0), 1e-9))).toFixed(1);

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
              Load an instrument parameter file (GSAS-II <code>.instprm</code>: TOF difC/difA/difB/Zero, or
              a wavelength). The demo uses a synthetic constant-wavelength pattern; a loaded instrument
              sets the abscissa calibration.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
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
            <div style={{ overflowX: "auto" }}>
              <PatternPlot curves={curves} xLabel={instrument.kind === "tof" ? "TOF (µs)" : "2θ (°)"} />
              <p style={{ fontSize: 12, color: "#666" }}>Observed data preview ({pattern.points.length} points).</p>
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
                <PatternPlot curves={curves} xLabel="2θ (°)" />
                <p style={{ fontSize: 12, color: "#666" }}>Powder · profile R ≈ {wRpct}% (live).</p>
                <div style={{ marginTop: 12 }}><ScatterPlot rows={scRows} /></div>
                <p style={{ fontSize: 12, color: "#666" }}>Single crystal · I(obs) vs I(calc).</p>
              </div>
              <div style={{ minWidth: 320, flex: 1 }}>
                <strong style={{ fontSize: 13 }}>Powder parameters</strong>
                <ParameterTable parameters={powderParams} esd={powderResult?.esd} onChange={patchPowder} />
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button style={btnPrimary} disabled={busy !== null} onClick={runPowder}>{busy === "powder" ? "Refining…" : "Refine powder"}</button>
                  <button style={btn} onClick={() => downloadText(`${pattern.id}.csv`, powderPatternCsv(curves), "text/csv")}>Export CSV</button>
                </div>
                {powderResult && <Agreement result={powderResult} />}
                <div style={{ marginTop: 16 }}>
                  <strong style={{ fontSize: 13 }}>Single-crystal parameters</strong>
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
