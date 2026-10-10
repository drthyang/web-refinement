/**
 * Which page cards the Agent is on: the cards a running (or waiting) tool call
 * acts on, and the cards a reply names. The shell writes them to the root
 * element (`data-agent-focus`), and workbench.css makes those cards' edges
 * breathe, so the user sees where the agent is looking.
 */

export type AgentCard = "structure" | "data" | "instrument" | "pattern" | "parameters" | "result";

/** The cards each tool reads or changes (none for the whole-page reads). */
export const TOOL_CARDS: Readonly<Record<string, readonly AgentCard[]>> = {
  get_state: [],
  read_ref: [],
  read_skill: [],
  allow_exception: [],
  write_note: [],
  go_to_step: [],
  cancel_refinement: [],
  assess_refinement: ["result", "pattern"],
  suggest_next_steps: ["result"],
  rank_next_parameters: ["parameters"],
  check_cell_symmetry: ["structure", "pattern"],
  find_unexplained_peaks: ["pattern"],
  review_symmetry: ["structure", "pattern"],
  magnetic_state: [],
  search_propagation_vector: [],
  set_propagation_vector: [],
  select_magnetic_ions: [],
  set_moment_ties: [],
  rank_magnetic_groups: [],
  choose_magnetic_group: [],
  refine_moments: [],
  show_magnetic_model: ["pattern"],
  continue_magnetic_refinement: ["parameters"],
  bond_geometry: ["structure"],
  interpret_structure: ["structure"],
  set_free: ["parameters"],
  set_background: ["parameters", "pattern"],
  set_microstrain: ["parameters"],
  set_adp_model: ["parameters"],
  set_site_ties: ["parameters"],
  set_fit_range: ["pattern"],
  refine: ["parameters", "pattern"],
  reset_parameters: ["parameters"],
  boxcar_scan: ["pattern"],
};

/** Words that name a card, conservatively: each must point at one place on the page. */
const CARD_WORDS: readonly [AgentCard, RegExp][] = [
  ["structure", /\b(structure|space group|bonds?|bond lengths?|atoms?|unit cell|cell check)\b/i],
  ["instrument", /\b(instrument|wavelength|difC|difA|calibration|zero shift)\b/i],
  ["data", /\b(data file|dataset|counting statistics)\b/i],
  // "peak widths" and "peak shape" are the profile, not the plot.
  ["pattern", /\b(plot|pattern|residual|peaks?\b(?!\s+(widths?|shapes?))|fit window|fit range|difference curve|G\(r\))/i],
  ["parameters", /\b(background|scale|ADPs?|B_?iso|U_?iso|occupanc(y|ies)|positions?|profile|peak (widths?|shapes?)|microstrain|parameters?)\b/i],
  ["result", /\b(wR|Rwp|Rw|GoF|goodness of fit|converged|esds?)\b/i],
];

/** The cards a piece of text names. */
export function cardsInText(text: string): AgentCard[] {
  return CARD_WORDS.filter(([, re]) => re.test(text)).map(([card]) => card);
}

/**
 * The cards a reply points the user to: those named in its last paragraph,
 * where a reply says what it found or proposes next (naming every card the
 * whole reply touches would light up the page).
 */
export function cardsInReply(text: string): AgentCard[] {
  const last = text.split(/\n\s*\n/).filter((p) => p.trim()).at(-1) ?? "";
  return cardsInText(last);
}
