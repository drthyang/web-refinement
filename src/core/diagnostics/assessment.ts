/**
 * Expert assessment of a refinement — the "what matters" layer.
 *
 * A converged fit returns a pile of numbers; an experienced refiner reads a
 * *judgment* off them: is the fit trustworthy, which correlations are dangerous,
 * is a parameter railing against a bound, is the model over- or
 * under-parameterized, and — most valuable for discovery — is there structured
 * intensity the current model does not explain (a missing phase, an impurity, or
 * magnetic order)? This module encodes that reading as pure, tested functions
 * over the plain result types, so both the UI and an agent get the *same*
 * structured findings to reason over rather than a scalar wR.
 *
 * Design: this computes *facts and flags with severity*, not prose. The narration
 * ("this scale/background correlation means your background is soaking up peak
 * intensity") is left to the caller/agent — the guardrail from
 * docs/AGENT_TOOLS.md: the engine and this layer are deterministic; the LLM
 * sequences and narrates. Thresholds follow the project's knowledge base
 * (knowledge/refinement_fitting_algorithms_knowledge.md) and Toby 2006 for GoF.
 */

import type {
  RefinementParameter,
  RefinementResult,
  ParameterKind,
} from "@/core/refinement/types";
import { detectExtraPeaks } from "@/core/magnetic/extraPeaks";

export type Severity = "info" | "note" | "warning" | "critical";

/** The order matters: higher index = more urgent, used for sorting findings. */
const SEVERITY_RANK: Record<Severity, number> = { info: 0, note: 1, warning: 2, critical: 3 };

export type FindingCategory =
  | "fit-quality"
  | "correlation"
  | "at-bound"
  | "conditioning"
  | "parameterization"
  | "convergence"
  | "physical"
  | "residual";

export interface AssessmentFinding {
  readonly category: FindingCategory;
  readonly severity: Severity;
  /** One factual line: what is observed. */
  readonly summary: string;
  /** Expert context: what this usually indicates and how it is typically resolved. */
  readonly detail?: string;
  /** Parameters this finding is about (ids), when applicable. */
  readonly parameterIds?: readonly string[];
  /** The raw numbers behind the finding, for the agent to reason with. */
  readonly evidence?: Readonly<Record<string, number | string>>;
}

export interface FitVerdict {
  /**
   * Overall trust band. `unreliable` means the fit did not converge or is
   * ill-posed enough that the numbers should not be quoted at all.
   */
  readonly band: "excellent" | "good" | "fair" | "poor" | "unreliable";
  readonly wRPercent?: number;
  readonly gof?: number;
  readonly rationale: string;
}

export interface RefinementAssessment {
  readonly verdict: FitVerdict;
  /** Findings, most severe first. */
  readonly findings: readonly AssessmentFinding[];
  /** A single headline for the agent (verdict + the count of what needs attention). */
  readonly summary: string;
}

export interface AssessmentInput {
  readonly result: RefinementResult;
  /** The parameter set the fit ran on (for kinds, bounds, and physical checks). */
  readonly parameters: readonly RefinementParameter[];
  /** Number of observations in the fit (points in range, or reflections). */
  readonly observationCount: number;
  /**
   * Residual analysis inputs: d-spacing (Å), observed, and calculated at each
   * point. When present, positive unexplained residual is scanned for peaks —
   * the missing-phase / impurity / magnetic-order signal. Omit for single
   * crystal or when a profile is unavailable.
   */
  readonly residual?: {
    readonly d: readonly number[];
    readonly yObs: readonly number[];
    readonly yCalc: readonly number[];
  };
  readonly mode?: "powder" | "single-crystal";
}

/** Displacement-parameter kinds, for physical (negative-ADP) checks. */
const ADP_KINDS: ReadonlySet<ParameterKind> = new Set(["bIso", "uAniso"]);

