/**
 * Runs the in-app chat's Agent tool calls against the live page: validate the
 * input, ask the user before a change, make the change as the agent so the history tags its
 * step, wait for it to render, and answer with a compact JSON view.
 *
 * Results travel like the MATERIA MCP server's: a bulky part becomes a ref
 * ("#3/findings") the model can open with `read_ref`, so one answer never
 * floods the conversation.
 */

import { z } from "zod";
import { PAGE_LABEL, liveTool, type AgentPage, type LiveToolSpec, type ToolEffect } from "@/agent/tools";
import type { AgentPort, LiveState, PdfLiveState, PowderLiveState, SingleCrystalLiveState } from "@/agent/port";
import { changePowder, describePowderChange, diagnosisText, powderNoOp, powderReportChecks, readPowderTool, requireStructure, type DiagnosisView } from "@/agent/powderTools";
import { changeMagnetic, describeMagneticChange, isMagneticTool, magneticNext, magneticNoOp, magneticOutcome, readMagneticTool } from "@/agent/magneticTools";
import { changePdf, describePdfChange, pdfNoOp, pdfReportChecks, readPdfTool } from "@/agent/pdfTools";
import { changeSingleCrystal, describeSingleCrystalChange, keptMeasurements, readSingleCrystalTool, singleCrystalNoOp, singleCrystalReportChecks } from "@/agent/scTools";
import { samplePosteriorTool, type PosteriorRun } from "@/agent/posteriorTool";
import { buildAgentReport, freeSummary, reportFileBase, type AgentReport } from "@/agent/report";
import { matchIds, type LiveToolHost } from "@/agent/liveCommon";
import { fillReferences, referenceCatalog, type ReferenceSource } from "@/agent/references";
import { powderReferences } from "@/agent/powderTools";
import { pdfReferences } from "@/agent/pdfTools";
import { singleCrystalReferences } from "@/agent/scTools";
import { PROBE_OPTIONS, carriedText, correlationRefusal, disorderAssemblies, pairText, readCorrelations, refusalLine } from "@/agent/correlationCheck";
import { PAGE_METHOD, readSkill } from "@/agent/skills";
import { RULES, advanceAlternation, alternationView, keyOfState, methodProgress, outOfOrder, ruleRefusal, stagesCovered, stagesLeft, stagesOnPath, type AgentRecord, type Alternation, type MethodRule } from "@/agent/method";
import { REF_KEY, RefStore, buildView } from "@/mcp/refs";
import type { LinearRestraint, RefinementParameter, RefinementResult } from "@/core/refinement/types";
import type { StepKind } from "@/core/project/history";

/** What the executor needs from the app shell. */
export interface AgentHost extends LiveToolHost {
  /** The active engine's port; null with nothing loaded. */
  readonly port: () => AgentPort | null;
  /** The page on screen, to explain why a tool is unavailable there. */
  readonly technique: () => "powder" | "singleCrystal" | "pdf" | null;
  /** Resolves once the state an action set has rendered and any step it requested is recorded. */
  readonly settle: () => Promise<void>;
  /** Run `fn` with every history step it records tagged as the agent's. */
  readonly asAgent: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Record the live state as a step now (a no-op when nothing changed). */
  readonly recordNow: (kind: StepKind, label?: string) => void;
  /** The Agent's record of an analysis (method.ts): kept by the shell, saved with the project. */
  readonly record: (key: string) => AgentRecord;
  readonly updateRecord: (key: string, update: (record: AgentRecord) => AgentRecord) => void;
}

export type ActivityStatus = "waiting" | "running" | "done" | "declined" | "failed";

/** One tool call as the Agent drawer lists it. */
export interface ActivityEntry {
  readonly id: string;
  readonly tool: string;
  readonly title: string;
  readonly effect: ToolEffect;
  /** What a change will do, in the page's terms (the approval card's line). */
  readonly preview?: string;
  readonly at: number;
  readonly status: ActivityStatus;
  /** A short outcome line once it finished. */
  readonly outcome?: string;
  /** Only the user may approve it: asked even in Auto. */
  readonly alwaysAsk?: boolean;
}

/** The answer a model gets: JSON text, flagged when it is an error. */
export interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
}

/**
 * Where the analysis stands, as the chat loop reads it between tool calls:
 * its loop guard compares fingerprints (did a call change anything?), and a
 * local model's tool list follows the page and the method's stage.
 */
export interface AgentSituation {
  readonly page: AgentPage;
  /** The method's next required stage (its id), or null when every required one is done. */
  readonly stage: string | null;
  /** The stages done (ids). */
  readonly stagesDone: readonly string[];
  /** The magnetic step is under way: a magnetic model on the page, or the step's tools used in this conversation. */
  readonly magnetic: boolean;
  /** Changes whenever anything a tool can change changes: the parameters and their values, the fit, the settings, the History step, the method's record. */
  readonly fingerprint: string;
  /** One sentence for the user: the page, the stages done, the next, the last refinement. */
  readonly summary: string;
}

/** What the chat calls: the executor, or a lazy stand-in for it. */
export interface ToolRunner {
  /** Run one call; `signal` is the user's Stop: a call it reaches before acting is not run, and a running fit is cancelled. */
  readonly run: (name: string, input: unknown, signal?: AbortSignal) => Promise<ToolOutcome>;
  /** A new conversation: the skills read in the last one must be read again. */
  readonly newConversation?: () => void;
  /** What the user said: a number they gave (a published refinement's, a reference value) may be quoted in the report. */
  readonly heard?: (text: string) => void;
  /** Where the analysis stands now; null with nothing open. */
  readonly situation?: () => Promise<AgentSituation | null> | AgentSituation | null;
  /** The Agent's words with its {{references}} filled in from the page as it stands (numbers by reference). */
  readonly fill?: (text: string) => string;
  /** The page the analysis is on, for the checks on a final answer (evidence.ts); null with none open. */
  readonly page?: () => "powder" | "pdf" | "singleCrystal" | null;
}

export interface ExecutorOptions {
  /** Ask the user to approve a change. Resolves false when they decline. */
  readonly approve: (entry: ActivityEntry, signal?: AbortSignal) => Promise<boolean>;
  /** Every status change of every call, for the drawer. */
  readonly onActivity: (entry: ActivityEntry) => void;
  /** Largest answer, in characters of compact JSON (default 8000, as the MCP server). */
  readonly budget?: number;
  /** The model and how it is reached, for the report ("Claude Opus 5.5 · Anthropic API"). */
  readonly modelLabel?: () => string;
  /** A report the Agent wrote (write_report), for the viewer. */
  readonly onReport?: (report: AgentReport) => void;
  /**
   * The skills (default on). Off is the validation's ablation arm
   * (docs/VALIDATION.md): read_skill is refused and no change waits for a
   * method to be read; every other rule still holds.
   */
  readonly skills?: boolean;
}

