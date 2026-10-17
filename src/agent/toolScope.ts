/**
 * The tools a local model is offered on each request: the page's, and on the
 * powder page only those of the method's stage. Every tool's name, description
 * and schema go with every request, and on the powder page all 44 of them
 * take about 10k tokens of a 32k window — on the user's qwen3.8-27b the
 * instructions and the 56 tools then took 18.8k before the conversation began.
 * Claude is offered every tool (ChatConfig.toolScope "all").
 *
 * The offer grows, never shrinks, within a conversation:
 *  - the core: reading the analysis, the method and refs, notes, freeing and
 *    refining, undoing, the report — every page, every stage;
 *  - the page's own: on the PDF and single-crystal pages all of them; on the
 *    powder page, the fit window and the fit's diagnosis, and the current
 *    stage's tools and the next one's (the cell check's, the background's,
 *    the profile's…);
 *    once every required stage is done, the review, the structure's tables,
 *    the posterior, the optional stages and the way into the magnetic step;
 *  - what the user's words ask for (an impurity, the symmetry, an occupancy,
 *    a magnetic structure, a bond length…), whatever the stage;
 *  - every tool the model has already called: a tool is never taken away
 *    mid-task, and one called by name though not offered (the executor runs
 *    any tool) is offered from then on.
 *
 * Without the skills (the validation's arm C) there is no method to follow,
 * so no stage either: every page offers all of its tools.
 */

import { LIVE_TOOLS, type AgentPage, type LiveToolSpec } from "@/agent/tools";
import { stagesFor } from "@/agent/method";

/** Offered on every page, at every stage. */
export const CORE_TOOLS: readonly string[] = [
  "get_state", "read_skill", "read_ref", "write_note", "assess_refinement", "set_free", "refine", "reset_parameters", "go_to_step", "cancel_refinement", "allow_exception", "write_report",
];

/** The powder page, at every stage: the fit window (read again after the first refinement) and the fit's diagnosis. */
const POWDER_ALWAYS: readonly string[] = ["check_fit_range", "set_fit_range", "diagnose_fit", "suggest_next_steps", "rank_next_parameters"];

/** The powder method's stages (method.ts), each with its own tools. */
export const POWDER_STAGE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  range: [],
  check: ["check_cell_symmetry", "identify_peaks", "add_known_phase", "find_unexplained_peaks"],
  base: ["set_background", "set_instrument_constants", "identify_peaks", "add_known_phase"],
  positions: ["tie_parameters", "set_site_ties"],
  profile: ["set_microstrain", "set_corrections"],
  adp: ["set_adp_model", "tie_parameters"],
  occupancy: ["set_site_ties", "tie_parameters", "add_antisite"],
  corrections: ["set_corrections"],
  symmetry: ["review_symmetry"],
};

/**
 * Every required powder stage done: the symmetry review, the structure's
 * table and the posterior for the report, the residual's peaks, the polish
 * (corrections, ties) and the magnetic step's door. The rest (an occupancy's
 * ties, bond geometry, a known phase) comes with the user's words or the
 * model's own earlier use.
 */
const POWDER_FINISH: readonly string[] = [
  "review_symmetry", "structure_table", "sample_posterior", "find_unexplained_peaks", "identify_peaks", "set_corrections", "tie_parameters", "magnetic_state", "search_propagation_vector",
];

/** The magnetic step (magnetic-analysis), offered once it is under way or asked for. */
export const MAGNETIC_TOOLS: readonly string[] = [
  "magnetic_state", "search_propagation_vector", "set_propagation_vector", "select_magnetic_ions", "set_moment_ties", "rank_magnetic_groups", "choose_magnetic_group", "refine_moments", "show_magnetic_model", "continue_magnetic_refinement",
];

