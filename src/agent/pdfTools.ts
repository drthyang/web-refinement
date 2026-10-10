/**
 * The Agent tools on the PDF page: each one reads the live state through the
 * page's port (port.ts) or calls the page's own handler, as on the powder
 * page (powderTools.ts). The analysis tools are the MATERIA MCP handlers that
 * hold in real space: the assessment (without its GoF verdict and its
 * Bragg-peak scan), the next-step ranking built on it, bond geometry and the
 * structure read.
 *
 * A PDF fit weights every G(r) point equally (core/workflow/pdf.ts): Rw is a
 * relative measure, there is no GoF, and the esds are not statistical. The
 * answers say so, so a model does not read them as a Rietveld fit's.
 */

import type { PdfAgentPort, PdfLiveState } from "@/agent/port";
import type { LiveToolSpec } from "@/agent/tools";
import type { ProjectHistory } from "@/core/project/history";
import { assess_refinement, bond_geometry, interpret_structure, suggest_next_steps } from "@/mcp/tools";
import { structureTable } from "@/agent/structureTable";
import { applyFree, bondsOf, cellOf, describeFree, freeNoOp, goToStep, historyView, matchIds, parameterSummary, pct, sig, type ChangeResult, type LiveToolHost } from "@/agent/liveCommon";
import { boxcarStepIndex, boxcarWindows, type BoxcarRun } from "@/core/workflow/pdfBoxcar";
import type { RefinementParameter } from "@/core/refinement/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are validated against the spec's zod schema before a handler runs */
type Input = any;

/** What every PDF answer says about its numbers. */
export const PDF_CONVENTION =
  "PDF fit: uniform weights over G(r), so Rw is a relative measure, there is no GoF, and the esds are not statistical.";

/** Run a read tool. Returns the JSON result the model sees. */
export function readPdfTool(name: string, input: Input, port: PdfAgentPort, host: LiveToolHost): unknown {
  const s = port.state();
  switch (name) {
    case "get_state":
      return stateView(s, host.history(), input.parameters);
    case "assess_refinement":
      return assessment(s);
    case "suggest_next_steps":
      return { steps: suggest_next_steps({ assessment: assessment(s) }) };
    case "structure_table":
      return { phases: s.refinedPhases.map((ph, k) => structureTable(ph, k, s.parameters, s.bindings, s.result?.esd ?? {})), ...(s.result ? {} : { note: "No refinement on screen: the values carry no esds." }) };
    case "bond_geometry":
      return bondsOf(s.refinedPhases, input, bond_geometry);
    case "interpret_structure":
      return interpret_structure({
        structure: s.refinedPhases[0]!,
        parameters: [...s.parameters],
        ...(s.result ? { esd: { ...s.result.esd } } : {}),
        magnetic: null,
      });
    default:
      throw new Error(`${name} is not a PDF read tool`);
  }
}

/**
 * Make a change on the page. Returns a note for the model when the change
 * needed adjusting (tied parameters skipped) or did not finish.
 */
export async function changePdf(name: string, input: Input, port: PdfAgentPort, host: LiveToolHost): Promise<ChangeResult> {
  const s = port.state();
  switch (name) {
    case "set_free":
      return applyFree(s.parameters, input, port.setFixed);
    case "set_fit_range": {
      if (input.unit !== undefined) throw new Error("the PDF page fits a window in r (Å); leave out `unit`");
      if (input.whole) {
        port.setFitRange(null);
        return undefined;
      }
      const min = input.min ?? s.fitRange.min;
      const max = input.max ?? s.fitRange.max;
      if (!(max > min)) throw new Error(`the window needs max > min (got ${min}–${max} Å)`);
      if (max < s.extent.min || min > s.extent.max) throw new Error(`${min}–${max} Å is outside the data (${sig(s.extent.min, 5)}–${sig(s.extent.max, 5)} Å)`);
      port.setFitRange({ min: Math.max(min, s.extent.min), max: Math.min(max, s.extent.max) });
      return undefined;
    }
    case "refine": {
      if (!s.parameters.some((p) => !p.fixed && !p.expression)) throw new Error("no parameter is free — free some with set_free first");
      const why = await (input.mode === "thorough" ? port.thorough() : port.refine());
      return why ? `The refinement did not finish (${why}); the parameters keep their values from before it.` : undefined;
    }
    case "boxcar_scan": {
      if (!s.parameters.some((p) => !p.fixed && !p.expression)) throw new Error("no parameter is free — free the ones to track with set_free first");
      const run = await port.boxcar({ width: input.width ?? 5, step: input.step ?? 1, direction: input.direction ?? "up" });
      if (!run) return "The scan did not finish (cancelled, failed, or the model changed while it ran).";
      return { note: boxcarLine(run), data: boxcarView(run, s.parameters) };
    }
    case "reset_parameters":
      port.reset(input.parameters ? matchIds(s.parameters, input.parameters as string[]) : undefined);
      return undefined;
    case "go_to_step":
      goToStep(host, input.step);
      return undefined;
    default:
      throw new Error(`${name} is not a PDF change tool`);
  }
}

