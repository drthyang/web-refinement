/**
 * The Validation view's verdict: the checks a refiner runs before trusting a
 * fit, each as one line with a status. Built from the validation statistics
 * (powderValidation / singleCrystalValidation), the current parameters, and the
 * last refinement's diagnostics, so the powder and single-crystal views share
 * one grammar while each keeps its own tests.
 *
 * Statuses: "ok" passes; "note" is worth a look; "warn" should be resolved
 * before quoting the result; "critical" makes the numbers unquotable; "info"
 * is context (not run yet, not checked here, a next step).
 */

import type { RefinementParameter, RefinementResult } from "@/core/refinement/types";
import { physicalFindings } from "@/core/diagnostics/assessment";
import type { PowderValidation, UnindexedPeak } from "@/core/diagnostics/powderValidation";
import type { ScValidation } from "@/core/diagnostics/singleCrystalValidation";

export type CheckStatus = "ok" | "note" | "warn" | "critical" | "info";

/** A UI hook a check can offer (the view decides what it does). */
export type CheckAction = "show-unindexed" | "export-gsas2" | "export-fullprof" | "posterior";

export interface ValidationCheck {
  readonly id: string;
  readonly status: CheckStatus;
  /** The bold lead: what was checked and its value. */
  readonly title: string;
  /** What it means / what to do. */
  readonly detail?: string;
  readonly actions?: readonly CheckAction[];
}

export interface ValidationVerdict {
  readonly checks: readonly ValidationCheck[];
  /** Headline for the chip beside "Verdict". */
  readonly headline: string;
  /** The chip's tone: the worst status among the checks. */
  readonly tone: "ok" | "note" | "warn";
}

const RANK: Record<CheckStatus, number> = { info: 0, ok: 1, note: 2, warn: 3, critical: 4 };

/** Above this |r| a correlation is worth naming (the engine reports from 0.95 by default). */
const CORRELATION_NOTE = 0.95;

function fmt(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
}

/** True when the current values have moved away from the last refinement's. */
export function parametersChangedSince(result: RefinementResult, parameters: readonly RefinementParameter[]): boolean {
  for (const p of parameters) {
    if (p.fixed || p.expression) continue;
    const r = result.parameters[p.id];
    if (r === undefined) return true;
    if (Math.abs(r - p.value) > 1e-9 * Math.max(1, Math.abs(r))) return true;
  }
  return false;
}

function labelOf(parameters: readonly RefinementParameter[], id: string): string {
  return parameters.find((p) => p.id === id)?.label ?? id;
}

/** The goodness-of-fit line, banded per Toby (2006); below 1 is a warning sign, not a win. */
function gofCheck(gof: number, name: string, okMax: number, extra?: string): ValidationCheck {
  const value = `${name} ${fmt(gof)}`;
  if (!(gof > 0)) return { id: "gof", status: "info", title: `${name} —`, detail: "no fitted points" };
  if (gof < 0.8 || (gof < 1 && name === "GoF")) {
    return {
      id: "gof", status: "note", title: value,
      detail: "below 1: the σ's are over-estimated or the model has more parameters than the data support, so the esds are optimistic",
    };
  }
  if (gof <= okMax) return { id: "gof", status: "ok", title: value, detail: extra ?? "close to the statistical floor" };
  if (gof <= okMax + 1) return { id: "gof", status: "note", title: value, detail: extra ?? "residual structure the model does not capture" };
  if (gof <= okMax + 2.5) return { id: "gof", status: "warn", title: value, detail: extra ?? "significant unmodelled features" };
  return { id: "gof", status: "critical", title: value, detail: extra ?? "the model is far from the data" };
}