/** What the user's words ask for, and the tools that answer it, on any page. */
const ASKED: readonly (readonly [RegExp, readonly string[]])[] = [
  [/magnet|propagation|\bk[- ]?(vector|point|search)\b|\bk\s*=|\bmoments?\b|\bspins?\b|ferro|antiferro|satellite/i, MAGNETIC_TOOLS],
  [/impurit|extra (peaks?|lines?|reflections?)|unexplained|unindexed|not (account|explain)|does(n't| not) (account|explain)|second phase|another phase|other phase|lines? (this|the) model|known phase|sample environment|alumin/i, ["find_unexplained_peaks", "identify_peaks", "add_known_phase", "check_cell_symmetry"]],
  [/symmetr|space ?group|sub ?group|absences?/i, ["review_symmetry", "check_cell_symmetry"]],
  [/occupan|vacanc|antisite|anti-site|site mixing|disorder|composition|stoichiometr/i, ["set_site_ties", "tie_parameters", "add_antisite"]],
  [/posterior|uncertaint|credible|confiden|trust|esd|error bars?/i, ["sample_posterior"]],
  [/bond|distance|angles?\b|coordinat|octahed|tetrahed|geometr|polyhed/i, ["bond_geometry", "structure_table", "interpret_structure"]],
  [/report|table|summar|publish/i, ["structure_table", "interpret_structure"]],
  [/background/i, ["set_background"]],
  [/strain|crystallite|size broadening|broaden|mustrain/i, ["set_microstrain"]],
  [/aniso|\badps?\b|thermal|\bb[- ]?(iso|values?)\b|u_?iso|displacement param/i, ["set_adp_model", "tie_parameters"]],
  [/texture|preferred orientation|absorption|asymmetr|sample displacement|transparency|correction|extinction/i, ["set_corrections"]],
  [/x-?ray|polari[sz]ation|k-?alpha|kα|monochromat/i, ["set_instrument_constants"]],
  [/\btie\b|\btied\b|constrain|equal|same value/i, ["tie_parameters", "set_site_ties"]],
  [/cell check|check(ing)? (the )?cell|le ?bail|\bindex/i, ["check_cell_symmetry"]],
];

export interface ScopeInput {
  /** The page open (null: nothing open). */
  readonly page: AgentPage | null;
  /** The method's next required stage (null: every required stage done). */
  readonly stage: string | null;
  /** The magnetic step is under way. */
  readonly magnetic: boolean;
  /** What the user said in this conversation. */
  readonly asked: readonly string[];
  /** Every tool called in this conversation. */
  readonly called: ReadonlySet<string>;
  /** The page's written method is in play (default). False without the skills (arm C): the page's tools, not the stage's. */
  readonly method?: boolean;
}

/** The names a local model is offered now. */
export function scopedToolNames(input: ScopeInput): Set<string> {
  const names = new Set<string>(CORE_TOOLS);
  const add = (list: readonly string[]): void => list.forEach((n) => names.add(n));
  if (input.page === "pdf" || input.page === "singleCrystal" || (input.page === "powder" && input.method === false)) {
    add(LIVE_TOOLS.filter((t) => t.pages.includes(input.page!)).map((t) => t.name));
  } else if (input.page === "powder") {
    add(POWDER_ALWAYS);
    if (input.stage === null) add(POWDER_FINISH);
    else {
      // The stage's tools and the next one's: a model that takes the cell check before the window is not left without it.
      const required = stagesFor("powder").filter((st) => !st.optional).map((st) => st.id);
      const next = required[required.indexOf(input.stage) + 1];
      add(POWDER_STAGE_TOOLS[input.stage] ?? []);
      // (After the last, the finishing tools come once it is done.)
      add(next ? POWDER_STAGE_TOOLS[next] ?? [] : []);
    }
    if (input.magnetic) add(MAGNETIC_TOOLS);
  }
  for (const text of input.asked) for (const [what, tools] of ASKED) if (what.test(text)) add(tools);
  add([...input.called]);
  // Only what works on the page open (a tool from the user's words may belong to another page).
  if (input.page !== null) for (const n of [...names]) if (!LIVE_TOOLS.find((t) => t.name === n)?.pages.includes(input.page)) names.delete(n);
  return names;
}

/** The tools a local model is offered now, in the list's own order (so the prompt's tool block changes only where it must). */
export function scopedTools(input: ScopeInput): LiveToolSpec[] {
  const names = scopedToolNames(input);
  return LIVE_TOOLS.filter((t) => names.has(t.name));
}

/** What a local model is told about its tool list. */
export const SCOPE_NOTE = "Tools: you are offered the tools of the page and of the method's current stage; a later stage's tools appear once you reach it (a converged refinement completes a stage), and every tool you have used stays offered.";

/** The same, without the skills (arm C): no method, so no stage. */
export const SCOPE_NOTE_PAGE = "Tools: you are offered the tools of the page that is open.";

/** The note that goes with a scoped tool list. */
export function scopeNote(method: boolean): string {
  return method ? SCOPE_NOTE : SCOPE_NOTE_PAGE;
}