/** History step kind for a change that does not record its own step. */
const STEP_KIND: Readonly<Record<string, StepKind>> = {
  set_free: "edit",
  set_background: "settings",
  set_microstrain: "settings",
  set_adp_model: "settings",
  set_site_ties: "settings",
  set_fit_range: "settings",
  set_outlier_filter: "settings",
  omit_reflections: "settings",
  set_resolution_range: "settings",
  set_radiation: "settings",
  set_extinction_model: "settings",
  set_riding_hydrogens: "settings",
  set_weighting: "settings",
  set_twin: "settings",
  invert_structure: "settings",
  restrain_distances: "settings",
  merge_equivalents: "settings",
};

let nextCallId = 1;

/** Notes kept per analysis; the oldest go first. */
const MAX_NOTES = 40;

/** Diagnoses of the fit kept per analysis (one per History step); the oldest go first. */
const MAX_DIAGNOSES = 12;

let nextReportId = 1;

export class AgentExecutor implements ToolRunner {
  private readonly refs = new RefStore(128);
  /** The skills read in this conversation (a page's method gates its changes). */
  private readonly skillsRead = new Set<string>();
  /** Changes run one at a time: the page has one compute client and one history. */
  private changes: Promise<unknown> = Promise.resolve();
  /** The last posterior run (sample_posterior), with the analysis and the step it sampled: for the report. */
  private posterior: { readonly run: PosteriorRun; readonly key: string; readonly step: { id: string; label: string } | null } | null = null;
  /** Per analysis: the instrument terms and the thermal parameters as each was last refined, for the alternation. */
  private readonly alternations = new Map<string, Alternation>();

  constructor(private readonly host: AgentHost, private readonly opts: ExecutorOptions) {}

  /**
   * A new conversation: the skills, the user's words and the refs to earlier
   * answers belong to the last one. What belongs to the analysis stays: its
   * record (saved with the project), the alternation, and the last posterior
   * run, which the report places by the History step it sampled.
   */
  newConversation(): void {
    this.skillsRead.clear();
    this.userText = [];
    this.magneticUsed = false;
    this.refs.clear();
  }

  /** The magnetic step's tools ran in this conversation (its panel then counts in the fingerprint). */
  private magneticUsed = false;

  /** The page open. */
  page(): "powder" | "pdf" | "singleCrystal" | null {
    return this.host.port()?.technique ?? null;
  }

