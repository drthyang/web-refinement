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
import { PatternPlot } from "@/visualization/PatternPlot";
import { ScatterPlot } from "@/visualization/ScatterPlot";

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

      <section style={card}>
        <h2 style={h2}>Structure — {structure.name}</h2>
        <table style={{ fontSize: 13 }}>
          <tbody>
            <tr><td style={kcell}>Space group</td><td>{structure.spaceGroup.hermannMauguin ?? "(from ops)"} · {structure.spaceGroup.operations.length} ops</td></tr>
            <tr><td style={kcell}>Cell</td><td>a={structure.cell.a.toFixed(4)} b={structure.cell.b.toFixed(4)} c={structure.cell.c.toFixed(4)} Å · α={structure.cell.alpha} β={structure.cell.beta} γ={structure.cell.gamma}°</td></tr>
            <tr><td style={kcell}>Volume</td><td>{cellVolume(structure.cell).toFixed(3)} Å³</td></tr>
            <tr><td style={kcell}>Sites</td><td>{structure.sites.map((s) => `${s.label}(${s.element}) occ ${s.occupancy.toFixed(3)}`).join(", ")}</td></tr>
          </tbody>
        </table>
      </section>

      <section style={card}>
        <h2 style={h2}>Powder refinement</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={{ overflowX: "auto" }}>
            <PatternPlot curves={curves} xLabel="2θ (°)" />
            <p style={{ fontSize: 12, color: "#666" }}>Current profile R ≈ {wRpct}% (unweighted, live).</p>
          </div>
          <div style={{ minWidth: 320, flex: 1 }}>
            <ParameterTable parameters={powderParams} esd={powderResult?.esd} onChange={patchPowder} />
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button style={btnPrimary} disabled={busy !== null} onClick={runPowder}>
                {busy === "powder" ? "Refining…" : "Refine"}
              </button>
              <button style={btn} onClick={() => downloadText(`${pattern.id}.csv`, powderPatternCsv(curves), "text/csv")}>
                Export pattern CSV
              </button>
            </div>
            {powderResult && <Agreement result={powderResult} />}
          </div>
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>Single-crystal refinement</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div><ScatterPlot rows={scRows} /></div>
          <div style={{ minWidth: 320, flex: 1 }}>
            <ParameterTable parameters={scParams} esd={scResult?.esd} onChange={patchSc} />
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button style={btnPrimary} disabled={busy !== null} onClick={runSingleCrystal}>
                {busy === "sc" ? "Refining…" : "Refine"}
              </button>
              <button style={btn} onClick={() => downloadText(`${scDataset.id}.csv`, reflectionTableCsv(scRows), "text/csv")}>
                Export reflections CSV
              </button>
            </div>
            {scResult && <Agreement result={scResult} />}
          </div>
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>Magnetic refinement — {mag.ex.structure.name}</h2>
        <p style={{ fontSize: 12, color: "#666", marginTop: 0 }}>
          Nuclear and magnetic Bragg intensities kept separate; refine moment components (μB, crystal
          axes). Bundled example: Mn₃Ga 30 K (GSAS-II). Load a magnetic CIF to replace it.
        </p>
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
      </section>

      <footer style={{ color: "#888", fontSize: 12, marginTop: 24 }}>
        Bundled example structures from GSAS-II validation data. See docs/VALIDATION.md.
      </footer>
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
const btnPrimary: React.CSSProperties = { ...btn, background: "#1f4e79", color: "#fff", borderColor: "#1f4e79" };
