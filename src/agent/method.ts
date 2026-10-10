/**
 * The user's method as code: the firm rules the Agent cannot refine past, and
 * the stages it moves through, for each page. The skills (skills.ts) say the
 * same in the user's words; this is what the app enforces and shows.
 *
 * - Firm rules (`MethodRule`) refuse a refinement, like the correlation
 *   check: the cell gate on the powder page (no atomic parameter refines
 *   until check_cell_symmetry has passed for this analysis) and the occupancy
 *   guardrail on both pages (no occupancy refines with nothing but the scale
 *   to determine it). Only the user lifts one, through allow_exception, which
 *   always asks them, even in Auto.
 * - Stages are the method's blocks in order. A stage is done once a converged
 *   refinement had one of its parameters free. Freeing a later block before an
 *   earlier one is a note on the outcome, not a refusal (the user's profile
 *   order is not rigid); the drawer shows the stages as a checklist.
 *
 * The record (gate, exceptions, stages done, notes) is per analysis — the
 * data and the phases — and is kept by the shell, saved with the project.
 */

import type { LinearRestraint, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { AgentPage } from "@/agent/tools";
import type { LiveState } from "@/agent/port";
import { PAGE_METHOD } from "@/agent/skills";

export type MethodRule = "cell-gate" | "bare-occupancy";

export const RULES: Readonly<Record<MethodRule, { readonly title: string; readonly pages: readonly AgentPage[] }>> = {
  "cell-gate": { title: "Refine the structure before the cell gate has passed", pages: ["powder"] },
  "bare-occupancy": { title: "Refine an occupancy with no tie or second contrast", pages: ["powder", "pdf"] },
};

export interface AgentRecord {
  /** The analysis this record belongs to (analysisKey). */
  readonly key: string;
  /** The last cell gate (check_cell_symmetry) on this analysis. */
  readonly cellGate?: { readonly passed: boolean; readonly at: number; readonly summary: string };
  /** Firm rules the user lifted for this analysis, and why. */
  readonly exceptions: readonly { readonly rule: MethodRule; readonly reason: string; readonly at: number }[];
  /** Stages a converged refinement has covered (stage ids). */
  readonly stagesDone: readonly string[];
  /** The Agent's notes on this analysis: findings and the user's decisions. */
  readonly notes: readonly { readonly text: string; readonly at: number }[];
}

export function emptyRecord(key: string): AgentRecord {
  return { key, exceptions: [], stagesDone: [], notes: [] };
}

/** The analysis on a page, from its live state. */
export function keyOfState(page: AgentPage, s: LiveState): string {
  return "phases" in s ? analysisKey(page, s.source, s.phases) : analysisKey(page, s.source, [s.structure, ...s.extraPhases]);
}

/** What identifies an analysis: the page, the data, and the phases (name and space group). */
export function analysisKey(page: AgentPage, source: string, phases: readonly { readonly name: string; readonly spaceGroup: { readonly hermannMauguin?: string; readonly number?: number } }[]): string {
  return [page, source, ...phases.map((p) => `${p.name}|${p.spaceGroup.hermannMauguin ?? p.spaceGroup.number ?? "?"}`)].join("¦");
}

// ── stages ─────────────────────────────────────────────────────────────────

export interface MethodStage {
  readonly id: string;
  readonly label: string;
  /** Parameter kinds this stage frees (none: a check, not a block). */
  readonly kinds: readonly ParameterKind[];
  /** A stage the method uses only when the data call for it. */
  readonly optional?: boolean;
}

const ATOMIC: readonly ParameterKind[] = ["atomX", "atomY", "atomZ", "positionShift", "bIso", "uAniso", "occupancy"];

/** my-rietveld-workflow: the gate, then atoms before profile, ADPs, occupancy, corrections. */
const POWDER_STAGES: readonly MethodStage[] = [
  { id: "gate", label: "Cell gate", kinds: [] },
  { id: "base", label: "Scale, background, cell", kinds: ["scale", "background", "cellLength", "cellAngle", "zeroShift", "tofCalibration"] },
  { id: "positions", label: "Positions", kinds: ["atomX", "atomY", "atomZ", "positionShift"] },
  { id: "profile", label: "Profile", kinds: ["peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY", "asymSL", "asymHL", "tofProfile", "mustrainIso", "stephensStrain", "anisoSizePerp", "anisoSizePar", "mustrainPerp", "mustrainPar"] },
  { id: "adp", label: "ADPs", kinds: ["bIso", "uAniso"] },
  { id: "occupancy", label: "Occupancy", kinds: ["occupancy"], optional: true },
  { id: "corrections", label: "Corrections", kinds: ["sampleDisplacement", "sampleTransparency", "poRatio", "absorption", "surfaceRoughA", "surfaceRoughB", "extinction"], optional: true },
];

/** pdf-workflow: scale and cell, ADPs, one correlated-motion term, positions, occupancy, particle size. */
const PDF_STAGES: readonly MethodStage[] = [
  { id: "base", label: "Scale, cell", kinds: ["pdfScale", "cellLength", "cellAngle"] },
  { id: "adp", label: "ADPs", kinds: ["bIso", "uAniso"] },
  { id: "motion", label: "Correlated motion", kinds: ["delta1", "delta2", "sratio", "rcut"] },
  { id: "positions", label: "Positions", kinds: ["atomX", "atomY", "atomZ", "positionShift"] },
  { id: "occupancy", label: "Occupancy", kinds: ["occupancy"], optional: true },
  { id: "size", label: "Particle size", kinds: ["spdiameter"], optional: true },
];

export function stagesFor(page: AgentPage): readonly MethodStage[] {
  return page === "powder" ? POWDER_STAGES : PDF_STAGES;
}

/** The stages a converged refinement with these parameters free covers. */
export function stagesCovered(page: AgentPage, free: readonly RefinementParameter[]): string[] {
  const kinds = new Set(free.map((p) => p.kind));
  return stagesFor(page).filter((s) => s.kinds.some((k) => kinds.has(k))).map((s) => s.id);
}

export interface StageView {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  readonly optional: boolean;
}

export interface MethodProgress {
  /** The page's method skill. */
  readonly skill: string;
  readonly stages: readonly StageView[];
  /** The first required stage not done yet (null: all done; then the acceptance checks). */
  readonly next: string | null;
}

export function methodProgress(page: AgentPage, record: AgentRecord): MethodProgress {
  const done = new Set(record.stagesDone);
  const stages = stagesFor(page).map((s): StageView => ({
    id: s.id,
    label: s.label,
    done: s.id === "gate" ? record.cellGate?.passed === true || hasException(record, "cell-gate") : done.has(s.id),
    optional: !!s.optional,
  }));
  return { skill: PAGE_METHOD[page], stages, next: stages.find((s) => !s.done && !s.optional)?.label ?? null };
}

/**
 * Freeing a block before an earlier required one: a note for the outcome.
 * The method's order is advice except where a firm rule backs it.
 */
export function outOfOrder(page: AgentPage, free: readonly RefinementParameter[], record: AgentRecord): string | null {
  const progress = methodProgress(page, record);
  const covered = new Set(stagesCovered(page, free));
  const stages = stagesFor(page);
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    if (!covered.has(s.id)) continue;
    const skipped = stages.slice(0, i).filter((e) => !e.optional && e.kinds.length > 0 && !covered.has(e.id) && !progress.stages.find((v) => v.id === e.id)!.done);
    if (skipped.length > 0) {
      return `Out of the method's order (${PAGE_METHOD[page]}): ${s.label.toLowerCase()} refined before ${skipped.map((e) => e.label.toLowerCase()).join(", ")}. Fine if the residual calls for it; say why.`;
    }
  }
  return null;
}

