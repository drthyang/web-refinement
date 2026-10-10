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
  LinearRestraint,
  RefinementParameter,
  RefinementResult,
  ParameterKind,
} from "@/core/refinement/types";
import { annotateExtraPeaks, detectExtraPeaks, type AnnotatedExtraPeak } from "@/core/magnetic/extraPeaks";
import { correctionCorrelation } from "@/core/diffraction/corrections";

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
  | "residual"
  | "misfit";

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
    /** Each point's standard uncertainty: a residual peak must stand above its
     *  own counting noise, so a noisy low-count region does not read as peaks. */
    readonly sigma?: readonly number[];
    /** Every phase's reflections (refined cells): a residual peak on one is a
     *  misfit of that reflection, not intensity no phase accounts for. */
    readonly reflections?: readonly { readonly d: number; readonly hkl: string; readonly phaseLabel: string }[];
    /** A neutron pattern of a phase with magnetic ions: excess on nuclear
     *  reflections at large d may then be k = 0 magnetic order. */
    readonly magneticNeutron?: boolean;
  };
  readonly mode?: "powder" | "single-crystal" | "pdf";
  /** The restraints the fit ran with: two parameters in one move together by
   *  construction, so their correlation is noted once, not warned about. */
  readonly restraints?: readonly LinearRestraint[];
  /** Displacement parameters of sites several atoms share (a mixed site): at a
   *  bound, the mixing is the first suspect. */
  readonly sharedSiteAdps?: readonly string[];
}

/**
 * Shift/esd of the last step (`maxShiftOverEsd`). Below SHIFT_SETTLED the
 * parameters have settled by the crystallographic convention. Above
 * SHIFT_MOVING a parameter moved by more than its own esd, so its quoted value
 * is not yet the minimum.
 */
const SHIFT_SETTLED = 0.1;
const SHIFT_MOVING = 1;

/** Displacement-parameter kinds, for physical (negative-ADP) checks. */
const ADP_KINDS: ReadonlySet<ParameterKind> = new Set(["bIso", "uAniso"]);

/**
 * Known dangerous correlation pairs → the physical reason they correlate.
 * Keyed by the unordered pair of kinds. This is where refiner folklore becomes
 * machine-readable: the agent gets *why* a correlation is expected and what to do.
 */
export function correlationInsight(a: ParameterKind, b: ParameterKind): string | undefined {
  const pair = new Set<ParameterKind>([a, b]);
  const has = (x: ParameterKind, y: ParameterKind): boolean => pair.has(x) && pair.has(y);
  if (has("scale", "background")) return "The overall scale and the background are trading intensity — a flexible background can soak up peak intensity. Reduce background terms, or refine scale with the background fixed first.";
  if (has("scale", "bIso")) return "Scale and isotropic B correlate through the overall fall-off of intensity with angle. Fix one (usually B) until the scale and cell are stable.";
  if (has("scale", "occupancy")) return "Scale and site occupancy are near-degenerate on a single site (both multiply intensity). Constrain occupancy (e.g. full, or a Σ=1 tie) unless a second contrast breaks the tie.";
  if (has("cellLength", "zeroShift")) return "Cell length and zero shift both move peak positions; they separate only across a wide 2θ/TOF range. Refine the zero from a well-characterized standard, or fix it.";
  if (has("profileU", "profileV") || has("profileV", "profileW") || has("profileU", "profileW")) return "The Caglioti U/V/W parameterize one FWHM²(θ) curve, so they trade off by construction; the curve is what the data determine. Refine W first, then U and V once the peaks are fitted across the range.";
  if (has("profileX", "profileY")) return "The Lorentzian X (size, 1/cosθ) and Y (strain, tanθ) widths differ only in how they grow with angle, so over a short or low-angle range they describe the same broadening. Refine Y (or X) alone, and free the other only with data to high angle.";
  if (has("mustrainPerp", "mustrainPar") || has("anisoSizePerp", "anisoSizePar")) return "Anisotropic microstructure components correlate along directions the data barely resolves. Free them only after the isotropic profile has converged.";
  // Time of flight: the back-to-back-exponential rise (α) moves each peak apex
  // along TOF, as a uniform cell change or the calibration does.
  if (has("tofProfile", "cellLength") || has("tofProfile", "tofCalibration") || has("tofProfile", "zeroShift")) return "A TOF profile term (the rise-time α above all) moves each peak apex along TOF, as a uniform cell change or the difC/zero calibration does, so the data cannot separate them. Take α from the instrument calibration and keep it fixed; refine the widths (σ) and the decay (β) instead.";
  // Real space (PDF): the peak-sharpening and envelope terms.
  if (has("delta1", "delta2")) return "δ1 and δ2 both sharpen the near-neighbour peaks (the 1/r and 1/r² correlated-motion terms). Refine one: δ2 at low temperature, δ1 at high temperature.";
  if (has("sratio", "delta1") || has("sratio", "delta2") || has("rcut", "delta1") || has("rcut", "delta2")) return "sratio/rcut is the other correlated-motion model; it describes the same peak sharpening as δ1/δ2. Use one model, never both.";
  if (has("pdfScale", "spdiameter")) return "The particle-size envelope and the scale both set the amplitude of G(r) over a short r window. Refine spdiameter only for nanoparticles, over an r range that reaches the particle size.";
  // Correction-owned correlations (displacement/transparency/roughness vs. cell,
  // zero, scale, background) live on their registry descriptors.
  const fromCorrection = correctionCorrelation(a, b);
  if (fromCorrection) return fromCorrection;
  return undefined;
}