  /** Where the analysis stands (the chat's loop guard and a local model's tool list read it). */
  situation(): AgentSituation | null {
    const port = this.host.port();
    if (!port) return null;
    const s = port.state();
    const record = this.syncStages(port);
    const progress = methodProgress(port.technique, record);
    const next = progress.stages.find((st) => !st.done && !st.optional) ?? null;
    const powder = port.technique === "powder" ? (s as PowderLiveState) : null;
    const panel = powder && this.magneticUsed ? (port as Extract<AgentPort, { technique: "powder" }>).magnetic?.()?.state() ?? null : null;
    const sig = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v);
    const fingerprint = hashText(JSON.stringify({
      step: this.currentStep()?.id ?? null,
      busy: s.busy,
      parameters: s.parameters.map((p) => [p.id, p.fixed ? 0 : 1, p.expression ?? "", sig(p.value)]),
      result: s.result ? [s.result.status, s.result.history.length, Object.keys(s.result.esd).sort()] : null,
      fitRange: "fitRange" in s ? s.fitRange : null,
      settings: "settings" in s ? s.settings : null,
      magnetic: powder ? powder.magnetic !== null : null,
      panel: panel ? [panel.k, panel.ions.filter((i) => i.selected).map((i) => i.label), panel.ties, panel.selected?.id ?? null, panel.kSearch?.length ?? null, panel.candidates.filter((c) => c.fit !== undefined).length] : null,
      record: [record.stagesDone, record.exceptions.map((e) => e.rule), !!record.rangeCheck, !!record.cellCheck, !!record.dataCheck, !!record.symmetryReviewed],
    }));
    const done = progress.stages.filter((st) => st.done).map((st) => st.label);
    const fit = s.result ? `the last refinement ${s.result.status}` : "no refinement on screen yet";
    return {
      page: port.technique,
      stage: next?.id ?? null,
      stagesDone: record.stagesDone,
      magnetic: this.magneticUsed || (powder !== null && powder.magnetic !== null),
      fingerprint,
      summary: `the ${PAGE_LABEL[port.technique]} page; done: ${done.length ? done.join(", ") : "nothing yet"}; next: ${next?.label ?? "every required stage is done"}; ${fit}.`,
    };
  }

  /** The user's messages in this conversation: their numbers are theirs to quote, not the Agent's own. */
  private userText: string[] = [];

  heard(text: string): void {
    this.userText.push(text);
  }

  /** What the page's references resolve against now; null with no analysis open. */
  private referenceSource(): ReferenceSource | null {
    const port = this.host.port();
    if (!port) return null;
    const s = port.state();
    const entries = port.technique === "pdf" ? pdfReferences(s as PdfLiveState)
      : port.technique === "singleCrystal" ? singleCrystalReferences(s as SingleCrystalLiveState)
        : powderReferences(s as PowderLiveState);
    return { entries, parameters: s.parameters, esd: s.result?.esd ?? {} };
  }

  /** The Agent's words with its references filled in from the page as it stands; a reference it cannot fill stays as written. */
  fill(text: string): string {
    if (!text.includes("{{")) return text;
    return fillReferences(text, this.referenceSource()).text;
  }

  /** Filled, or refused when a reference names nothing the page has: the report and the notes keep no unfilled reference. */
  private fillOrRefuse(text: string, where: string): string {
    const source = this.referenceSource();
    const out = fillReferences(text, source);
    if (out.unknown.length > 0) {
      throw new Error(`${where}: ${out.unknown.map((k) => `{{${k}}}`).join(", ")} ${out.unknown.length === 1 ? "names" : "name"} no value the page has now. The references here: ${source ? referenceCatalog(source) : "none (no analysis is open)"}. Use one of them, or write the number with the tool that gave it.`);
    }
    return out.text;
  }

  /** Run one call. Never throws: failures come back as an error outcome the model can read. */
  run(name: string, input: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
    const spec = liveTool(name);
    if (!spec) return Promise.resolve(error(`no tool named ${name}`));
    if (spec.effect !== "change") return this.execute(spec, input, signal);
    // A change queued behind another still checks the Stop when its turn comes.
    const run = this.changes.then(() => this.execute(spec, input, signal));
    this.changes = run.catch(() => undefined);
    return run;
  }

  private async execute(spec: LiveToolSpec, raw: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
    if (signal?.aborted) return error(STOPPED);
    if (isMagneticTool(spec.name)) this.magneticUsed = true;
    let entry: ActivityEntry = { id: `c${nextCallId++}`, tool: spec.name, title: spec.title, effect: spec.effect, at: Date.now(), status: "running", ...(spec.alwaysAsk ? { alwaysAsk: true } : {}) };
    const update = (patch: Partial<ActivityEntry>): void => {
      entry = { ...entry, ...patch };
      this.opts.onActivity(entry);
    };
    try {
      const parsed = z.object(spec.inputSchema).strict().safeParse(raw ?? {});
      if (!parsed.success) throw new Error(`invalid input for ${spec.name}: ${z.prettifyError(parsed.error)}`);
      const input = parsed.data as Record<string, unknown>;

      if (spec.name === "read_ref") {
        update({});
        const out = this.readRef(input as { ref: string; start?: number; end?: number });
        update({ status: "done" });
        return { isError: false, text: JSON.stringify(out) };
      }
      if (spec.name === "read_skill") {
        if (this.opts.skills === false) throw new Error("there are no skills in this configuration: decide the method yourself");
        // Whole, as Markdown: a skill is read as written, not paged as a ref.
        const { name, reference } = input as { name: string; reference?: string };
        update({ preview: reference ? `${name} · ${reference}` : name });
        const text = readSkill(name, reference);
        if (reference === undefined) this.skillsRead.add(name);
        update({ status: "done" });
        return { isError: false, text };
      }

      const port = this.requirePort();
      if (!spec.pages.includes(port.technique)) {
        const where = spec.pages.map((p) => PAGE_LABEL[p]).join(" and ");
        throw new Error(`${spec.name} works on the ${where} page${spec.pages.length === 1 ? "" : "s"} only; the ${PAGE_LABEL[port.technique]} page is open`);
      }
      if (spec.effect === "control") {
        update({});
        port.cancel();
        update({ status: "done", outcome: "Cancel requested" });
        return this.respond({ cancelled: port.state().busy ? "requested" : "nothing was running" });
      }

      if (spec.name === "write_note") {
        // The record's notes, not the page: no approval, no history step.
        // Its numbers as they stand when it is written: the note keeps them.
        const text = this.fillOrRefuse((input as { text: string }).text.trim(), "write_note");
        update({ preview: text });
        const key = keyOfState(port.technique, port.state());
        this.host.updateRecord(key, (r) => ({ ...r, notes: [...r.notes, { text, at: Date.now() }].slice(-MAX_NOTES) }));
        update({ status: "done" });
        return this.respond({ noted: true, notes: this.host.record(key).notes.length });
      }

      if (spec.name === "write_report") {
        update({});
        // Let the drawer paint "running" before the checks run.
        await new Promise((r) => setTimeout(r, 0));
        return await this.writeReport(port, this.fillOrRefuse((input as { summary: string }).summary, "write_report"), update);
      }

      if (spec.effect === "read") {
        update({});
        // The space group is questioned last: only once the method's stages
        // are refined, on a converged fit.
        if (spec.name === "review_symmetry") {
          const notYet = this.symmetryNotYet(port);
          if (notYet) {
            update({ status: "failed", outcome: notYet.line });
            return error(notYet.message);
          }
        }
        // Let the drawer paint "running" before a heavy synchronous analysis.
        await new Promise((r) => setTimeout(r, 0));
        let out = port.technique === "singleCrystal" ? readSingleCrystalTool(spec.name, input, port, this.host)
          : spec.name === "sample_posterior" ? await samplePosteriorTool(input as { continue?: boolean; steps?: number; compare?: [string, string][] }, port, (run) => { this.posterior = { run, key: keyOfState(port.technique, port.state()), step: this.currentStep() }; })
            : port.technique === "pdf" ? readPdfTool(spec.name, input, port, this.host)
              : isMagneticTool(spec.name) ? await readMagneticTool(spec.name, input, port, () => this.host.settle())
                : readPowderTool(spec.name, input, port, this.host);
        if (spec.name === "check_cell_symmetry") this.noteCellCheck(port, out as CellCheckAnswer);
        if (spec.name === "diagnose_fit") this.noteDiagnosis(port, out);
        if (spec.name === "check_fit_range") this.noteRangeCheck(port, out as RangeAnswer);
        if (spec.name === "reflection_statistics") this.noteDataCheck(port, out as DataAnswer);
        if (spec.name === "review_symmetry") this.noteSymmetryReview(port, out as { observedForbidden?: unknown[]; candidates?: { name: string }[] });
        if (spec.name === "get_state") {
          const source = this.referenceSource();
          out = { ...this.withoutMethod(out), ...this.recordView(port), ...(source ? { references: `Quote the engine's numbers by reference; the app fills them in where your words are shown and in the report: ${referenceCatalog(source)}.` } : {}) };
        }
        update({ status: "done" });
        return this.respond(out);
      }

      // A change: only once the page's method has been read, never while a fit
      // runs; then ask, then act as the agent.
      const method = spec.skill ?? PAGE_METHOD[port.technique];
      if (this.opts.skills !== false && !this.skillsRead.has(method)) {
        const what = spec.skill ? `it is how the user works on this step` : `it is how the user works on this page`;
        throw new Error(`read the method first: call read_skill with name "${method}" — ${what}, and changes wait until it has been read in this conversation`);
      }
      if (spec.name === "allow_exception") return await this.allowException(port, input as { rule: MethodRule; reason: string }, entry, update);
      const before = port.state();
      if (before.busy) throw new Error("a refinement is running — wait for it to finish, or call cancel_refinement");
      const magnetic = port.technique === "powder" && isMagneticTool(spec.name);
      const noOp = port.technique === "pdf" ? pdfNoOp(spec, input, before as PdfLiveState)
        : port.technique === "singleCrystal" ? singleCrystalNoOp(spec, input, before as SingleCrystalLiveState)
          : magnetic ? magneticNoOp(spec.name, input, port)
            : powderNoOp(spec, input, before as PowderLiveState);
      if (noOp) {
        update({ status: "done", outcome: "No change" });
        return this.respond({ unchanged: true, note: noOp });
      }
      let preview = port.technique === "pdf" ? describePdfChange(spec, input, before as PdfLiveState)
        : port.technique === "singleCrystal" ? describeSingleCrystalChange(spec, input, before as SingleCrystalLiveState)
          : magnetic ? describeMagneticChange(spec.name, input, port)
            : describePowderChange(spec, input, before as PowderLiveState);
      // The method's firm rules, then its order (a note, not a refusal).
      const key = keyOfState(port.technique, before);
      const freeBefore = before.parameters.filter((p) => !p.fixed && !p.expression);
      let orderNote: string | null = null;
      if (spec.name === "refine" || spec.name === "boxcar_scan") {
        const record = this.syncStages(port);
        // A scan given its own free set refines that set, not the page's.
        const scanFree = spec.name === "boxcar_scan" && Array.isArray(input.free) ? new Set(matchIds(before.parameters, input.free as string[])) : null;
        const ruleFree = scanFree ? before.parameters.filter((p) => scanFree.has(p.id) && !p.expression) : freeBefore;
        const rule = ruleRefusal(port.technique, ruleFree, restraintsOf(before), record, before.parameters);
        if (rule) {
          update({ status: "failed", preview, outcome: rule.line });
          return error(rule.message);
        }
        // The method's order is the skills' (arm C has none).
        if (spec.name === "refine" && this.opts.skills !== false) orderNote = outOfOrder(port.technique, freeBefore, record, before.parameters);
      }
      if (spec.name === "refine") {
        // Correlated parameters are never refined together: measure the free
        // set first, and ask the user only about a set that may run.
        update({ preview: "Checking correlations…" });
        let probe: RefinementResult;
        try {
          probe = await port.probe(PROBE_OPTIONS);
        } catch (e) {
          throw new Error(`could not check the free parameters' correlations before refining (${e instanceof Error ? e.message : String(e)}); nothing was refined`, { cause: e });
        }
        const check = readCorrelations(probe, before.parameters, restraintsOf(before), assembliesOf(before));
        const refusal = correlationRefusal(check);
        if (refusal) {
          update({ status: "failed", preview, outcome: refusalLine(check) });
          return error(refusal);
        }
        preview += check.carried.length > 0 ? ` · ${check.carried.map(carriedText).join("; ")}, carried by the other free parameters`
          : check.strongest ? ` · strongest correlation ${pairText(check.strongest)}` : " · no correlation above 0.5";
      }
      update({ status: "waiting", preview });
      if (!(await this.opts.approve(entry, signal))) {
        update({ status: "declined", outcome: signal?.aborted ? "Stopped" : "Declined" });
        if (signal?.aborted) return error(STOPPED);
        return this.respond({ declined: true, note: "The user declined this change. Ask what they would prefer, or propose something else." });
      }
      // The card may have waited a long time: Stop, a running fit, or a page that changed since it was checked all hold the change back.
      if (signal?.aborted) {
        update({ status: "declined", outcome: "Stopped" });
        return error(STOPPED);
      }
      // The page as it is now (a port is a render's view: ask the host again).
      const now = this.requirePort().state();
      if (now.busy || stateStamp(now) !== stateStamp(before)) {
        const why = now.busy ? "a refinement is running" : "the analysis changed while it waited for approval";
        update({ status: "failed", outcome: `Not run: ${why}` });
        return error(`not run: ${why}, so what was checked and approved no longer describes it. Read the state again (get_state) and propose the change again if it still applies.`);
      }
      update({ status: "running" });
      // The user's own unsaved edits become their step first, so the agent's
      // step holds only what the agent changed.
      this.host.recordNow("edit");
      // Stop cancels a fit this change started.
      const cancel = (): void => this.host.port()?.cancel();
      signal?.addEventListener("abort", cancel);
      const changed = await this.host.asAgent(async () => {
        const n = port.technique === "pdf" ? await changePdf(spec.name, input, port, this.host)
          : port.technique === "singleCrystal" ? await changeSingleCrystal(spec.name, input, port, this.host)
            : magnetic ? await changeMagnetic(spec.name, input, port)
              : await changePowder(spec.name, input, port, this.host);
        await this.host.settle();
        const kind = STEP_KIND[spec.name];
        if (kind) {
          this.host.recordNow(kind);
          await this.host.settle();
        }
        return n;
      }).finally(() => signal?.removeEventListener("abort", cancel));
      const note = typeof changed === "object" ? changed.note : changed;
      const after = this.requirePort().state();
      // Where the fit started, once per analysis: the report gives it before the steps.
      if (spec.name === "refine" && after.result && after.result !== before.result && !this.host.record(key).start) {
        const r1 = "dataset" in before ? { r1: before.agreement.r1 } : {};
        this.host.updateRecord(key, (r) => (r.start ? r : { ...r, start: { at: Date.now(), agreement: agreement(before).live, ...r1 } }));
      }
      let alternation: Record<string, unknown> | null = null;
      if (spec.name === "refine" && after.result?.status === "converged" && after.result !== before.result) {
        const covered = stagesCovered(port.technique, freeBefore, before.parameters);
        this.host.updateRecord(key, (r) => ({ ...r, stagesDone: [...new Set([...r.stagesDone, ...covered])] }));
        const step = advanceAlternation(this.alternations.get(key) ?? {}, freeBefore, after.parameters, after.result.esd);
        this.alternations.set(key, step.memory);
        alternation = alternationView(step.memory, step.refined, after.parameters);
      }
      const out = {
        ...changeOutcome(spec.name, before, after, this.currentStep(), note),
        ...(typeof changed === "object" ? changed.data : {}),
        ...(orderNote ? { methodNote: orderNote } : {}),
        ...(alternation ?? {}),
        ...(magnetic ? magneticOutcome(spec.name, this.requirePort() as typeof port) : {}),
      };
      update({ status: "done", outcome: outcomeLine(spec.name, before, after, note) });
      return this.respond(out);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      update({ status: "failed", outcome: message });
      return error(message);
    }
  }

  private requirePort(): AgentPort {
    const port = this.host.port();
    if (port) return port;
    throw new Error("no analysis is open — ask the user to load a structure and data, or a demo");
  }

  private currentStep(): { id: string; label: string } | null {
    const h = this.host.history();
    const st = h?.steps.find((s) => s.id === h.current);
    return st ? { id: st.id, label: st.name ?? st.label } : null;
  }

  /** The cell check's outcome, kept for the analysis it ran on. A record, not a gate. */
  private noteCellCheck(port: AgentPort, out: CellCheckAnswer): void {
    this.host.updateRecord(keyOfState(port.technique, port.state()), (r) => ({ ...r, cellCheck: { passed: !!out.passed, at: Date.now(), summary: cellCheckSummary(out, port.state().parameters) } }));
  }

  /**
   * A diagnosis of the fit (diagnose_fit), kept with the History step it read:
   * the report gives the earlier ones by step, so an account that cites what
   * the fit was diagnosed with on the way cites the report. The latest per
   * step, at most MAX_DIAGNOSES.
   */
  private noteDiagnosis(port: AgentPort, out: unknown): void {
    const dx = out as Partial<DiagnosisView>;
    if (typeof dx.reading !== "string" || !Array.isArray(dx.causes)) return;
    const step = this.currentStep()?.id;
    const entry = { at: Date.now(), ...(step ? { step } : {}), summary: diagnosisText(dx as DiagnosisView) };
    this.host.updateRecord(keyOfState(port.technique, port.state()), (r) => ({
      ...r,
      diagnoses: [...(r.diagnoses ?? []).filter((d) => d.step !== entry.step), entry].slice(-MAX_DIAGNOSES),
    }));
  }

  /** The data ends' reading, kept for the analysis: what each end showed and the window proposed. A record, not a gate. */
  private noteRangeCheck(port: AgentPort, out: RangeAnswer): void {
    const causes = (e: RangeAnswer["low"]): string => e.findings.map((f) => f.slice(0, f.indexOf(":"))).join(", ");
    const end = (e: RangeAnswer["low"]): string => e.verdict === "trim" ? `${e.end}: trim to ${e.cut} (${causes(e)})` : e.outside ? `${e.end}: left out by the window (${causes(e)})` : `${e.end}: keep`;
    const proposed = typeof out.proposed === "object" ? `; proposed window ${out.proposed.min}–${out.proposed.max} ${out.unit}` : Array.isArray(out.window) ? `; window ${out.window[0]}–${out.window[1]} ${out.unit}` : "";
    const summary = `${end(out.low)}; ${end(out.high)}${proposed}`;
    this.host.updateRecord(keyOfState(port.technique, port.state()), (r) => ({ ...r, rangeCheck: { at: Date.now(), summary } }));
  }

  /** The data's reading before the model (single crystal), kept for the analysis. A record, not a gate. */
  private noteDataCheck(port: AgentPort, out: DataAnswer): void {
    const r = out.reflections;
    const e = out.intensityStatistics;
    const parts = [
      r.listed !== undefined
        ? `${r.listed} reflections from a refinement's listing, each once: no R_int`
        : `${r.measured} reflections, ${r.unique} unique, ${typeof r.rInt === "number" ? `R_int ${r.rInt} %${r.rIntFriedelApart !== undefined ? ` (${r.rIntFriedelApart} % with the Friedel mates apart, as SHELXL reports it)` : ""}` : "merged (one value per reflection)"}`,
      `d_min ${out.resolution.dMin} Å${out.resolution.sinThetaOverLambdaMax !== undefined ? ` (sinθ/λ ${out.resolution.sinThetaOverLambdaMax} Å⁻¹)` : ""}${out.resolution.completeness !== undefined ? `, completeness ${out.resolution.completeness} %` : ""}`,
      ...(typeof e === "object" ? [`⟨|E²−1|⟩ ${e.meanAbsE2Minus1}: ${e.reading}`] : []),
      // The strongest merohedral law the H-test reads, when it reads one.
      ...(typeof out.twinLaws === "object" && typeof out.twinLaws.laws[0]?.alpha === "number" && out.twinLaws.laws[0].alpha >= 0.2 ? [`the H-test reads a twin by ${out.twinLaws.laws[0].indices.replace("h, k, l → ", "(h, k, l) → (")}) at α ≈ ${out.twinLaws.laws[0].alpha} (${out.twinLaws.laws[0].pairs} pairs)`] : []),
      ...(typeof out.absences === "object" ? [`${out.absences.atThreeSigma} of ${out.absences.measured} forbidden reflections at ≥ 3σ${out.absences.strongest?.[0] ? `, the strongest ${out.absences.strongest[0]}` : ""}`] : []),
      ...(out.friedel.startsWith("centrosymmetric") ? [] : [out.friedel.split(":")[0]!]),
    ];
    this.host.updateRecord(keyOfState(port.technique, port.state()), (rec) => ({ ...rec, dataCheck: { at: Date.now(), summary: parts.join("; ") } }));
  }

  /** The symmetry review's outcome, kept for the analysis. */
  private noteSymmetryReview(port: AgentPort, out: { observedForbidden?: unknown[]; candidates?: { name: string }[] }): void {
    const n = out.observedForbidden?.length ?? 0;
    const top = out.candidates?.slice(0, 3).map((c) => c.name) ?? [];
    const summary = n === 0 ? "no forbidden reflection carries intensity in the refined fit" : `${n} forbidden reflection${n === 1 ? "" : "s"} with intensity${top.length ? `; subgroups allowing them: ${top.join(", ")}` : ""}`;
    this.host.updateRecord(keyOfState(port.technique, port.state()), (r) => ({ ...r, symmetryReviewed: { at: Date.now(), summary } }));
  }

  /** A converged refinement on screen counts its free blocks as done, whoever ran it. */
  private syncStages(port: AgentPort): AgentRecord {
    const s = port.state();
    const key = keyOfState(port.technique, s);
    // With a History, the stages follow it: undo, go_to_step and a reset take a stage back off the list.
    const onPath = stagesOnPath(port.technique, this.host.history(), s);
    if (onPath) {
      this.host.updateRecord(key, (r) => (r.stagesDone.length === onPath.length && onPath.every((c) => r.stagesDone.includes(c)) ? r : { ...r, stagesDone: onPath }));
    } else if (s.result?.status === "converged") {
      // What the fit on screen refined (its esds), not what is free now: a parameter freed since has not been refined.
      const refined = new Set(Object.keys(s.result.esd));
      const covered = stagesCovered(port.technique, s.parameters.filter((p) => refined.has(p.id)), s.parameters);
      this.host.updateRecord(key, (r) => (covered.every((c) => r.stagesDone.includes(c)) ? r : { ...r, stagesDone: [...new Set([...r.stagesDone, ...covered])] }));
    }
    return this.host.record(key);
  }

  /**
   * Why the space group may not be questioned yet, or null: the method's
   * required stages must be refined, and the fit on screen converged.
   * Without the skills (arm C) there are no stages: a converged fit only.
   */
  private symmetryNotYet(port: AgentPort): { message: string; line: string } | null {
    const record = this.syncStages(port);
    const left = this.opts.skills === false ? [] : stagesLeft(port.technique, record);
    const why = "The space group is the last thing questioned: a structure is refined to the best its group allows first, and intensity that differs on the group's own reflections is what that refinement fixes, not evidence against the group.";
    if (left.length > 0) {
      return {
        line: `Not yet: ${left.length} stage${left.length === 1 ? "" : "s"} to refine first`,
        message: `Not yet. ${why} Refine these stages of ${PAGE_METHOD[port.technique]} first, each to convergence: ${left.join(", ")}. Then, only if the fit is still not good, review the symmetry.`,
      };
    }
    const status = port.state().result?.status;
    if (status !== "converged") {
      return {
        line: "Not yet: no converged refinement on screen",
        message: `Not yet: the review reads the refined residual, and the fit on screen is ${status ? `"${status}"` : "not refined"}. ${why} Refine to convergence first.`,
      };
    }
    return null;
  }

  /**
   * What get_state adds from the Agent's record: with the skills, `method`
   * (methodView); without them (the validation's arm C), `record`, the same
   * checks, exceptions and notes with no stage, skill or next step of a method.
   */
  private recordView(port: AgentPort): Record<string, unknown> {
    if (this.opts.skills !== false) return { method: this.methodView(port) };
    const record = this.syncStages(port);
    const kept = {
      ...(record.rangeCheck ? { rangeCheck: record.rangeCheck.summary } : {}),
      ...(record.cellCheck ? { cellCheck: record.cellCheck.summary } : {}),
      ...(record.symmetryReviewed ? { symmetryReview: record.symmetryReviewed.summary } : {}),
      ...(record.exceptions.length > 0 ? { exceptions: record.exceptions.map((e) => `${e.rule}: ${e.reason}`) } : {}),
      ...(record.notes.length > 0 ? { notes: record.notes.map((n) => n.text) } : {}),
    };
    return Object.keys(kept).length > 0 ? { record: kept } : {};
  }

  /** get_state's own answer, without the skills: its magnetic step's note refers to the method's stages. */
  private withoutMethod(out: unknown): object {
    const o = out as { magneticStep?: { next: unknown; note?: string } };
    if (this.opts.skills !== false || !o.magneticStep) return out as object;
    return { ...o, magneticStep: { next: o.magneticStep.next, note: "For the magnetic structure, magnetic_state reads where the magnetic step stands." } };
  }

  /**
   * get_state's view of the method: its stages (done or not), the cell check,
   * the symmetry review, and the exceptions the user allowed.
   */
  private methodView(port: AgentPort): Record<string, unknown> {
    const record = this.syncStages(port);
    const progress = methodProgress(port.technique, record);
    // Where the magnetic step has something to work on, its own next step leads (as get_state's magneticStep): the stages are the refinement step's.
    const panel = port.technique === "powder" ? port.magnetic?.()?.state() ?? null : null;
    const magnetic = panel !== null && (panel.peaks.some((p) => p.included) || panel.kSearch !== null || panel.selected !== null);
    return {
      skill: magnetic ? "magnetic-analysis" : progress.skill,
      stages: progress.stages.map((st) => `${st.done ? "✓" : "○"} ${st.label}${st.optional ? " (if needed)" : ""}`),
      next: magnetic
        ? `the magnetic step: ${magneticNext(panel)} (the stages above are the refinement step's)`
        : progress.next ?? `every required stage done: check the acceptance bar${port.technique === "powder" ? "; only if the fit is still not good, review_symmetry" : ""}`,
      ...(record.rangeCheck ? { rangeCheck: record.rangeCheck.summary } : {}),
      ...(record.cellCheck ? { cellCheck: record.cellCheck.summary } : {}),
      ...(record.symmetryReviewed ? { symmetryReview: record.symmetryReviewed.summary } : {}),
      ...(record.exceptions.length > 0 ? { exceptions: record.exceptions.map((e) => `${e.rule}: ${e.reason}`) } : {}),
      ...(record.notes.length > 0 ? { notes: record.notes.map((n) => n.text) } : {}),
    };
  }

  /**
   * write_report: the page's report with the analysis as the Agent ran it and
   * its account, opened in the viewer. The answer lists the checks, the open
   * issues and any number in the account the report did not compute.
   */
  private async writeReport(port: AgentPort, summary: string, update: (patch: Partial<ActivityEntry>) => void): Promise<ToolOutcome> {
    if (!port.reportInput) throw new Error("this page cannot build a report");
    const s = port.state();
    if (s.busy) throw new Error("a refinement is running — wait for it to finish, then write the report");
    if (port.technique === "powder") requireStructure("refine", s as PowderLiveState);
    const record = this.syncStages(port);
    // The correlations at the refined values, every pair from |ρ| 0.5 as refine measures them (the
    // refinement itself keeps only those at 0.95): for the free set the refinement on screen had.
    const free = s.parameters.filter((p) => !p.fixed && !p.expression).map((p) => p.id);
    const refined = s.result ? Object.keys(s.result.esd) : [];
    let probe: RefinementResult | null = null;
    if (free.length > 0 && free.length === refined.length && free.every((id) => refined.includes(id))) {
      try {
        probe = await port.probe(PROBE_OPTIONS);
      } catch {
        probe = null;
      }
    }
    const checks = port.technique === "pdf" ? pdfReportChecks(s as PdfLiveState, probe)
      : port.technique === "singleCrystal" ? singleCrystalReportChecks(s as SingleCrystalLiveState, probe, keptMeasurements(record))
        : powderReportChecks(s as PowderLiveState, probe);
    // The last run on this analysis: of the refinement on screen, or of an earlier one (a focused
    // set, before the final refinement), which the report labels with how far its values moved since.
    const sampled = this.posterior && this.posterior.key === keyOfState(port.technique, s) ? this.posterior : null;
    const built = buildAgentReport({
      page: port.technique,
      input: port.reportInput(),
      history: this.host.history(),
      record,
      checks,
      posterior: sampled ? { run: sampled.run, current: sampled.run.result === s.result, stepId: sampled.step?.id ?? null, parameters: s.parameters } : null,
      model: this.opts.modelLabel?.() ?? "the configured model",
      ...(this.opts.skills === false ? { method: false } : {}),
      narrative: summary,
      userText: this.userText.join("\n\n"),
    });
    const report: AgentReport = {
      id: nextReportId++,
      title: built.input.title,
      technique: port.technique,
      html: built.html,
      markdown: built.markdown,
      fileBase: reportFileBase(built.input.title),
      at: Date.now(),
      unverified: built.unverified,
      audit: built.audit,
    };
    this.opts.onReport?.(report);
    const attention = built.agent.checks.filter((c) => c.status === "warn").length;
    update({
      status: "done",
      preview: built.input.title,
      outcome: `Report open · ${built.agent.steps.length} steps · ${built.agent.checks.length} checks${attention ? `, ${attention} for attention` : ""}${built.unverified.length ? ` · ${built.unverified.length} number${built.unverified.length === 1 ? "" : "s"} unverified` : ""}`,
    });
    return this.respond({
      shown: true,
      title: built.input.title,
      steps: built.agent.steps.length,
      checks: built.agent.checks.map((c) => `${c.status === "warn" ? "attention" : c.status}: ${c.name} — ${c.detail}`),
      openIssues: built.agent.openIssues,
      ...(built.agent.posterior ? { bayesianCheck: `included (${built.agent.posterior.convergence}${built.agent.posterior.earlier ? `; ${built.agent.posterior.earlier}` : ""})` } : {}),
      ...(built.input.boxcar ? { boxcarScan: `included (${built.input.boxcar.rows.length} boxes of ${built.input.boxcar.width} Å: ${built.input.boxcar.columns.join(", ")})` } : {}),
      ...(built.unverified.length > 0
        ? {
            unverifiedNumbers: built.unverified,
            note: "These numbers in your account (or your notes) match no value the report computed, and are underlined in it. Check each against the tools: correct the account and call write_report again, or leave the number out.",
          }
        : {}),
      downloads: "The user can save the report as HTML, Markdown or PDF, and the CIF, from the viewer.",
    });
  }

  /** allow_exception: the user lifts a firm rule for this analysis. Always asks them. */
  private async allowException(port: AgentPort, input: { rule: MethodRule; reason: string }, entry: ActivityEntry, update: (patch: Partial<ActivityEntry>) => void): Promise<ToolOutcome> {
    const rule = RULES[input.rule];
    if (!rule.pages.includes(port.technique)) throw new Error(`the rule "${input.rule}" does not apply on this page`);
    update({ status: "waiting", preview: `${rule.title}, because: ${input.reason}` });
    if (!(await this.opts.approve({ ...entry, status: "waiting", preview: `${rule.title}, because: ${input.reason}`, alwaysAsk: true }))) {
      update({ status: "declined", outcome: "Declined" });
      return this.respond({ declined: true, note: "The user keeps the rule. Work within it, or ask what they would prefer." });
    }
    const key = keyOfState(port.technique, port.state());
    this.host.updateRecord(key, (r) => ({ ...r, exceptions: [...r.exceptions.filter((e) => e.rule !== input.rule), { rule: input.rule, reason: input.reason, at: Date.now() }] }));
    update({ status: "done", outcome: "Allowed for this analysis" });
    return this.respond({ allowed: input.rule, until: "the data or the phases change" });
  }

  private respond(out: unknown): ToolOutcome {
    const ref = this.refs.put(out);
    const view = buildView(this.refs.get(ref), ref, this.opts.budget ?? 8000);
    const payload = view !== null && typeof view === "object" && !Array.isArray(view) ? { [REF_KEY]: ref, ...view } : view;
    return { isError: false, text: JSON.stringify(payload) };
  }

  private readRef({ ref, start, end }: { ref: string; start?: number; end?: number }): unknown {
    const budget = this.opts.budget ?? 8000;
    const value = this.refs.get(ref);
    if (typeof value === "string" || Array.isArray(value)) {
      const s = Math.min(start ?? 0, value.length);
      const e = Math.min(end ?? value.length, value.length);
      const window = value.slice(s, e);
      const shown = typeof window === "string" ? window : buildView(window, ref, budget, s);
      const chars = JSON.stringify(shown).length;
      if (chars > budget) {
        const fits = Math.max(1, Math.floor(((e - s) * budget) / chars));
        throw new Error(`${ref} holds ${value.length} ${typeof value === "string" ? "characters" : "items"}; ${s}–${e} is ${chars} characters. Read about ${fits} at a time with start/end.`);
      }
      return { ref, length: value.length, start: s, end: e, [typeof value === "string" ? "text" : "items"]: shown };
    }
    return { ref, value: buildView(value, ref, budget) };
  }
}