function convergenceCheck(result: RefinementResult | null, parameters: readonly RefinementParameter[]): ValidationCheck {
  if (!result) return { id: "convergence", status: "info", title: "Not refined yet", detail: "refine to get convergence, esds and correlations" };
  if (result.status !== "converged") {
    return {
      id: "convergence", status: result.status === "diverged" ? "critical" : "warn",
      title: `Refinement ${result.status}`, detail: "treat the values as provisional",
    };
  }
  if (parametersChangedSince(result, parameters)) {
    return { id: "convergence", status: "note", title: "Edited since the last refinement", detail: "refine again before quoting values or esds" };
  }
  const shift = result.diagnostics?.maxShiftOverEsd ?? 0;
  const who = result.diagnostics?.maxShiftParameterId ? ` (${labelOf(parameters, result.diagnostics.maxShiftParameterId)})` : "";
  const cycles = `${result.history.length} cycle${result.history.length === 1 ? "" : "s"}`;
  if (shift > 1) return { id: "convergence", status: "warn", title: `Still moving — max shift/esd ${fmt(shift)}${who}`, detail: "refine more cycles; the value ± esd is not yet the minimum" };
  if (shift > 0.1) return { id: "convergence", status: "note", title: `Nearly settled — max shift/esd ${fmt(shift)}${who}`, detail: "settled is below 0.1; refine a few more cycles" };
  return { id: "convergence", status: "ok", title: "Converged", detail: `max shift/esd ${fmt(shift, shift < 0.01 ? 3 : 2)}${who}, ${cycles}` };
}

function physicalCheck(result: RefinementResult | null, parameters: readonly RefinementParameter[], nonPdSites: readonly string[] = []): ValidationCheck {
  const physical = physicalFindings(parameters);
  const atBounds = result && !parametersChangedSince(result, parameters) ? result.diagnostics?.atBounds ?? [] : [];
  const problems = [
    ...physical.map((f) => f.summary.replace(/\.$/, "")),
    ...nonPdSites.map((l) => `${l}: anisotropic U not positive-definite`),
    ...atBounds.map((b) => `${labelOf(parameters, b.parameterId)} at its ${b.bound} bound`),
  ];
  if (problems.length === 0) {
    return { id: "physical", status: "ok", title: "Physically sane", detail: "displacement parameters positive, occupancies in [0, 1], nothing at a bound" };
  }
  const critical = physical.some((f) => f.severity === "critical") || nonPdSites.length > 0;
  return {
    id: "physical", status: critical ? "critical" : "warn",
    title: problems.length === 1 ? "Unphysical value" : `${problems.length} unphysical values`,
    detail: problems.slice(0, 3).join(" · ") + (problems.length > 3 ? " …" : ""),
  };
}

function correlationChecks(result: RefinementResult | null, parameters: readonly RefinementParameter[]): ValidationCheck[] {
  if (!result || parametersChangedSince(result, parameters)) return [];
  const d = result.diagnostics;
  if (!d) return [];
  const out: ValidationCheck[] = [];
  const pairs = d.highCorrelations.filter((c) => Math.abs(c.coefficient) >= CORRELATION_NOTE);
  if (pairs.length > 0) {
    const shown = pairs.slice(0, 2).map((c) => `${labelOf(parameters, c.parameterIdA)} / ${labelOf(parameters, c.parameterIdB)} ${fmt(c.coefficient)}`);
    out.push({
      id: "correlation",
      status: pairs.some((c) => Math.abs(c.coefficient) > 0.98) ? "warn" : "note",
      title: `${pairs.length} correlation${pairs.length === 1 ? "" : "s"} above ${CORRELATION_NOTE}`,
      detail: shown.join(" · ") + (pairs.length > 2 ? " …" : ""),
    });
  }
  if (d.svdZeroCount > 0) {
    out.push({
      id: "conditioning", status: "warn",
      title: `${d.svdZeroCount} undetermined direction${d.svdZeroCount === 1 ? "" : "s"}`,
      detail: `the data cannot separate ${d.singularParameterIds.slice(0, 3).map((id) => labelOf(parameters, id)).join(", ")} — fix or tie one`,
    });
  }
  return out;
}