/** Why a change would do nothing, or null when it would do something. */
export function pdfNoOp(spec: LiveToolSpec, input: Input, s: PdfLiveState): string | null {
  return spec.name === "set_free" ? freeNoOp(s.parameters, input) : null;
}

/** One line for the approval card: what this change will do, in the page's terms. */
export function describePdfChange(spec: LiveToolSpec, input: Input, s: PdfLiveState): string {
  switch (spec.name) {
    case "boxcar_scan": {
      const width = input.width ?? 5;
      const step = input.step ?? 1;
      const boxes = boxcarWindows({ range: s.fitRange, width, step }).length;
      const free = s.parameters.filter((p) => !p.fixed && !p.expression).length;
      return `Boxcar scan: ${boxes} boxes of ${width} Å every ${step} Å across r ${sig(s.fitRange.min, 4)} – ${sig(s.fitRange.max, 4)} Å, ${free} free parameters${input.direction === "both" ? ", both directions" : input.direction === "down" ? ", high → low r" : ""}`;
    }
    case "set_free":
      return describeFree(s.parameters, input);
    case "set_fit_range":
      return input.whole
        ? `Fit the default window, r ${sig(s.defaultRange.min, 4)} – ${sig(s.defaultRange.max, 4)} Å`
        : `Fit window r ${String(input.min ?? sig(s.fitRange.min, 4))} – ${String(input.max ?? sig(s.fitRange.max, 4))} Å`;
    case "refine": {
      const free = s.parameters.filter((p) => !p.fixed && !p.expression).length;
      const what = s.spinModel ? "nuclear + magnetic G(r)" : "G(r)";
      return input.mode === "thorough"
        ? `${s.result ? "Escape minimum" : "Prefit"} (multi-start) on ${free} free parameter${free === 1 ? "" : "s"}`
        : `Refine ${what}, ${free} free parameter${free === 1 ? "" : "s"}`;
    }
    case "reset_parameters":
      return input.parameters ? `Reset ${matchIds(s.parameters, input.parameters as string[]).join(", ")} to the starting value` : "Reset every parameter to its starting value";
    case "go_to_step":
      return `Go to step ${String(input.step)}`;
    default:
      return spec.title;
  }
}

// ── state view ──────────────────────────────────────────────────────────────

function stateView(s: PdfLiveState, history: ProjectHistory | null, select: readonly string[] | undefined): Record<string, unknown> {
  const p = s.pattern;
  return {
    technique: "pdf",
    source: s.source,
    busy: s.busy,
    phases: s.phases.map((ph, i) => {
      const refined = s.refinedPhases[i] ?? ph;
      return { id: ph.id, name: ph.name, spaceGroup: ph.spaceGroup.hermannMauguin, cell: cellOf(refined), sites: ph.sites.map((site) => `${site.label} ${site.element}`) };
    }),
    data: {
      points: p.points.length,
      axis: "r (Å)",
      extent: [sig(s.extent.min, 5), sig(s.extent.max, 5)],
      fitWindow: [sig(s.fitRange.min, 5), sig(s.fitRange.max, 5)],
      defaultWindow: [sig(s.defaultRange.min, 5), sig(s.defaultRange.max, 5)],
      observations: s.observationCount,
      radiation: p.scatteringType,
      ...(p.qmax !== undefined ? { qmax: p.qmax } : {}),
    },
    positions: s.positionMode === "irreps" ? "symmetry-mode amplitudes (irreps)" : "constrained atomic coordinates",
    spinModel: s.spinModel ? "applied: refine fits nuclear + magnetic G(r)" : null,
    Rw: pct(s.rw),
    lastRefinement: s.result
      ? {
          status: s.result.status,
          Rw: pct(s.result.agreement.rWeighted ?? 0),
          iterations: s.result.history.length,
          ...(s.result.diagnostics ? { maxShiftOverEsd: sig(s.result.diagnostics.maxShiftOverEsd, 3), atBounds: s.result.diagnostics.atBounds.map((b) => b.parameterId) } : {}),
          ...(s.result.message ? { message: s.result.message } : {}),
        }
      : null,
    ...(s.warnings.length ? { warnings: s.warnings } : {}),
    convention: PDF_CONVENTION,
    ...parameterSummary(s.parameters, s.result?.esd, select),
    history: historyView(history),
  };
}

