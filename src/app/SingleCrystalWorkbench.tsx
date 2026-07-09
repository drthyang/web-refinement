/**
 * Single-crystal F² refinement page (Roadmap M7 UI). Mirrors the powder
 * workbench's guided shape — merge report → free parameters → refine → F_obs vs
 * F_calc with SHELX R1/wR2/GooF — but against integrated Bragg intensities,
 * driven entirely by the single-crystal core (`buildSingleCrystalSpec`,
 * `buildSingleCrystalRefinementProblem`, `singleCrystalRefinementComparison`).
 *
 * Self-contained: it owns its parameter/result state and its own CIF export, so
 * the powder path in App is untouched. The root mounts it (keyed on the dataset)
 * whenever single-crystal data is loaded.
 */

import { useMemo, useState } from "react";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { RefinementResult } from "@/core/refinement/types";
import { refine } from "@/core/refinement/engine";
import { mergeEquivalents } from "@/core/diffraction/merge";
import {
  buildSingleCrystalSpec,
  guidedSingleCrystalParams,
  buildSingleCrystalRefinementProblem,
  singleCrystalRefinementComparison,
} from "@/core/workflow/singleCrystalRefinement";
import { normalProbabilityPlot } from "@/core/refinement/diagnostics";
import { dSpacing } from "@/core/crystal/unitCell";
import { ParameterTable } from "@/components/ParameterTable";
import { QualityPlots } from "@/app/ui/QualityPlots";
import { structureToCif, type CifRefinementMeta } from "@/core/export/cif";
import { downloadText } from "@/app/download";
import { color, mono, sans, radius, fz } from "@/app/theme";

const card: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.card,
  padding: "16px 18px",
};
const kicker: React.CSSProperties = { fontSize: fz.micro, letterSpacing: "0.08em", color: color.faint, fontWeight: 650 };
const stat = (label: string, value: string, hint?: string): JSX.Element => (
  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
    <span style={{ fontFamily: mono, fontSize: 17, color: color.ink, fontWeight: 600 }}>{value}</span>
    <span style={{ fontSize: fz.micro, color: color.secondary }}>{label}</span>
    {hint ? <span style={{ fontSize: fz.micro, color: color.faint }}>{hint}</span> : null}
  </div>
);