export function verdictFrom(checks: ValidationCheck[]): ValidationVerdict {
  const counts = { critical: 0, warn: 0, note: 0 };
  for (const c of checks) if (c.status === "critical" || c.status === "warn" || c.status === "note") counts[c.status]++;
  const worst = checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "info");
  const toCheck = counts.warn + counts.note;
  const headline = counts.critical > 0
    ? `Not reliable yet · ${counts.critical} to fix${toCheck > 0 ? `, ${toCheck} to check` : ""}`
    : toCheck > 0
      ? `${toCheck} thing${toCheck === 1 ? "" : "s"} to check`
      : "Nothing flagged";
  return { checks, headline, tone: worst === "critical" || worst === "warn" ? "warn" : worst === "note" ? "note" : "ok" };
}

export interface PowderCheckInput {
  readonly validation: PowderValidation;
  readonly unindexed: readonly UnindexedPeak[];
  readonly result: RefinementResult | null;
  readonly parameters: readonly RefinementParameter[];
  /** Offer the cross-check exports. */
  readonly canExport?: boolean;
}

/** The powder verdict, most important first. */
export function powderChecks(input: PowderCheckInput): ValidationVerdict {
  const { validation: v, unindexed, result, parameters } = input;
  const checks: ValidationCheck[] = [];
  checks.push(gofCheck(v.agreement.gof, "GoF", 1.5, undefined));
  if (checks[0]!.status === "ok") checks[0] = { ...checks[0]!, detail: `close to the statistical floor (χ²ᵥ ${fmt(v.agreement.chi2nu)})` };
  checks.push(convergenceCheck(result, parameters));
  checks.push(physicalCheck(result, parameters));
  const dw = v.durbinWatson;
  if (dw) {
    checks.push(dw.correlated
      ? {
          id: "durbin-watson", status: "warn",
          title: "Residuals are serially correlated",
          detail: `Durbin–Watson ${fmt(dw.d)} < Q_D ${fmt(dw.qd)}: neighbouring points miss together — a systematic profile misfit, and the esds are optimistic`,
        }
      : { id: "durbin-watson", status: "ok", title: "No serial correlation", detail: `Durbin–Watson ${fmt(dw.d)} ≥ Q_D ${fmt(dw.qd)}` });
  }
  if (unindexed.length > 0) {
    const share = unindexed.reduce((a, p) => a + p.share, 0);
    checks.push({
      id: "unindexed", status: "warn",
      title: unindexed.length === 1 ? `Unindexed peak at d ${fmt(unindexed[0]!.d, 3)} Å` : `${unindexed.length} unindexed peaks`,
      detail: `${unindexed.length > 1 ? `d ${unindexed.map((p) => fmt(p.d, 3)).join(", ")} Å · ` : ""}${fmt(100 * share, 1)}% of χ², no reflection of any phase there — a missing phase or an impurity?`,
      actions: ["show-unindexed"],
    });
  } else {
    checks.push({ id: "unindexed", status: "ok", title: "Every residual peak indexes", detail: "no positive residual away from the reflections" });
  }
  checks.push(...correlationChecks(result, parameters));
  if (input.canExport) {
    checks.push({ id: "cross-check", status: "info", title: "External cross-check", detail: "refine the same model in GSAS-II and FullProf and compare values and esds", actions: ["export-gsas2", "export-fullprof"] });
  }
  return verdictFrom(checks);
}

export interface SingleCrystalCheckInput {
  readonly validation: ScValidation;
  /** GooF of the current parameters over all reflections. */
  readonly goof: number;
  readonly result: RefinementResult | null;
  readonly parameters: readonly RefinementParameter[];
  /** Sites whose anisotropic U is not positive-definite. */
  readonly nonPositiveDefinite?: readonly string[];
  /** X-ray data (the Flack parameter matters for a non-centrosymmetric group). */
  readonly xray?: boolean;
}