/**
 * Known dangerous correlation pairs → the physical reason they correlate.
 * Keyed by the unordered pair of kinds. This is where refiner folklore becomes
 * machine-readable: the agent gets *why* a correlation is expected and what to do.
 */
function correlationInsight(a: ParameterKind, b: ParameterKind): string | undefined {
  const pair = new Set<ParameterKind>([a, b]);
  const has = (x: ParameterKind, y: ParameterKind): boolean => pair.has(x) && pair.has(y);
  if (has("scale", "background")) return "The overall scale and the background are trading intensity — a flexible background can soak up peak intensity. Reduce background terms, or refine scale with the background fixed first.";
  if (has("scale", "bIso")) return "Scale and isotropic B correlate through the overall fall-off of intensity with angle. Fix one (usually B) until the scale and cell are stable.";
  if (has("scale", "occupancy")) return "Scale and site occupancy are near-degenerate on a single site (both multiply intensity). Constrain occupancy (e.g. full, or a Σ=1 tie) unless a second contrast breaks the tie.";
  if (has("cellLength", "zeroShift")) return "Cell length and zero shift both move peak positions; they separate only across a wide 2θ/TOF range. Refine the zero from a well-characterized standard, or fix it.";
  if (has("profileU", "profileV") || has("profileV", "profileW") || has("profileU", "profileW")) return "The Caglioti U/V/W are mutually correlated (they parameterize one FWHM(θ) curve). Free them together only with good angular coverage; otherwise refine W first.";
  if (has("mustrainPerp", "mustrainPar") || has("anisoSizePerp", "anisoSizePar")) return "Anisotropic microstructure components correlate along directions the data barely resolves. Free them only after the isotropic profile has converged.";
  return undefined;
}

/** Toby 2006: the ratio wR/R_exp (the GoF) is what's meaningful, not absolute wR. */
function verdictFrom(result: RefinementResult): FitVerdict {
  const ag = result.agreement;
  const wRPercent = ag.rWeighted !== undefined ? 100 * ag.rWeighted : undefined;
  const gof = ag.goodnessOfFit;
  if (result.status === "diverged") {
    return { band: "unreliable", ...(wRPercent !== undefined ? { wRPercent } : {}), ...(gof !== undefined ? { gof } : {}), rationale: "The refinement diverged — the parameters and esds are not meaningful." };
  }
  if (result.status !== "converged") {
    return { band: "poor", ...(wRPercent !== undefined ? { wRPercent } : {}), ...(gof !== undefined ? { gof } : {}), rationale: `The refinement stopped as "${result.status}" rather than converging; treat the values as provisional.` };
  }
  if (gof === undefined) {
    return { band: "fair", ...(wRPercent !== undefined ? { wRPercent } : {}), rationale: "Converged, but no expected-R was available to form a goodness of fit — judge from the residual shape instead of wR alone." };
  }
  // Bands mirror the app's qualityInk (Toby 2006): GoF ≈ 1 is ideal; < 1 warns of
  // over-fitting or overestimated σ; the higher bands are progressively worse.
  if (gof < 0.8) return { band: "fair", ...(wRPercent !== undefined ? { wRPercent } : {}), gof, rationale: `GoF ${gof.toFixed(2)} < 1: the fit is "too good" — σ's are likely overestimated or the model is over-parameterized. Not a green light.` };
  if (gof <= 1.5) return { band: "excellent", ...(wRPercent !== undefined ? { wRPercent } : {}), gof, rationale: `GoF ${gof.toFixed(2)} is close to the statistical floor — the model explains the data to within its uncertainties.` };
  if (gof <= 2.5) return { band: "good", ...(wRPercent !== undefined ? { wRPercent } : {}), gof, rationale: `GoF ${gof.toFixed(2)}: a reasonable fit with residual structure the model does not fully capture.` };
  if (gof <= 4) return { band: "fair", ...(wRPercent !== undefined ? { wRPercent } : {}), gof, rationale: `GoF ${gof.toFixed(2)}: significant unmodelled features — background, profile, or a missing phase are the usual causes.` };
  return { band: "poor", ...(wRPercent !== undefined ? { wRPercent } : {}), gof, rationale: `GoF ${gof.toFixed(2)}: the model is far from the data — revisit the starting cell, background, and phase content before trusting any parameter.` };
}

