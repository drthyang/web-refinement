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
import { applyFree, bondsOf, cellOf, describeFree, freeNoOp, goToStep, historyView, parameterSummary, pct, sig, type LiveToolHost } from "@/agent/liveCommon";

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
export async function changePdf(name: string, input: Input, port: PdfAgentPort, host: LiveToolHost): Promise<string | undefined> {
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
    case "reset_parameters":
      port.reset();
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
      return "Reset every parameter to its starting value";
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
  });
  return { ...out, convention: `${PDF_CONVENTION} The verdict reads convergence only; wRPercent is Rw. No residual-peak scan in real space.` };
}
