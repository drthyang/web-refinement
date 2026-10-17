/**
 * The user's method as code: the firm rules the Agent cannot refine past, and
 * the stages it moves through, for each page. The skills (skills.ts) say the
 * same in the user's words; this is what the app enforces and shows.
 *
 * - Firm rules (`MethodRule`) refuse a refinement, like the correlation
 *   check: the occupancy guardrail on both pages (no occupancy refines with
 *   nothing but the scale to determine it), and the instrument's terms never
 *   refined together with the thermal parameters (the user's demo feedback:
 *   alternate the two groups). Only the user lifts a rule, through
 *   allow_exception, which always asks them, even in Auto.
 * - The fit range comes first: check_fit_range reads the data's ends and
 *   proposes a window (the user's demo feedback: an edge that is not real
 *   data was fitted). A check, done once it has run; the window is set by
 *   set_fit_range, with the user's approval.
 * - The cell check at the start is a check, not a gate: it catches gross
 *   problems (a peak no reflection can index) and never blocks a refinement.
 *   The space group is reviewed LAST (review_symmetry refuses until every
 *   required stage is done): a structure is refined to the best before its
 *   symmetry is questioned, and intensity misfit is what refinement fixes.
 * - Stages are the method's blocks in order. A stage is done once a converged
 *   refinement had one of its parameters free (the scale, refined with every
 *   stage, counts for the first only when nothing else is free). Freeing a later block before an
 *   earlier one is a note on the outcome, not a refusal (the user's profile
 *   order is not rigid); the drawer shows the stages as a checklist.
 *
 * The record (the checks, exceptions, stages done, notes) is per analysis —
 * the data and the phases — and is kept by the shell, saved with the project.
 */