/** The single-crystal verdict, most important first. */
export function singleCrystalChecks(input: SingleCrystalCheckInput): ValidationVerdict {
  const { validation: v, goof, result, parameters } = input;
  const checks: ValidationCheck[] = [];
  const ext = v.extinction;
  // With extinction, say how much of the GooF the strong reflections carry.
  const drivenByStrong = ext.suspected && v.goofWithoutStrongest !== undefined && goof - v.goofWithoutStrongest > 0.1;
  checks.push(gofCheck(goof, "GooF", 1.3, drivenByStrong ? `driven by the strongest reflections — ${fmt(v.goofWithoutStrongest!)} without them` : undefined));
  checks.push(convergenceCheck(result, parameters));

  const need = v.centrosymmetric ? 10 : 8;
  const ratio = v.reflectionsPerParameter;
  checks.push(ratio >= need
    ? { id: "data-parameter", status: "ok", title: `${fmt(ratio, 1)} reflections per parameter`, detail: `${v.uniqueObserved} unique; checkCIF asks ≥ ${need} for a ${v.centrosymmetric ? "centrosymmetric" : "non-centrosymmetric"} group` }
    : { id: "data-parameter", status: "warn", title: `Only ${fmt(ratio, 1)} reflections per parameter`, detail: `checkCIF asks ≥ ${need}: free fewer parameters or add restraints` });

  if (v.completeness !== undefined) {
    const c = v.completeness;
    const where = `to sinθ/λ ${fmt(v.sinThetaOverLambdaMax, 2)} Å⁻¹ (d ${fmt(v.dMin, 2)} Å)`;
    checks.push(c >= 0.95
      ? { id: "completeness", status: "ok", title: `${fmt(100 * c, 1)}% complete`, detail: where }
      : { id: "completeness", status: c >= 0.9 ? "note" : "warn", title: `Only ${fmt(100 * c, 1)}% complete`, detail: `${where}; missing reflections bias the ADPs and hide systematic errors` });
  }

  checks.push(physicalCheck(result, parameters, input.nonPositiveDefinite));

  if (ext.suspected) {
    checks.push({
      id: "extinction", status: "warn", title: "Extinction",
      detail: `K ${fmt(ext.strongBinK)} and GooF ${fmt(ext.strongBinGoof)} in the strongest bin; ${ext.strongUnder} of the ${ext.outliers} largest outliers are strong with Fo² < Fc². Refine the extinction parameter.`,
    });
  } else if (v.bins.length > 0) {
    checks.push({ id: "extinction", status: "ok", title: "Strong reflections agree", detail: `K ${fmt(ext.strongBinK)} in the strongest bin — no extinction signature` });
  }

  // Weighting: GooF should be flat across intensity. Leave out the strongest
  // bin when extinction already explains it.
  const goofs = (ext.suspected ? v.bins.slice(0, -1) : v.bins).map((b) => b.goof).filter((g) => g > 0);
  if (goofs.length >= 3) {
    const lo = Math.min(...goofs);
    const hi = Math.max(...goofs);
    checks.push(hi > 1.5 * lo && hi > 1.3
      ? { id: "weighting", status: "note", title: "GooF varies with intensity", detail: `${fmt(lo)} – ${fmt(hi)} across the bins; adjust the weighting scheme once the model is right` }
      : { id: "weighting", status: "ok", title: "Weights fit", detail: `GooF ${fmt(lo)} – ${fmt(hi)} across the intensity bins` });
  }

  // K with resolution (skip when extinction already accounts for low angle).
  if (!ext.suspected && v.shells.length >= 4) {
    const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const kLow = mean(v.shells.slice(0, 2).map((s) => s.k));
    const kHigh = mean(v.shells.slice(-2).map((s) => s.k));
    if (Math.abs(kLow - kHigh) > 0.08) {
      checks.push({ id: "k-trend", status: "note", title: "K drifts with resolution", detail: `${fmt(kLow)} at low angle → ${fmt(kHigh)} at high angle: ADPs, absorption or scattering factors` });
    }
  }

  checks.push(...correlationChecks(result, parameters));
  const notChecked = ["difference-Fourier residual density"];
  if (input.xray && !v.centrosymmetric) notChecked.push("the Flack parameter");
  checks.push({ id: "not-checked", status: "info", title: "Not checked here", detail: notChecked.join(", ") });
  return verdictFrom(checks);
}