export function SingleCrystalWorkbench({ structure, dataset, onLoadData, onLoadCif }: {
  structure: StructureModel;
  dataset: SingleCrystalDataset;
  /** Load a different dataset — powder here switches the app back to powder mode. */
  onLoadData?: (file: File) => void;
  /** Load a different structure (CIF). */
  onLoadCif?: (file: File) => void;
}): JSX.Element {
  const spec = useMemo(() => buildSingleCrystalSpec(structure, dataset, { extinction: 0 }), [structure, dataset]);
  const bindings = spec.bindings;
  const [params, setParams] = useState(spec.params);
  const [result, setResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Laue-equivalent merge report (data quality — R_int, redundancy).
  const merge = useMemo(
    () => mergeEquivalents(
      dataset.reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, intensity: r.iObs, sigma: r.sigma ?? 0 })),
      structure.spaceGroup.operations,
    ),
    [dataset, structure],
  );

  // Live obs/calc comparison + SHELX agreement for the current parameters.
  const comparison = useMemo(
    () => singleCrystalRefinementComparison(structure, dataset, params, bindings),
    [structure, dataset, params, bindings],
  );

  // Reuse the powder quality plots: F_obs/F_calc scatter (√Fo² vs √Fc²) + the
  // normal-probability plot over the standardized residuals (Fo²−Fc²)/σ.
  const obsCalc: ReflectionObsCalc[] = useMemo(
    () => comparison.rows.map((r) => ({
      kind: "nuclear" as const,
      h: r.h, k: r.k, l: r.l,
      d: dSpacing(structure.cell, r.h, r.k, r.l),
      iObs: r.foSq, iCalc: r.fcSq,
    })),
    [comparison, structure],
  );
  const npp = useMemo(() => normalProbabilityPlot(comparison.rows.map((r) => r.deltaOverSigma)), [comparison]);

  // Largest standardized-residual outliers (bad/wrongly-measured reflections).
  const outliers = useMemo(
    () => [...comparison.rows].sort((a, b) => Math.abs(b.deltaOverSigma) - Math.abs(a.deltaOverSigma)).slice(0, 6),
    [comparison],
  );

  const nFree = params.filter((p) => !p.fixed && !p.expression).length;

  function runRefine(guided: boolean): void {
    setBusy(true);
    // Defer so the "Refining…" state paints before the synchronous solve.
    setTimeout(() => {
      const start = guided ? guidedSingleCrystalParams(params) : params;
      const problem = buildSingleCrystalRefinementProblem(structure, dataset, start, bindings);
      const res = refine(problem, { maxIterations: 25 });
      setParams(start.map((p) => ({ ...p, value: res.parameters[p.id] ?? p.value, ...(guided ? { fixed: false } : {}) })));
      setResult(res);
      setBusy(false);
    }, 0);
  }

  function onParamChange(id: string, patch: Partial<typeof params[number]>): void {
    setParams((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function reset(): void {
    setParams(spec.params.map((p) => ({ ...p, value: p.initialValue })));
    setResult(null);
  }

  function exportCif(): void {
    const withEsd = params.map((p) => {
      const e = result?.esd[p.id];
      return e !== undefined ? { ...p, esd: e } : { ...p };
    });
    const meta: CifRefinementMeta = {
      r1: comparison.agreement.r1,
      wr2: comparison.agreement.wr2,
      gof: comparison.agreement.goof,
      nRef: dataset.reflections.length,
      nParam: nFree,
    };
    downloadText(`${structure.id}.cif`, structureToCif(structure, { params: withEsd, bindings, refinement: meta }), "chemical/x-cif");
  }

  const ag = comparison.agreement;
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 20px" }}>
      {/* Merge / data-quality report */}
      <div style={{ ...card, display: "flex", flexWrap: "wrap", gap: 28, alignItems: "center" }}>
        <div style={{ minWidth: 200 }}>
          <div style={kicker}>SINGLE CRYSTAL — {structure.name}</div>
          <div style={{ fontSize: 13, color: color.secondary, marginTop: 4 }}>
            {dataset.radiation.kind === "neutron" ? "Neutron" : dataset.radiation.kind === "xray" ? "X-ray" : "TOF"} · {structure.spaceGroup.hermannMauguin ?? "—"} · {dataset.name}
          </div>
        </div>
        {stat("observations", `${merge.statistics.observations}`)}
        {stat("unique", `${merge.statistics.unique}`)}
        {stat("redundancy", merge.statistics.redundancy.toFixed(2))}
        {stat("R_int", pct(merge.statistics.rInt), "Laue-equivalent agreement")}
        {stat("R_sigma", pct(merge.statistics.rSigma))}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {onLoadCif ? <FileButton label="Load CIF…" accept=".cif,text/plain" onFile={onLoadCif} /> : null}
          {onLoadData ? <FileButton label="Load data…" accept=".xye,.xy,.dat,.txt,.gr,.hkl,.fcf,.int,.csv,.gsa,.gss,.fxye,text/plain" onFile={onLoadData} /> : null}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.1fr) minmax(300px, 1fr)", gap: 16, alignItems: "start" }}>
        {/* Results: agreement + quality plots + outliers */}
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div style={kicker}>REFINEMENT QUALITY (F²)</div>
            <div style={{ display: "flex", gap: 18 }}>
              {stat("R1", pct(ag.r1), `${ag.observed}/${ag.total} obs > 2σ`)}
              {stat("wR2", pct(ag.wr2))}
              {stat("GooF", ag.goof.toFixed(3))}
            </div>
          </div>
          <QualityPlots obsCalc={obsCalc} npp={npp} />
          <div>
            <div style={{ ...kicker, marginBottom: 6 }}>LARGEST OUTLIERS (Fo²−Fc²)/σ</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: mono, fontSize: fz.small }}>
              {outliers.map((r) => (
                <div key={`${r.h} ${r.k} ${r.l}`} style={{ display: "flex", justifyContent: "space-between", color: color.secondary }}>
                  <span>({r.h} {r.k} {r.l})</span>
                  <span>Fo² {r.foSq.toFixed(1)} · Fc² {r.fcSq.toFixed(1)}</span>
                  <span style={{ color: Math.abs(r.deltaOverSigma) > 4 ? color.primary : color.faint }}>{r.deltaOverSigma >= 0 ? "+" : ""}{r.deltaOverSigma.toFixed(1)}σ</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Parameters + actions */}
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={kicker}>PARAMETERS — {nFree} of {params.length} free</div>
            <button onClick={reset} style={ghostBtn}>Reset</button>
          </div>
          <ParameterTable parameters={params} esd={result?.esd} onChange={onParamChange} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            <button onClick={() => runRefine(false)} disabled={busy} style={primaryBtn}>{busy ? "Refining…" : "Refine"}</button>
            <button onClick={() => runRefine(true)} disabled={busy} style={ghostBtn}>Refine (free structure)</button>
            <button onClick={exportCif} style={ghostBtn}>Export CIF</button>
          </div>
          {result ? (
            <div style={{ fontSize: fz.small, color: color.secondary }}>
              {result.status === "converged" ? "Converged" : result.status} · {result.history.length} cycles
              {result.message ? ` · ${result.message}` : ""}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A compact file-input styled as a ghost button (label wraps a hidden input). */
function FileButton({ label, accept, onFile }: { label: string; accept: string; onFile: (file: File) => void }): JSX.Element {
  return (
    <label style={{ ...ghostBtn, display: "inline-flex", alignItems: "center" }}>
      {label}
      <input
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = ""; // allow re-loading the same filename
        }}
      />
    </label>
  );
}

const primaryBtn: React.CSSProperties = {
  background: color.primary, color: "#fff", border: `1px solid ${color.primary}`,
  borderRadius: radius.button, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: sans,
};
const ghostBtn: React.CSSProperties = {
  background: color.surface, color: color.ink, border: `1px solid ${color.control}`,
  borderRadius: radius.button, padding: "8px 16px", fontSize: 13, fontWeight: 550, cursor: "pointer", fontFamily: sans,
};
