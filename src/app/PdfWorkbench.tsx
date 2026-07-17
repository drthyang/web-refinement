/**
 * PDF (pair distribution function) refinement page — "real-space Rietveld"
 * (PDF_MPDF_ROADMAP P0/P1). Shares the workbench design language — SummaryCards
 * row, quality strip, the collapsible ParameterPanel, and the shared plot in its
 * signed-y mode (G(r) oscillates about zero) — and drives the real-space core
 * (`buildPdfSpec` / `buildPdfProblem` via the compute worker).
 *
 * Self-contained: owns its parameter/result state and its CSV export. The app
 * shell mounts it (keyed on the dataset) whenever a reduced `.gr` PDF is loaded.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { EngineExportsRef } from "@/app/workbenchEngine";
import type { StructureModel } from "@/core/crystal/types";
import type { PdfPattern } from "@/core/diffraction/types";
import type { RefinementResult } from "@/core/refinement/types";
import type { RefinementParameter } from "@/core/refinement/types";
import type { ComputeClient } from "@/workers/computeClient";
import {
  buildPdfSpec,
  buildMultiPhasePdfSpec,
  pdfCurves,
  multiPhasePdfCurves,
  pdfPartialCurves,
  pdfPhaseCurves,
  pdfPhaseBindingsFor,
  optimalPdfScale,
  correlatedMotionConflict,
} from "@/core/workflow/pdf";
import { applyParameters } from "@/core/workflow/apply";

// Lazy so three.js stays out of the main bundle until the 3D view is opened.
const StructureView = lazy(() => import("@/app/ui/StructureView").then((m) => ({ default: m.StructureView })));
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { WorkbenchPlot, type FitRangeSelection } from "@/app/ui/WorkbenchPlot";
import { downloadText } from "@/app/download";
import { structureToCif } from "@/core/export/cif";
import { pdfReport } from "@/core/export/pdfReport";
import { card as themeCard, color, mono, secondaryButton, uppercaseLabel, fz, toolbarBtn, resetRangeBtn } from "@/app/theme";

const DATA_ACCEPT = ".gr,.sgr,.sq,.fq,.dat,.txt,text/plain";
const noop = (): void => {};
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/** Rw quality bands for a PDF (fraction): <15 % good · <30 % mediocre · else
 *  poor. PDF Rw runs much higher than Bragg Rwp for equally good fits — and with
 *  correlated G(r) errors it is a relative indicator, not an absolute one. */
function rwInk(rw: number): string {
  if (!Number.isFinite(rw)) return color.ink;
  if (rw < 0.15) return color.okInk;
  if (rw < 0.3) return color.noteInk;
  return color.warnInk;
}