const CAGLIOTI: ReadonlySet<ParameterKind> = new Set<ParameterKind>(["profileU", "profileV", "profileW"]);

/**
 * Two parameters of one curve in a correlated basis: the background
 * coefficients, or the Caglioti U, V, W of one FWHM²(θ). The terms trade off by
 * construction while the curve itself is determined, and no coefficient is a
 * result anyone reports, so their mutual correlation is expected (the data's
 * null directions are caught apart, by the SVD).
 */
export function oneCurve(a: ParameterKind | undefined, b: ParameterKind | undefined): "background" | "caglioti" | null {
  if (a === "background" && b === "background") return "background";
  if (a && b && CAGLIOTI.has(a) && CAGLIOTI.has(b)) return "caglioti";
  return null;
}

const ONE_CURVE_NOTE = {
  background: {
    summary: (top: string) => `The background coefficients correlate among themselves (up to ${top}).`,
    detail: "Expected for a polynomial background: its terms trade off, while the background curve itself is determined. Their individual esds mean little; nothing to fix unless a background term also correlates with the scale or a structural parameter.",
  },
  caglioti: {
    summary: (top: string) => `The Caglioti U, V, W correlate among themselves (up to ${top}).`,
    detail: "Expected: they parameterize one FWHM²(θ) = U tan²θ + V tanθ + W, which the data determine across the angular range while the coefficients trade off. Their individual esds mean little; nothing to fix unless one also correlates with a structural parameter.",
  },
} as const;

/** Why excess intensity on nuclear reflections may be magnetic, for a neutron pattern of a phase with magnetic ions. */
export const K0_MAGNETIC =
  "This is a neutron pattern of a phase with magnetic ions, and the excess sits on nuclear reflections at large d: if the sample can be magnetically ordered at this temperature, that is the k = 0 magnetic signature (magnetic intensity on the nuclear positions, fading with the form factor at small d). Check it with the Magnetic analysis step before refining atoms or ADPs into it.";

/** On-reflection excess that may be k = 0 magnetic: neutrons, magnetic ions, and most of it at d > 2.5 Å. */
export function k0MagneticHint(magneticNeutron: boolean | undefined, onReflection: readonly { readonly d: number }[]): boolean {
  if (!magneticNeutron || onReflection.length === 0) return false;
  return onReflection.filter((p) => p.d > 2.5).length * 2 >= onReflection.length;
}

/** Within this of a reflection (relative d), a residual peak is that reflection's misfit. */
const ON_REFLECTION = 0.005;
/** Within this, it is beside one: a shoulder or a profile tail (a TOF peak's tail runs to larger d). */
const BESIDE_REFLECTION = 0.02;

/**
 * Residual peaks, split by where they sit: on a known reflection (a misfit of
 * its intensity), beside one (a shoulder or tail: the profile first, or a
 * nearby impurity peak), or between reflections (unexplained). With per-point
 * σ, a peak must also stand 5σ above its own counting noise.
 */