/** reflection_statistics' answer, as the record reads it. */
interface DataAnswer {
  /** `listed` for a refinement's listing (each reflection once), `measured` for a measurement. */
  readonly reflections: { readonly measured?: number; readonly listed?: number; readonly unique: number; readonly rInt: number | string; readonly rIntFriedelApart?: number };
  readonly resolution: { readonly dMin: number; readonly sinThetaOverLambdaMax?: number; readonly completeness?: number };
  readonly friedel: string;
  readonly absences: { readonly measured: number; readonly atThreeSigma: number; readonly strongest?: readonly string[] } | string;
  readonly intensityStatistics: { readonly meanAbsE2Minus1: number; readonly reading: string } | string;
  readonly twinLaws?: { readonly laws: readonly { readonly indices: string; readonly alpha: number | string; readonly pairs: number }[] } | string;
}

/** check_cell_symmetry's answer, as the record reads it. */
interface CellCheckAnswer {
  readonly passed?: boolean;
  readonly unindexedPeaks?: readonly { readonly d?: number }[];
  readonly absences?: { readonly violated?: readonly unknown[] };
  /** The Le Bail fit: Rwp in per cent, the independent cell parameters by id. */
  readonly leBail?: { readonly Rwp?: number };
  readonly cellValues?: Readonly<Record<string, number>>;
}

