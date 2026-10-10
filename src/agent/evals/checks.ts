/**
 * The checks the eval scenarios grade a run by. Each is written against a
 * failure seen in the researcher rounds or reported by a user; most read the
 * tool calls (what the Agent did), a few the replies (what it told the user),
 * where a sentence-level reading is enough: a sentence that names the thing
 * and does not negate it.
 */

import { PAGE_METHOD } from "@/agent/skills";
import { keyOfState } from "@/agent/method";
import { announcedTool } from "@/agent/chat";
import { LIVE_TOOLS, liveTool } from "@/agent/tools";
import { convertInterval } from "@/visualization/axisUnits";
import type { PowderAgentPort, PowderLiveState } from "@/agent/port";
import { calls, isChange, replies, type Check, type EvalRun } from "@/agent/evals/harness";

const ok = (detail: string) => ({ pass: true, detail });
const fail = (detail: string) => ({ pass: false, detail });
const json = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Sentences of a reply (Markdown bullets and lines count as sentences too). */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

const NEGATION = /\b(no|not|never|none|nothing|zero|without|don't|doesn't|isn't|aren't|won't|wouldn't|shouldn't|rather than|instead of|before|until|unless|only (if|when|after|once)|last|first refine|premature)\b|n't\b/i;

/** The sentences of the replies that say `what` without negating it. */
export function asserted(run: EvalRun, what: RegExp, upTo = Infinity): string[] {
  const out: string[] = [];
  let i = 0;
  for (const e of run.events) {
    if (i >= upTo) break;
    i++;
    if (e.kind !== "reply") continue;
    for (const s of sentences(e.text)) if (what.test(s) && !NEGATION.test(s)) out.push(s);
  }
  return out;
}

/** Changes wait for the page's method skill (the skill loader: the method is read on demand). */
export const readsMethodFirst: Check = {
  name: "reads the page's method before its first change",
  grade: (run) => {
    const all = calls(run);
    // An attempt counts, refused or not: the executor refuses it, but the Agent did not follow its method.
    const first = all.findIndex((c) => isChange(c.name));
    if (first < 0) return ok("made no change");
    // A step with its own method (the magnetic step) needs that one.
    const method = liveTool(all[first]!.name)?.skill ?? PAGE_METHOD[run.port.technique];
    const read = all.slice(0, first).some((c) => c.name === "read_skill" && c.input.name === method && c.input.reference === undefined && !c.isError);
    return read ? ok(`read ${method}, then ${all[first]!.name}`) : fail(`${all[first]!.name} before reading ${method}`);
  },
};

/** A refinement asked for is run (user report: the Agent refused the full refinement on the cell check). */
export function refines(atLeast: number): Check {
  return {
    name: `runs at least ${atLeast} converged refinement${atLeast === 1 ? "" : "s"}`,
    grade: (run) => {
      const done = calls(run).filter((c) => c.name === "refine" && !c.isError && json(c.text)?.refined === true);
      return done.length >= atLeast ? ok(`${done.length} refinements ran`) : fail(`${done.length} refinement${done.length === 1 ? "" : "s"} ran`);
    },
  };
}

/** The method's stages a converged refinement covered (the record the drawer shows). */
export function coversStages(ids: readonly string[]): Check {
  return {
    name: `covers the stages ${ids.join(", ")}`,
    grade: (run) => {
      const record = run.records.get(keyOfState(run.port.technique, run.port.state()));
      const done = new Set(record?.stagesDone ?? []);
      const missing = ids.filter((id) => !done.has(id));
      return missing.length === 0 ? ok(`done: ${[...done].join(", ")}`) : fail(`not done: ${missing.join(", ")}`);
    },
  };
}

const REFUSAL = /\b(can ?not|can't|won't|will not|unable to|not able to|must not|shouldn't)\b[^.]{0,60}\b(refine|run|proceed|continue|start)\b|\bblock(s|ed|ing)?\b[^.]{0,50}\b(refine|refinement)\b|\b(Le Bail|cell|space[- ]group) gate\b/i;

/** No reply refuses the refinement or invokes a "gate" (user report, 2026-10-10). */
export const doesNotRefuse: Check = {
  name: "does not refuse the refinement or cite a gate",
  grade: (run) => {
    const said = replies(run).flatMap((r) => sentences(r)).filter((s) => REFUSAL.test(s));
    return said.length === 0 ? ok("no refusal") : fail(`said: "${said[0]}"`);
  },
};

const LOWER_SYMMETRY = /\b(lower(ing)?|reduc(e|ing)|drop(ping)?|break(ing)?)\b[^.]{0,30}\bsymmetry\b|\blower[- ]symmetry\b|\b(sub ?group|a lower (space )?group)\b|\bchang(e|ing) (the )?space group\b/i;

/**
 * No symmetry change is proposed before review_symmetry has run on a refined
 * fit (user report: the Agent proposed lowering the symmetry first).
 */
export const symmetryLast: Check = {
  name: "proposes no symmetry change before the review",
  grade: (run) => {
    const reviewed = run.events.findIndex((e) => e.kind === "call" && e.name === "review_symmetry" && !e.isError);
    const said = asserted(run, LOWER_SYMMETRY, reviewed < 0 ? Infinity : reviewed);
    return said.length === 0 ? ok(reviewed < 0 ? "no symmetry change proposed" : "proposed only after review_symmetry") : fail(`said: "${said[0]}"`);
  },
};

const EXTRA_PEAKS = /\b(extra|unexplained|additional|unindexed|impurity|new) (peaks?|reflections?|lines?)\b/i;

/**
 * When find_unexplained_peaks found none, no reply says there are extra peaks
 * (user report: misfits on known reflections were called extra peaks).
 */
export const noPhantomPeaks: Check = {
  name: "calls no misfit an extra peak",
  grade: (run) => {
    const found = calls(run).filter((c) => c.name === "find_unexplained_peaks" && !c.isError).map((c) => Number(json(c.text)?.count ?? NaN));
    if (found.some((n) => n > 0)) return ok("the tool found unexplained peaks");
    const said = asserted(run, EXTRA_PEAKS);
    return said.length === 0 ? ok(found.length ? "the tool found none, and none was claimed" : "no claim") : fail(`said: "${said[0]}"`);
  },
};

export function ran(name: string): Check {
  return {
    name: `calls ${name}`,
    grade: (run) => (calls(run).some((c) => c.name === name && !c.isError) ? ok(`${name} ran`) : fail(`${name} never ran`)),
  };
}

/** A reply names a d-spacing within `tol` of `d`: a line found is reported where the user can find it. */
export function mentionsD(d: number, tol: number): Check {
  return {
    name: `reports the line at d ≈ ${d.toFixed(2)} Å`,
    grade: (run) => {
      const numbers = replies(run).flatMap((r) => [...r.matchAll(/\d+\.\d+/g)].map((m) => Number(m[0])));
      const hit = numbers.find((n) => Math.abs(n - d) <= tol);
      return hit !== undefined ? ok(`said ${hit}`) : fail(`no d within ${tol} Å of ${d.toFixed(3)} in the replies`);
    },
  };
}

/** The last reply does not end on a promise to act (the stall guard: local models ended turns on "Starting the gate now."). */
export const noStall: Check = {
  name: "does not end on a promise to act",
  grade: (run) => {
    const last = replies(run).at(-1) ?? "";
    const tool = announcedTool(last, LIVE_TOOLS.map((t) => t.name));
    return tool ? fail(`ended announcing ${tool}: "${last.slice(-120)}"`) : ok("ended on an answer");
  },
};

/** A firm rule is never lifted unasked (the occupancy guardrail, round 5). */
export const liftsNoRule: Check = {
  name: "does not ask to lift a firm rule unprompted",
  grade: (run) => {
    const lifts = calls(run).filter((c) => c.name === "allow_exception");
    return lifts.length === 0 ? ok("no allow_exception") : fail(`allow_exception(${JSON.stringify(lifts[0]!.input)})`);
  },
};

/** After a refusal (correlation or rule), the free set changes before refine runs again; no more than `max` refusals. */
export function adaptsAfterRefusal(max = 3): Check {
  return {
    name: `changes the free set after a refused refinement (≤ ${max} refusals)`,
    grade: (run) => {
      const all = calls(run);
      let refusals = 0;
      for (let i = 0; i < all.length; i++) {
        const c = all[i]!;
        if (c.name !== "refine" || !c.isError) continue;
        refusals++;
        const next = all.slice(i + 1).find((n) => n.name === "refine");
        if (next && next.free && c.free && next.free.join() === c.free.join()) return fail(`refine retried with the same free set: ${c.free.join(", ")}`);
      }
      return refusals <= max ? ok(`${refusals} refusal${refusals === 1 ? "" : "s"}`) : fail(`${refusals} refusals`);
    },
  };
}

/** The reply explains with these words (e.g. why an occupancy needs a tie). */
export function explains(what: RegExp, label: string): Check {
  return {
    name: `explains ${label}`,
    grade: (run) => {
      const hit = replies(run).flatMap((r) => sentences(r)).find((s) => what.test(s));
      return hit ? ok(`"${hit.slice(0, 120)}"`) : fail(`no reply mentions ${label}`);
    },
  };
}

/** The powder fit window ends up at [min, max] in `unit` (axis units: windows given in d or Q). */
export function fitWindowIs(unit: "dSpacing" | "q", min: number, max: number, tol: number): Check {
  return {
    name: `sets the fit window to ${min}–${max} (${unit})`,
    grade: (run) => {
      const s = run.port.state() as PowderLiveState;
      if (!s.fitRange) return fail("the whole pattern is fitted");
      const w = convertInterval(s.fitRange, s.pattern.xUnit, unit, s.axis);
      const [lo, hi] = [Math.min(w.min, w.max), Math.max(w.min, w.max)];
      return Math.abs(lo - min) <= tol && Math.abs(hi - max) <= tol ? ok(`${lo.toFixed(3)}–${hi.toFixed(3)}`) : fail(`window is ${lo.toFixed(3)}–${hi.toFixed(3)} in ${unit}`);
    },
  };
}

/** Never a converged PDF refinement with δ1 and δ2 both free (the PDF method: one correlated-motion term). */
export const oneMotionTerm: Check = {
  name: "never refines δ1 and δ2 together",
  grade: (run) => {
    const both = calls(run).find((c) => c.name === "refine" && !c.isError && c.free?.includes("delta1") && c.free.includes("delta2"));
    return both ? fail("refined δ1 and δ2 together") : ok("one motion term at a time");
  },
};

/** The magnetic step ends at this k (the "Agent can't do magnetic analysis" report). */
export function magneticKIs(k: readonly [number, number, number]): Check {
  return {
    name: `sets k = (${k.join(", ")}) on the magnetic step`,
    grade: (run) => {
      const h = (run.port as PowderAgentPort).magnetic?.();
      if (!h) return fail("no magnetic step");
      const now = h.state().k;
      return now.every((c, i) => Math.abs(c - k[i]!) < 1e-9) ? ok(`k = (${now.join(", ")})`) : fail(`k is (${now.join(", ")})`);
    },
  };
}

/** The chosen magnetic group, or one the ranking ties with it (the powder's degeneracy). */
export function magneticGroupIs(id: string): Check {
  return {
    name: `chooses the magnetic group ${id}`,
    grade: (run) => {
      const h = (run.port as PowderAgentPort).magnetic?.();
      const chosen = h?.state().selected?.id;
      return chosen === id ? ok(`chose ${id}`) : fail(chosen ? `chose ${chosen}` : "chose none");
    },
  };
}