export function residualPeaks(residual: NonNullable<AssessmentInput["residual"]>, options: { readonly sigma?: number; readonly limit?: number } = {}): {
  between: AnnotatedExtraPeak[];
  beside: AnnotatedExtraPeak[];
  onReflection: AnnotatedExtraPeak[];
} {
  const { d, yObs, yCalc, sigma, reflections } = residual;
  const peaks = detectExtraPeaks(d, yObs, yCalc, {
    ...(sigma ? { pointSigma: sigma } : {}),
    ...(options.sigma !== undefined ? { sigma: options.sigma } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const annotated: AnnotatedExtraPeak[] = reflections ? annotateExtraPeaks(peaks, reflections, BESIDE_REFLECTION) : [...peaks];
  const rel = (p: AnnotatedExtraPeak): number => p.nearNuclear?.relDelta ?? Infinity;
  return {
    between: annotated.filter((p) => rel(p) > BESIDE_REFLECTION),
    beside: annotated.filter((p) => rel(p) > ON_REFLECTION && rel(p) <= BESIDE_REFLECTION),
    onReflection: annotated.filter((p) => rel(p) <= ON_REFLECTION),
  };
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
 * Physical sanity of the parameter values: negative displacement parameters
 * and occupancies outside [0, 1]. Needs no refinement result, so the
 * Validation view can run it on the current values. A held parameter never
 * moved, so its value is an input (starting structure or CIF): word it that
 * way and do not blame the fit for it.
 */
export function physicalFindings(parameters: readonly RefinementParameter[]): AssessmentFinding[] {
  const findings: AssessmentFinding[] = [];
  for (const p of parameters) {
    if (ADP_KINDS.has(p.kind) && p.value < 0) {
      const what = PHYSICAL_LABEL[p.kind] ?? "displacement parameter";
      findings.push({
        category: "physical",
        severity: "critical",
        summary: p.fixed
          ? `${p.label} is held at ${p.value.toFixed(4)}, negative — an unphysical ${what}.`
          : `${p.label} refined negative (${p.value.toFixed(4)}) — an unphysical ${what}.`,
        detail: p.fixed
          ? "This value was not refined; it comes from the starting structure or CIF. A negative ADP has no physical meaning — correct the input to a small positive value, or constrain it, before refining."
          : "A negative ADP has no physical meaning; it typically absorbs an error elsewhere (scale, background, absorption, or a wrong scattering type). Fix it at a small positive value and address the real cause.",
        parameterIds: [p.id],
        evidence: { value: p.value, origin: p.fixed ? "input" : "refined" },
      });
    }
    if ((p.kind === "profileX" || p.kind === "profileY") && p.value < -1e-6 && !p.fixed) {
      const what = p.kind === "profileX" ? "size (Lorentzian X)" : "microstrain (Lorentzian Y)";
      findings.push({
        category: "physical",
        severity: "warning",
        summary: `${p.label} refined negative (${p.value.toFixed(3)}): a negative ${what} has no physical meaning.`,
        detail: "It narrows the peaks below the Gaussian width, compensating Caglioti U, V, W that make them too broad (or a wrong peak-shape mix). Fix it at 0 and refine U, V, W, then free it again; quote no size or strain from it.",
        parameterIds: [p.id],
        evidence: { value: p.value },
      });
    }
    if (p.kind === "occupancy" && (p.value < -1e-6 || p.value > 1 + 1e-6)) {
      findings.push({
        category: "physical",
        severity: "warning",
        summary: p.fixed
          ? `${p.label} is held at ${p.value.toFixed(4)}, outside [0, 1].`
          : `${p.label} refined to ${p.value.toFixed(4)}, outside [0, 1].`,
        detail: p.fixed
          ? "This value was not refined; it comes from the starting structure or CIF. Correct the input occupancy to its physical range, or constrain it (full site, or a Σ=1 tie)."
          : "Occupancy outside its physical range points to a scale/occupancy correlation or the wrong site multiplicity. Constrain it (full site, or a Σ=1 tie) unless a second contrast justifies the value.",
        parameterIds: [p.id],
        evidence: { value: p.value, origin: p.fixed ? "input" : "refined" },
      });
    }
  }
  return findings;
}

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
  // Shift/esd of the last accepted step. The χ² test alone bounds it only by
  // about √(tolerance·N), so a long pattern can pass that test with a
  // parameter still moving by a sizeable fraction of its esd, or more.
  const shift = diag?.maxShiftOverEsd ?? 0;
  if (result.status === "converged" && shift > SHIFT_SETTLED) {
    const id = diag?.maxShiftParameterId;
    const name = id ? byId.get(id)?.label ?? id : "a parameter";
    const moving = shift > SHIFT_MOVING;
    findings.push({
      category: "convergence",
      severity: moving ? "warning" : "note",
      summary: moving
        ? `Converged on χ² while ${name} was still moving: the last step shifted it by ${shift.toFixed(2)} esd.`
        : `${name} had not fully settled: the last step shifted it by ${shift.toFixed(2)} esd (settled is < ${SHIFT_SETTLED}).`,
      detail: moving
        ? "A parameter moved by more than its own esd on the final step, so its value ± esd does not yet describe the minimum. χ² flattened first, which is typical of a shallow or correlated direction, where steps zig-zag across a narrow valley. Refine more cycles from these values; if it keeps moving, find the correlation behind it or fix the parameter."
        : "By the crystallographic convention a refinement has converged when every shift is below a tenth of its esd. Refine a few more cycles before quoting final values. If another cycle moves it by about as much again, it lies along a flat direction the data barely determine (often a minor phase's ADP or a weak profile term): fix it rather than cycling.",
      ...(id ? { parameterIds: [id] } : {}),
      evidence: { maxShiftOverEsd: shift, ...(id ? { parameterId: id } : {}) },
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
        ? input.sharedSiteAdps?.includes(b.parameterId)
          ? `This displacement parameter belongs to a site several atoms share, so the site's scattering power is the first suspect: ${b.bound === "min" ? "B → 0 makes up for a site that scatters more than the model puts on it" : "a large B makes up for a site that scatters less than the model puts on it"}, i.e. the mixing is off (anti-site disorder, spinel inversion). Refine the site's occupancies with its Σ held (and the composition, when the formula is known) before trusting the ADP.`
          : input.mode === "pdf"
          ? "In real space a displacement parameter at 0 usually means the near-neighbour peaks are sharper than the model's: correlated motion sharpens them, and with δ1/δ2 (or sratio) held, U takes up the sharpening. Free one correlated-motion term (δ2 at low temperature, δ1 at high), or fit a window long enough to pin U, rather than trusting the value. In a short low-r window it can also mean the local structure differs from the model."
          : "A displacement parameter pinned at a bound (often B→0) usually means the model is over-damping high-angle intensity — check the background, an absorption/extinction effect, or a correlation, rather than trusting the value."
        : "A free parameter at a bound has a meaningless esd and signals the fit wanted to go where physics forbids — hold it fixed and find the upstream cause (correlation, wrong background, bad starting value).",
      parameterIds: [b.parameterId],
      evidence: { bound: b.bound, value: b.value },
    });
  }

  // --- physical sanity of the values ------------------------------------
  findings.push(...physicalFindings(parameters));

  // --- correlations ------------------------------------------------------
  // The terms of one curve (the background, the Caglioti width) trade off by
  // construction and say nothing about the curve: one note per curve, not a
  // warning per pair.
  const curveOf = (c: { parameterIdA: string; parameterIdB: string }) => oneCurve(byId.get(c.parameterIdA)?.kind, byId.get(c.parameterIdB)?.kind);
  // Two parameters in one restraint move together by construction.
  const restraints = input.restraints ?? [];
  const tiedBy = (c: { parameterIdA: string; parameterIdB: string }) =>
    restraints.find((r) => r.terms.some((t) => t.parameterId === c.parameterIdA) && r.terms.some((t) => t.parameterId === c.parameterIdB));
  const tiedPairs = (diag?.highCorrelations ?? []).filter((c) => !curveOf(c) && tiedBy(c));
  if (tiedPairs.length > 0) {
    const top = Math.max(...tiedPairs.map((c) => Math.abs(c.coefficient)));
    findings.push({
      category: "correlation",
      severity: "info",
      summary: `Parameters tied by a restraint correlate (up to ${top.toFixed(3)}): ${[...new Set(tiedPairs.map((c) => tiedBy(c)!.label))].join("; ")}.`,
      detail: "Expected: the restraint moves them together, and the data decide only what it leaves free (for a mixed site with its Σ and the composition held, the exchange fraction). Read that quantity's esd, not each occupancy's.",
      parameterIds: [...new Set(tiedPairs.flatMap((c) => [c.parameterIdA, c.parameterIdB]))],
      evidence: { pairs: tiedPairs.length, maxCoefficient: top },
    });
  }
  for (const curve of ["background", "caglioti"] as const) {
    const pairs = (diag?.highCorrelations ?? []).filter((c) => curveOf(c) === curve);
    if (pairs.length === 0) continue;
    const top = Math.max(...pairs.map((c) => Math.abs(c.coefficient)));
    findings.push({
      category: "correlation",
      severity: "info",
      summary: ONE_CURVE_NOTE[curve].summary(top.toFixed(3)),
      detail: ONE_CURVE_NOTE[curve].detail,
      parameterIds: [...new Set(pairs.flatMap((c) => [c.parameterIdA, c.parameterIdB]))],
      evidence: { pairs: pairs.length, maxCoefficient: top },
    });
  }
  for (const c of diag?.highCorrelations ?? []) {
    if (curveOf(c) || tiedBy(c)) continue;
    const a = byId.get(c.parameterIdA);
    const b = byId.get(c.parameterIdB);
    const insight = a && b ? correlationInsight(a.kind, b.kind) : undefined;
    const abs = Math.abs(c.coefficient);
    findings.push({
      category: "correlation",
      severity: abs > 0.95 ? "warning" : "note",
      // Three places near ±1, where two would round 0.995 up to a perfect 1.00.
      summary: `${a?.label ?? c.parameterIdA} ↔ ${b?.label ?? c.parameterIdB} correlate at ${c.coefficient.toFixed(abs >= 0.99 ? 3 : 2)}.`,
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
    const { between, beside, onReflection } = residualPeaks(input.residual);
    if (between.length > 0) {
      const ds = between.slice(0, 8).map((p) => p.d.toFixed(3));
      findings.push({
        category: "residual",
        severity: between.length >= 3 ? "warning" : "note",
        summary: `${between.length} unexplained peak${between.length === 1 ? "" : "s"} in the positive residual (obs > calc)${input.residual.reflections ? ", away from every phase's reflections," : ""} at d ≈ ${ds.join(", ")} Å.`,
        detail: "Intensity the model does not account for. In order of likelihood: an impurity or secondary crystallographic phase, magnetic Bragg peaks (if magnetic ions are present — try a k-search), or unmodelled peak-shape/asymmetry. This is where new materials physics hides.",
        evidence: { peakCount: between.length, dSpacings: ds.join(", ") },
      });
    }
    if (onReflection.length + beside.length > 0) {
      const name = (p: (typeof onReflection)[number]): string => `${p.nearNuclear!.phaseLabel} ${p.nearNuclear!.hkl}`;
      const on = onReflection.slice(0, 6).map((p) => `${name(p)} (d ${p.d.toFixed(3)})`);
      const by = beside.slice(0, 6).map((p) => `d ${p.d.toFixed(3)} beside ${name(p)} (${((p.d / p.nearNuclear!.d - 1) * 100).toFixed(1)}% in d)`);
      findings.push({
        category: "misfit",
        severity: "note",
        summary: [
          on.length ? `${onReflection.length} residual peak${onReflection.length === 1 ? " sits" : "s sit"} on known reflections: ${on.join(", ")}` : null,
          by.length ? `${beside.length} beside one: ${by.join(", ")}` : null,
        ].filter(Boolean).join("; ") + ".",
        detail: (k0MagneticHint(input.residual.magneticNeutron, onReflection) ? K0_MAGNETIC + " " : "") +
          "On a reflection, the reflection is calculated too weak — a misfit of its intensity: the atoms (positions, ADPs, occupancy constraints) or an intensity correction. Beside one, within 2% in d, it is most often the peak's shoulder or tail — the profile (TOF peaks tail to larger d) — and only then a weak peak of another phase. Refine those per the method before reading anything new into them: they are misfits, not extra peaks, and no reason to change the space group.",
        evidence: { onReflection: onReflection.length, beside: beside.length, reflections: [...on, ...by].join("; ") },
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
    const target = physical.parameterIds?.[0] ?? "the offending parameter";
    steps.push({
      action: physical.evidence?.origin === "input"
        ? `Correct ${target} in the starting structure to a physical value, then re-refine.`
        : `Fix ${target} at a physical value and re-refine, then trace the upstream cause (scale, background, or scattering type).`,
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

  const misfit = has("misfit");
  if (misfit && !has("residual")) {
    steps.push({
      action: "Fit the misfit reflections before looking for anything new: refine what sets their intensities (positions, ADPs) or their shape (the profile), in the method's order.",
      rationale: misfit.summary,
      priority: 5,
      addresses: ["misfit"],
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
      action: "Validate before extending: check the Validation view (normalized residual, Durbin–Watson, worst peaks or the intensity bins) for structure the wR hides; then consider anisotropic ADPs or the next physically-motivated parameter.",
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