/**
 * The cell check in a line, for the record and the report: what indexed and
 * what was flagged, and the Le Bail fit that judged it (its Rwp and cell, as
 * the tool gave them), so an account that quotes the Le Bail cell quotes the
 * report.
 */
export function cellCheckSummary(out: CellCheckAnswer, parameters: readonly RefinementParameter[]): string {
  const unindexed = out.unindexedPeaks?.length ?? 0;
  const flagged = out.absences?.violated?.length ?? 0;
  // The peaks by d, so the report says which they were, and a note that names them names the report's numbers.
  const ds = (out.unindexedPeaks ?? []).map((p) => p.d).filter((d): d is number => typeof d === "number").slice(0, 12);
  const parts = [
    ...(unindexed > 0 ? [`${unindexed} unindexed peak${unindexed === 1 ? "" : "s"}${ds.length ? ` (d = ${ds.join(", ")}${unindexed > ds.length ? ", …" : ""} Å)` : ""}`] : []),
    ...(flagged > 0 ? [`${flagged} absence${flagged === 1 ? "" : "s"} flagged (revisit at the symmetry review)`] : []),
  ];
  const cell = Object.entries(out.cellValues ?? {}).map(([id, v]) => {
    const p = parameters.find((q) => q.id === id);
    return `${(p?.label ?? id).replace(/\s*\(.*\)$/, "")} ${v} ${p?.kind === "cellAngle" ? "°" : "Å"}`;
  });
  const leBail = typeof out.leBail?.Rwp === "number" ? `; the Le Bail fit (every intensity free) reached Rwp ${out.leBail.Rwp.toFixed(2)} %${cell.length ? ` with ${cell.join(", ")}` : ""}` : "";
  return `${out.passed ? "every peak indexes; no absence flagged" : parts.join(", ")}${leBail}`;
}

