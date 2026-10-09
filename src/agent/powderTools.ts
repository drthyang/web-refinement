/**
 * The Agent tools on the powder page: each one reads the live state through
 * the page's port (port.ts) or calls the page's own handler. The analysis
 * tools are the MATERIA MCP handlers (src/mcp/tools.ts) fed from what is on
 * screen, so the Agent and a headless agent judge a fit the same way.
 */

import type { PowderAgentPort, PowderLiveState } from "@/agent/port";
import type { LiveToolSpec } from "@/agent/tools";
import type { RefinementParameter } from "@/core/refinement/types";
import type { ProjectHistory } from "@/core/project/history";
import { lineage } from "@/core/project/history";
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

/** What the powder handlers need from the shell besides the page itself. */
export interface PowderToolHost {
  readonly history: () => ProjectHistory | null;
  readonly goToStep: (id: string) => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are validated against the spec's zod schema before a handler runs */
type Input = any;

/** Run a read or control tool. Returns the JSON result the model sees. */
export function readPowderTool(name: string, input: Input, port: PowderAgentPort, host: PowderToolHost): unknown {
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
    case "bond_geometry": {
      const phase = input.phase ? s.refinedPhases.find((p) => p.id === input.phase) : s.refinedPhases[0];
      if (!phase) throw new Error(`no phase "${String(input.phase)}" — phases: ${s.refinedPhases.map((p) => p.id).join(", ")}`);
      const geo = bond_geometry({ structure: phase, ...(input.cutoff !== undefined ? { cutoff: input.cutoff } : {}) });
      return { phase: phase.id, shortest: geo.shortest, bonds: geo.bonds.slice(0, 40).map((b) => ({ ...b, distance: sig(b.distance, 5) })) };
    }
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
export async function changePowder(name: string, input: Input, port: PowderAgentPort, host: PowderToolHost): Promise<string | undefined> {
  const s = port.state();
  switch (name) {
    case "set_free": {
      const plan = freePlan(s.parameters, input.free ?? [], input.fix ?? []);
      if (plan.changes.length === 0) return plan.note ?? "nothing to change: every named parameter was already in that state";
      port.setFixed(plan.changes);
      return plan.note;
    }
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
    case "go_to_step": {
      const h = host.history();
      if (!h || !h.steps.some((st) => st.id === input.step)) throw new Error(`no step ${String(input.step)} in the history`);
      host.goToStep(input.step);
      return undefined;
    }
    default:
      throw new Error(`${name} is not a powder change tool`);
  }
}

/**
 * Why a change would do nothing, or null when it would do something — a
 * no-op never asks the user for approval.
 */
export function powderNoOp(spec: LiveToolSpec, input: Input, s: PowderLiveState): string | null {
  if (spec.name === "set_free") {
    const plan = freePlan(s.parameters, input.free ?? [], input.fix ?? []);
    return plan.changes.length === 0 ? plan.note ?? "every named parameter is already in that state" : null;
  }
  return null;
}

/** One line for the approval card: what this change will do, in the page's terms. */
export function describePowderChange(spec: LiveToolSpec, input: Input, s: PowderLiveState): string {
  switch (spec.name) {
    case "set_free": {
      const plan = freePlan(s.parameters, input.free ?? [], input.fix ?? []);
      const freed = plan.changes.filter((c) => !c.fixed).map((c) => labelOf(s.parameters, c.id));
      const fixed = plan.changes.filter((c) => c.fixed).map((c) => labelOf(s.parameters, c.id));
      const parts = [
        ...(freed.length ? [`Free ${listOf(freed)}`] : []),
        ...(fixed.length ? [`Fix ${listOf(fixed)}`] : []),
      ];
      return parts.length ? parts.join(" · ") : "No change: every named parameter is already in that state";
    }
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
  const isFree = (p: RefinementParameter): boolean => !p.fixed && !p.expression;
  const groups = new Map<string, { kind: string; count: number; free: number; tied: number }>();
  for (const p of s.parameters) {
    const g = groups.get(p.kind) ?? { kind: p.kind, count: 0, free: 0, tied: 0 };
    g.count++;
    if (isFree(p)) g.free++;
    if (p.expression) g.tied++;
    groups.set(p.kind, g);
  }
  const patterns = select?.map((f) => ({ f, re: globRegExp(f) }));
  const unmatched = patterns?.filter(({ re }) => !s.parameters.some((p) => re.test(p.id))).map(({ f }) => f) ?? [];
  const rows = (patterns ? s.parameters.filter((p) => patterns.some(({ re }) => re.test(p.id))) : s.parameters.filter(isFree))
    .map((p) => parameterRow(p, s.result?.esd[p.id] ?? p.esd));
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
    parameterGroups: [...groups.values()],
    parameterRows: rows,
    ...(unmatched.length ? { unmatched } : {}),
    history: historyView(history),
  };
}

function historyView(history: ProjectHistory | null): unknown {
  if (!history) return null;
  const recent = lineage(history).slice(-8).reverse();
  return {
    current: history.current,
    steps: history.steps.length,
    recent: recent.map((st) => ({
      id: st.id,
      label: st.name ?? st.label,
      ...(st.summary.wR !== undefined ? { wR: pct(st.summary.wR) } : {}),
      free: st.summary.nFree,
      by: st.actor ?? "user",
    })),
  };
}

function parameterRow(p: RefinementParameter, esd: number | undefined): Record<string, unknown> {
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    value: sig(p.value, 6),
    ...(esd !== undefined && !p.fixed ? { esd: sig(esd, 2) } : {}),
    state: p.expression ? `tied ${p.expression}` : p.fixed ? "fixed" : "free",
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
  };
}

function cellOf(s: StructureModel): Record<string, number> {
  const c = s.cell;
  return { a: sig(c.a, 7), b: sig(c.b, 7), c: sig(c.c, 7), alpha: sig(c.alpha, 6), beta: sig(c.beta, 6), gamma: sig(c.gamma, 6) };
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

// ── free / fix ──────────────────────────────────────────────────────────────

/**
 * Which `fixed` flags a set_free call changes. A tied parameter (an
 * expression) follows its tie and is skipped with a note; a name matching
 * nothing is an error listing the ids, so the model can correct itself.
 */
export function freePlan(
  params: readonly RefinementParameter[],
  free: readonly string[],
  fix: readonly string[],
): { changes: { id: string; fixed: boolean }[]; note?: string } {
  if (free.length === 0 && fix.length === 0) throw new Error("pass `free`, `fix`, or both");
  const match = (list: readonly string[]): Set<string> => {
    const out = new Set<string>();
    const unmatched: string[] = [];
    for (const f of list) {
      const re = globRegExp(f);
      const hits = params.filter((p) => re.test(p.id));
      if (hits.length === 0) unmatched.push(`"${f}"`);
      for (const p of hits) out.add(p.id);
    }
    if (unmatched.length) throw new Error(`nothing matches ${unmatched.join(", ")}. Parameter ids: ${params.map((p) => p.id).join(", ")}`);
    return out;
  };
  const toFree = match(free);
  const toFix = match(fix);
  const both = [...toFree].filter((id) => toFix.has(id));
  if (both.length) throw new Error(`${both.join(", ")} would be both freed and fixed`);
  const tied: string[] = [];
  const changes: { id: string; fixed: boolean }[] = [];
  for (const p of params) {
    if (toFree.has(p.id)) {
      if (p.expression) tied.push(p.id);
      else if (p.fixed) changes.push({ id: p.id, fixed: false });
    } else if (toFix.has(p.id) && !p.fixed && !p.expression) {
      changes.push({ id: p.id, fixed: true });
    }
  }
  return { changes, ...(tied.length ? { note: `skipped tied parameter${tied.length === 1 ? "" : "s"} ${tied.join(", ")} (they follow their tie)` } : {}) };
}

export function globRegExp(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function labelOf(params: readonly RefinementParameter[], id: string): string {
  return params.find((p) => p.id === id)?.label ?? id;
}

function listOf(items: readonly string[], max = 8): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** A fraction as a percentage with two decimals, the way the page shows wR. */
function pct(f: number): number {
  return Math.round(f * 10000) / 100;
}

function sig(v: number, digits = 6): number {
  return Number.isFinite(v) ? Number(v.toPrecision(digits)) : v;
}