// ── analysis helpers ────────────────────────────────────────────────────────

/**
 * The MCP assessment, read for real space: the GoF (and the expected R it is
 * formed from) is dropped, since uniform weights make it meaningless, and no
 * residual is passed — its peak scan works in d-spacing, on Bragg peaks.
 */
function assessment(s: PdfLiveState): ReturnType<typeof assess_refinement> & { convention: string } {
  if (!s.result) throw new Error("there is no refinement result on screen — refine first (a model change clears the last result)");
  const { goodnessOfFit: _gof, rExpected: _rExp, ...agreement } = s.result.agreement;
  const out = assess_refinement({
    result: { ...s.result, agreement },
    parameters: [...s.parameters],
    observationCount: s.observationCount,
    mode: "pdf",
    restraints: s.restraints,
  });
  return { ...out, convention: `${PDF_CONVENTION} The verdict reads convergence only; wRPercent is Rw. No residual-peak scan in real space.` };
}

/** One box of a scan, in the run's ascending window order. */
function boxAt(run: BoxcarRun, series: BoxcarRun["series"][number], i: number): BoxcarRun["series"][number]["result"]["steps"][number] | undefined {
  return series.result.steps[boxcarStepIndex(series.direction, i, run.windows.length, series.result.steps.length)];
}

/** The scan as the model reads it: per box its window, Rw and the free values; per parameter its spread. */
function boxcarView(run: BoxcarRun, parameters: readonly RefinementParameter[]): Record<string, unknown> {
  const label = new Map(parameters.map((p) => [p.id, p.label]));
  const passes = run.series.map((series) => {
    const boxes = run.windows.map((w, i) => {
      const step = boxAt(run, series, i);
      if (!step) return null;
      return {
        r: [sig(w.min, 4), sig(w.max, 4)],
        Rw: pct(step.result.agreement.rWeighted ?? NaN),
        ...(step.carried ? {} : { diverged: true }),
        values: Object.fromEntries(run.freeIds.map((id) => [id, sig(step.result.parameters[id] ?? NaN, 5)])),
      };
    }).filter((b) => b !== null);
    const spread = Object.fromEntries(run.freeIds.map((id) => {
      const v = boxes.map((b) => b.values[id] as number).filter(Number.isFinite);
      const lo = Math.min(...v);
      const hi = Math.max(...v);
      return [id, { label: label.get(id) ?? id, first: v[0], last: v.at(-1), min: lo, max: hi }];
    }));
    return { direction: series.direction, boxes, spread };
  });
  return { boxcar: { width: run.width, boxes: run.windows.length, passes }, reading: "Rw and a parameter that drift together across r mean the model fits some length scales and not others: compare the low-r boxes (the local structure) with the high-r ones (the average)." };
}

/** The card's outcome line: the scan's Rw at low and high r. */
function boxcarLine(run: BoxcarRun): string {
  const series = run.series[0];
  const first = series && boxAt(run, series, 0);
  const last = series && boxAt(run, series, run.windows.length - 1);
  const rw = (step: typeof first): string => (step ? `${pct(step.result.agreement.rWeighted ?? NaN).toFixed(1)}%` : "?");
  return `${run.windows.length} boxes · Rw ${rw(first)} at low r → ${rw(last)} at high r`;
}