/** check_fit_range's answer, as the record reads it. */
interface RangeAnswer {
  readonly unit: string;
  readonly window: readonly [number, number] | string;
  readonly low: { readonly end: string; readonly verdict: string; readonly outside?: true; readonly cut?: number; readonly findings: readonly string[] };
  readonly high: { readonly end: string; readonly verdict: string; readonly outside?: true; readonly cut?: number; readonly findings: readonly string[] };
  readonly proposed: { readonly min: number; readonly max: number } | string;
}

function error(message: string): ToolOutcome {
  return { isError: true, text: `Error: ${message}` };
}

/**
 * A page's agreement: wR on powder; Rw on PDF, which has no GoF (uniform
 * weights); wR2 on F² on the single-crystal page, with R1 beside it. The
 * model sees the name the page shows.
 */
function agreement(s: LiveState): { key: "wR" | "Rw" | "wR2"; live: number } {
  return "rw" in s ? { key: "Rw", live: s.rw } : "dataset" in s ? { key: "wR2", live: s.agreement.wr2 } : { key: "wR", live: s.wR };
}

/** What the model learns after a change: the effect on the fit and the step it became. */
function changeOutcome(
  name: string,
  before: LiveState,
  after: LiveState,
  step: { id: string; label: string } | null,
  note: string | undefined,
): Record<string, unknown> {
  const { key } = agreement(after);
  const free = after.parameters.filter((p) => !p.fixed && !p.expression).map((p) => p.id);
  const base = { step, ...(note ? { note } : {}), freeCount: free.length };
  if (name === "refine") {
    const r = after.result;
    if (!r || r === before.result) {
      return { ...base, refined: false, note: note ?? "The refinement did not finish (cancelled or failed); the parameters are unchanged. get_state shows the current values." };
    }
    return {
      ...base,
      refined: true,
      status: r.status,
      [key]: pct(r.agreement.rWeighted ?? 0),
      [`${key}Before`]: pct(agreement(before).live),
      ...(key === "wR" ? { gof: r.agreement.goodnessOfFit !== undefined ? Number(r.agreement.goodnessOfFit.toPrecision(4)) : null } : {}),
      ...("dataset" in after && "dataset" in before ? { R1: pct(after.agreement.r1), R1Before: pct(before.agreement.r1), GooF: Number(after.agreement.goof.toPrecision(4)) } : {}),
      iterations: r.history.length,
      ...(r.diagnostics ? { atBounds: r.diagnostics.atBounds.map((b) => b.parameterId), maxShiftOverEsd: Number(r.diagnostics.maxShiftOverEsd.toPrecision(3)) } : {}),
      ...developedCorrelations(r, after.parameters, restraintsOf(after), assembliesOf(after)),
      ...(r.message ? { message: r.message } : {}),
    };
  }
  // A long free set by kind, as the History's rows give it (a structure of 567 parameters would fill the context with ids).
  if (name === "set_free") return { ...base, free: free.length > 40 ? freeSummary(after.parameters) : free };
  return { ...base, [key]: pct(agreement(after).live), lastResultCleared: before.result !== null && after.result === null };
}

