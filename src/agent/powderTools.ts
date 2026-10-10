/**
 * The Agent tools on the powder page: each one reads the live state through
 * the page's port (port.ts) or calls the page's own handler. The analysis
 * tools are the MATERIA MCP handlers (src/mcp/tools.ts) fed from what is on
 * screen, so the Agent and a headless agent judge a fit the same way.
 */

import type { PowderAgentPort, PowderLiveState } from "@/agent/port";
import type { LiveToolSpec } from "@/agent/tools";
import type { ProjectHistory } from "@/core/project/history";
import {
  assess_refinement,
  bond_geometry,
  check_cell_symmetry,
  find_unexplained_peaks,
  interpret_structure,
  rank_next_parameters,
  suggest_next_steps,
} from "@/mcp/tools";
import type { StructureModel } from "@/core/crystal/types";
import type { BackgroundType } from "@/core/diffraction/background";
import type { MustrainModel } from "@/app/powderSpec";
import { applyFree, bondsOf, cellOf, describeFree, freeNoOp, goToStep, historyView, parameterSummary, pct, sig, type LiveToolHost } from "@/agent/liveCommon";


/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are validated against the spec's zod schema before a handler runs */
type Input = any;

/** Run a read or control tool. Returns the JSON result the model sees. */
export function readPowderTool(name: string, input: Input, port: PowderAgentPort, host: LiveToolHost): unknown {
  const s = port.state();
  switch (name) {
    case "get_state":
      return stateView(s, host.history(), input.parameters);
    case "assess_refinement":
      return assessment(s);
    case "suggest_next_steps":
      return { steps: suggest_next_steps({ assessment: assessment(s) }) };
    case "rank_next_parameters": {
      if (s.extraPhases.length > 0) throw new Error("rank_next_parameters is single-phase only; this session has " + (s.extraPhases.length + 1) + " phases");
      const ranked = rank_next_parameters({
        structure: s.structure,
        pattern: s.pattern,
        parameters: [...s.parameters],
        bindings: [...s.bindings],
        profile: s.profile,
        magnetic: s.magnetic,
      });
      return {
        wrNow: pct(ranked.wrNow),
        groups: ranked.groups.slice(0, 12).map((g) => ({
          group: g.group,
          parameterIds: g.parameterIds,
          predictedWr: pct(g.predictedWr),
          expectedRelativeImprovement: sig(g.expectedRelativeImprovement, 3),
        })),
      };
    }
    case "check_cell_symmetry":
      return check_cell_symmetry({
        structure: s.refinedPhases[0] ?? s.structure,
        pattern: s.pattern,
        ...(s.instrument ? { instrument: s.instrument } : {}),
        ...(s.extraPhases.length > 0 ? { extraPhases: s.refinedPhases.slice(1) as StructureModel[] } : {}),
        ...(s.fitRange ? { fitRange: { ...s.fitRange } } : {}),
        ...(input.dMin !== undefined ? { dMin: input.dMin } : {}),
        ...(input.significance !== undefined ? { significance: input.significance } : {}),
      });
    case "find_unexplained_peaks": {
      const residual = residualOf(s);
      const found = find_unexplained_peaks({
        residual,
        options: { ...(input.sigma !== undefined ? { sigma: input.sigma } : {}), limit: input.limit ?? 12 },
      });
      return { count: found.count, peaks: found.peaks.map((p) => ({ d: sig(p.d, 5), height: sig(p.height, 3) })) };
    }
    case "bond_geometry":
      return bondsOf(s.refinedPhases, input, bond_geometry);
    case "interpret_structure": {
      const wavelength = s.instrument?.kind === "constantWavelength" ? s.instrument.wavelength : s.pattern.radiation.kind !== "neutron-tof" ? s.pattern.radiation.wavelength : undefined;
      return interpret_structure({
        structure: s.refinedPhases[0] ?? s.structure,
        parameters: [...s.parameters],
        ...(s.result ? { esd: { ...s.result.esd } } : {}),
        ...(wavelength !== undefined ? { wavelength } : {}),
        magnetic: s.magnetic,
      });
    }
    default:
      throw new Error(`${name} is not a powder read tool`);
  }
}

/**
 * Make a change on the page. Returns a note for the model when the change
 * needed adjusting (tied parameters skipped). The caller records the step and
 * reports the outcome once the change has rendered.
 */
