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

import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EngineExportsRef } from "@/app/workbenchEngine";
import type { StructureModel } from "@/core/crystal/types";
import type { Radiation, SingleCrystalDataset } from "@/core/diffraction/types";
import type { ReflectionObsCalc } from "@/core/workflow/obsCalc";
import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { ComputeClient } from "@/workers/computeClient";
import { mergeEquivalents } from "@/core/diffraction/merge";
import {
  buildSingleCrystalSpec,
  guidedSingleCrystalParams,
  singleCrystalRefinementComparison,
} from "@/core/workflow/singleCrystalRefinement";
import { normalProbabilityPlot } from "@/core/refinement/diagnostics";
import { dSpacing } from "@/core/crystal/unitCell";
import { isMomentParameterKind } from "@/core/refinement/types";
import type { ParameterBinding } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { applyMagneticMoments, magneticComparison } from "@/core/workflow/magnetic";
import { KSearchPanel, type MagneticFit } from "@/components/KSearchPanel";
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

/** F-plot ↔ list selection: which reflection is spotlighted (shared with the
 *  QualityPlots' FobsFcalc so a click there highlights the matching list row). */
type Selection = { hkl: string; kind: ReflectionObsCalc["kind"]; phaseId?: string };

/** Probe the reflections were measured with. A bare .hkl / reflection list can't
 *  carry this, so the user picks it (seeded from the loaded instrument). */
type Probe = "xray" | "neutron" | "neutron-tof";

