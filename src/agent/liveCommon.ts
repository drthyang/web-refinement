/**
 * What every page's Agent tools share: freeing and fixing by id or glob, the
 * history and parameter views get_state returns, and number formatting. The
 * page-specific tools (powderTools.ts, pdfTools.ts) build on these, so a model
 * sees the same shapes whichever page is open.
 */

import type { RefinementParameter } from "@/core/refinement/types";
import type { ProjectHistory } from "@/core/project/history";
import type { AgentRecord } from "@/agent/method";
import { lineage } from "@/core/project/history";
import type { StructureModel } from "@/core/crystal/types";
import { bondValenceReading, bondValenceSums } from "@/core/crystal/bondValence";
import { withEsd } from "@/agent/structureTable";
import { bondEsds, bondKeys } from "@/core/workflow/bondEsds";
import { covalentlyBonded, hydrogenBondLines, inverseImage, ringGeometryLines } from "@/core/crystal/geometry";

export { bondEsds };

/** What a change handler returns: a note for the model, or a note and data to merge into its answer. */
export type ChangeResult = string | { readonly note?: string; readonly data: Record<string, unknown> } | undefined;

/** What every page's tools need from the shell besides the page itself. */
export interface LiveToolHost {
  readonly history: () => ProjectHistory | null;
  readonly goToStep: (id: string) => void;
  /** The Agent's record of an analysis (method.ts), and a change to it: kept with the project. */
  readonly record: (key: string) => AgentRecord;
  readonly updateRecord: (key: string, update: (record: AgentRecord) => AgentRecord) => void;
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
  const patterns = select?.map((f) => ({ f, test: idMatcher(params, f) }));
  const unmatched = patterns?.filter(({ test }) => !params.some((p) => test(p.id))).map(({ f }) => f) ?? [];
  const rows = (patterns ? params.filter((p) => patterns.some(({ test }) => test(p.id))) : params.filter(isFree))
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

type BondGeometry = (args: { structure: StructureModel; cutoff?: number }) => { shortest: unknown; bonds: readonly { distance: number }[] };

/** A structure's bonds as bond_geometry finds them, each once: A–B and B–A at the same length are one bond. */
export function uniqueBonds(structure: StructureModel, input: Input, bondGeometry: BondGeometry): { shortest: unknown; bonds: { from?: string; to?: string; distance: number }[] } {
  const geo = bondGeometry({ structure, ...(input.cutoff !== undefined ? { cutoff: input.cutoff } : {}) });
  const seen = new Set<string>();
  const bonds = (geo.bonds as { from?: string; to?: string; distance: number }[]).filter((bond) => {
    const key = `${[bond.from, bond.to].sort().join("–")}@${bond.distance.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { shortest: geo.shortest, bonds };
}

/** A bond read from its far end: `to` first, its image code (the CIF's site symmetry of the far atom) inverted. */
function reversed<B extends { from?: string; to?: string; distance: number; image?: string }>(phase: StructureModel, b: B): B {
  const { image, ...rest } = b;
  const back = image ? inverseImage(phase, image) : undefined;
  return { ...rest, from: b.to, to: b.from, ...(back && back !== "1_555" ? { image: back } : {}) } as B;
}

/** The shortest bond, its length to five significant digits (0.98, not 0.9799999999999989). */
function shortestOf(shortest: unknown): unknown {
  const s = shortest as { distance?: unknown } | null;
  return s && typeof s.distance === "number" ? { ...s, distance: sig(s.distance, 5) } : shortest;
}

/** The bond_geometry tool on a page's refined phases; with `esds`, each bond's esd from the refined positions. */
export function bondsOf(refinedPhases: readonly StructureModel[], input: Input, bondGeometry: BondGeometry, esds?: (phase: StructureModel) => Map<string, number>): unknown {
  const phase = input.phase ? refinedPhases.find((p) => p.id === input.phase) : refinedPhases[0];
  if (!phase) throw new Error(`no phase "${String(input.phase)}" — phases: ${refinedPhases.map((p) => p.id).join(", ")}`);
  const geo = uniqueBonds(phase, input, bondGeometry);
  const bonds = geo.bonds;
  const sums = bondValenceSums(phase);
  const esdByKey = esds?.(phase);
  const keys = bondKeys(bonds);
  // Only the bonds to the atoms asked for, when asked; a list cut at 40 says so.
  const asked = Array.isArray(input.atoms) && input.atoms.length > 0 ? new Set(input.atoms as string[]) : null;
  const unknown = asked ? [...asked].filter((label) => !phase.sites.some((site) => site.label === label)) : [];
  if (unknown.length) throw new Error(`no site ${unknown.join(", ")} in ${phase.id} — sites: ${phase.sites.map((site) => site.label).join(", ")}`);
  const all = bonds.map((b, i) => ({ b, key: keys[i]! })).filter(({ b }) => !asked || asked.has(b.from ?? "") || asked.has(b.to ?? ""));
  // In a molecular structure (one with carbon) a bond is what the covalent radii make one; the rest are contacts.
  const molecular = phase.sites.some((site) => site.element === "C");
  const elementOf = new Map(phase.sites.map((site) => [site.label, site.element]));
  const bonded = (b: { from?: string; to?: string; distance: number }): boolean => covalentlyBonded(elementOf.get(b.from ?? "") ?? "", elementOf.get(b.to ?? "") ?? "", b.distance);
  const listed = molecular ? all.filter(({ b }) => bonded(b)) : all;
  // A contact is neither a bond nor two bonds apart (a hydrogen and its parent's neighbour): those the bonds and their angles give.
  const neighbours = new Map<string, Set<string>>();
  for (const b of bonds) {
    if (!bonded(b)) continue;
    const [x, y] = [b.from ?? "", b.to ?? ""];
    if (!neighbours.has(x)) neighbours.set(x, new Set());
    if (!neighbours.has(y)) neighbours.set(y, new Set());
    neighbours.get(x)!.add(y);
    neighbours.get(y)!.add(x);
  }
  const geminal = (b: { from?: string; to?: string }): boolean => [...(neighbours.get(b.from ?? "") ?? [])].some((c) => neighbours.get(b.to ?? "")?.has(c));
  const contacts = molecular ? all.filter(({ b }) => !bonded(b) && !geminal(b)) : [];
  // A riding hydrogen's bond to its parent is set by the constraint: no esd.
  const pair = (a?: string, b?: string): string => [a ?? "", b ?? ""].sort().join("–");
  const riding = new Set((phase.riding ?? []).filter((r) => r.geometry !== "free").map((r) => pair(r.site, r.parent)));
  // Nothing within the cutoff for the atoms asked: say so, and how far their nearest neighbour is.
  const cutoff = typeof input.cutoff === "number" ? input.cutoff : 3.2;
  const nearest = asked && all.length === 0
    ? uniqueBonds(phase, { cutoff: 6 }, bondGeometry).bonds.filter((b) => asked.has(b.from ?? "") || asked.has(b.to ?? "")).sort((a, b) => a.distance - b.distance)[0]
    : undefined;
  const nearAsked = <B extends { from?: string; to?: string; distance: number; image?: string }>(b: B): B => (asked && !asked.has(b.from ?? "") ? reversed(phase, b) : b);
  // A molecule's rings (a Cp's metal, an X–H···π) and hydrogen bonds, those of the atoms asked for when asked.
  const names = (line: string): boolean => !asked || [...asked].some((a) => line.split(/[^A-Za-z0-9']+/).includes(a));
  const ringLines = molecular ? ringGeometryLines(phase) : { rings: [], contacts: [] };
  const centroids = ringLines.contacts.filter(names);
  const hydrogenBonds = molecular ? hydrogenBondLines(phase).filter(names) : [];
  return {
    // The id is what `phase` takes; the name, when it says more ("loaded" is a single-crystal page's id).
    phase: phase.id,
    ...(phase.name && phase.name !== phase.id ? { name: phase.name } : {}),
    shortest: shortestOf(geo.shortest),
    ...(asked && all.length === 0 ? { none: `no neighbour of ${[...asked].join(", ")} within the cutoff (${cutoff} Å)${nearest ? `; the nearest is ${nearAsked(nearest).from}–${nearAsked(nearest).to} at ${nearest.distance.toFixed(3)} Å: give a longer \`cutoff\`` : " nor within 6 Å"}` } : {}),
    ...(listed.length > 40 ? { listed: `the 40 shortest of ${listed.length} bonds${asked ? ` to ${[...asked].join(", ")}` : ""} up to the cutoff: name the atoms (atoms) to see the others` } : {}),
    ...(contacts.length ? { contacts: `${contacts.length} longer contact${contacts.length === 1 ? "" : "s"} up to the cutoff, neither bonds by the covalent radii (their sum + 0.4 Å) nor two bonds apart: ${contacts.slice(0, 8).map(({ b }) => `${b.from}···${b.to} ${b.distance.toFixed(3)} Å`).join(", ")}${contacts.length > 8 ? ", …" : ""}` } : {}),
    ...(centroids.length ? { rings: ringLines.rings, centroids } : {}),
    ...(hydrogenBonds.length ? { hydrogenBonds } : {}),
    bonds: listed.slice(0, 40).map(({ b: found, key }) => {
      // Read from the atom asked for: the far end's image code becomes the reverse bond's.
      const b = asked && asked.has(found.to ?? "") ? nearAsked(found) : found;
      if (riding.has(pair(b.from, b.to))) return { ...b, distance: sig(b.distance, 5), length: `${b.distance.toFixed(4)} (riding: set by the constraint, no esd)` };
      const e = esdByKey?.get(key);
      return e !== undefined && e > 0 ? { ...b, distance: sig(b.distance, 5), length: withEsd(b.distance, e, 5) } : { ...b, distance: sig(b.distance, 5) };
    }),
    ...(sums.length ? {
      bondValence: {
        sums: sums.map((v) => ({ site: v.site, valence: `${v.element}${v.valence}+${v.assumed ? " (assumed)" : ""}`, sum: sig(v.sum, 3), coordination: sig(v.coordination, 3), meanDistance: sig(v.meanDistance, 4) })),
        reading: bondValenceReading(sums),
      },
    } : {}),
  };
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
      const test = idMatcher(params, f);
      const hits = params.filter((p) => test(p.id));
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

/** The ids these globs match, in the parameters' order; an unmatched glob is an error naming the ids. */
export function matchIds(params: readonly RefinementParameter[], globs: readonly string[]): string[] {
  const res = globs.map((g) => ({ g, test: idMatcher(params, g) }));
  const unmatched = res.filter(({ test }) => !params.some((p) => test(p.id))).map(({ g }) => `"${g}"`);
  if (unmatched.length) throw new Error(`nothing matches ${unmatched.join(", ")}. Parameter ids: ${params.map((p) => p.id).join(", ")}`);
  return params.filter((p) => res.some(({ test }) => test(p.id))).map((p) => p.id);
}

/**
 * Which ids a glob names. A multi-phase model prefixes each phase's ids
 * (p0_pos_Ca1_0, p1_cell_a): a glob that matches no id as written is tried
 * against the ids without the prefix, so "pos_*" means every phase's
 * positions, as on a single-phase page (round 10, NAC with fluorite).
 */
export function idMatcher(params: readonly RefinementParameter[], glob: string): (id: string) => boolean {
  const re = globRegExp(glob);
  if (params.some((p) => re.test(p.id))) return (id) => re.test(id);
  return (id) => re.test(id.replace(/^p\d+_/, ""));
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