/**
 * Correlations at the minimum the refinement reached: the check before it ran
 * read the starting values, and a pair can tighten on the way. The next
 * refinement refuses the set until one of each pair is fixed.
 */
function developedCorrelations(r: RefinementResult, parameters: readonly RefinementParameter[], restraints: readonly LinearRestraint[], assemblies: ReadonlyMap<string, string>): Record<string, unknown> {
  const check = readCorrelations(r, parameters, restraints, assemblies);
  const carried = check.carried.length > 0
    ? { carriedCorrelations: check.carried.map(carriedText), carriedNote: "Correlated, and refined together: through the other free parameters (with them held fixed each pair separates), as the overall intensity terms (scale, extinction, batch scales), as one disorder's alternatives, or as the domains of a twin with both hands, as every single-crystal program refines them. The correlation is in their esds: read them before quoting them." }
    : {};
  if (check.correlated.length === 0 && check.undetermined.length === 0) return carried;
  return {
    ...carried,
    correlated: check.correlated.map(pairText),
    ...(check.undetermined.length > 0 ? { undetermined: check.undetermined } : {}),
    correlationNote: "These parameters correlate at the refined values. Fix one of each pair before the next refinement; refine will not run with them all free.",
  };
}

/** The restraints the page fits with (site ties, a shared site's Σ). */
const restraintsOf = (s: LiveState): readonly LinearRestraint[] => s.restraints;
/** The single-crystal page's disorder assemblies (SHELXL's PART groups): pairs within one are listed, not stopped. */
const assembliesOf = (s: LiveState): ReadonlyMap<string, string> => ("dataset" in s ? disorderAssemblies(s.structure, s.bindings, s.twinLaws) : new Map());

function outcomeLine(name: string, before: LiveState, after: LiveState, note: string | undefined): string {
  if (name === "refine") {
    const r = after.result;
    if (!r || r === before.result) return "Did not finish";
    return `${r.status} · ${agreement(after).key} ${pct(r.agreement.rWeighted ?? 0).toFixed(2)}%`;
  }
  return note ?? "Done";
}

function pct(f: number): number {
  return Math.round(f * 10000) / 100;
}

/** A short, stable hash of a string (FNV-1a, 32 bits, as hex): the situation's fingerprint. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** What a stopped call answers. */
const STOPPED = "Stopped by the user before this ran.";

/**
 * What a change was checked against: the parameters (free, tied, values),
 * the fit window and the settings. A change approved after any of them moved
 * is not run (the approval card described another state).
 */
export function stateStamp(s: LiveState): string {
  const sig = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v);
  return hashText(JSON.stringify({
    parameters: s.parameters.map((p) => [p.id, p.fixed ? 0 : 1, p.expression ?? "", sig(p.value)]),
    fitRange: "fitRange" in s ? s.fitRange : null,
    settings: "settings" in s ? s.settings : null,
  }));
}
