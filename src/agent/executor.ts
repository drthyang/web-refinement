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
import { PAGE_LABEL, liveTool, type LiveToolSpec, type ToolEffect } from "@/agent/tools";
import type { AgentPort, LiveState, PdfLiveState, PowderLiveState } from "@/agent/port";
import { changePowder, describePowderChange, powderNoOp, readPowderTool } from "@/agent/powderTools";
import { changePdf, describePdfChange, pdfNoOp, readPdfTool } from "@/agent/pdfTools";
import type { LiveToolHost } from "@/agent/liveCommon";
import { PROBE_OPTIONS, correlationRefusal, pairText, readCorrelations, refusalLine } from "@/agent/correlationCheck";
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
}

/** The answer a model gets: JSON text, flagged when it is an error. */
export interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
}

/** What the chat calls: the executor, or a lazy stand-in for it. */
export interface ToolRunner {
  readonly run: (name: string, input: unknown) => Promise<ToolOutcome>;
}

export interface ExecutorOptions {
  /** Ask the user to approve a change. Resolves false when they decline. */
  readonly approve: (entry: ActivityEntry) => Promise<boolean>;
  /** Every status change of every call, for the drawer. */
  readonly onActivity: (entry: ActivityEntry) => void;
  /** Largest answer, in characters of compact JSON (default 8000, as the MCP server). */
  readonly budget?: number;
}

/** History step kind for a change that does not record its own step. */
const STEP_KIND: Readonly<Record<string, StepKind>> = {
  set_free: "edit",
  set_background: "settings",
  set_microstrain: "settings",
  set_adp_model: "settings",
  set_site_ties: "settings",
  set_fit_range: "settings",
};

let nextCallId = 1;

export class AgentExecutor implements ToolRunner {
  private readonly refs = new RefStore(128);
  /** Changes run one at a time: the page has one compute client and one history. */
  private changes: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: AgentHost, private readonly opts: ExecutorOptions) {}

  /** Run one call. Never throws: failures come back as an error outcome the model can read. */
  run(name: string, input: unknown): Promise<ToolOutcome> {
    const spec = liveTool(name);
    if (!spec) return Promise.resolve(error(`no tool named ${name}`));
    if (spec.effect !== "change") return this.execute(spec, input);
    const run = this.changes.then(() => this.execute(spec, input));
    this.changes = run.catch(() => undefined);
    return run;
  }

  private async execute(spec: LiveToolSpec, raw: unknown): Promise<ToolOutcome> {
    let entry: ActivityEntry = { id: `c${nextCallId++}`, tool: spec.name, title: spec.title, effect: spec.effect, at: Date.now(), status: "running" };
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

      if (spec.effect === "read") {
        update({});
        // Let the drawer paint "running" before a heavy synchronous analysis.
        await new Promise((r) => setTimeout(r, 0));
        const out = port.technique === "pdf" ? readPdfTool(spec.name, input, port, this.host) : readPowderTool(spec.name, input, port, this.host);
        update({ status: "done" });
        return this.respond(out);
      }

      // A change: refuse while a fit runs, then ask, then act as the agent.
      const before = port.state();
      if (before.busy) throw new Error("a refinement is running — wait for it to finish, or call cancel_refinement");
      const noOp = port.technique === "pdf" ? pdfNoOp(spec, input, before as PdfLiveState) : powderNoOp(spec, input, before as PowderLiveState);
      if (noOp) {
        update({ status: "done", outcome: "No change" });
        return this.respond({ unchanged: true, note: noOp });
      }
      let preview = port.technique === "pdf" ? describePdfChange(spec, input, before as PdfLiveState) : describePowderChange(spec, input, before as PowderLiveState);
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
        const check = readCorrelations(probe, before.parameters, restraintsOf(before));
        const refusal = correlationRefusal(check);
        if (refusal) {
          update({ status: "failed", preview, outcome: refusalLine(check) });
          return error(refusal);
        }
        preview += check.strongest ? ` · strongest correlation ${pairText(check.strongest)}` : " · no correlation above 0.5";
      }
      update({ status: "waiting", preview });
      if (!(await this.opts.approve(entry))) {
        update({ status: "declined", outcome: "Declined" });
        return this.respond({ declined: true, note: "The user declined this change. Ask what they would prefer, or propose something else." });
      }
      update({ status: "running" });
      // The user's own unsaved edits become their step first, so the agent's
      // step holds only what the agent changed.
      this.host.recordNow("edit");
      const changed = await this.host.asAgent(async () => {
        const n = port.technique === "pdf" ? await changePdf(spec.name, input, port, this.host) : await changePowder(spec.name, input, port, this.host);
        await this.host.settle();
        const kind = STEP_KIND[spec.name];
        if (kind) {
          this.host.recordNow(kind);
          await this.host.settle();
        }
        return n;
      });
      const note = typeof changed === "object" ? changed.note : changed;
      const after = this.requirePort().state();
      const out = { ...changeOutcome(spec.name, before, after, this.currentStep(), note), ...(typeof changed === "object" ? changed.data : {}) };
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
    const technique = this.host.technique();
    throw new Error(
      technique === "singleCrystal"
        ? "the Agent works on the powder and PDF pages for now; the single-crystal page is not connected yet"
        : "no analysis is open — ask the user to load a structure and data, or a demo",
    );
  }

  private currentStep(): { id: string; label: string } | null {
    const h = this.host.history();
    const st = h?.steps.find((s) => s.id === h.current);
    return st ? { id: st.id, label: st.name ?? st.label } : null;
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

function error(message: string): ToolOutcome {
  return { isError: true, text: `Error: ${message}` };
}

/**
 * A page's agreement: wR on powder; Rw on PDF, which has no GoF (uniform
 * weights). The model sees the name the page shows.
 */
function agreement(s: LiveState): { key: "wR" | "Rw"; live: number } {
  return "rw" in s ? { key: "Rw", live: s.rw } : { key: "wR", live: s.wR };
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
      iterations: r.history.length,
      ...(r.diagnostics ? { atBounds: r.diagnostics.atBounds.map((b) => b.parameterId), maxShiftOverEsd: Number(r.diagnostics.maxShiftOverEsd.toPrecision(3)) } : {}),
      ...developedCorrelations(r, after.parameters, restraintsOf(after)),
      ...(r.message ? { message: r.message } : {}),
    };
  }
  if (name === "set_free") return { ...base, free };
  return { ...base, [key]: pct(agreement(after).live), lastResultCleared: before.result !== null && after.result === null };
}

/**
 * Correlations at the minimum the refinement reached: the check before it ran
 * read the starting values, and a pair can tighten on the way. The next
 * refinement refuses the set until one of each pair is fixed.
 */
function developedCorrelations(r: RefinementResult, parameters: readonly RefinementParameter[], restraints: readonly LinearRestraint[]): Record<string, unknown> {
  const check = readCorrelations(r, parameters, restraints);
  if (check.correlated.length === 0 && check.undetermined.length === 0) return {};
  return {
    correlated: check.correlated.map(pairText),
    ...(check.undetermined.length > 0 ? { undetermined: check.undetermined } : {}),
    correlationNote: "These parameters correlate at the refined values. Fix one of each pair before the next refinement; refine will not run with them all free.",
  };
}

/** The restraints the page fits with (site ties, a shared site's Σ). */
const restraintsOf = (s: LiveState): readonly LinearRestraint[] => s.restraints;

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