export async function changePowder(name: string, input: Input, port: PowderAgentPort, host: LiveToolHost): Promise<string | undefined> {
  const s = port.state();
  switch (name) {
    case "set_free":
      return applyFree(s.parameters, input, port.setFixed);
    case "set_background":
      if (input.terms === undefined && input.type === undefined) throw new Error("pass `terms`, `type`, or both");
      if (input.terms !== undefined) port.setBackgroundTerms(input.terms);
      if (input.type !== undefined) port.setBackgroundType(input.type as BackgroundType);
      return undefined;
    case "set_microstrain":
      port.setMustrain(input.model as MustrainModel);
      return undefined;
    case "set_adp_model":
      port.setAnisotropicAdp(!!input.anisotropic);
      return undefined;
    case "set_fit_range": {
      if (input.whole) {
        port.setFitRange(null);
        return undefined;
      }
      const min = input.min ?? s.extent.min;
      const max = input.max ?? s.extent.max;
      if (!(max > min)) throw new Error(`the window needs max > min (got ${min}–${max})`);
      if (max < s.extent.min || min > s.extent.max) throw new Error(`${min}–${max} is outside the pattern (${sig(s.extent.min, 6)}–${sig(s.extent.max, 6)} ${s.pattern.xUnit})`);
      port.setFitRange({ min: Math.max(min, s.extent.min), max: Math.min(max, s.extent.max) });
      return undefined;
    }
    case "refine":
      if (s.viewOnly) throw new Error("this pattern is view-only (a TOF pattern without a TOF profile); load its instrument file to refine it");
      if (!s.parameters.some((p) => !p.fixed && !p.expression)) throw new Error("no parameter is free — free some with set_free first");
      {
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
      throw new Error(`${name} is not a powder change tool`);
  }
}

/**
 * Why a change would do nothing, or null when it would do something — a
 * no-op never asks the user for approval.
 */
export function powderNoOp(spec: LiveToolSpec, input: Input, s: PowderLiveState): string | null {
  return spec.name === "set_free" ? freeNoOp(s.parameters, input) : null;
}

/** One line for the approval card: what this change will do, in the page's terms. */
export function describePowderChange(spec: LiveToolSpec, input: Input, s: PowderLiveState): string {
  switch (spec.name) {
    case "set_free":
      return describeFree(s.parameters, input);
    case "set_background":
      return [
        ...(input.terms !== undefined ? [`Background terms ${s.settings.backgroundTerms} → ${String(input.terms)}`] : []),
        ...(input.type !== undefined ? [`Background basis ${s.settings.backgroundType} → ${String(input.type)}`] : []),
      ].join(" · ");
    case "set_microstrain":
      return `Microstrain ${s.settings.mustrain} → ${String(input.model)}`;
    case "set_adp_model":
      return `ADPs ${s.settings.anisotropicAdp ? "anisotropic" : "isotropic"} → ${input.anisotropic ? "anisotropic" : "isotropic"}`;
    case "set_fit_range":
      return input.whole ? "Fit the whole pattern" : `Fit window ${String(input.min ?? sig(s.extent.min, 6))} – ${String(input.max ?? sig(s.extent.max, 6))} ${s.pattern.xUnit}`;
    case "refine": {
      const free = s.parameters.filter((p) => !p.fixed && !p.expression).length;
      return input.mode === "thorough"
        ? `${s.result ? "Escape minimum" : "Prefit"} (multi-start) on ${free} free parameter${free === 1 ? "" : "s"}`
        : `Refine ${free} free parameter${free === 1 ? "" : "s"}`;
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

function stateView(s: PowderLiveState, history: ProjectHistory | null, select: readonly string[] | undefined): Record<string, unknown> {
  const xs = s.pattern.points;
  return {
    technique: "powder",
    source: s.source,
    busy: s.busy,
    ...(s.viewOnly ? { viewOnly: "TOF pattern without a TOF profile: shown, not refined" } : {}),
    phases: [s.structure, ...s.extraPhases].map((ph, i) => {
      const refined = s.refinedPhases[i] ?? ph;
      return { id: ph.id, name: ph.name, spaceGroup: ph.spaceGroup.hermannMauguin, cell: cellOf(refined), sites: ph.sites.map((site) => `${site.label} ${site.element}`) };
    }),
    data: {
      points: xs.length,
      axis: s.pattern.xUnit,
      extent: [sig(s.extent.min, 6), sig(s.extent.max, 6)],
      fitWindow: s.fitRange ? [sig(s.fitRange.min, 6), sig(s.fitRange.max, 6)] : "whole pattern",
      observations: s.observationCount,
      radiation: s.pattern.radiation.kind,
    },
    instrument: s.instrument
      ? s.instrument.kind === "constantWavelength" ? { kind: "constant wavelength", wavelength: s.instrument.wavelength } : { kind: "time of flight", difC: s.instrument.difC }
      : "none loaded (default CW, λ = 1.54 Å)",
    settings: { ...s.settings, profileShape: s.profile.shape },
    magneticModel: s.magnetic
      ? { propagation: s.magnetic.propagation, moments: s.magnetic.moments.length, refined: s.parameters.some((p) => p.kind === "momentMode") }
      : null,
    wR: pct(s.wR),
    lastRefinement: s.result
      ? {
          status: s.result.status,
          wR: pct(s.result.agreement.rWeighted ?? 0),
          gof: s.result.agreement.goodnessOfFit !== undefined ? sig(s.result.agreement.goodnessOfFit, 4) : null,
          rExpected: s.result.agreement.rExpected !== undefined ? pct(s.result.agreement.rExpected) : null,
          iterations: s.result.history.length,
          ...(s.result.diagnostics ? { maxShiftOverEsd: sig(s.result.diagnostics.maxShiftOverEsd, 3), atBounds: s.result.diagnostics.atBounds.map((b) => b.parameterId) } : {}),
          ...(s.result.message ? { message: s.result.message } : {}),
        }
      : null,
    ...parameterSummary(s.parameters, s.result?.esd, select),
    history: historyView(history),
  };
}

// ── analysis helpers ────────────────────────────────────────────────────────

function residualOf(s: PowderLiveState): { d: number[]; yObs: number[]; yCalc: number[] } {
  if (!s.d) throw new Error("this pattern's axis cannot be converted to d-spacing (no wavelength or TOF calibration)");
  // Inside the fit window only: outside it the model is not being fitted.
  const keep = s.curves.x.map((x) => !s.fitRange || (x >= s.fitRange.min && x <= s.fitRange.max));
  const pick = (a: readonly number[]): number[] => a.filter((_, i) => keep[i]);
  return { d: pick(s.d), yObs: pick(s.curves.yObs), yCalc: pick(s.curves.yCalc) };
}

function assessment(s: PowderLiveState): ReturnType<typeof assess_refinement> {
  if (!s.result) throw new Error("there is no refinement result on screen — refine first (a model change clears the last result)");
  return assess_refinement({
    result: s.result,
    parameters: [...s.parameters],
    observationCount: s.observationCount,
    ...(s.d ? { residual: residualOf(s) } : {}),
    mode: "powder",
  });
}
