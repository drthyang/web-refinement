/**
 * The Agent's analysis report: the page's own report — every engine number:
 * the data and the model, the fit figure, the refined structures with esds,
 * every parameter, the diagnostics — with the analysis as the Agent ran it:
 * the History's steps on the path to the result (what was freed at each
 * refinement, and the method stage that is the reason for it), the method's
 * checklist, the engine's checks and the issues left open, the Bayesian check
 * when one ran on this refinement, and the notes kept in the record.
 *
 * The Agent writes one thing: its own account (`narrative`), labelled as its
 * words. Its decimal numbers are audited against the numbers the report
 * computed (reportAudit.ts); any that match none are marked in the report and
 * returned, so the Agent can correct them.
 */

import { reportHtml, type ReportAgent, type ReportCheck, type ReportInput, type ReportPosterior, type ReportStep } from "@/core/export/report";
import { reportMarkdown } from "@/core/export/reportMarkdown";
import { unverifiedNumbers } from "@/core/export/reportAudit";
import { lineage, type HistoryStep, type ProjectHistory } from "@/core/project/history";
import type { ParameterBinding, ParameterKind, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { AgentPage } from "@/agent/tools";
import { RULES, methodProgress, stagesCovered, stagesFor, stagesLeft, type AgentRecord } from "@/agent/method";
import { differenceSentences, readPosterior, type PosteriorRun } from "@/agent/posteriorTool";
import type { UnitCell } from "@/core/crystal/types";
import { isInversion, type ExtinctionModel, type OmittedMeasurement, type ResolutionRange, type TwinLaw } from "@/core/diffraction/types";
import { improper } from "@/core/workflow/singleCrystalRefinement";
import { EIGHT_PI_SQUARED, uEquivalent } from "@/core/crystal/adp";
import { EXTINCTION_MODEL_LABELS, EXTINCTION_PARAMETER_LABELS } from "@/core/diffraction/singleCrystalFactors";
import { withEsd } from "@/agent/structureTable";

/** A finished report, as the viewer shows it and the downloads save it. */
export interface AgentReport {
  readonly id: number;
  readonly title: string;
  readonly technique: AgentPage;
  readonly html: string;
  readonly markdown: string;
  /** File name without its extension. */
  readonly fileBase: string;
  readonly at: number;
  /** Numbers in the Agent's account that match no value the report computed. */
  readonly unverified: readonly string[];
  /**
   * What the number audit read: the Agent's words (its account and notes) and
   * the text it checked them against (the report's engine numbers and what
   * the user said). An eval saves it, so a change to the audit can be scored
   * on saved runs again.
   */
  readonly audit: { readonly account: string; readonly against: string };
}

/** Short names of the parameter kinds, for a refinement's "Refined" column. */
const KIND_SHORT: Partial<Record<ParameterKind, string>> = {
  scale: "scale", background: "background", cellLength: "cell", cellAngle: "cell", zeroShift: "zero",
  tofCalibration: "TOF calibration", atomX: "positions", atomY: "positions", atomZ: "positions", positionShift: "positions",
  occupancy: "occupancy", bIso: "B", uAniso: "Uij",
  peakWidth: "profile", profileU: "profile", profileV: "profile", profileW: "profile", profileX: "profile", profileY: "profile", tofProfile: "profile",
  asymSL: "asymmetry", asymHL: "asymmetry",
  mustrainIso: "microstrain", stephensStrain: "microstrain", mustrainPerp: "microstrain", mustrainPar: "microstrain", anisoSizePerp: "size", anisoSizePar: "size",
  sampleDisplacement: "displacement", sampleTransparency: "transparency", poRatio: "texture", absorption: "absorption",
  surfaceRoughA: "roughness", surfaceRoughB: "roughness", extinction: "extinction", batchScale: "batch scales",
  magneticScale: "magnetic scale", momentX: "moments", momentY: "moments", momentZ: "moments", momentMode: "moments", propagationK: "k",
  pdfScale: "scale", qdamp: "Qdamp", qbroad: "Qbroad", delta1: "δ1", delta2: "δ2", spdiameter: "particle size", sratio: "sratio", rcut: "rcut",
  mpdfOrdScale: "mPDF scale", mpdfParaScale: "mPDF paramagnetic scale", mpdfPsigma: "mPDF width", corrLength: "correlation length",
};

/** The free parameters, by group: "scale, background ×6, cell ×2". */
export function freeSummary(params: readonly RefinementParameter[]): string {
  const counts = new Map<string, number>();
  for (const p of params) {
    if (p.fixed || p.expression) continue;
    const k = KIND_SHORT[p.kind] ?? p.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
}

function stepParameters(st: HistoryStep): readonly RefinementParameter[] {
  const r = st.workspace.refinement as { parameters?: readonly RefinementParameter[] } | undefined;
  return r?.parameters ?? [];
}

/** An unnamed edit that only freed or fixed parameters: the next refinement's row shows what was free. */
function freeFixOnly(st: HistoryStep): boolean {
  return st.kind === "edit" && !st.name && /^(Freed|Fixed)\b/.test(st.label) && !/(^|· )set /i.test(st.label);
}

/**
 * The steps on the path from the first step to the one on screen, as the
 * report lists them, and how many steps lie on branches the analysis left.
 */
export function historySteps(page: AgentPage, history: ProjectHistory | null, method = true): { steps: ReportStep[]; otherBranches: number; rowOf: Map<string, number> } {
  if (!history) return { steps: [], otherBranches: 0, rowOf: new Map() };
  const path = lineage(history);
  const stageLabel = new Map(stagesFor(page).map((s) => [s.id, s.label]));
  const shown = path.filter((st) => !freeFixOnly(st));
  const steps = shown.map((st): ReportStep => {
    const refine = st.kind === "refine";
    const free = refine ? stepParameters(st).filter((p) => !p.fixed && !p.expression) : [];
    // Without the skills (arm C) there is no method stage to give as a step's reason.
    const stages = method ? stagesCovered(page, free).map((id) => stageLabel.get(id) ?? id).join(" · ") : "";
    const status = refine && st.summary.status && st.summary.status !== "converged" ? ` (${st.summary.status})` : "";
    return {
      label: `${st.name ? `${st.name} — ` : ""}${st.label}${status}`,
      by: st.actor === "agent" ? "agent" : "user",
      kind: st.kind,
      ...(refine && st.summary.wR !== undefined ? { wR: st.summary.wR } : {}),
      // No GoF on the PDF page (uniform weights), even from a project saved before steps left it out.
      ...(refine && page !== "pdf" && st.summary.gof !== undefined ? { gof: st.summary.gof } : {}),
      free: st.summary.nFree,
      ...(free.length > 0 ? { refined: freeSummary(free) } : {}),
      ...(stages ? { stages } : {}),
    };
  });
  return { steps, otherBranches: history.steps.length - path.length, rowOf: new Map(shown.map((st, i) => [st.id, i + 1])) };
}

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** A single-crystal step's workspace fields the comparison reads (inline in a History step). */
interface ScStepFields {
  /** The bindings are shared between steps: a pointer into the History's blobs. */
  readonly refinement?: { readonly parameters?: readonly RefinementParameter[]; readonly bindings?: readonly ParameterBinding[] | { readonly blob: string }; readonly lastResult?: RefinementResult };
  readonly extinctionModel?: ExtinctionModel;
  readonly resolution?: ResolutionRange;
  readonly omitted?: readonly OmittedMeasurement[];
  readonly outlierFilter?: { readonly on: boolean; readonly cutoffSigma: number; readonly minExtinction?: number };
  readonly adpModel?: "isotropic" | "anisotropic";
  readonly twinLaws?: readonly TwinLaw[];
  readonly inverted?: boolean;
  readonly weighting?: { readonly a: number; readonly b: number };
}

/** A step's twin model in a few words: untwinned, the inversion twin, or the domains (both hands when one is inverted). */
function twinWords(laws: readonly TwinLaw[] | undefined): string {
  if (!laws?.length) return "untwinned";
  if (laws.length === 1 && isInversion(laws[0]!)) return "inversion twin";
  return `${laws.length + 1} twin domains${laws.some((l) => improper(l.matrix)) ? " of both hands" : ""}`;
}

/** "H11A 0.088(8)", "H11B 0.088(8)", … as one entry, "H11A…H15C 0.088(8)": a run of sites with one value (a shared U). */
function runsOf(entries: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const [label, value] = [entries[i]!.slice(0, entries[i]!.indexOf(" ")), entries[i]!.slice(entries[i]!.indexOf(" ") + 1)];
    let j = i + 1;
    while (j < entries.length && entries[j]!.slice(entries[j]!.indexOf(" ") + 1) === value) j++;
    // Two sites that happen to agree stay two entries; a run of three or more is one (a shared U, a group).
    if (j - i > 2) out.push(`${label}…${entries[j - 1]!.slice(0, entries[j - 1]!.indexOf(" "))} ${value} (${j - i} sites)`);
    else out.push(...entries.slice(i, j));
    i = j;
  }
  return out;
}

/** The ADP model a refinement kept as loaded, named: the values refine, the model (anisotropic or isotropic per atom) is the file's. */
function loadedAdpWords(params: readonly { kind: string; fixed?: boolean; expression?: unknown }[]): string {
  const aniso = params.some((p) => p.kind === "uAniso");
  // A riding hydrogen's U_iso follows its parent (held, or tied to it): only a refined U_iso makes the model mixed.
  const iso = params.some((p) => p.kind === "bIso" && !p.fixed && !p.expression);
  return `${aniso && iso ? "anisotropic and isotropic" : aniso ? "anisotropic" : "isotropic"} ADPs as loaded`;
}

/** A step's U_eq in a line: every site of a small structure; of a large one, the first six (the heavy atoms, as a structure file lists them) and the others' range. */
function ueqText(entries: readonly string[]): string {
  if (entries.length <= 12) return entries.join(", ");
  // The value is each entry's second word ("C12 0.050(4)", "H11A…H15C 0.082(7) (15 sites)").
  const values = entries.slice(6).map((e) => Number.parseFloat(e.split(" ")[1] ?? "")).filter(Number.isFinite);
  return `${entries.slice(0, 6).join(", ")}; the other ${entries.length - 6} entries${values.length ? ` ${Math.min(...values).toFixed(3)}–${Math.max(...values).toFixed(3)}` : ""}`;
}

/** Each site's U_eq (Å²) with its esd, from a step's parameters: Σ c·basis over its tensor modes, or B/8π². */
function stepUeq(params: readonly RefinementParameter[], bindings: readonly ParameterBinding[], esd: Readonly<Record<string, number>>, cell: UnitCell): string[] {
  const value = new Map(params.map((p) => [p.id, p.value]));
  const free = new Set(params.filter((p) => !p.fixed && !p.expression).map((p) => p.id));
  const sites = [...new Set(bindings.filter((b) => (b.kind === "uAniso" || b.kind === "bIso") && b.targetKey).map((b) => b.targetKey!))];
  return sites.map((site) => {
    const own = bindings.filter((b) => b.targetKey === site && (b.kind === "uAniso" || b.kind === "bIso"));
    const aniso = own.filter((b) => b.kind === "uAniso" && b.uBasis);
    if (aniso.length > 0) {
      const u = [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number];
      let variance = 0;
      for (const b of aniso) {
        const c = value.get(b.parameterId) ?? 0;
        for (let i = 0; i < 6; i++) u[i]! += c * b.uBasis![i]!;
        const e = free.has(b.parameterId) ? esd[b.parameterId] : undefined;
        if (e !== undefined) variance += (uEquivalent(b.uBasis! as [number, number, number, number, number, number], cell) * e) ** 2;
      }
      return `${site} ${withEsd(uEquivalent(u, cell), variance > 0 ? Math.sqrt(variance) : undefined, 5)}`;
    }
    const b = own.find((x) => x.kind === "bIso");
    if (!b) return `${site} —`;
    const e = free.has(b.parameterId) ? esd[b.parameterId] : undefined;
    return `${site} ${withEsd((value.get(b.parameterId) ?? 0) / EIGHT_PI_SQUARED, e !== undefined ? e / EIGHT_PI_SQUARED : undefined, 5)}`;
  });
}

/**
 * Single crystal: the last converged refinement with the ADPs free under each
 * set of conditions — the extinction model, the resolution range, the
 * measurements omitted, the filter, the ADP model — on the path to the
 * result, with wR2, GooF, the extinction parameter and each site's U_eq. A
 * test (another extinction model, a high-order refinement, the extinction
 * cut) is reported with the engine's numbers, so the account can quote them.
 * Null with fewer than two such sets.
 */
export function comparedRefinements(history: ProjectHistory | null, cell: UnitCell, rowOf: ReadonlyMap<string, number>): ReportCheck | null {
  if (!history) return null;
  const last = new Map<string, { text: string; weights: string }>();
  for (const st of lineage(history)) {
    if (st.kind !== "refine" || st.summary.status !== "converged") continue;
    const ws = st.workspace as ScStepFields;
    const params = ws.refinement?.parameters ?? [];
    if (!params.some((p) => !p.fixed && !p.expression && (p.kind === "bIso" || p.kind === "uAniso"))) continue;
    const ext = params.find((p) => p.kind === "extinction");
    // An extinction held at 0 is none, whichever model would refine it (a listing's).
    const model = ext && (!ext.fixed || ext.value !== 0) ? ws.extinctionModel ?? "shelx" : null;
    const range = ws.resolution ?? {};
    const filter = ws.outlierFilter?.on ? ws.outlierFilter : undefined;
    const omitted = ws.omitted?.length ?? 0;
    const twin = twinWords(ws.twinLaws);
    // wR2 and GooF are sums under the weights: refinements under other weights are other conditions.
    const weights = ws.weighting && (ws.weighting.a > 0 || ws.weighting.b > 0) ? `WGHT ${ws.weighting.a} ${ws.weighting.b}` : "w = 1/σ²";
    const key = JSON.stringify([model, range.dMin ?? null, range.dMax ?? null, omitted, filter?.cutoffSigma ?? null, filter?.minExtinction ?? null, ws.adpModel ?? "cif", twin, ws.inverted ?? false, weights]);
    const conditions = [
      ...(ws.inverted ? ["the model inverted"] : []),
      ...(ws.twinLaws?.length ? [twin] : []),
      model ? EXTINCTION_MODEL_LABELS[model] : "no extinction",
      ...(range.dMin !== undefined || range.dMax !== undefined ? [`d ${range.dMax !== undefined ? `≤ ${range.dMax}` : ""}${range.dMin !== undefined && range.dMax !== undefined ? " and " : ""}${range.dMin !== undefined ? `≥ ${range.dMin}` : ""} Å`] : []),
      ...(filter ? [`filter |Δ|/σ > ${filter.cutoffSigma}${filter.minExtinction !== undefined ? ` or y < ${filter.minExtinction}` : ""}`] : []),
      ...(omitted ? [`${omitted} omitted`] : []),
      ws.adpModel === "anisotropic" ? "anisotropic" : ws.adpModel === "isotropic" ? "isotropic" : loadedAdpWords(params),
      weights,
    ].join(", ");
    const esd = ws.refinement?.lastResult?.esd ?? {};
    const extText = model && ext ? `; ${EXTINCTION_PARAMETER_LABELS[model]} ${withEsd(ext.value, ext.fixed ? undefined : esd[ext.id], 6)}` : "";
    const row = rowOf.get(st.id);
    const stored = ws.refinement?.bindings;
    const bindings = Array.isArray(stored) ? stored : stored && "blob" in stored && Array.isArray(history.blobs[stored.blob]) ? (history.blobs[stored.blob] as ParameterBinding[]) : [];
    const text = `${row !== undefined ? `step ${row}` : st.label}: ${conditions} — wR2 ${st.summary.wR !== undefined ? (100 * st.summary.wR).toFixed(2) : "—"} %, GooF ${st.summary.gof !== undefined ? st.summary.gof.toFixed(2) : "—"}${extText}; U_eq ${ueqText(runsOf(stepUeq(params, bindings, esd, cell)))} Å²`;
    last.delete(key);
    last.set(key, { text, weights });
  }
  if (last.size < 2) return null;
  const entries = [...last.values()];
  const mixed = new Set(entries.map((e) => e.weights)).size > 1;
  return {
    name: "Refinements compared",
    status: "note",
    detail: `The last converged refinement under each set of conditions, the ADPs free${mixed ? " (wR2 and GooF compare only under the same weights)" : ""}: ${entries.map((e) => e.text).join("; ")}.`,
  };
}

/**
 * The fit's earlier diagnoses (diagnose_fit), each by the step of the table
 * whose fit it read. The report's own "Fit diagnosis" reads the fit on
 * screen; these are the fits on the way, so an account that cites what a
 * diagnosis found then (the lines 2.45× too broad before the profile was
 * refined) cites the report. A diagnosis made after a step the table folds
 * away (freeing or fixing parameters) read the fit of the step before it.
 */
export function earlierDiagnoses(record: AgentRecord, history: ProjectHistory | null, rowOf: ReadonlyMap<string, number>, steps: readonly ReportStep[]): ReportCheck | null {
  const earlier = (record.diagnoses ?? []).filter((d) => !history || d.step !== history.current);
  if (earlier.length === 0) return null;
  const path = history ? lineage(history) : [];
  const onPath = new Set(path.map((st) => st.id));
  const parentOf = new Map(path.map((st) => [st.id, st.parent]));
  const where = (step: string | undefined): string => {
    if (step === undefined) return "a fit before the History began";
    if (!onPath.has(step)) return "a step on a branch the analysis left";
    let id: string | undefined = step;
    while (id !== undefined && !rowOf.has(id)) id = parentOf.get(id);
    const row = id !== undefined ? rowOf.get(id)! : undefined;
    return row !== undefined ? `step ${row} (${steps[row - 1]!.label})` : "the first step";
  };
  return { name: "Earlier fit diagnoses", status: "note", detail: earlier.map((d) => `At ${where(d.step)}: ${d.summary}`).join(" ") };
}

/** The record's checks: the fit range, the cell check, the symmetry review, the data's reading, the method exceptions the user allowed. */
export function recordChecks(page: AgentPage, record: AgentRecord): ReportCheck[] {
  const out: ReportCheck[] = [];
  if (page === "singleCrystal") {
    out.push(record.dataCheck
      ? { name: "Data reading", status: "note", detail: `${capital(record.dataCheck.summary)}.` }
      : { name: "Data reading", status: "note", detail: "Not run in this analysis (reflection_statistics)." });
  }
  if (page === "powder") {
    if (record.rangeCheck) out.push({ name: "Fit range", status: "note", detail: `${capital(record.rangeCheck.summary)}.` });
    out.push(record.cellCheck
      ? { name: "Cell check", status: record.cellCheck.passed ? "pass" : "note", detail: `${capital(record.cellCheck.summary)}.` }
      : { name: "Cell check", status: "note", detail: "Not run in this analysis." });
    if (record.symmetryReviewed) {
      out.push({ name: "Symmetry review", status: record.symmetryReviewed.summary.startsWith("no forbidden") ? "pass" : "note", detail: `${capital(record.symmetryReviewed.summary)}.` });
    }
  }
  for (const e of record.exceptions) out.push({ name: "Method exception", status: "note", detail: `${RULES[e.rule].title}: allowed by the user, because ${e.reason}` });
  return out;
}

/**
 * The Bayesian check for the report, from the Agent's last run. `since` is
 * given when the run sampled an earlier refinement than the one on screen
 * (a focused set, before the final refinement): where it was, and the
 * parameters now, to say how far the sampled values have moved since, in
 * their esds.
 */
export function reportPosterior(p: PosteriorRun, since: { readonly where: string; readonly parameters: readonly RefinementParameter[] } | null = null): ReportPosterior {
  const read = readPosterior(p.run, p.parameters, p.result.esd);
  let earlier: string | undefined;
  if (since) {
    const now = new Map(since.parameters.map((q) => [q.id, q.value]));
    const then = new Map(p.parameters.map((q) => [q.id, q.value]));
    const moved = Math.max(0, ...p.run.freeIds.map((id) => {
      const e = p.result.esd[id];
      const a = now.get(id);
      const b = then.get(id);
      return e && e > 0 && a !== undefined && b !== undefined ? Math.abs(a - b) / e : 0;
    }));
    earlier = `sampled at ${since.where}, with ${p.run.freeIds.length} parameters free; since then they have moved by up to ${moved.toFixed(1)} esd`;
  }
  return {
    ...(earlier ? { earlier } : {}),
    convergence: read.converged ? "converged" : read.nearly ? "close" : "not converged",
    walkers: p.run.resume.q.length,
    steps: p.run.resume.stepIndex,
    samples: p.run.diagnostics.nSamples,
    maxRHat: p.run.diagnostics.maxRHat,
    minEss: p.run.diagnostics.minEss,
    rows: read.rows.map((r) => ({
      label: r.label,
      refined: r.refined,
      ...(r.esd !== undefined ? { esd: r.esd } : {}),
      median: r.median,
      ci68: r.ci68,
      ci95: r.ci95,
      ...(r.esdRatio !== undefined ? { esdRatio: r.esdRatio } : {}),
      verdict: r.verdict,
    })),
    differences: read.converged || read.nearly ? differenceSentences(p.run, p.parameters, p.compare) : [],
  };
}

export interface AgentReportArgs {
  readonly page: AgentPage;
  /** The page's own report (powderReportInput / pdfReportInput). */
  readonly input: ReportInput;
  readonly history: ProjectHistory | null;
  readonly record: AgentRecord;
  /** The page's engine checks (powderReportChecks / pdfReportChecks). */
  readonly checks: readonly ReportCheck[];
  /**
   * The Agent's last posterior run on this analysis: whether it sampled the
   * refinement on screen, the History step it sampled, and the parameters now.
   */
  readonly posterior: { readonly run: PosteriorRun; readonly current: boolean; readonly stepId: string | null; readonly parameters: readonly RefinementParameter[] } | null;
  /** The model and how it was reached. */
  readonly model: string;
  /** The Agent's own account. */
  readonly narrative: string;
  /** What the user said in the conversation: the numbers they gave may be quoted. */
  readonly userText?: string;
  readonly date?: Date;
  /**
   * The page's written method was in play (default). False without the skills
   * (the validation's arm C): no method checklist, no stage given as a step's
   * reason, and no stage left among the open issues.
   */
  readonly method?: boolean;
}

/** Build the report: its input, the Agent section, the HTML and the Markdown, and the audit. */
export function buildAgentReport(a: AgentReportArgs): { input: ReportInput; agent: ReportAgent; html: string; markdown: string; unverified: string[]; audit: AgentReport["audit"] } {
  const method = a.method !== false;
  const progress = methodProgress(a.page, a.record);
  const { steps, otherBranches, rowOf } = historySteps(a.page, a.history, method);
  const compared = a.page === "singleCrystal" && a.input.phases[0] ? comparedRefinements(a.history, a.input.phases[0].structure.cell, rowOf) : null;
  const diagnosed = earlierDiagnoses(a.record, a.history, rowOf, steps);
  const checks = [...a.checks, ...recordChecks(a.page, a.record), ...(diagnosed ? [diagnosed] : []), ...(compared ? [compared] : [])];
  const left = method ? stagesLeft(a.page, a.record) : [];
  // An earlier run is placed by its row in the steps table, the reader's own reference.
  const where = (id: string | null): string => {
    const row = id ? rowOf.get(id) : undefined;
    return row !== undefined ? `step ${row} of the table (${steps[row - 1]!.label})` : id ? "a step on a branch the analysis left" : "an earlier refinement";
  };
  const posterior = a.posterior ? reportPosterior(a.posterior.run, a.posterior.current ? null : { where: where(a.posterior.stepId), parameters: a.posterior.parameters }) : null;
  const openIssues = [
    ...(left.length > 0 ? [`Method stages not yet refined to convergence: ${left.join(", ")}.`] : []),
    ...checks.filter((c) => c.status === "warn").map((c) => `${c.name}: ${c.detail}`),
    ...(posterior && posterior.convergence !== "converged" ? ["The Bayesian check has not converged: its intervals are not final."] : []),
  ];
  const base: ReportAgent = {
    model: a.model,
    ...(method ? { method: { skill: progress.skill, stages: progress.stages.map((s) => ({ label: s.label, done: s.done, optional: s.optional })) } } : {}),
    steps,
    agreementLabel: a.page === "pdf" ? "Rw" : a.page === "singleCrystal" ? "wR2" : "wR",
    ...(otherBranches > 0 ? { otherBranches } : {}),
    ...(a.record.start ? { start: { agreement: a.record.start.agreement, ...(a.record.start.r1 !== undefined ? { r1: a.record.start.r1 } : {}) } } : {}),
    checks,
    posterior,
    openIssues,
    notes: a.record.notes.map((n) => n.text),
  };
  const date = a.date ?? new Date();
  // What the report computed: no figure (its data URI), and none of the Agent's
  // own words — the account, its notes, the reasons it gave for an exception.
  const engineText = reportMarkdown({ ...a.input, date, figure: null, agent: { ...base, notes: [], checks: checks.filter((c) => c.name !== "Method exception") } });
  const narrative = a.narrative.trim();
  // The numbers the user gave (a published refinement's, a reference) are quoted, not the Agent's own.
  const audit = { account: [narrative, ...base.notes].join("\n\n"), against: `${engineText}\n\n${a.userText ?? ""}` };
  const unverified = unverifiedNumbers(audit.account, audit.against);
  const agent: ReportAgent = { ...base, narrative, unverified };
  const input: ReportInput = { ...a.input, date, agent };
  return { input, agent, html: reportHtml(input), markdown: reportMarkdown(input), unverified, audit };
}

/** "<title>_agent_report", the title reduced to a safe token. */
export function reportFileBase(title: string): string {
  const token = title.normalize("NFKD").replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${token.length >= 2 ? token : "analysis"}_agent_report`;
}