const PHYSICAL_LABEL: Partial<Record<ParameterKind, string>> = {
  bIso: "isotropic displacement B",
  occupancy: "site occupancy",
};

/**
 * Assess a completed refinement: a trust verdict plus the findings an expert
 * would flag, most severe first. Pure and deterministic — same result in, same
 * assessment out.
 */
export function assessRefinement(input: AssessmentInput): RefinementAssessment {
  const { result, parameters, observationCount } = input;
  const diag = result.diagnostics;
  const byId = new Map(parameters.map((p) => [p.id, p]));
  const findings: AssessmentFinding[] = [];

  const verdict = verdictFrom(result);

  // --- convergence -------------------------------------------------------
  if (result.status === "converged" && diag && diag.maxParameterShift > 0.05) {
    findings.push({
      category: "convergence",
      severity: "warning",
      summary: `Converged on χ² while a parameter was still shifting (max relative shift ${diag.maxParameterShift.toFixed(3)}).`,
      detail: "The objective flattened but a parameter had not settled — often a sign of a shallow/degenerate direction. Refine a few more cycles or fix the drifting parameter.",
      evidence: { maxParameterShift: diag.maxParameterShift },
    });
  } else if (result.status !== "converged") {
    findings.push({
      category: "convergence",
      severity: result.status === "diverged" ? "critical" : "warning",
      summary: `Refinement status: ${result.status}.`,
      ...(result.message ? { detail: result.message } : {}),
    });
  }

  // --- at-bound parameters ----------------------------------------------
  for (const b of diag?.atBounds ?? []) {
    const p = byId.get(b.parameterId);
    const isStructural = p && (ADP_KINDS.has(p.kind) || p.kind === "occupancy");
    findings.push({
      category: "at-bound",
      severity: isStructural ? "critical" : "warning",
      summary: `${p?.label ?? b.parameterId} is resting on its ${b.bound} bound (${b.value}).`,
      detail: p && ADP_KINDS.has(p.kind)
        ? "A displacement parameter pinned at a bound (often B→0) usually means the model is over-damping high-angle intensity — check the background, an absorption/extinction effect, or a correlation, rather than trusting the value."
        : "A free parameter at a bound has a meaningless esd and signals the fit wanted to go where physics forbids — hold it fixed and find the upstream cause (correlation, wrong background, bad starting value).",
      parameterIds: [b.parameterId],
      evidence: { bound: b.bound, value: b.value },
    });
  }

  // --- physical sanity of the values ------------------------------------
  for (const p of parameters) {
    if (ADP_KINDS.has(p.kind) && p.value < 0) {
      findings.push({
        category: "physical",
        severity: "critical",
        summary: `${p.label} refined negative (${p.value.toFixed(4)}) — an unphysical ${PHYSICAL_LABEL[p.kind] ?? "displacement parameter"}.`,
        detail: "A negative ADP has no physical meaning; it typically absorbs an error elsewhere (scale, background, absorption, or a wrong scattering type). Fix it at a small positive value and address the real cause.",
        parameterIds: [p.id],
        evidence: { value: p.value },
      });
    }
    if (p.kind === "occupancy" && (p.value < -1e-6 || p.value > 1 + 1e-6)) {
      findings.push({
        category: "physical",
        severity: "warning",
        summary: `${p.label} refined to ${p.value.toFixed(4)}, outside [0, 1].`,
        detail: "Occupancy outside its physical range points to a scale/occupancy correlation or the wrong site multiplicity. Constrain it (full site, or a Σ=1 tie) unless a second contrast justifies the value.",
        parameterIds: [p.id],
        evidence: { value: p.value },
      });
    }
  }

  // --- correlations ------------------------------------------------------
  for (const c of diag?.highCorrelations ?? []) {
    const a = byId.get(c.parameterIdA);
    const b = byId.get(c.parameterIdB);
    const insight = a && b ? correlationInsight(a.kind, b.kind) : undefined;
    const abs = Math.abs(c.coefficient);
    findings.push({
      category: "correlation",
      severity: abs > 0.95 ? "warning" : "note",
      summary: `${a?.label ?? c.parameterIdA} ↔ ${b?.label ?? c.parameterIdB} correlate at ${c.coefficient.toFixed(2)}.`,
      ...(insight ? { detail: insight } : { detail: "Strongly correlated parameters share information the data cannot separate; their individual esds are inflated. Consider refining them in separate stages or fixing one." }),
      parameterIds: [c.parameterIdA, c.parameterIdB],
      evidence: { coefficient: c.coefficient },
    });
  }

  // --- conditioning (SVD near-null directions) ---------------------------
  if (diag && diag.svdZeroCount > 0) {
    findings.push({
      category: "conditioning",
      severity: "warning",
      summary: `${diag.svdZeroCount} near-null direction${diag.svdZeroCount === 1 ? "" : "s"} dropped from the covariance (condition number ${diag.conditionNumber.toExponential(1)}).`,
      detail: "One or more parameter combinations are essentially undetermined by the data. The esds along those directions are not trustworthy; the listed parameters are the main participants — fix or tie one of them.",
      ...(diag.singularParameterIds.length ? { parameterIds: diag.singularParameterIds } : {}),
      evidence: { svdZeroCount: diag.svdZeroCount, conditionNumber: diag.conditionNumber },
    });
  }

  // --- parameterization (data support) -----------------------------------
  const nFree = parameters.filter((p) => !p.fixed && !p.expression).length;
  if (nFree > 0 && observationCount > 0) {
    const ratio = observationCount / nFree;
    if (ratio < 10) {
      findings.push({
        category: "parameterization",
        severity: ratio < 5 ? "warning" : "note",
        summary: `Only ${ratio.toFixed(1)} observations per free parameter (${nFree} free / ${observationCount} obs).`,
        detail: "Thin data-to-parameter support inflates esds and invites over-fitting. Free fewer parameters per stage, or acquire more data / a wider range.",
        evidence: { freeParameters: nFree, observations: observationCount, ratio },
      });
    }
  }

  // --- unexplained residual: the discovery signal ------------------------
  if (input.residual) {
    const { d, yObs, yCalc } = input.residual;
    const peaks = detectExtraPeaks(d, yObs, yCalc);
    if (peaks.length > 0) {
      const ds = peaks.slice(0, 8).map((p) => p.d.toFixed(3));
      findings.push({
        category: "residual",
        severity: peaks.length >= 3 ? "warning" : "note",
        summary: `${peaks.length} unexplained peak${peaks.length === 1 ? "" : "s"} in the positive residual (obs > calc) at d ≈ ${ds.join(", ")} Å.`,
        detail: "Intensity the model does not account for. In order of likelihood: an impurity or secondary crystallographic phase, magnetic Bragg peaks (if magnetic ions are present — try a k-search), or unmodelled peak-shape/asymmetry. This is where new materials physics hides.",
        evidence: { peakCount: peaks.length, dSpacings: ds.join(", ") },
      });
    }
  }

  findings.sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);

  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const attention = critical + warnings;
  const summary =
    `${verdict.band.toUpperCase()} fit` +
    (verdict.gof !== undefined ? ` (GoF ${verdict.gof.toFixed(2)}` + (verdict.wRPercent !== undefined ? `, wR ${verdict.wRPercent.toFixed(2)}%)` : ")") : "") +
    (attention === 0 ? " — no issues flagged." : ` — ${attention} item${attention === 1 ? "" : "s"} need attention (${critical} critical, ${warnings} warning).`);

  return { verdict, findings, summary };
}

