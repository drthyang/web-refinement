/**
 * The eval scenarios: each one a request a user made (or a researcher round
 * made) that the Agent once got wrong, on a page built from the repository's
 * own data, with the checks that say whether it got it right this time.
 */

import { impurityD, mn3gaImpuritySession, mn3gaMisfitSession, mn3gaSession, pdfPage, powderPage } from "@/agent/evals/pages";
import {
  adaptsAfterRefusal,
  coversStages,
  doesNotRefuse,
  explains,
  fitWindowIs,
  liftsNoRule,
  mentionsD,
  noPhantomPeaks,
  noStall,
  oneMotionTerm,
  ran,
  readsMethodFirst,
  refines,
  symmetryLast,
} from "@/agent/evals/checks";
import type { EvalScenario } from "@/agent/evals/harness";

export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: "full-refinement",
    title: "Runs the full refinement when asked",
    origin: "User report on the deployed Agent: it refused the full refinement, citing the cell and space-group check.",
    page: () => powderPage(mn3gaSession()),
    messages: ["Run the full refinement to improve the quality of the fit."],
    autonomy: "auto",
    checks: [readsMethodFirst, doesNotRefuse, refines(3), coversStages(["base", "positions", "profile", "adp"]), symmetryLast, noStall],
  },
  {
    id: "misfits-not-extra-peaks",
    title: "Calls intensity misfit a misfit, not an extra peak",
    origin: "User report: reflections with somewhat different intensity were called extra peaks.",
    page: () => powderPage(mn3gaMisfitSession()),
    messages: ["Are there extra peaks in this pattern that the model does not explain?"],
    autonomy: "ask",
    checks: [ran("find_unexplained_peaks"), noPhantomPeaks, symmetryLast, noStall],
  },
  {
    id: "symmetry-last",
    title: "Refines to the best before questioning the space group",
    origin: "User report: the Agent proposed lowering the symmetry at the start; that is the last step, once nothing else can be refined.",
    page: () => powderPage(mn3gaMisfitSession()),
    messages: ["The fit is not good. Should we lower the symmetry?"],
    autonomy: "ask",
    checks: [symmetryLast, explains(/\brefin/i, "refining first"), noStall],
  },
  {
    id: "impurity-line",
    title: "Finds and reports a line no phase explains",
    origin: "Residual peaks (#40): judged by their own noise and against every phase's reflections.",
    page: () => powderPage(mn3gaImpuritySession()),
    messages: ["Is there anything in the pattern the model does not account for?"],
    autonomy: "ask",
    checks: [ran("find_unexplained_peaks"), mentionsD(impurityD(), 0.03), symmetryLast, noStall],
  },
  {
    id: "bare-occupancy",
    title: "Does not refine an occupancy bare, and says why",
    origin: "Round 5: the occupancy guardrail; only the user lifts it.",
    page: () => powderPage(mn3gaSession()),
    messages: ["Refine the Mn occupancy as well."],
    autonomy: "ask",
    checks: [liftsNoRule, adaptsAfterRefusal(2), explains(/\b(tie|Σ|sum|scale|composition|restrain|degenera|correlat)/i, "why the occupancy needs a tie"), noStall],
  },
  {
    id: "free-everything",
    title: "Answers a refusal by changing the free set",
    origin: "The correlation guard (#39): correlated parameters are never refined together.",
    page: () => powderPage(mn3gaSession()),
    messages: ["Free every parameter and refine."],
    autonomy: "ask",
    checks: [liftsNoRule, adaptsAfterRefusal(3), noStall],
  },
  {
    id: "fit-window-in-d",
    title: "Sets a fit window given in d",
    origin: "Axis units (#39): windows and positions in d, Q or the data's own axis.",
    page: () => powderPage(mn3gaSession()),
    messages: ["Restrict the fit to d-spacings from 1.2 to 3 Å."],
    autonomy: "ask",
    checks: [fitWindowIs("dSpacing", 1.2, 3, 0.01), noStall],
  },
  {
    id: "pdf-method",
    title: "Refines a PDF by its method",
    origin: "The PDF page (v0.3): scale and cell, ADPs, one correlated-motion term, positions.",
    page: () => pdfPage(),
    messages: ["Refine this PDF fit following my method."],
    autonomy: "auto",
    checks: [readsMethodFirst, refines(2), oneMotionTerm, noStall],
  },
  {
    id: "pdf-local-structure",
    title: "Compares local and average structure with a boxcar scan",
    origin: "Boxcar scans on the PDF page (#40).",
    page: () => pdfPage(),
    messages: ["Does the local structure differ from the average one?"],
    autonomy: "ask",
    checks: [ran("boxcar_scan"), noStall],
  },
];

export function scenario(id: string): EvalScenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no eval scenario "${id}"`);
  return s;
}
