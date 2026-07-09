/**
 * Single-crystal F² refinement page (Roadmap M7 UI). Shares the powder
 * workbench's design language — SummaryCards row, a themed quality rail, and the
 * collapsible ParameterPanel — but drives the single-crystal core against
 * integrated Bragg intensities (`buildSingleCrystalSpec`,
 * `buildSingleCrystalRefinementProblem`, `singleCrystalRefinementComparison`).
 *
 * Self-contained: it owns its parameter/result state and its own CIF export, so
 * the powder path in App is untouched. The root mounts it (keyed on the dataset)
 * whenever single-crystal data is loaded.
 */

import { lazy, Suspense, useMemo, useState, type CSSProperties } from "react";
import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
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
import { FobsFcalc, NormalProb } from "@/app/ui/QualityPlots";
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { structureToCif, type CifRefinementMeta } from "@/core/export/cif";
import { downloadText } from "@/app/download";
import { card as themeCard, color, mono, fz, uppercaseLabel, secondaryButton } from "@/app/theme";

// Lazy so three.js stays out of the main bundle until the 3D view is opened.
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));

const DATA_ACCEPT = ".xye,.xy,.dat,.txt,.gr,.hkl,.fcf,.int,.csv,.gsa,.gss,.fxye,text/plain";
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const noop = (): void => {};