export function SingleCrystalWorkbench({ structure, dataset, client, step, onStep, instrumentProbe, exportsRef, onLoadData, onLoadCif }: {
  structure: StructureModel;
  dataset: SingleCrystalDataset;
  /** Shared compute worker — refinement runs off the main thread, as in powder. */
  client: ComputeClient;
  /** Active workflow step (0 = F² refinement, 1 = magnetic symmetry analysis). */
  step: number;
  /** Switch the app-level step (e.g. "continue to refinement" after applying a model). */
  onStep?: (i: number) => void;
  /** Radiation of the loaded instrument, if any — seeds the probe default so a
   *  loaded X-ray instrument selects X-ray scattering without the user asking. */
  instrumentProbe?: "xray" | "neutron";
  /** Shell-owned ref this engine publishes its header exports into
   *  (WorkbenchEngine contract) — so "Export CIF" acts on this mode's
   *  structure/params (this workbench owns them), not the powder exporter. */
  exportsRef?: EngineExportsRef;
  /** Load a different dataset — powder here switches the app back to powder mode. */
  onLoadData?: (file: File) => void;
  /** Load a different structure (CIF). */
  onLoadCif?: (file: File) => void;
}): JSX.Element {
  // Probe selection. The reflection file is hardcoded to neutron on load (it can't
  // report its own source), so the user can switch here — and the choice changes
  // the physics (neutron b vs X-ray form factors f(Q) + polarization), rebuilding
  // F_calc and the agreement factors live. Seeded from the instrument when known.
  const baseWavelength = ("wavelength" in dataset.radiation ? dataset.radiation.wavelength : undefined) ?? 1.54;
  const [probe, setProbe] = useState<Probe>(() => instrumentProbe ?? dataset.radiation.kind);
  const effectiveRadiation: Radiation = useMemo(() => {
    if (probe === "neutron-tof") return { kind: "neutron-tof" };
    if (probe === "xray") return { kind: "xray", wavelength: baseWavelength, polarization: 0.5 };
    return { kind: "neutron", wavelength: baseWavelength };
  }, [probe, baseWavelength]);
  // The dataset the physics runs against — same reflections, user-chosen radiation.
  const probedDataset = useMemo(() => ({ ...dataset, radiation: effectiveRadiation }), [dataset, effectiveRadiation]);

  const spec = useMemo(() => buildSingleCrystalSpec(structure, probedDataset, { extinction: 0 }), [structure, probedDataset]);
  const bindings = spec.bindings;
  const [params, setParams] = useState(spec.params);
  const [result, setResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [plotKind, setPlotKind] = useState<"fobs" | "npp">("fobs");
  // Reflection spotlighted by a click in the F_obs/F_calc plot (or null).
  const [selected, setSelected] = useState<Selection | null>(null);

  // Magnetic model applied from the (shared) symmetry analysis, with its moment
  // bindings. When present, refinement fits nuclear + moments against F² together
  // and the F_obs/F_calc plot shows the total (nuclear + magnetic) intensity.
  const [magnetic, setMagnetic] = useState<MagneticModel | null>(null);
  const [momentBindings, setMomentBindings] = useState<readonly ParameterBinding[]>([]);

  // Outlier filter: reject reflections whose standardized residual |Fo²−Fc²|/σ
  // exceeds `cutoffSigma` (SHELX-style OMIT). Off by default. The threshold is
  // applied against the *current* model, so it stays live as the fit changes.
  const [filterOn, setFilterOn] = useState(false);
  const [cutoffSigma, setCutoffSigma] = useState(6);

  // Comparison over the *full* dataset — the residuals that drive the filter.
  const fullComparison = useMemo(
    () => singleCrystalRefinementComparison(structure, probedDataset, params, bindings),
    [structure, probedDataset, params, bindings],
  );
  const activeDataset = useMemo(() => {
    if (!filterOn || cutoffSigma <= 0) return probedDataset;
    const keep = probedDataset.reflections.filter((_, i) => Math.abs(fullComparison.rows[i]?.deltaOverSigma ?? 0) <= cutoffSigma);
    return { ...probedDataset, reflections: keep };
  }, [probedDataset, filterOn, cutoffSigma, fullComparison]);
  const excluded = probedDataset.reflections.length - activeDataset.reflections.length;

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
  // probability plot over the standardized residuals (Fo²−Fc²)/σ. With a magnetic
  // model applied, the calc is the total (nuclear + magnetic) intensity.
  const obsCalc: ReflectionObsCalc[] = useMemo(() => {
    if (magnetic) {
      return magneticComparison(structure, magnetic, activeDataset, params, [...bindings, ...momentBindings]).map((r) => ({
        kind: r.iMagnetic > r.iNuclear ? ("magnetic" as const) : ("nuclear" as const),
        h: r.h, k: r.k, l: r.l,
        d: dSpacing(structure.cell, r.h, r.k, r.l),
        iObs: r.iObs, iCalc: r.iTotal,
      }));
    }
    return comparison.rows.map((r) => ({
      kind: "nuclear" as const,
      h: r.h, k: r.k, l: r.l,
      d: dSpacing(structure.cell, r.h, r.k, r.l),
      iObs: r.foSq, iCalc: r.fcSq,
    }));
  }, [magnetic, structure, activeDataset, params, bindings, momentBindings, comparison]);
  const npp = useMemo(() => normalProbabilityPlot(comparison.rows.map((r) => r.deltaOverSigma)), [comparison]);
  const outliers = useMemo(
    () => [...comparison.rows].sort((a, b) => Math.abs(b.deltaOverSigma) - Math.abs(a.deltaOverSigma)).slice(0, 6),
    [comparison],
  );

  const nFree = params.filter((p) => !p.fixed && !p.expression).length;

  async function runRefine(guided: boolean): Promise<void> {
    setBusy(true);
    try {
      const start = guided ? guidedSingleCrystalParams(params) : params;
      // Solve off the main thread (shared worker) so the UI stays responsive,
      // matching the powder path; the σ-filtered `activeDataset` is refined.
      // With a magnetic model applied, fit nuclear + moments together (F² total).
      const res = magnetic
        ? await client.refineMagnetic({
            structure, magnetic, dataset: activeDataset, parameters: start, bindings: [...bindings, ...momentBindings], options: { maxIterations: 25 },
          })
        : await client.refineSingleCrystal({
            structure, dataset: activeDataset, parameters: start, bindings, options: { maxIterations: 25 },
          });
      setParams(start.map((p) => ({ ...p, value: res.parameters[p.id] ?? p.value, ...(guided ? { fixed: false } : {}) })));
      setResult(res);
      if (magnetic) setMagnetic(applyMagneticMoments(magnetic, momentBindings, res.parameters));
    } catch (e) {
      console.error(`[status] Single-crystal refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Moment-fit backend handed to the (shared) symmetry panel: it fits the freed
  // moment amplitudes against this dataset's F² with the nuclear model held fixed,
  // through the same worker. This is single-crystal magnetic refinement.
  const magneticFit: MagneticFit = {
    agreementLabel: "wR2",
    refine: async (mag, momentParams, mBindings) => {
      const nuclearFixed = params.map((p) => ({ ...p, fixed: true }));
      const res = await client.refineMagnetic({
        structure, magnetic: mag, dataset: activeDataset,
        parameters: [...nuclearFixed, ...momentParams], bindings: [...bindings, ...mBindings],
        options: { maxIterations: 20 },
      });
      const values: Record<string, number> = {};
      for (const p of momentParams) values[p.id] = res.parameters[p.id] ?? p.value;
      return { values, agreement: res.agreement.rWeighted ?? null };
    },
  };

  // Apply a magnetic model from the symmetry step to the workbench: keep its
  // bindings and merge the (freed) moment parameters into the F² parameter set
  // so the refinement and parameter panel show them alongside the nuclear ones.
  function applyMagneticModel(mag: MagneticModel | null, momentParams: readonly RefinementParameter[] = [], mBindings: readonly ParameterBinding[] = []): void {
    setMagnetic(mag);
    setMomentBindings(mag ? mBindings : []);
    setParams((prev) => [
      ...prev.filter((p) => !isMomentParameterKind(p.kind)),
      ...(mag ? momentParams.map((p) => ({ ...p, fixed: false })) : []),
    ]);
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

  // Publish the current exporter so the app header can drive it; clear on unmount
  // (switch back to powder) so the header never calls a stale single-crystal export.
  useEffect(() => {
    if (!exportsRef) return;
    exportsRef.current = { cif: exportCif };
    return () => { exportsRef.current = null; };
  });

  const ag = comparison.agreement;
  const st = merge.statistics;
  const cell = structure.cell;
  const probeLabel = probe === "xray" ? "X-ray" : probe === "neutron" ? "Neutron" : "Neutron TOF";
  const wl = "wavelength" in effectiveRadiation ? ` · λ ${effectiveRadiation.wavelength} Å` : "";

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
      meta: `${probeLabel}${wl} · ${st.observations} obs → ${st.unique} unique · R_int ${pct(st.rInt)}`,
      control: <ProbeToggle probe={probe} onChange={setProbe} />,
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
      {/* Step 0 (F² refinement) and step 1 (magnetic symmetry) stay mounted; the
          step toggles visibility so each page's state survives switching. */}
      <div className="wb-sc" style={{ display: step === 1 ? "none" : undefined }}>
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
              {plotKind === "fobs"
                ? <FobsFcalc rows={obsCalc} selected={selected} onHighlight={setSelected} />
                : <NormalProb npp={npp} />}
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
              {outliers.map((r, i) => {
                const hkl = `${r.h} ${r.k} ${r.l}`;
                const isSel = selected?.kind === "nuclear" && selected.hkl === hkl;
                return (
                  <div
                    key={`${i}:${hkl}`}
                    onClick={() => setSelected(isSel ? null : { hkl, kind: "nuclear" })}
                    style={{
                      display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, cursor: "pointer",
                      padding: "1px 4px", borderRadius: 5,
                      color: isSel ? color.ink : color.secondary,
                      background: isSel ? color.primaryTintBg : "transparent",
                    }}
                  >
                    <span>({hkl})</span>
                    <span style={{ color: color.faint }}>Fo² {r.foSq.toFixed(1)} · Fc² {r.fcSq.toFixed(1)}</span>
                    <span style={{ color: Math.abs(r.deltaOverSigma) > 4 ? color.warnInk : color.faint }}>
                      {r.deltaOverSigma >= 0 ? "+" : ""}{r.deltaOverSigma.toFixed(1)}σ
                    </span>
                  </div>
                );
              })}
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

      {/* Step 1 — magnetic symmetry analysis. The workflow itself is structure-
          driven and identical to powder; only the moment fit (magneticFit) runs
          against F² reflections instead of a powder pattern. */}
      <div style={{ display: step === 1 ? "grid" : "none", gap: 14 }}>
        <div style={{ ...themeCard, padding: "14px 16px" }}>
          <div style={{ ...uppercaseLabel, marginBottom: 4 }}>Magnetic symmetry analysis — single crystal ({structure.name || "structure"})</div>
          <p style={{ fontSize: 13, color: color.secondary, margin: 0, lineHeight: 1.5 }}>
            Commensurate single-k workflow (shared with powder): magnetic ions → propagation vector k → symmetry framework → magnetic space group → refine moments.
            &ldquo;Refine moments&rdquo; fits the moment amplitudes to the F² reflections; &ldquo;Continue&rdquo; carries the model to the F² refinement to fit nuclear + magnetic together.
          </p>
        </div>
        <KSearchPanel
          structure={structure}
          magneticFit={magneticFit}
          onApply={(m) => applyMagneticModel(m)}
          onContinue={(m, mp, mb) => { applyMagneticModel(m, mp, mb); onStep?.(0); }}
        />
      </div>
    </>
  );
}

/** Segmented X-ray / Neutron / TOF control for the single-crystal Data card.
 *  A bare reflection file carries no probe, so this is the authoritative source. */
function ProbeToggle({ probe, onChange }: { probe: Probe; onChange: (p: Probe) => void }): JSX.Element {
  const opts: { value: Probe; label: string }[] = [
    { value: "xray", label: "X-ray" },
    { value: "neutron", label: "Neutron" },
    { value: "neutron-tof", label: "TOF" },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{ fontSize: fz.micro, color: color.faint }}
        title="The reflection file cannot report its own radiation. Pick the probe used — it selects neutron scattering lengths (b) vs X-ray form factors f(Q) + polarization, changing every F_calc."
      >
        probe
      </span>
      <span style={{ display: "inline-flex", border: `1px solid ${color.control}`, borderRadius: 6, overflow: "hidden" }}>
        {opts.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              border: "none", padding: "2px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer",
              background: probe === o.value ? color.primary : "transparent",
              color: probe === o.value ? "#fff" : color.secondary,
            }}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
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
