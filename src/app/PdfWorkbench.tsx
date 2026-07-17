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

import { useEffect, useMemo, useRef, useState } from "react";
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
  optimalPdfScale,
  guidedPdfParams,
  correlatedMotionConflict,
  PDF_STAGE_KINDS,
} from "@/core/workflow/pdf";
import { ParameterPanel } from "@/app/ui/ParameterPanel";
import { SummaryCards, type SummaryCardData } from "@/app/ui/SummaryCards";
import { WorkbenchPlot, type FitRangeSelection } from "@/app/ui/WorkbenchPlot";
import { downloadText } from "@/app/download";
import { structureToCif } from "@/core/export/cif";
import { pdfReport } from "@/core/export/pdfReport";
import { card as themeCard, color, mono, secondaryButton, uppercaseLabel } from "@/app/theme";

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

export function PdfWorkbench({ structure, pattern, extraPhases = [], ownStructure = false, client, exportsRef, onLoadData, onLoadCif, onAddPhase, onRemovePhase }: {
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
    return {
      min: Math.min(Math.max(pattern.rpoly ?? 1.5, rFirst0), rLast0),
      max: Math.min(rLast0, 30),
    };
  }, [pattern]);
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
    const params = raw.params.map((p) =>
      p.kind === "pdfScale" ? { ...p, value: kappa, initialValue: kappa } : p,
    );
    return { ...raw, params };
  }, [structure, extraPhases, multiPhase, phases, pattern, defaultRange]);

  const [params, setParams] = useState<readonly RefinementParameter[]>(spec.params);
  const [result, setResult] = useState<RefinementResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Live calculated curve streamed from the worker during a refinement.
  const [live, setLive] = useState<number[] | null>(null);
  useEffect(() => {
    setParams(spec.params);
    setResult(null);
    setLive(null);
  }, [spec]);

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

  // Rw over G(r) inside the fit window, live for the current parameters —
  // uniform weights, so Rw = √(Σ(o−c)² / Σo²). A relative indicator only
  // (correlated G(r) errors; see core/workflow/pdf.ts).
  const rw = useMemo(() => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < curves.x.length; i++) {
      const r = curves.x[i]!;
      if (r < fitRange.min || r > fitRange.max) continue;
      const d = curves.yObs[i]! - curves.yCalc[i]!;
      num += d * d;
      den += curves.yObs[i]! * curves.yObs[i]!;
    }
    return den > 0 ? Math.sqrt(num / den) : NaN;
  }, [curves, fitRange]);

  const nFree = params.filter((p) => !p.fixed && !p.expression).length;

  async function runRefine(guided: boolean): Promise<void> {
    setBusy(true);
    try {
      const start = guided ? guidedPdfParams(params) : [...params];
      const res = await client.refinePdfParallel(
        {
          structure,
          ...(multiPhase ? { extraPhases: [...extraPhases] } : {}),
          pattern,
          parameters: start,
          bindings: [...spec.bindings],
          restraints: spec.restraints,
          ...(guided ? { staged: PDF_STAGE_KINDS } : {}),
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

  // Qdamp/Qbroad calibration on a STANDARD: the loaded structure is taken as
  // known — only the scale(s) and the instrument envelope refine; the result is
  // adopted and kept fixed for subsequent sample fits.
  async function runCalibrate(): Promise<void> {
    setBusy(true);
    try {
      const calib = params.map((p) => ({
        ...p,
        fixed: !(p.kind === "pdfScale" || p.kind === "qdamp" || p.kind === "qbroad"),
      }));
      const res = await client.refinePdfParallel(
        {
          structure,
          ...(multiPhase ? { extraPhases: [...extraPhases] } : {}),
          pattern,
          parameters: calib,
          bindings: [...spec.bindings],
          restraints: spec.restraints,
          fitRange,
          options: { maxIterations: 25 },
        },
        (yCalc) => setLive(yCalc),
      );
      setParams((ps) =>
        ps.map((p) =>
          p.kind === "qdamp" || p.kind === "qbroad" || p.kind === "pdfScale"
            ? { ...p, value: res.parameters[p.id] ?? p.value, fixed: p.kind === "pdfScale" ? p.fixed : true }
            : p,
        ),
      );
      setResult(res);
    } catch (e) {
      console.error(`[status] Qdamp calibration failed: ${e instanceof Error ? e.message : String(e)}`);
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

  const refineActions = (
    <>
      <button
        style={{ ...secondaryButton, padding: "7px 13px", ...(busy ? { opacity: 0.55, cursor: "default" } : {}) }}
        disabled={busy}
        onClick={() => void runRefine(true)}
        title="Staged sequence: scale → cell → ADP → correlated motion (δ1) → positions (occupancies stay fixed)"
      >
        Guided refine
      </button>
      <button
        style={{ ...secondaryButton, padding: "7px 13px", ...(busy ? { opacity: 0.55, cursor: "default" } : {}) }}
        disabled={busy}
        onClick={() => void runCalibrate()}
        title="Instrument calibration on a STANDARD (Ni/Si/LaB₆ with a known structure): fit only scale + Qdamp + Qbroad, then adopt and hold them for sample fits"
      >
        Calibrate Qdamp
      </button>
    </>
  );

  return (
    <>
      <SummaryCards cards={summaryCards} />
      <div className="wb-sc">
        <div style={{ ...themeCard, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={uppercaseLabel}>PDF fit — G(r), real space</span>
            <div style={{ display: "flex", gap: 20, alignItems: "baseline" }}>
              {canOverlay && (
                <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11.5, color: color.secondary, cursor: "pointer" }} title={multiPhase ? "Overlay each phase's G(r) contribution — they sum exactly to the calc curve" : "Overlay the element-pair (Faber–Ziman) partial PDFs — they sum exactly to the calc curve"}>
                  <input type="checkbox" checked={showPartials} onChange={(e) => setShowPartials(e.target.checked)} style={{ accentColor: color.primary }} />
                  {multiPhase ? "phases" : "partials"}
                </label>
              )}
              <span style={{ fontFamily: mono, fontSize: 15, color: rwInk(rw) }} title="Rw over G(r) inside the fit window (uniform weights). G(r) point errors are correlated, so treat as a relative indicator.">
                Rw {Number.isFinite(rw) ? pct(rw) : "—"}
              </span>
              <span style={{ fontFamily: mono, fontSize: 12, color: color.faint }}>{nFree} free</span>
            </div>
          </div>
          <WorkbenchPlot
            curves={plotCurves}
            xLabel="r (Å)"
            yLabel="G(r) (Å⁻²)"
            signedY
            showBackground={false}
            fitRange={fitRange}
            onFitRangeChange={setFitRange}
            {...(partials ? { overlays: partials } : {})}
          />
          <div style={{ fontSize: 11.5, color: color.faint }}>
            Fit window {fitRange.min.toFixed(2)}–{fitRange.max.toFixed(2)} Å (drag the handles; low r below r_poly is
            reduction artifact). Qdamp/Qbroad are instrument constants — calibrate on a standard, then keep fixed.
          </div>
          {correlatedMotionConflict(params) && (
            <div style={{ fontSize: 11.5, color: color.warnInk }}>⚠ {correlatedMotionConflict(params)}</div>
          )}
        </div>

        <ParameterPanel
          params={params}
          esd={result?.esd}
          onChange={onParamChange}
          onRefine={() => void runRefine(false)}
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