/** R1 quality bands (fraction): <8 % good · <15 % mediocre · else poor. */
function r1Ink(r1: number): string {
  if (!Number.isFinite(r1)) return color.ink;
  if (r1 < 0.08) return color.okInk;
  if (r1 < 0.15) return color.noteInk;
  return color.warnInk;
}

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
  const [plotKind, setPlotKind] = useState<"fobs" | "npp">("fobs");

  // Outlier filter: reject reflections whose standardized residual |Fo²−Fc²|/σ
  // exceeds `cutoffSigma` (SHELX-style OMIT). Off by default. The threshold is
  // applied against the *current* model, so it stays live as the fit changes.
  const [filterOn, setFilterOn] = useState(false);
  const [cutoffSigma, setCutoffSigma] = useState(6);

  // Comparison over the *full* dataset — the residuals that drive the filter.
  const fullComparison = useMemo(
    () => singleCrystalRefinementComparison(structure, dataset, params, bindings),
    [structure, dataset, params, bindings],
  );
  const activeDataset = useMemo(() => {
    if (!filterOn || cutoffSigma <= 0) return dataset;
    const keep = dataset.reflections.filter((_, i) => Math.abs(fullComparison.rows[i]?.deltaOverSigma ?? 0) <= cutoffSigma);
    return { ...dataset, reflections: keep };
  }, [dataset, filterOn, cutoffSigma, fullComparison]);
  const excluded = dataset.reflections.length - activeDataset.reflections.length;

  // Laue-equivalent merge report (data quality — R_int, redundancy) on the active set.
  const merge = useMemo(
    () => mergeEquivalents(
      activeDataset.reflections.map((r) => ({ h: r.h, k: r.k, l: r.l, intensity: r.iObs, sigma: r.sigma ?? 0 })),
      structure.spaceGroup.operations,
    ),
    [activeDataset, structure],
  );

  // Live obs/calc comparison + SHELX agreement for the current parameters.
  const comparison = useMemo(
    () => (filterOn && excluded > 0 ? singleCrystalRefinementComparison(structure, activeDataset, params, bindings) : fullComparison),
    [structure, activeDataset, params, bindings, filterOn, excluded, fullComparison],
  );

  // Reuse the powder quality plots: F_obs/F_calc (√Fo² vs √Fc²) + the normal-
  // probability plot over the standardized residuals (Fo²−Fc²)/σ.
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
      const problem = buildSingleCrystalRefinementProblem(structure, activeDataset, start, bindings);
      const res = refine(problem, { maxIterations: 25 });
      setParams(start.map((p) => ({ ...p, value: res.parameters[p.id] ?? p.value, ...(guided ? { fixed: false } : {}) })));
      setResult(res);
      setBusy(false);
    }, 0);
  }

  function onParamChange(id: string, patch: Partial<RefinementParameter>): void {
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
      nRef: activeDataset.reflections.length,
      nParam: nFree,
    };
    downloadText(`${structure.id}.cif`, structureToCif(structure, { params: withEsd, bindings, refinement: meta }), "chemical/x-cif");
  }

  const ag = comparison.agreement;
  const st = merge.statistics;
  const cell = structure.cell;
  const probe = dataset.radiation.kind === "xray" ? "X-ray" : dataset.radiation.kind === "neutron" ? "Neutron" : "Neutron TOF";
  const wl = "wavelength" in dataset.radiation ? ` · λ ${dataset.radiation.wavelength} Å` : "";

  const summaryCards: SummaryCardData[] = [
    {
      label: "Structure",
      loadLabel: "Load CIF…",
      accept: ".cif,.mcif,text/plain",
      onFile: onLoadCif ?? noop,
      chip: "✓ parsed",
      title: `${structure.name || "structure"} · ${structure.spaceGroup.hermannMauguin ?? "—"}`,
      meta: `a ${cell.a.toFixed(4)} · b ${cell.b.toFixed(4)} · c ${cell.c.toFixed(4)} Å · ${structure.sites.length} sites`,
    },
    {
      label: "Data · single crystal",
      loadLabel: "Load data…",
      accept: DATA_ACCEPT,
      onFile: onLoadData ?? noop,
      chip: "✓ loaded",
      title: dataset.name,
      meta: `${probe}${wl} · ${st.observations} obs → ${st.unique} unique · R_int ${pct(st.rInt)}`,
    },
  ];

  const refineActions = (
    <>
      <button
        style={{ ...secondaryButton, padding: "7px 13px", ...(busy ? disabledStyle : {}) }}
        disabled={busy}
        onClick={() => runRefine(true)}
        title="Free all symmetry-allowed structural parameters (positions, ADPs) and refine"
      >
        Refine structure
      </button>
      <button
        style={{ ...secondaryButton, padding: "7px 13px" }}
        onClick={exportCif}
        title="Export the current structure as CIF (with esds + agreement factors)"
      >
        Export CIF
      </button>
    </>
  );

  return (
    <>
      <SummaryCards cards={summaryCards} />
      <div className="wb-sc">
        {/* Quality rail: F² agreement + merge stats + F_obs/F_calc beside the 3D model. */}
        <div style={{ ...themeCard, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={uppercaseLabel}>Refinement quality — single crystal (F²)</span>
            <div style={{ display: "flex", gap: 20 }}>
              <Stat value={pct(ag.r1)} label="R1" hint={`${ag.observed}/${ag.total} obs > 2σ`} ink={r1Ink(ag.r1)} />
              <Stat value={pct(ag.wr2)} label="wR2" />
              <Stat value={ag.goof.toFixed(2)} label="GooF" />
            </div>
          </div>

          <div style={mergeStrip}>
            <Stat small value={`${st.observations}`} label={excluded > 0 ? "kept" : "observations"} />
            <Stat small value={`${st.unique}`} label="unique" />
            <Stat small value={st.redundancy.toFixed(2)} label="redundancy" />
            <Stat small value={pct(st.rInt)} label="R_int" />
            <Stat small value={pct(st.rSigma)} label="R_sigma" />
          </div>

          {/* Outlier (σ) reflection filter. */}
          <label style={filterRow} title="Reject reflections whose |Fo²−Fc²|/σ exceeds the threshold against the current model (SHELX-style OMIT)">
            <input type="checkbox" checked={filterOn} onChange={(e) => setFilterOn(e.target.checked)} style={{ accentColor: color.primary }} />
            <span style={{ color: color.secondary }}>Reject reflections with |Δ|/σ &gt;</span>
            <input
              type="number" min={2} step={0.5} value={cutoffSigma}
              disabled={!filterOn}
              onChange={(e) => setCutoffSigma(Math.max(0, Number(e.target.value) || 0))}
              style={{ ...numInput, ...(filterOn ? {} : { opacity: 0.5 }) }}
            />
            <span style={{ color: color.secondary }}>σ</span>
            {filterOn && (
              <span style={{ marginLeft: "auto", fontFamily: mono, color: excluded > 0 ? color.warnInk : color.faint }}>
                {excluded} of {dataset.reflections.length} excluded
              </span>
            )}
          </label>

          {/* One plot at a time (F_obs/F_calc ↔ normal-probability, toggled) beside
              the 3D structure model; stacks when the panel is narrow. */}
          <div className="wb-sc-plots">
            <div>
              <div style={{ display: "flex", gap: 16, marginBottom: 6 }}>
                {(["fobs", "npp"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setPlotKind(k)}
                    style={{
                      ...uppercaseLabel, background: "none", border: "none", padding: "0 0 3px", cursor: "pointer",
                      color: plotKind === k ? color.primary : color.faint,
                      borderBottom: `2px solid ${plotKind === k ? color.primary : "transparent"}`,
                    }}
                  >
                    {k === "fobs" ? "F_obs vs F_calc" : "Normal probability"}
                  </button>
                ))}
              </div>
              {plotKind === "fobs" ? <FobsFcalc rows={obsCalc} /> : <NormalProb npp={npp} />}
            </div>
            <div>
              <div style={{ ...uppercaseLabel, marginBottom: 4 }}>Crystal structure — unit cell</div>
              <Suspense fallback={<div style={{ minHeight: 320, display: "grid", placeItems: "center", color: color.secondary, fontSize: 13 }}>Loading 3D viewer…</div>}>
                <div style={{ minHeight: 320 }}><StructureView structure={structure} /></div>
              </Suspense>
            </div>
          </div>

          <div>
            <div style={{ ...uppercaseLabel, marginBottom: 6 }}>Largest outliers · (Fo²−Fc²)/σ</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: mono, fontSize: fz.small }}>
              {outliers.map((r, i) => (
                <div key={`${i}:${r.h} ${r.k} ${r.l}`} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, color: color.secondary }}>
                  <span>({r.h} {r.k} {r.l})</span>
                  <span style={{ color: color.faint }}>Fo² {r.foSq.toFixed(1)} · Fc² {r.fcSq.toFixed(1)}</span>
                  <span style={{ color: Math.abs(r.deltaOverSigma) > 4 ? color.warnInk : color.faint }}>
                    {r.deltaOverSigma >= 0 ? "+" : ""}{r.deltaOverSigma.toFixed(1)}σ
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Parameters — the shared collapsible panel, single-crystal actions. */}
        <ParameterPanel
          params={params}
          esd={result?.esd}
          onChange={onParamChange}
          onRefine={() => runRefine(false)}
          onReset={reset}
          busy={busy}
          result={result}
          title="Single-crystal parameters"
          extraActions={refineActions}
        />
      </div>
    </>
  );
}

function Stat({ value, label, hint, ink, small }: { value: string; label: string; hint?: string; ink?: string; small?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontFamily: mono, fontSize: small ? 14 : 18, fontWeight: 600, color: ink ?? color.ink }}>{value}</span>
      <span style={{ fontSize: fz.micro, color: color.secondary }}>{label}</span>
      {hint ? <span style={{ fontSize: fz.micro, color: color.faint }}>{hint}</span> : null}
    </div>
  );
}

const mergeStrip: CSSProperties = {
  display: "flex",
  gap: 22,
  flexWrap: "wrap",
  padding: "10px 2px",
  borderTop: `1px solid ${color.subtle}`,
  borderBottom: `1px solid ${color.subtle}`,
};
const filterRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, fontSize: fz.small, cursor: "pointer",
};
const numInput: CSSProperties = {
  width: 52, border: `1px solid ${color.input}`, borderRadius: 7, fontSize: 12, fontFamily: mono, padding: "2px 6px", background: "#fff",
};
const disabledStyle: CSSProperties = { opacity: 0.55, cursor: "not-allowed" };