export function PdfWorkbench({ structure, pattern, extraPhases = [], ownStructure = false, client, exportsRef, onLoadData, onLoadCif, onAddPhase, onRemovePhase, presetValues, presetFitRange }: {
  structure: StructureModel;
  pattern: PdfPattern;
  /** Additional crystallographic phases (multi-phase G(r) sum). */
  extraPhases?: readonly StructureModel[];
  /** True once the user replaced the bundled structure — the load button then
   *  appends phases instead of replacing (multi-phase entry point, as powder). */
  ownStructure?: boolean;
  /** Shared compute worker — the fit runs off the main thread, as in powder. */
  client: ComputeClient;
  exportsRef?: EngineExportsRef;
  onLoadData?: (file: File) => void;
  onLoadCif?: (file: File) => void;
  onAddPhase?: (file: File) => void;
  onRemovePhase?: (id: string) => void;
  /** Converged parameter values to open with (bundled demo snapshots). Applied
   *  as value AND initialValue, so Reset returns to the converged state. */
  presetValues?: Record<string, number>;
  /** Fit window to open with (demo snapshots refine a specific window). */
  presetFitRange?: { min: number; max: number };
}): JSX.Element {
  const multiPhase = extraPhases.length > 0;
  const phases = useMemo(
    () => [{ structure, id: structure.id }, ...extraPhases.map((s) => ({ structure: s, id: s.id }))],
    [structure, extraPhases],
  );
  // Default fit window: above the reduction's low-r validity limit, and capped
  // at 30 Å — files often carry G(r) to 100 Å, and modeling the whole grid on
  // load would hang the page (the model is only ever computed in the window;
  // drag the right handle out to fit further).
  const defaultRange = useMemo((): FitRangeSelection => {
    const rFirst0 = pattern.points[0]?.r ?? 0;
    const rLast0 = pattern.points[pattern.points.length - 1]?.r ?? 1;
    if (presetFitRange) {
      return { min: Math.max(presetFitRange.min, rFirst0), max: Math.min(presetFitRange.max, rLast0) };
    }
    return {
      min: Math.min(Math.max(pattern.rpoly ?? 1.5, rFirst0), rLast0),
      max: Math.min(rLast0, 30),
    };
  }, [pattern, presetFitRange]);
  // Parameter spec: PDF scale/envelope + the symmetry-reduced structural set,
  // with the phase scale(s) seeded from the least-squares optimum of the
  // starting model (exact for one linear scale; split evenly across phases).
  const spec = useMemo(() => {
    const raw = multiPhase ? buildMultiPhasePdfSpec([structure, ...extraPhases], pattern) : buildPdfSpec(structure, pattern);
    const start = multiPhase
      ? multiPhasePdfCurves(phases, pattern, raw.params, raw.bindings, defaultRange)
      : pdfCurves(structure, pattern, raw.params, raw.bindings, defaultRange);
    const kappa = optimalPdfScale(
      start.yObs.filter((_, i) => start.x[i]! >= defaultRange.min && start.x[i]! <= defaultRange.max),
      start.yCalc.filter((_, i) => start.x[i]! >= defaultRange.min && start.x[i]! <= defaultRange.max),
    ) / (multiPhase ? phases.length : 1);
    const seeded = raw.params.map((p) =>
      p.kind === "pdfScale" ? { ...p, value: kappa, initialValue: kappa } : p,
    );
    // Demo snapshots open converged: preset values win over the κ seed, and
    // become the reset anchor too.
    const params = presetValues
      ? seeded.map((p) => (presetValues[p.id] !== undefined ? { ...p, value: presetValues[p.id]!, initialValue: presetValues[p.id]! } : p))
      : seeded;
    return { ...raw, params };
  }, [structure, extraPhases, multiPhase, phases, pattern, defaultRange, presetValues]);

  const [params, setParams] = useState<readonly RefinementParameter[]>(spec.params);
  const [result, setResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Live calculated curve streamed from the worker during a refinement.
  const [live, setLive] = useState<number[] | null>(null);
  // Plot-card view: the fit, or the refined 3D structure (per phase).
  const [viewTab, setViewTab] = useState<"fit" | "model3d">("fit");
  const [viewPhase, setViewPhase] = useState(0);
  const [focusFitToken, setFocusFitToken] = useState(0);
  useEffect(() => {
    setParams(spec.params);
    setResult(null);
    setLive(null);
  }, [spec]);

  // The 3D view tracks the refinement: apply the current parameter values so
  // the viewer shows the refined cell/positions/ADPs, not the loaded CIF.
  const viewStructure = useMemo(() => {
    const phase = phases[Math.min(viewPhase, phases.length - 1)]!;
    const values: Record<string, number> = {};
    for (const p of params) values[p.id] = p.value;
    const phaseBindings = multiPhase ? pdfPhaseBindingsFor(spec.bindings, phase.id) : spec.bindings;
    return applyParameters(phase.structure, phaseBindings, values).model;
  }, [phases, viewPhase, params, spec.bindings, multiPhase]);

  // Fit window over r (drag the plot handles). Starts at the default window;
  // the model is only computed inside it, so widening it costs compute.
  const rFirst = pattern.points[0]?.r ?? 0;
  const rLast = pattern.points[pattern.points.length - 1]?.r ?? 1;
  const [fitRange, setFitRange] = useState<FitRangeSelection>(defaultRange);
  useEffect(() => setFitRange(defaultRange), [defaultRange]);

  const curves = useMemo(
    () =>
      multiPhase
        ? multiPhasePdfCurves(phases, pattern, params, spec.bindings, fitRange)
        : pdfCurves(structure, pattern, params, spec.bindings, fitRange),
    [multiPhase, phases, structure, pattern, params, spec.bindings, fitRange],
  );

  // Decomposition overlays (P3): per-phase contributions on a multi-phase fit,
  // element-pair (Faber–Ziman) partials on a single-phase fit with ≥2 elements.
  const nElements = useMemo(() => new Set(structure.sites.map((s) => s.element)).size, [structure]);
  const canOverlay = multiPhase || nElements >= 2;
  const [showPartials, setShowPartials] = useState(false);
  const partials = useMemo(() => {
    if (!showPartials || !canOverlay) return null;
    return multiPhase
      ? pdfPhaseCurves(phases, pattern, params, spec.bindings, fitRange)
      : pdfPartialCurves(structure, pattern, params, spec.bindings, fitRange);
  }, [showPartials, canOverlay, multiPhase, phases, structure, pattern, params, spec.bindings, fitRange]);
  const plotCurves = useMemo(() => {
    if (!live) return curves;
    const yCalc = live;
    return { ...curves, yCalc, diff: curves.yObs.map((o, i) => o - (yCalc[i] ?? 0)) };
  }, [curves, live]);

  // Rw over G(r) inside the fit window — computed from the PLOTTED curves so
  // it ticks live while a refinement streams its per-cycle calc. Uniform
  // weights, Rw = √(Σ(o−c)² / Σo²): a relative indicator only (correlated
  // G(r) errors; see core/workflow/pdf.ts).
  const rw = useMemo(() => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < plotCurves.x.length; i++) {
      const r = plotCurves.x[i]!;
      if (r < fitRange.min || r > fitRange.max) continue;
      const d = plotCurves.yObs[i]! - plotCurves.yCalc[i]!;
      num += d * d;
      den += plotCurves.yObs[i]! * plotCurves.yObs[i]!;
    }
    return den > 0 ? Math.sqrt(num / den) : NaN;
  }, [plotCurves, fitRange]);

  const nFree = params.filter((p) => !p.fixed && !p.expression).length;

  async function runRefine(): Promise<void> {
    setBusy(true);
    try {
      const start = [...params];
      const res = await client.refinePdfParallel(
        {
          structure,
          ...(multiPhase ? { extraPhases: [...extraPhases] } : {}),
          pattern,
          parameters: start,
          bindings: [...spec.bindings],
          restraints: spec.restraints,
          fitRange,
          options: { maxIterations: 30 },
        },
        (yCalc) => setLive(yCalc),
      );
      setParams(start.map((p) => ({ ...p, value: res.parameters[p.id] ?? p.value })));
      setResult(res);
    } catch (e) {
      console.error(`[status] PDF refinement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLive(null);
      setBusy(false);
    }
  }

  // Multi-start (one engine, two faces, as powder): a cold start gets the wide
  // "Prefit" search; once a fit exists it's a lighter "Escape min" nudge out of
  // the current basin. Keeps the lowest-χ² of baseline + restarts.
  async function runMultiStart(): Promise<void> {
    setBusy(true);
    try {
      const escape = result !== null;
      const ms = await client.refinePdfMultiStart(
        {
          structure,
          ...(multiPhase ? { extraPhases: [...extraPhases] } : {}),
          pattern,
          parameters: [...params],
          bindings: [...spec.bindings],
          restraints: spec.restraints,
          fitRange,
          options: { maxIterations: 25 },
        },
        escape ? { restarts: 4, escapeSigma: 2 } : { restarts: 8 },
        (yCalc) => setLive(yCalc),
      );
      setParams((ps) => ps.map((p) => ({ ...p, value: ms.final.parameters[p.id] ?? p.value })));
      setResult(ms.final);
      console.info(
        `[status] PDF multi-start (${escape ? "escape" : "prefit"}): best of ${ms.restartsRun + 1} starts` +
        `${ms.bestStartIndex > 0 ? ` (restart ${ms.bestStartIndex} won)` : " (baseline held)"} · Rw ${(100 * (ms.final.agreement.rWeighted ?? 0)).toFixed(2)}%`,
      );
    } catch (e) {
      console.error(`[status] PDF multi-start failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLive(null);
      setBusy(false);
    }
  }

  function onParamChange(id: string, patch: Partial<RefinementParameter>): void {
    setParams((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function reset(): void {
    setParams(spec.params);
    setResult(null);
    setLive(null);
  }

  // Exports published to the app header (engine contract): the output triple —
  // refined curves (CSV), refined structure(s) (CIF with esds + Rw meta), and
  // the markdown report.
  const exportCsvRef = useRef<() => void>(noop);
  exportCsvRef.current = (): void => {
    const rows = curves.x.map((r, i) => `${r},${curves.yObs[i]},${curves.yCalc[i]},${curves.diff[i]}`);
    downloadText(`${pattern.id}.csv`, `r,Gobs,Gcalc,diff\n${rows.join("\n")}\n`, "text/csv");
  };
  const exportCifRef = useRef<() => void>(noop);
  exportCifRef.current = (): void => {
    const withEsd = params.map((p) => {
      const esd = result?.esd[p.id] ?? p.esd;
      return esd !== undefined ? { ...p, esd } : { ...p };
    });
    const meta = {
      rwp: rw * 100,
      nRef: curves.x.filter((r) => r >= fitRange.min && r <= fitRange.max).length,
      nParam: nFree,
    };
    for (const phase of phases) {
      const cif = structureToCif(phase.structure, { params: withEsd, bindings: spec.bindings, refinement: meta });
      downloadText(`${phase.structure.name || phase.id}_pdf.cif`, cif, "chemical/x-cif");
    }
  };
  const exportReportRef = useRef<() => void>(noop);
  exportReportRef.current = (): void => {
    const conflict = correlatedMotionConflict(params);
    const text = pdfReport({
      phases: phases.map((p) => p.structure),
      pattern,
      parameters: params,
      result,
      rw,
      fitRange,
      ...(conflict ? { warnings: [conflict] } : {}),
    });
    downloadText(`${pattern.id}_report.md`, text, "text/markdown");
  };
  useEffect(() => {
    if (!exportsRef) return;
    exportsRef.current = {
      csv: () => exportCsvRef.current(),
      cif: () => exportCifRef.current(),
      report: () => exportReportRef.current(),
    };
    return () => { exportsRef.current = null; };
  }, [exportsRef]);

  const probeLabel = pattern.scatteringType === "neutron" ? "Neutron" : "X-ray";
  const summaryCards: SummaryCardData[] = [
    {
      label: "Structure",
      // Once the user owns the structure, the button appends phases (multi-phase
      // G(r) sum) instead of replacing — mirroring the powder card's behaviour.
      loadLabel: ownStructure && onAddPhase ? "Add CIF…" : "Load CIF…",
      accept: ".cif,.mcif,text/plain",
      onFile: (ownStructure && onAddPhase ? onAddPhase : onLoadCif) ?? noop,
      chip: multiPhase ? `✓ ${phases.length} phases` : "✓ parsed",
      title: multiPhase
        ? phases.map((p) => p.structure.name || p.id).join(" + ")
        : `${structure.name || "structure"} · ${structure.spaceGroup.hermannMauguin ?? "—"}`,
      meta: `a ${structure.cell.a.toFixed(4)} · b ${structure.cell.b.toFixed(4)} · c ${structure.cell.c.toFixed(4)} Å · ${structure.sites.length} sites`,
      ...(multiPhase && onRemovePhase
        ? {
            phaseBadges: phases.map((p, i) => ({ id: p.id, label: p.structure.name || p.id, removable: i > 0 })),
            onRemovePhase,
          }
        : {}),
    },
    {
      label: "Data · PDF G(r)",
      loadLabel: "Load data…",
      accept: DATA_ACCEPT,
      onFile: onLoadData ?? noop,
      chip: "✓ reduced G(r)",
      title: pattern.name,
      meta:
        `${probeLabel} · r ${rFirst.toFixed(2)}–${rLast.toFixed(2)} Å · ${pattern.points.length} pts` +
        (pattern.qmax !== undefined ? ` · Qmax ${pattern.qmax.toFixed(1)} Å⁻¹` : "") +
        (pattern.sourceKind === "sq" ? " · from S(Q)" : pattern.sourceKind === "fq" ? " · from F(Q)" : "") +
        (pattern.composition ? ` · ${pattern.composition}` : ""),
    },
  ];

  // Mirrors the powder page's "Magnetic analysis →" slot; enabled when mPDF
  // (roadmap P4) lands.
  const refineActions = (
    <button
      style={{ ...secondaryButton, flex: "0 0 auto", padding: "10px 13px", fontSize: 13, opacity: 0.5, cursor: "default" }}
      disabled
      title="Magnetic PDF (mPDF) — moment refinement against magnetic G(r). The next roadmap milestone (P4)."
    >
      Magnetic PDF →
    </button>
  );

  return (
    <>
      <SummaryCards cards={summaryCards} />
      <div className="wb-work2">
        <div style={{ ...themeCard, padding: "16px 18px", display: "flex", flexDirection: "column", height: "clamp(500px, 66vh, 900px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={uppercaseLabel}>
              {viewTab === "fit" ? "PDF pattern — G(r)" : "Crystal structure — unit cell"}
            </span>
            {viewTab === "fit" && (
              <span style={{ display: "flex", gap: 14, fontFamily: mono, fontSize: 12.5 }}>
                <span style={{ color: color.secondary }} title="Rw over G(r) inside the fit window (uniform weights). G(r) point errors are correlated, so treat as a relative indicator.">
                  Rw <b style={{ color: rwInk(rw) }}>{Number.isFinite(rw) ? pct(rw) : "—"}</b>
                </span>
              </span>
            )}
            {viewTab === "fit" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: mono, fontSize: fz.micro, color: color.secondary }} title="The r window used for refinement (set with the blue handles). Low r below r_poly is reduction artifact.">
                fit {fitRange.min.toFixed(2)}–{fitRange.max.toFixed(2)} Å
                <button style={resetRangeBtn} onClick={() => setFitRange(defaultRange)} title="Reset to the default window">Reset range</button>
              </span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, rowGap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {viewTab === "fit" && canOverlay && (
                <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: fz.micro, color: color.secondary, cursor: "pointer" }} title={multiPhase ? "Overlay each phase's G(r) contribution — they sum exactly to the calc curve" : "Overlay the element-pair (Faber–Ziman) partial PDFs — they sum exactly to the calc curve"}>
                  <input type="checkbox" checked={showPartials} onChange={(e) => setShowPartials(e.target.checked)} style={{ accentColor: color.primary }} />
                  {multiPhase ? "phases" : "partials"}
                </label>
              )}
              {viewTab === "fit" && (
                <button
                  style={{ ...toolbarBtn, display: "inline-flex", alignItems: "center", gap: 5 }}
                  title="Zoom the plot onto the active fit window"
                  onClick={() => setFocusFitToken((t) => t + 1)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  optimize view
                </button>
              )}
              <div style={{ display: "inline-flex", gap: 2, background: color.chipBg, border: `1px solid ${color.border}`, borderRadius: 8, padding: 2 }}>
                {(["fit", "model3d"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setViewTab(k)}
                    title={k === "fit" ? "Observed vs calculated G(r)" : "3D crystal-structure model"}
                    style={{
                      border: "none", borderRadius: 6, padding: "3px 11px", fontSize: 11, fontWeight: 600,
                      cursor: "pointer", fontFamily: mono,
                      background: viewTab === k ? color.primary : "transparent",
                      color: viewTab === k ? "#fff" : color.secondary,
                    }}
                  >
                    {k === "fit" ? "Refinement" : "3D Model"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {viewTab === "fit" ? (
            <>
              <WorkbenchPlot
                curves={plotCurves}
                xLabel="r (Å)"
                yLabel="G(r) (Å⁻²)"
                signedY
                showBackground={false}
                fitRange={fitRange}
                onFitRangeChange={setFitRange}
                focusFitToken={focusFitToken}
                {...(partials ? { overlays: partials } : {})}
              />
              <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: color.secondary }}>
                Drag across the plot to zoom, blue handles to set the fit window. Qdamp/Qbroad are instrument constants — hold them fixed once calibrated on a standard.
              </p>
              {correlatedMotionConflict(params) && (
                <div style={{ marginTop: 6, fontSize: 12, color: color.warnInk }}>⚠ {correlatedMotionConflict(params)}</div>
              )}
            </>
          ) : (
            <>
              {multiPhase && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, color: color.secondary }}>phase</span>
                  <span style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: 6, overflow: "hidden" }}>
                    {phases.map((ph, i) => (
                      <button
                        key={ph.id}
                        onClick={() => setViewPhase(i)}
                        style={{ border: "none", padding: "1px 9px", fontSize: 11.5, fontFamily: "inherit", cursor: "pointer", background: i === viewPhase ? color.primary : "#fff", color: i === viewPhase ? "#fff" : color.ink }}
                      >
                        {ph.structure.name || `phase ${i + 1}`}
                      </button>
                    ))}
                  </span>
                </div>
              )}
              <Suspense fallback={<div style={{ flex: 1, minHeight: 360, display: "grid", placeItems: "center", color: color.secondary, fontSize: 13 }}>Loading 3D viewer…</div>}>
                <div style={{ minHeight: 360 }}>
                  <StructureView key={viewStructure.id + viewPhase} structure={viewStructure} />
                </div>
              </Suspense>
              <p style={{ marginTop: 4, fontSize: 12, color: color.secondary }}>
                {viewStructure.name || "Structure"}
                {viewStructure.spaceGroup.hermannMauguin ? ` · ${viewStructure.spaceGroup.hermannMauguin}` : ""}
                {` · ${viewStructure.sites.length} site${viewStructure.sites.length === 1 ? "" : "s"} · refined values applied · drag to rotate, scroll to zoom.`}
              </p>
            </>
          )}
        </div>

        <ParameterPanel
          params={params}
          esd={result?.esd}
          onChange={onParamChange}
          onRefine={() => void runRefine()}
          onThorough={() => void runMultiStart()}
          thoroughMode={result ? "escape" : "prefit"}
          prefitTitle="Prefit from a cold start: a broad set of perturbed restarts of the free parameters, keeping the best — lands the model in a good basin before you refine. (No Le Bail stage — that extracts Bragg intensities, which real-space G(r) doesn't have.)"
          onReset={reset}
          busy={busy}
          result={result}
          title="PDF parameters"
          extraActions={refineActions}
        />
      </div>
    </>
  );
}
