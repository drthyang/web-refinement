/**
 * What every page's Agent tools share: freeing and fixing by id or glob, the
 * history and parameter views get_state returns, and number formatting. The
 * page-specific tools (powderTools.ts, pdfTools.ts) build on these, so a model
 * sees the same shapes whichever page is open.
 */

import type { RefinementParameter } from "@/core/refinement/types";
import type { ProjectHistory } from "@/core/project/history";
import { lineage } from "@/core/project/history";
import type { StructureModel } from "@/core/crystal/types";

/** What every page's tools need from the shell besides the page itself. */
export interface LiveToolHost {
  readonly history: () => ProjectHistory | null;
  readonly goToStep: (id: string) => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are validated against the spec's zod schema before a handler runs */
type Input = any;

/** get_state's parameter part: the groups with free counts, and the rows asked for (default the free ones). */
export function parameterSummary(
  params: readonly RefinementParameter[],
  esd: Readonly<Record<string, number>> | undefined,
  select: readonly string[] | undefined,
): Record<string, unknown> {
  const isFree = (p: RefinementParameter): boolean => !p.fixed && !p.expression;
  const groups = new Map<string, { kind: string; count: number; free: number; tied: number }>();
  for (const p of params) {
    const g = groups.get(p.kind) ?? { kind: p.kind, count: 0, free: 0, tied: 0 };
    g.count++;
    if (isFree(p)) g.free++;
    if (p.expression) g.tied++;
    groups.set(p.kind, g);
  }
  const patterns = select?.map((f) => ({ f, re: globRegExp(f) }));
  const unmatched = patterns?.filter(({ re }) => !params.some((p) => re.test(p.id))).map(({ f }) => f) ?? [];
  const rows = (patterns ? params.filter((p) => patterns.some(({ re }) => re.test(p.id))) : params.filter(isFree))
    .map((p) => parameterRow(p, esd?.[p.id] ?? p.esd));
  return { parameterGroups: [...groups.values()], parameterRows: rows, ...(unmatched.length ? { unmatched } : {}) };
}

/** set_free on any page: plan it, then hand the changes to the page's own handler. */
export function applyFree(params: readonly RefinementParameter[], input: Input, setFixed: (changes: { id: string; fixed: boolean }[]) => void): string | undefined {
  const plan = freePlan(params, input.free ?? [], input.fix ?? []);
  if (plan.changes.length === 0) return plan.note ?? "nothing to change: every named parameter was already in that state";
  setFixed(plan.changes);
  return plan.note;
}

/** Why set_free would change nothing, or null when it would change something. */
export function freeNoOp(params: readonly RefinementParameter[], input: Input): string | null {
  const plan = freePlan(params, input.free ?? [], input.fix ?? []);
  return plan.changes.length === 0 ? plan.note ?? "every named parameter is already in that state" : null;
}

/** set_free's approval-card line. */
export function describeFree(params: readonly RefinementParameter[], input: Input): string {
  const plan = freePlan(params, input.free ?? [], input.fix ?? []);
  const freed = plan.changes.filter((c) => !c.fixed).map((c) => labelOf(params, c.id));
  const fixed = plan.changes.filter((c) => c.fixed).map((c) => labelOf(params, c.id));
  const parts = [...(freed.length ? [`Free ${listOf(freed)}`] : []), ...(fixed.length ? [`Fix ${listOf(fixed)}`] : [])];
  return parts.length ? parts.join(" · ") : "No change: every named parameter is already in that state";
}

/** go_to_step on any page. */
export function goToStep(host: LiveToolHost, step: string): void {
  const h = host.history();
  if (!h || !h.steps.some((st) => st.id === step)) throw new Error(`no step ${step} in the history`);
  host.goToStep(step);
}

/** The bond_geometry tool on a page's refined phases. */
export function bondsOf(refinedPhases: readonly StructureModel[], input: Input, bondGeometry: (args: { structure: StructureModel; cutoff?: number }) => { shortest: unknown; bonds: readonly { distance: number }[] }): unknown {
  const phase = input.phase ? refinedPhases.find((p) => p.id === input.phase) : refinedPhases[0];
  if (!phase) throw new Error(`no phase "${String(input.phase)}" — phases: ${refinedPhases.map((p) => p.id).join(", ")}`);
  const geo = bondGeometry({ structure: phase, ...(input.cutoff !== undefined ? { cutoff: input.cutoff } : {}) });
  return { phase: phase.id, shortest: geo.shortest, bonds: geo.bonds.slice(0, 40).map((b) => ({ ...b, distance: sig(b.distance, 5) })) };
}

export function historyView(history: ProjectHistory | null): unknown {
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

export function parameterRow(p: RefinementParameter, esd: number | undefined): Record<string, unknown> {
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

export function cellOf(s: StructureModel): Record<string, number> {
  const c = s.cell;
  return { a: sig(c.a, 7), b: sig(c.b, 7), c: sig(c.c, 7), alpha: sig(c.alpha, 6), beta: sig(c.beta, 6), gamma: sig(c.gamma, 6) };
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

export function labelOf(params: readonly RefinementParameter[], id: string): string {
  return params.find((p) => p.id === id)?.label ?? id;
}

export function listOf(items: readonly string[], max = 8): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** A fraction as a percentage with two decimals, the way the page shows wR. */
export function pct(f: number): number {
  return Math.round(f * 10000) / 100;
}

export function sig(v: number, digits = 6): number {
  return Number.isFinite(v) ? Number(v.toPrecision(digits)) : v;
}