import type { LinearRestraint, ParameterKind, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { AgentRecordFile } from "@/core/project/types";
import type { AgentPage } from "@/agent/tools";
import type { LiveState } from "@/agent/port";
import { PAGE_METHOD } from "@/agent/skills";
import { parseTie } from "@/core/refinement/constraints";
import { lineage, type ProjectHistory } from "@/core/project/history";

export type MethodRule = "bare-occupancy" | "instrument-with-thermal";

export const RULES: Readonly<Record<MethodRule, { readonly title: string; readonly pages: readonly AgentPage[] }>> = {
  "bare-occupancy": { title: "Refine an occupancy with no tie or second contrast", pages: ["powder", "pdf", "singleCrystal"] },
  "instrument-with-thermal": { title: "Refine instrument and thermal parameters together", pages: ["powder", "pdf"] },
};

/**
 * The instrument's terms, GSAS-II's Instrument Parameters: the zero (or the
 * TOF calibration), the peak shape (Caglioti U V W, Lorentzian X Y, the TOF
 * profile) and its asymmetry; on a PDF the resolution, Qdamp and Qbroad.
 * Size and strain broadening are the sample's, not the instrument's.
 */
export const INSTRUMENT_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>([
  "zeroShift", "tofCalibration", "peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY", "asymSL", "asymHL", "tofProfile", "qdamp", "qbroad",
]);

/** The thermal parameters: B_iso and the anisotropic U's. */
export const THERMAL_KINDS: ReadonlySet<ParameterKind> = new Set<ParameterKind>(["bIso", "uAniso"]);

export type ParameterGroup = "instrument" | "thermal";

export function groupOf(kind: ParameterKind): ParameterGroup | null {
  return INSTRUMENT_KINDS.has(kind) ? "instrument" : THERMAL_KINDS.has(kind) ? "thermal" : null;
}

/**
 * The record of one analysis (the shape a project file stores): the last cell
 * check and symmetry review, the firm rules the user lifted and why, the
 * stages a converged refinement has covered (stage ids), and the Agent's notes.
 */
export type AgentRecord = AgentRecordFile;

export function emptyRecord(key: string): AgentRecord {
  return { key, exceptions: [], stagesDone: [], notes: [] };
}

/** The analysis on a page, from its live state. */
export function keyOfState(page: AgentPage, s: LiveState): string {
  if ("phases" in s) return analysisKey(page, s.source, s.phases);
  // An inverted model is the same analysis: keyed by the model as loaded.
  if ("dataset" in s) return analysisKey(page, s.source, [s.loadedAs ?? s.structure]);
  return analysisKey(page, s.source, [s.structure, ...s.extraPhases]);
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

/** my-rietveld-workflow: the fit range, the cell check, atoms before profile, ADPs, occupancy, corrections; symmetry last. */
const POWDER_STAGES: readonly MethodStage[] = [
  { id: "range", label: "Fit range", kinds: [] },
  { id: "check", label: "Cell check", kinds: [] },
  { id: "base", label: "Scale, background, cell", kinds: ["scale", "background", "cellLength", "cellAngle", "zeroShift", "tofCalibration"] },
  { id: "positions", label: "Positions", kinds: ["atomX", "atomY", "atomZ", "positionShift"] },
  { id: "profile", label: "Profile", kinds: ["peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY", "asymSL", "asymHL", "tofProfile", "mustrainIso", "stephensStrain", "anisoSizePerp", "anisoSizePar", "mustrainPerp", "mustrainPar"] },
  { id: "adp", label: "ADPs", kinds: ["bIso", "uAniso"] },
  { id: "occupancy", label: "Occupancy", kinds: ["occupancy"], optional: true },
  { id: "corrections", label: "Corrections", kinds: ["sampleDisplacement", "sampleTransparency", "poRatio", "absorption", "surfaceRoughA", "surfaceRoughB", "extinction"], optional: true },
  { id: "symmetry", label: "Symmetry review (last)", kinds: [], optional: true },
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

/**
 * sc-workflow: the data first (merging, resolution, completeness, absences),
 * then scale and extinction, positions, isotropic ADPs, anisotropic ADPs; the
 * rest where the data call for it. A twin's fractions (the Flack x) are overall
 * terms of the intensities, refined from the start with the scale as SHELXL
 * refines BASF with the OSF: their stage follows the scale's.
 */
const SC_STAGES: readonly MethodStage[] = [
  { id: "data", label: "Data quality", kinds: [] },
  { id: "base", label: "Scale, extinction", kinds: ["scale", "extinction", "batchScale"] },
  { id: "twin", label: "Twin fractions", kinds: ["twinFraction"], optional: true },
  { id: "positions", label: "Positions", kinds: ["atomX", "atomY", "atomZ", "positionShift", "ridingTorsion"] },
  { id: "adp", label: "Isotropic ADPs", kinds: ["bIso"] },
  { id: "aniso", label: "Anisotropic ADPs", kinds: ["uAniso"], optional: true },
  { id: "occupancy", label: "Occupancy", kinds: ["occupancy"], optional: true },
];

export function stagesFor(page: AgentPage): readonly MethodStage[] {
  return page === "powder" ? POWDER_STAGES : page === "pdf" ? PDF_STAGES : SC_STAGES;
}

/** Refined with every stage, so they mark their own stage only when nothing else is free: the scale, and a twin's fractions with it. */
const ALWAYS_FREE: ReadonlySet<ParameterKind> = new Set(["scale", "pdfScale", "twinFraction"]);

/**
 * The stages a converged refinement with these parameters free covers. The
 * scale rides along with every stage: refined with the positions, it does not
 * make the background and the cell refined. A stage the model has no
 * parameter for (`all`: every row on the page) cannot be refined, and a later
 * stage refined passes it: isotropic ADPs in a structure loaded anisotropic,
 * its hydrogens riding.
 */
export function stagesCovered(page: AgentPage, free: readonly RefinementParameter[], all?: readonly RefinementParameter[]): string[] {
  const freeKinds = new Set(free.map((p) => p.kind));
  const rest = new Set([...freeKinds].filter((k) => !ALWAYS_FREE.has(k)));
  const kinds = rest.size > 0 ? rest : freeKinds;
  const stages = stagesFor(page);
  const covered = stages.map((s) => s.kinds.some((k) => kinds.has(k)));
  const last = covered.lastIndexOf(true);
  const available = all ? new Set(all.map((p) => p.kind)) : null;
  // A required stage the model has no parameter for is passed by a later one; an optional one (a twin the crystal does not have) stays open.
  return stages.filter((s, i) => covered[i] || (available !== null && i < last && !s.optional && s.kinds.length > 0 && !s.kinds.some((k) => available.has(k)))).map((s) => s.id);
}

/** Two values of a parameter the same: a refinement's own, read back from a snapshot. */
const sameValue = (a: number, b: number): boolean => a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/**
 * The stages done as the analysis stands, from the History: every stage a
 * converged refinement on the path to the step on screen covered (since the
 * analysis was loaded), as long as each of its parameters still holds the
 * value the last converged refinement that refined it left. Undo and
 * go_to_step leave the path; a reset, of every parameter or some, and a
 * value typed in by hand move a parameter off its refined value: either way
 * the stage is no longer done. `now` is the page as it is, its converged fit
 * counted even before the page records it as a step. Null without a History
 * (the record's own list then stands).
 */
export function stagesOnPath(page: AgentPage, history: ProjectHistory | null, now: { readonly parameters: readonly RefinementParameter[]; readonly result: RefinementResult | null }): string[] | null {
  if (!history) return null;
  const path = lineage(history);
  const start = Math.max(0, ...path.map((st, i) => (st.kind === "load" || st.kind === "open" ? i : 0)));
  const fits = path.slice(start).map((st) => {
    const r = st.workspace.refinement as { parameters?: readonly RefinementParameter[]; lastResult?: RefinementResult } | undefined;
    return { parameters: r?.parameters ?? [], result: r?.lastResult ?? null };
  });
  const covered = new Set<string>();
  // Each parameter's value at the end of the last converged refinement that refined it.
  const refinedValue = new Map<string, number>();
  for (const fit of [...fits, now]) {
    if (fit.result?.status !== "converged") continue;
    const refined = new Set(Object.keys(fit.result.esd));
    const free = fit.parameters.filter((p) => refined.has(p.id));
    for (const id of stagesCovered(page, free, fit.parameters)) covered.add(id);
    for (const p of free) refinedValue.set(p.id, p.value);
  }
  const value = new Map(now.parameters.map((p) => [p.id, p.value]));
  return stagesFor(page).filter((st) => covered.has(st.id) && now.parameters.every((p) => {
    if (!st.kinds.includes(p.kind)) return true;
    const was = refinedValue.get(p.id);
    return was === undefined || sameValue(was, value.get(p.id)!);
  })).map((st) => st.id);
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
    done: s.id === "range" ? record.rangeCheck !== undefined : s.id === "check" ? record.cellCheck !== undefined : s.id === "data" ? record.dataCheck !== undefined : s.id === "symmetry" ? record.symmetryReviewed !== undefined : done.has(s.id),
    optional: !!s.optional,
  }));
  return { skill: PAGE_METHOD[page], stages, next: stages.find((s) => !s.done && !s.optional)?.label ?? null };
}