// ---------------------------------------------------------------------------

export interface NextStep {
  /** Imperative action for the agent to take or propose. */
  readonly action: string;
  /** Why — the finding or state that motivates it. */
  readonly rationale: string;
  /** 1 = do this first. Lower is more urgent. */
  readonly priority: number;
  /** The finding categories this step responds to. */
  readonly addresses: readonly FindingCategory[];
}

/**
 * Turn an assessment into a ranked set of next actions — the "decide" step of
 * the expert loop. Deterministic; the agent chooses whether to take, adapt, or
 * skip each. Nothing here invents parameter values — it sequences the
 * constrained refinement, matching the guardrail in docs/AGENT_TOOLS.md.
 */
export function suggestNextSteps(assessment: RefinementAssessment): NextStep[] {
  const steps: NextStep[] = [];
  const has = (c: FindingCategory): AssessmentFinding | undefined => assessment.findings.find((f) => f.category === c);
  const band = assessment.verdict.band;

  const physical = assessment.findings.find((f) => f.category === "physical" && f.severity === "critical");
  if (physical) {
    steps.push({
      action: `Fix ${physical.parameterIds?.[0] ?? "the offending parameter"} at a physical value and re-refine, then trace the upstream cause (scale, background, or scattering type).`,
      rationale: physical.summary,
      priority: 1,
      addresses: ["physical"],
    });
  }

  const atBound = assessment.findings.find((f) => f.category === "at-bound");
  if (atBound) {
    steps.push({
      action: `Hold ${atBound.parameterIds?.[0] ?? "the at-bound parameter"} fixed and re-refine; free it again only once the correlated quantities are stable.`,
      rationale: atBound.summary,
      priority: 2,
      addresses: ["at-bound"],
    });
  }

  const corr = has("correlation");
  if (corr && (corr.severity === "warning")) {
    steps.push({
      action: `Break the ${corr.parameterIds?.join(" ↔ ") ?? "correlated"} degeneracy: refine them in separate stages, reduce background terms, or fix one.`,
      rationale: corr.summary,
      priority: 3,
      addresses: ["correlation", "conditioning"],
    });
  }

  const residual = has("residual");
  if (residual) {
    steps.push({
      action: "Investigate the unexplained peaks: add a candidate impurity/secondary phase (multi-phase), or — if magnetic ions are present — run a k-search for magnetic order at those d-spacings.",
      rationale: residual.summary,
      priority: 4,
      addresses: ["residual"],
    });
  }

  const paramzn = has("parameterization");
  if (paramzn && paramzn.severity === "warning") {
    steps.push({
      action: "Reduce the number of freed parameters this stage (or widen the data range) so each parameter is supported by the data.",
      rationale: paramzn.summary,
      priority: 5,
      addresses: ["parameterization"],
    });
  }

  // When the fit is sound, point at validation and the next physically-motivated
  // model extension rather than more of the same.
  if ((band === "excellent" || band === "good") && !physical && !atBound) {
    steps.push({
      action: "Validate before extending: check the F_obs/F_calc and normal-probability plots for structure the wR hides; then consider anisotropic ADPs or the next physically-motivated parameter.",
      rationale: `${assessment.verdict.rationale}`,
      priority: residual ? 6 : 3,
      addresses: ["fit-quality"],
    });
  }

  if (band === "poor" || band === "unreliable") {
    steps.push({
      action: "Step back to the basics before freeing more: confirm the starting cell and zero, fit scale + background first, then the profile — refine in stages, not all at once.",
      rationale: assessment.verdict.rationale,
      priority: 1.5,
      addresses: ["fit-quality"],
    });
  }

  steps.sort((a, b) => a.priority - b.priority);
  return steps;
}