// ── firm rules ─────────────────────────────────────────────────────────────

export function hasException(record: AgentRecord, rule: MethodRule): boolean {
  return record.exceptions.some((e) => e.rule === rule);
}

export interface RuleRefusal {
  readonly rule: MethodRule;
  /** For the model: why, and what to do. */
  readonly message: string;
  /** For the card. */
  readonly line: string;
}

/**
 * The firm rule a refinement of this free set would break, or null. Checked
 * before the correlation probe: these do not depend on the data's numbers.
 */
export function ruleRefusal(page: AgentPage, free: readonly RefinementParameter[], restraints: readonly LinearRestraint[], record: AgentRecord): RuleRefusal | null {
  if (page === "powder" && !(record.cellGate?.passed) && !hasException(record, "cell-gate")) {
    const atomic = free.filter((p) => ATOMIC.includes(p.kind));
    if (atomic.length > 0) {
      const ran = record.cellGate ? `The cell gate ran and did not pass (${record.cellGate.summary}).` : "The cell gate has not run on this analysis.";
      return {
        rule: "cell-gate",
        line: `Not run: ${atomic.length} atomic parameter${atomic.length === 1 ? "" : "s"} before the cell gate`,
        message: `Not refined: the user's method keeps the structure fixed until the cell and space group are trusted, and ${atomic.map((p) => p.id).slice(0, 6).join(", ")}${atomic.length > 6 ? ` and ${atomic.length - 6} more` : ""} ${atomic.length === 1 ? "is" : "are"} atomic. ${ran} Run check_cell_symmetry; once it passes, refine again. If it cannot pass (a known impurity the model lacks, an overlap) and the user wants to go on regardless, ask them, then call allow_exception with rule "cell-gate" and their reason — they approve it themselves.`,
      };
    }
  }
  if (!hasException(record, "bare-occupancy")) {
    const tied = new Set(restraints.flatMap((r) => r.terms.map((t) => t.parameterId)));
    const bare = free.filter((p) => p.kind === "occupancy" && !tied.has(p.id));
    if (bare.length > 0) {
      const fix = page === "powder" ? "Tie it (set_site_ties: Σ occ = 1 on a shared site, or hold composition)" : "Tie it (a shared site holds its Σ occupancy; a lone site has no tie on this page)";
      return {
        rule: "bare-occupancy",
        line: `Not run: ${bare.map((p) => p.id).join(", ")} free with no tie`,
        message: `Not refined: ${bare.map((p) => p.id).join(", ")} ${bare.length === 1 ? "is a free occupancy" : "are free occupancies"} with nothing but the scale to determine ${bare.length === 1 ? "it" : "them"} — the user's method never frees an occupancy bare. ${fix}, or fix ${bare.length === 1 ? "it" : "them"}. If a second contrast determines it (X-ray near an absorption edge, isotopic neutron contrast) and the user agrees, call allow_exception with rule "bare-occupancy" and the reason — they approve it themselves.`,
      };
    }
  }
  return null;
}