/**
 * Freeing a block before an earlier required one: a note for the outcome.
 * The method's order is advice except where a firm rule backs it.
 */
export function outOfOrder(page: AgentPage, free: readonly RefinementParameter[], record: AgentRecord, all?: readonly RefinementParameter[]): string | null {
  const progress = methodProgress(page, record);
  // A stage the model has no parameter for is passed, not refined: it is never "refined out of order".
  const refined = new Set(stagesCovered(page, free));
  const passed = new Set(stagesCovered(page, free, all));
  const stages = stagesFor(page);
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    if (!refined.has(s.id)) continue;
    const skipped = stages.slice(0, i).filter((e) => !e.optional && e.kinds.length > 0 && !passed.has(e.id) && !progress.stages.find((v) => v.id === e.id)!.done);
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
 * The required refinement stages not done yet (labels): what must be refined
 * before the space group is questioned (review_symmetry). The cell check is a
 * check, not a stage to refine, so it is not among them.
 */
export function stagesLeft(page: AgentPage, record: AgentRecord): string[] {
  const done = new Set(record.stagesDone);
  return stagesFor(page).filter((s) => !s.optional && s.kinds.length > 0 && !done.has(s.id)).map((s) => s.label);
}

/**
 * The firm rules a refinement of this free set would break, as one refusal,
 * or null. Checked before the correlation probe: they do not depend on the
 * data's numbers. Every broken rule is named at once, so one change of the
 * free set can answer them all.
 */
export function ruleRefusal(page: AgentPage, free: readonly RefinementParameter[], restraints: readonly LinearRestraint[], record: AgentRecord, all: readonly RefinementParameter[] = free): RuleRefusal | null {
  const broken: { rule: MethodRule; line: string; why: string }[] = [];
  if (!hasException(record, "bare-occupancy")) {
    const tied = new Set(restraints.flatMap((r) => r.terms.map((t) => t.parameterId)));
    // An occupancy whose complement follows it (a disorder's alternatives, one minus the other) holds the site's sum: their contrast measures the split.
    for (const q of all) {
      if (q.kind !== "occupancy" || !q.expression) continue;
      const tie = parseTie(q.expression);
      if (tie.kind === "linear" && tie.factor < 0) tied.add(tie.refId);
    }
    const bare = free.filter((p) => p.kind === "occupancy" && !tied.has(p.id));
    if (bare.length > 0) {
      const fix = page === "powder" ? "Tie it (set_site_ties: Σ occ = 1 on a shared site, or hold composition)"
        : page === "singleCrystal" ? "Tie it (tie_parameters `complement`: a disorder's two alternatives add up to one)"
          : "Tie it (a shared site holds its Σ occupancy; a lone site has no tie on this page)";
      broken.push({
        rule: "bare-occupancy",
        line: `Not run: ${bare.map((p) => p.id).join(", ")} free with no tie`,
        why: `${bare.map((p) => p.id).join(", ")} ${bare.length === 1 ? "is a free occupancy" : "are free occupancies"} with nothing but the scale to determine ${bare.length === 1 ? "it" : "them"} — the user's method never frees an occupancy bare. ${fix}, or fix ${bare.length === 1 ? "it" : "them"}. If a second contrast determines it (X-ray near an absorption edge, isotopic neutron contrast) and the user agrees, call allow_exception with rule "bare-occupancy" and the reason — they approve it themselves.`,
      });
    }
  }
  if (!hasException(record, "instrument-with-thermal")) {
    const instrument = free.filter((p) => INSTRUMENT_KINDS.has(p.kind));
    const thermal = free.filter((p) => THERMAL_KINDS.has(p.kind));
    if (instrument.length > 0 && thermal.length > 0) {
      const ids = (ps: readonly RefinementParameter[]): string => ps.length <= 6 ? ps.map((p) => p.id).join(", ") : `${ps.slice(0, 6).map((p) => p.id).join(", ")} and ${ps.length - 6} more`;
      const trade = page === "pdf"
        ? "Qbroad widens the peaks with r and Qdamp damps them with r, as the ADPs and the correlated motion do: refined together, each absorbs the other's error and the esds hide it. Keep Qdamp and Qbroad from the standard measured on the same instrument (Ni, Si); if they must be refined"
        : "Wider or more Lorentzian peaks put intensity into tails the background takes up at high angle, and the B values' fall-off with angle gives it back; the zero and the asymmetry shape the low-angle lines that fix the scale the B values are measured against. Refined together, each absorbs the other's error (a B gone negative, a profile gone wide) and the esds hide it. Keep an instrument file's terms from its standard where they fit; where they must be refined";
      broken.push({
        rule: "instrument-with-thermal",
        line: `Not run: instrument terms (${ids(instrument)}) free with thermal (${ids(thermal)})`,
        why: `the instrument's terms (${ids(instrument)}) and the thermal parameters (${ids(thermal)}) are free together — the user's method never refines them together. ${trade}, alternate the two groups: fix the thermal parameters and refine the instrument terms, then fix those and refine the thermal ones, and repeat until a cycle moves neither by more than ${ALTERNATION_SETTLED} esd (refine's \`alternation\` gives the shifts). If the user wants them refined together, call allow_exception with rule "instrument-with-thermal" and their reason — they approve it themselves.`,
      });
    }
  }
  if (broken.length === 0) return null;
  const first = broken[0]!;
  if (broken.length === 1) return { rule: first.rule, line: first.line, message: `Not refined: ${first.why}` };
  return {
    rule: first.rule,
    line: broken.map((b) => b.line).join("; "),
    message: `Not refined, for ${broken.length} of the user's firm rules. ${broken.map((b, i) => `(${i + 1}) ${b.why}`).join(" ")}`,
  };
}

// ── the alternation: instrument and thermal refined in turn ────────────────

/** A cycle that moves neither group by more than this (in esd) ends the alternation. */
export const ALTERNATION_SETTLED = 0.3;

/** One group's last converged refinement in the alternation. */
export interface GroupRefinement {
  /** The group's values at its end, by id. */
  readonly values: Readonly<Record<string, number>>;
  /** The largest shift since the group's refinement before, in esd (null: its first). */
  readonly shift: { readonly id: string; readonly esds: number } | null;
  /** The shift of the refinement before (to see whether the alternation is converging). */
  readonly previousShift: number | null;
}

export type Alternation = Readonly<Partial<Record<ParameterGroup, GroupRefinement>>>;

/**
 * The alternation after a converged refinement: the group refined (the one
 * whose terms were free; none or both is no alternation step), its largest
 * shift since its last refinement, and whether the cycle has settled.
 */
export function advanceAlternation(
  memory: Alternation,
  free: readonly RefinementParameter[],
  parameters: readonly RefinementParameter[],
  esd: Readonly<Record<string, number>>,
): { readonly memory: Alternation; readonly refined: ParameterGroup | null } {
  const groups = new Set(free.map((p) => groupOf(p.kind)).filter((g): g is ParameterGroup => g !== null));
  let next: Alternation = memory;
  for (const g of groups) {
    const values = Object.fromEntries(parameters.filter((p) => groupOf(p.kind) === g).map((p) => [p.id, p.value]));
    const before = memory[g];
    let shift: GroupRefinement["shift"] = null;
    if (before) {
      for (const p of free) {
        if (groupOf(p.kind) !== g || before.values[p.id] === undefined) continue;
        const e = esd[p.id];
        if (!(e !== undefined && e > 0)) continue;
        const esds = Math.abs(values[p.id]! - before.values[p.id]!) / e;
        if (!shift || esds > shift.esds) shift = { id: p.id, esds };
      }
    }
    next = { ...next, [g]: { values, shift, previousShift: before?.shift?.esds ?? null } };
  }
  return { memory: next, refined: groups.size === 1 ? [...groups][0]! : null };
}

/** For refine's outcome: where the alternation stands after a step of it. Null when there is no alternation yet. */
export function alternationView(memory: Alternation, refined: ParameterGroup | null, parameters: readonly RefinementParameter[]): Record<string, unknown> | null {
  if (!refined) return null;
  const other: ParameterGroup = refined === "instrument" ? "thermal" : "instrument";
  // Before the other group has been refined, there is nothing to alternate with.
  if (!memory[other]) return null;
  const mine = memory[refined]!;
  const name = (g: ParameterGroup): string => g === "instrument" ? "the instrument terms" : "the thermal parameters";
  const idsOf = (g: ParameterGroup): string => {
    const ids = parameters.filter((p) => groupOf(p.kind) === g && !p.expression).map((p) => p.id);
    return ids.length <= 6 ? ids.join(", ") : `${ids.slice(0, 6).join(", ")}, …`;
  };
  const shiftText = (g: GroupRefinement | undefined): string => g?.shift ? `${g.shift.id} ${g.shift.esds.toFixed(2)} esd` : "not yet measured";
  const settled = [mine, memory[other]].every((g) => g?.shift && g.shift.esds <= ALTERNATION_SETTLED);
  const slow = mine.shift && mine.previousShift !== null && mine.shift.esds > ALTERNATION_SETTLED && mine.shift.esds > (2 / 3) * mine.previousShift;
  return {
    alternation: {
      refined: `${name(refined)} (${idsOf(refined)}), with ${name(other)} fixed`,
      largestShift: mine.shift ? `${shiftText(mine)} since their last refinement` : "their first refinement in the alternation",
      otherGroupLastShift: shiftText(memory[other]),
      settled,
      next: settled
        ? `Neither group moved by more than ${ALTERNATION_SETTLED} esd in its last refinement: the alternation has converged. Each group's esds are conditional on the other held fixed; say so in the report.`
        : `Fix ${name(refined)} and refine ${name(other)} (${idsOf(other)}) again${other === "instrument" ? ", unless they stay at the instrument file's values" : ""}; stop when a cycle moves neither group by more than ${ALTERNATION_SETTLED} esd.`,
      ...(slow ? { slow: `The shifts shrink slowly (${mine.shift!.id}: ${mine.previousShift!.toFixed(2)} → ${mine.shift!.esds.toFixed(2)} esd): the two groups are coupled. Tell the user, and ask whether one joint refinement is acceptable (allow_exception) or the B values are to be reported as conditional on the instrument terms.` } : {}),
    },
  };
}
