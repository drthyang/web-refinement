/**
 * The Agent tools on the single-crystal page: each reads the live state
 * through the page's port (port.ts) or calls the page's own handler, as on the
 * powder and PDF pages. A single-crystal fit is to integrated F²: its agreement
 * is SHELX's (R1 over Fo² > 2σ, wR2 and GooF over every reflection), the cell is
 * fixed input from indexing, and the data are judged before the model —
 * merging, resolution, completeness, the absences, the intensity statistics.
 */

import type { SingleCrystalAgentPort, SingleCrystalLiveState, SingleCrystalRow } from "@/agent/port";
import type { LiveToolSpec } from "@/agent/tools";
import type { ProjectHistory } from "@/core/project/history";
import { assess_refinement, bond_geometry } from "@/mcp/tools";
import type { ReferenceEntry } from "@/agent/references";
import { compareWithLoaded, structureTable, withEsd } from "@/agent/structureTable";
import { keyOfState, type AgentRecord } from "@/agent/method";
import { applyFree, bondEsds, bondsOf, uniqueBonds, cellOf, describeFree, freeNoOp, goToStep, historyView, matchIds, parameterSummary, pct, sig, type ChangeResult, type LiveToolHost } from "@/agent/liveCommon";
import type { RefinementResult } from "@/core/refinement/types";
import type { ReportCheck } from "@/core/export/report";
import { singleCrystalValidation, type ScValidation } from "@/core/diagnostics/singleCrystalValidation";
import { reflectionStatistics } from "@/core/diagnostics/reflectionStatistics";
import { canonicalKey, isCentrosymmetric, laueRotations, pointGroupRotations } from "@/core/diffraction/merge";
import { merohedralTwinLaws } from "@/core/diagnostics/twinLaws";
import { floatingOrigins, polarDirections } from "@/core/crystal/polarOrigin";
import { invertedModel } from "@/core/crystal/inversion";
import { isHydrogen, nonPositiveDefiniteSites } from "@/core/crystal/adp";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { dSpacing, reciprocalMetricTensor } from "@/core/crystal/unitCell";
import { AFIX, applyRiding, isRotating, ridingDistances, ridingRules, ridingSummary, sharedUGroups, type RidingOptions } from "@/core/crystal/riding";
import type { DistanceRestraint, RestrainedPair, RidingRule } from "@/core/crystal/types";
import { DEFAULT_RESTRAINT_SIGMA, nearestPair, restraintCount, restraintReport, restraintRows, restraintValues } from "@/core/crystal/restraints";
import { EXTINCTION_MODEL_LABELS, shelxWeights, suggestShelxWeighting, type WeightingSuggestion } from "@/core/diffraction/singleCrystalFactors";
import { improper, inResolution, isOmitted, mergedDataset, parsonsOfModel } from "@/core/workflow/singleCrystalRefinement";
import { INVERSION_TWIN, isInversion, mergedOnlyAbsences, type ExtinctionModel, type OmittedMeasurement, type ResolutionRange, type ShelxWeighting, type TwinLaw } from "@/core/diffraction/types";
import { dispersionLine } from "@/core/scattering/dispersion";
import { checkEqualTies, type EqualTieUpdate } from "@/core/refinement/constraints";
import { CORRELATION_LISTED, bondValenceCheck, boundsCheck, convergenceCheck, correlationsCheck, findingChecks, noResultCheck, verdictCheck } from "@/agent/reportChecks";
import { disorderAssemblies } from "@/agent/correlationCheck";

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are validated against the spec's zod schema before a handler runs */
type Input = any;

/** Run a read tool. Returns the JSON result the model sees. */
export function readSingleCrystalTool(name: string, input: Input, port: SingleCrystalAgentPort, host: LiveToolHost): unknown {
  const s = port.state();
  switch (name) {
    case "get_state":
      return stateView(s, host.history(), input.parameters);
    case "reflection_statistics":
      return statisticsView(s);
    case "reflection_equivalents":
      return equivalentsView(s, input.h, input.k, input.l);
    case "assess_refinement":
      return assessment(s, keptMeasurements(host.record(keyOfState("singleCrystal", s))));
    case "structure_table": {
      const table = structureTable(s.refinedStructure, 0, s.parameters, s.bindings, s.result?.esd ?? {});
      return {
        phases: [table],
        ...(input.against === "loaded" ? { againstLoaded: compareWithLoaded(table, s.refinedStructure, s.structure) } : {}),
        ...(s.result ? {} : { note: "No refinement on screen: the values carry no esds." }),
      };
    }
    case "bond_geometry":
      // With the refined positions' esds, each length's esd (the cell is fixed input here).
      return bondsOf([s.refinedStructure], input, bond_geometry, s.result
        ? () => bondEsds(s.structure, s.bindings, s.parameters, s.result!.esd, (st) => uniqueBonds(st, input, bond_geometry).bonds)
        : undefined);
    default:
      throw new Error(`${name} is not a single-crystal read tool`);
  }
}

/** Make a change on the page. Returns a note for the model when the change needed adjusting or did not finish. */
export async function changeSingleCrystal(name: string, input: Input, port: SingleCrystalAgentPort, host: LiveToolHost): Promise<ChangeResult> {
  const s = port.state();
  switch (name) {
    case "set_free":
      return applyFree(s.parameters, input, port.setFixed);
    case "set_adp_model": {
      port.setAdpModel(!!input.anisotropic);
      const hydrogens = s.structure.sites.filter((site) => isHydrogen(site)).length;
      if (!input.anisotropic || s.probe !== "xray" || hydrogens === 0) return undefined;
      return `The ${hydrogens} hydrogen${hydrogens === 1 ? " stays" : "s stay"} isotropic: X-ray data cannot give a hydrogen a tensor.${s.riding.length === 0 ? " Ride them (set_riding_hydrogens) unless the data can place them on their own." : ""}`;
    }
    case "set_outlier_filter":
      port.setOutlierFilter({
        ...(input.on !== undefined ? { on: !!input.on } : {}),
        ...(input.cutoffSigma !== undefined ? { cutoffSigma: input.cutoffSigma } : {}),
        ...(input.minExtinction !== undefined ? { minExtinction: input.minExtinction } : {}),
      });
      return undefined;
    case "omit_reflections":
      port.setOmitted(omitPlan(s, input).next);
      return undefined;
    case "test_extinction":
      return extinctionTest(s, port, input.below ?? 0.5);
    case "keep_reflections": {
      const failed = failedMeasurements(s);
      const asked = (input.reflections as { h: number; k: number; l: number; batch?: number }[]);
      const unknown = asked.filter((r) => !failed.some((f) => keptKey(f) === keptKey(r)));
      if (unknown.length) throw new Error(`${unknown.map(measurementName).join(", ")} ${unknown.length === 1 ? "is" : "are"} not on the failed list (assess_refinement \`failedMeasurements\`): only a listed failure needs keeping`);
      const at = Date.now();
      host.updateRecord(keyOfState("singleCrystal", s), (rec) => {
        const kept = new Map((rec.kept ?? []).map((k) => [k.measurement, k]));
        for (const r of asked) kept.set(keptKey(r), { measurement: keptKey(r), reason: String(input.reason), at });
        return { ...rec, kept: [...kept.values()] };
      });
      return `Kept in the fit at the user's word (${input.reason}): ${asked.map(measurementName).join(", ")}. The report says so; a change of the data starts the list again.`;
    }
    case "set_resolution_range":
      port.setResolution({ ...(input.dMin !== undefined ? { dMin: input.dMin } : {}), ...(input.dMax !== undefined ? { dMax: input.dMax } : {}) });
      return undefined;
    case "set_radiation":
      port.setRadiation({ ...(input.probe !== undefined ? { probe: input.probe } : {}), ...(input.wavelength !== undefined ? { wavelength: input.wavelength } : {}) });
      return "Every Fc changed with the radiation: the scale restarted from its best value and the last fit is cleared. Refine the scale (and what was free) again before comparing.";
    case "set_extinction_model":
      port.setExtinctionModel(input.model as ExtinctionModel);
      return "The extinction parameter restarted at 0 under the new model: refine it with the scale (and what was free before) to convergence before comparing the fit.";
    case "set_twin": {
      const next = twinAfter(s, input);
      const starts = twinStarts(s, next);
      port.setTwinLaws(next);
      if (next.length === 0) return "Untwinned again: the twin fraction left the fit, and the last fit is cleared.";
      const signal = isInversion(next[0]!) && !anomalousLine(s) ? " No anomalous scattering at this radiation (X-rays at a tabulated line give it): the inversion fraction is undetermined." : "";
      const dropped = s.twinLaws.length > next.length ? `; the other ${s.twinLaws.length - next.length} domain${s.twinLaws.length - next.length === 1 ? "" : "s"} left the fit` : "";
      if (next.length > 1) return `Four domains, as SHELXL's TWIN R −4: the law (twin_1), the inversion (twin_2) and the two together (twin_3) — ${startsText(starts)}. The inverted domains (twin_2 + twin_3) hold the Flack x: refine them with the structure.${anomalousLine(s) ? "" : " No anomalous scattering at this radiation: their split between the hands is undetermined."} The last fit is cleared.`;
      if (starts[0]!.kept) return `The law stays, its fraction kept at ${sig(starts[0]!.value, 4)} (twin_1)${dropped}: refine it with the structure.${signal} The last fit is cleared.`;
      return `${isInversion(next[0]!) ? "The inversion twin's fraction, the Flack x (twin_1)," : "The twin fraction (twin_1, BASF)"} is free from 0.1: refine it with the structure.${signal} The last fit is cleared.`;
    }
    case "invert_structure": {
      const was = s.structure.spaceGroup.hermannMauguin ?? "the space group";
      const text = port.invertStructure();
      const twins = s.twinLaws.length === 0 ? ""
        : s.twinLaws.length === 1 && isInversion(s.twinLaws[0]!) ? " The inversion twin's x is now 1 − x."
          : s.twinLaws.some((law) => improper(law.matrix)) ? " The twin keeps its fit: each domain took the fraction of its inverse."
            : " The twin law keeps its fraction: the crystal is now modelled with the other hand.";
      return `${text[0]!.toUpperCase()}${text.slice(1)} (was ${was}).${twins}${s.riding.length ? " The riding groups were placed afresh on the inverted atoms." : ""} The last fit is cleared: refine again, and compare wR2 and the Flack x with the other hand's.`;
    }
    case "set_weighting": {
      const next = weightingAfter(s, input);
      port.setWeighting(next);
      return `${next ? `WGHT ${next.a} ${next.b}` : "w = 1/σ²"} weights the next refinement: refine again before reading wR2 and GooF.`;
    }
    case "set_riding_hydrogens": {
      const options = ridingOptionsOf(input);
      const note = port.setRiding(!!input.on, options);
      if (!input.on) return `The hydrogens have their own rows again, fixed at the loaded positions${note ? `; ${note}` : ""}. The last fit is cleared.`;
      // What the page did, computed as it computes it: the port in hand shows the page as it was before the change.
      const rules = ridingRules({ ...s.refinedStructure, riding: [] }, options).rules;
      if (rules.length === 0) throw new Error(note ?? "no hydrogen rides");
      const sites = s.refinedStructure.sites.map((site) => ({ ...site }));
      const placed = { ...s.refinedStructure, riding: rules, sites };
      applyRiding(placed, sites);
      const odd = oddHydrogenDistances(s.probe, placed);
      const torsions = [...new Set(rules.filter(isRotating).map((r) => r.parent))];
      const free = rules.filter((r) => r.geometry === "free").map((r) => r.site);
      const shared = [...sharedUGroups(rules).keys()].map((key) => `B_shared_${key}`);
      const rows = [
        ...(torsions.length ? [`the torsion${torsions.length === 1 ? "" : "s"} ${torsions.map((p) => `rot_${p}`).join(", ")} (fixed) refine${torsions.length === 1 ? "s" : ""} with the positions`] : []),
        ...(free.length ? [`${free.join(", ")} keep${free.length === 1 ? "s" : ""} ${free.length === 1 ? "its" : "their"} position rows (fixed), to refine — restrained where the data are weak`] : []),
        ...(shared.length ? [`the shared U_iso ${shared.join(", ")} (fixed, at the hydrogens' present mean) refine${shared.length === 1 ? "s" : ""} with the ADPs`] : []),
      ];
      // A hydrogen whose position refines rides by its U only: counted apart, as SHELXL's −1.2 is not an AFIX.
      const riders = rules.length - free.length;
      const head = `${riders} hydrogen${riders === 1 ? " rides" : "s ride"}${free.length ? `, ${free.length} refine${free.length === 1 ? "s its position" : " their positions"} with U riding` : ""}`;
      return `${head}: ${ridingSummary(placed)}${note ? `; ${note}` : ""}.${odd ? ` ${odd}` : ""}${rows.length ? ` Free with set_free: ${rows.join("; ")}.` : ""} The last fit is cleared: refine again.`;
    }
    case "tie_parameters": {
      const update = scTieUpdate(s, input);
      port.setParameterTies(update);
      return tieNote(s, update);
    }
    case "merge_equivalents": {
      port.setMerged(!!input.on);
      if (!input.on) return `Every measurement is fitted again: ${s.totalReflections} reflections. The omissions and the last fit are cleared.`;
      const m = mergedDataset(s.dataset, s.structure.spaceGroup.operations);
      const apart = s.merge.friedelApart;
      const absent = m.merged!.absences ? `, ${m.merged!.absences} systematic absence${m.merged!.absences === 1 ? "" : "s"} left out${m.merged!.absentMeasurements ? ` (${m.merged!.absentMeasurements} measurements)` : ""}` : "";
      // A file the data reduction merged already holds each reflection once: the merge only leaves out the absences, and gives no R_int.
      if ((apart ?? s.merge).redundancy <= 1 + 1e-9) {
        return `The file holds each reflection once already (its data reduction merged them${m.merged!.friedelApart ? ", the Friedel opposites apart" : ""}): no R_int can be computed from it. As SHELXL's MERG 2${absent || ", nothing left out"}: ${m.reflections.length} reflections fitted. The data reading keeps the file as loaded. The omissions and the last fit are cleared: refine again.`;
      }
      const rInt = apart && m.merged!.friedelApart
        ? `R_int ${pct(apart.rInt)} % for this merge, as SHELXL reports it (${pct(s.merge.rInt)} % in the Laue class, the mates merged)`
        : `R_int ${rIntOf(s)}${typeof rIntOf(s) === "number" ? " %" : ""}`;
      return `${s.totalReflections} measurements merged into ${m.reflections.length} reflections, ${m.merged!.friedelApart ? "the Friedel opposites kept apart (a non-centrosymmetric group: they differ by the anomalous signal)" : "the Friedel opposites merged too (a centrosymmetric group)"}${absent}. ${rInt}; the data reading keeps the measurement as loaded. The omissions and the last fit are cleared: refine again.`;
    }
    case "restrain_distances": {
      const next = restraintsAfter(s, input);
      port.setDistanceRestraints(next);
      if (next.length === 0) return "No restraints: the fit is the data's alone again. The last fit is cleared.";
      const placed = { ...s.refinedStructure, restraints: next };
      const far = restraintReport(placed, next).filter((r) => r.worst > 3);
      return `${restraintCount(next)} restraint${restraintCount(next) === 1 ? "" : "s"} in all (as SHELXL counts them). As the model stands: ${restraintReport(placed, next).map((r) => r.text).join("; ")}.${far.length ? " One or more sits beyond 3σ now: the refinement will pull the atoms toward it." : ""} The last fit is cleared: refine again.`;
    }
    case "refine": {
      if (!s.parameters.some((p) => !p.fixed && !p.expression)) throw new Error("no parameter is free — free some with set_free first");
      const why = await (input.mode === "thorough" ? port.thorough() : port.refine());
      if (why) return `The refinement did not finish (${why}); the parameters keep their values from before it.`;
      const notes = [freeHydrogenNote(s), listingExtinctionNote(s)].filter((n): n is string => n !== null);
      return notes.length ? notes.join(" ") : undefined;
    }
    case "reset_parameters":
      port.reset(input.parameters ? matchIds(s.parameters, input.parameters as string[]) : undefined);
      return undefined;
    case "go_to_step":
      goToStep(host, input.step);
      return undefined;
    default:
      throw new Error(`${name} is not a single-crystal change tool`);
  }
}

/** Why a change would do nothing, or null when it would do something. */
export function singleCrystalNoOp(spec: LiveToolSpec, input: Input, s: SingleCrystalLiveState): string | null {
  switch (spec.name) {
    case "set_free":
      return freeNoOp(s.parameters, input);
    case "set_adp_model":
      return s.adpModel === (input.anisotropic ? "anisotropic" : "isotropic") ? `the ADPs are already ${s.adpModel}` : null;
    case "set_outlier_filter": {
      const on = input.on ?? s.outlierFilter.on;
      const cutoff = input.cutoffSigma ?? s.outlierFilter.cutoffSigma;
      const minY = input.minExtinction === undefined ? s.outlierFilter.minExtinction : input.minExtinction ?? undefined;
      return on === s.outlierFilter.on && cutoff === s.outlierFilter.cutoffSigma && minY === s.outlierFilter.minExtinction
        ? `the filter is already ${on ? `on at ${cutoff}σ${minY !== undefined ? `, y ≥ ${minY}` : ""}` : "off"}`
        : null;
    }
    case "omit_reflections": {
      const plan = omitPlan(s, input);
      return plan.added.length === 0 && plan.restored.length === 0
        ? s.omitted.length === 0 ? "nothing is omitted, and nothing new was named" : `already as asked: ${s.omitted.map(omittedText).join(", ")} omitted`
        : null;
    }
    case "set_extinction_model":
      return input.model === s.extinctionModel ? `the extinction model is already ${EXTINCTION_MODEL_LABELS[s.extinctionModel]}` : null;
    case "set_weighting": {
      const next = weightingAfter(s, input);
      return next?.a === s.weighting?.a && next?.b === s.weighting?.b ? `the weights are already ${weightingText(next)}` : null;
    }
    case "invert_structure": {
      if (isCentrosymmetric(s.structure.spaceGroup.operations)) throw new Error(`${s.structure.spaceGroup.hermannMauguin ?? "the space group"} is centrosymmetric: the inverted model is the same model`);
      if (s.magnetic) throw new Error("a magnetic model is applied: invert the structure before applying it");
      invertedModel(s.structure);
      return null;
    }
    case "set_twin": {
      const next = twinAfter(s, input);
      return sameLaws(next, s.twinLaws) ? (next.length ? `the twin law is already ${twinText(next[0]!)}` : "the crystal is already untwinned") : null;
    }
    case "tie_parameters":
      return checkEqualTies(s.parameters, scTieUpdate(s, input)).unchanged ? "those parameters are already tied so" : null;
    case "merge_equivalents": {
      if (input.on && s.probe === "neutron-tof") throw new Error("a time-of-flight Laue measurement is not merged: each reflection has its own wavelength, extinction and batch, which a merge would lose");
      if (input.on && s.dataset.origin === "refinement-listing") throw new Error("a refinement's listing is merged already: each reflection is there once");
      const on = !!s.dataset.merged;
      return !!input.on === on ? (on ? "the equivalents are merged already" : "every measurement is fitted already") : null;
    }
    case "restrain_distances": {
      const next = restraintsAfter(s, input);
      return JSON.stringify(next) === JSON.stringify(s.distanceRestraints) ? (next.length ? `the restraints are already so (${restraintCount(next)})` : "there is no restraint to remove") : null;
    }
    case "set_riding_hydrogens": {
      const hydrogens = s.structure.sites.filter((site) => isHydrogen(site)).length;
      if (input.on && hydrogens === 0) throw new Error("the model has no hydrogen atoms: nothing to ride");
      if (!input.on) return s.riding.length === 0 ? "no hydrogen rides: each refines on its own already" : null;
      const named = (input.refine as string[] | undefined) ?? [];
      const unknown = named.filter((label) => !s.structure.sites.some((site) => site.label === label && isHydrogen(site)));
      if (unknown.length) throw new Error(`no hydrogen ${unknown.join(", ")} in the model`);
      const shared = (input.sharedU as string[][] | undefined) ?? [];
      const words = new Set(["all", ...Object.keys(AFIX)]);
      const strange = shared.flat().filter((name) => !words.has(name) && !s.structure.sites.some((site) => site.label === name && isHydrogen(site)));
      if (strange.length) throw new Error(`sharedU names ${strange.join(", ")}: neither a hydrogen of the model nor a geometry (${[...words].join(", ")})`);
      const next = ridingRules({ ...s.refinedStructure, riding: [] }, ridingOptionsOf(input)).rules;
      const keys = new Set(next.flatMap((r) => (r.uShared !== undefined ? [r.uShared] : [])));
      const empty = shared.flatMap((names, k) => (keys.has(String(k + 1)) ? [] : [`[${names.join(", ")}]`]));
      if (empty.length) throw new Error(`sharedU ${empty.join(", ")} names no hydrogen that rides here${empty.length === shared.length ? "" : " (or only hydrogens an earlier list took)"}`);
      const same = s.riding.length === next.length && next.every((r) => {
        const was = s.riding.find((x) => x.site === r.site);
        return was && was.parent === r.parent && was.geometry === r.geometry && was.uFactor === r.uFactor && was.uShared === r.uShared && Math.abs((was.distance ?? 0) - (r.distance ?? 0)) < 5e-4;
      });
      return same ? `the hydrogens ride already: ${ridingSummary(s.refinedStructure)}` : null;
    }
    case "set_resolution_range": {
      const next = resolutionAfter(s, input);
      if (next.dMin !== undefined && next.dMax !== undefined && next.dMin >= next.dMax) throw new Error(`dMin ${next.dMin} Å must lie below dMax ${next.dMax} Å`);
      return next.dMin === s.resolution.dMin && next.dMax === s.resolution.dMax ? `the range is already ${rangeText(next)}` : null;
    }
    case "set_radiation": {
      const probe = input.probe ?? s.probe;
      if (probe === "neutron-tof" && input.wavelength !== undefined) throw new Error("a time-of-flight measurement has no single wavelength: each reflection has its own");
      const wl = "wavelength" in s.dataset.radiation ? s.dataset.radiation.wavelength : undefined;
      return probe === s.probe && (input.wavelength === undefined || input.wavelength === wl) ? `the radiation is already ${radiationText(probe, wl)}` : null;
    }
    default:
      return null;
  }
}

/** One line for the approval card: what this change will do, in the page's terms. */
export function describeSingleCrystalChange(spec: LiveToolSpec, input: Input, s: SingleCrystalLiveState): string {
  switch (spec.name) {
    case "keep_reflections":
      return `Keep in the fit, at your word, ${(input.reflections as { h: number; k: number; l: number; batch?: number }[]).map(measurementName).join(", ")} — read as failed measurements: ${String(input.reason)}`;
    case "test_extinction": {
      const below = input.below ?? 0.5;
      return `Test the extinction: refine twice as probes, with and without the ${s.rows.filter((r) => (r.extinction ?? 1) < below).length} reflections of y < ${below}, and compare — the page stays as it is`;
    }
    case "set_free":
      return describeFree(s.parameters, input);
    case "set_adp_model":
      return `ADPs ${s.adpModel} → ${input.anisotropic ? "anisotropic (U tensor per site, seeded from the refined B)" : "isotropic (one B per site)"}`;
    case "set_outlier_filter": {
      const on = input.on ?? s.outlierFilter.on;
      const cutoff = input.cutoffSigma ?? s.outlierFilter.cutoffSigma;
      const minY: number | undefined = input.minExtinction === undefined ? s.outlierFilter.minExtinction : input.minExtinction ?? undefined;
      if (!on) return "Outlier filter off: every reflection fitted";
      // Counted on every reflection in the file, against the current model, as the page's filter cuts.
      const left = s.allRows.filter((r) => !isOmitted(r, s.omitted) && inResolution(r, s.structure.cell, s.resolution) && (Math.abs(r.deltaOverSigma) > cutoff || (minY !== undefined && (r.extinction ?? 1) < minY))).length;
      return `Outlier filter on at ${cutoff}σ${minY !== undefined ? ` and y ≥ ${minY}` : ""}: leaves out ${left} reflection${left === 1 ? "" : "s"} against the current model`;
    }
    case "omit_reflections": {
      const plan = omitPlan(s, input);
      const parts = [
        ...(plan.added.length ? [`Omit ${plan.added.map(omittedText).join(", ")}${input.reason ? ` (${String(input.reason)})` : ""}`] : []),
        ...(plan.restored.length ? [`restore ${plan.restored.map(omittedText).join(", ")}`] : []),
      ];
      return `${parts.join("; ")} — ${plan.next.length} measurement${plan.next.length === 1 ? "" : "s"} omitted in all`;
    }
    case "set_extinction_model":
      return `Extinction model: ${EXTINCTION_MODEL_LABELS[input.model as ExtinctionModel]}, in place of ${EXTINCTION_MODEL_LABELS[s.extinctionModel]} — its parameter restarts at 0`;
    case "set_weighting": {
      const next = weightingAfter(s, input);
      const why = input.use === "suggested" ? (() => {
        const sug = suggestionOf(s);
        return ` (suggested for the model as refined now: GooF ${sig(sug.goof, 3)}, by intensity bin ${sug.bins.map((g) => sig(g, 3)).join(", ")})`;
      })() : "";
      return `Weights: ${weightingText(next)}${why}, in place of ${weightingText(s.weighting)} — wR2 and GooF change, R1 does not`;
    }
    case "invert_structure": {
      const inv = invertedModel(s.structure);
      const shifted = inv.shift.some((v) => v !== 0);
      if (s.inverted) return `Back to the hand as loaded: the model as it was loaded, in ${inv.enantiomorph ?? s.structure.spaceGroup.hermannMauguin ?? "its space group"}${s.twinLaws.length ? "; the twin fractions re-expressed" : ""}${s.riding.length ? "; the riding groups placed afresh" : ""}`;
      const moved = inv.translation.some((v) => v !== 0);
      return `Invert the model: every coordinate x → ${shifted ? `(${inv.shift.join(", ")}) − x` : "−x"}${moved ? `, moved into the cell by (${inv.translation.join(", ")})` : ""}; ${inv.enantiomorph ? `the space group ${s.structure.spaceGroup.hermannMauguin ?? "?"} → ${inv.enantiomorph}` : `the space group ${s.structure.spaceGroup.hermannMauguin ?? "?"} kept`}${s.twinLaws.length ? "; the twin fractions re-expressed" : ""}${s.riding.length ? "; the riding groups placed afresh" : ""}`;
    }
    case "set_twin": {
      const next = twinAfter(s, input);
      const starts = twinStarts(s, next);
      if (next.length > 1) return `Twin law: ${twinText(next[0]!)} with the inversion — four domains (TWIN R −4): ${startsText(starts)}`;
      if (next.length === 0) return `Untwinned: the twin fraction${s.twinLaws.length ? "" : "s"} leave the fit`;
      const leaving = s.twinLaws.length > next.length ? `, the other ${s.twinLaws.length - next.length} domain${s.twinLaws.length - next.length === 1 ? "" : "s"} leaving the fit` : "";
      return `Twin law: ${twinText(next[0]!)} — its fraction${isInversion(next[0]!) ? " (the Flack x)" : " (BASF)"} ${starts[0]!.kept ? `kept at ${sig(starts[0]!.value, 4)}${leaving}` : "refines from 0.1"}`;
    }
    case "merge_equivalents": {
      if (!input.on) return `Fit every measurement again (${s.totalReflections}), not the merged equivalents`;
      const m = mergedDataset(s.dataset, s.structure.spaceGroup.operations);
      return `Merge the equivalents as SHELXL's MERG 2: ${s.totalReflections} measurements → ${m.reflections.length} reflections, ${m.merged!.friedelApart ? "Friedel opposites apart" : "Friedel opposites merged (centrosymmetric)"}`;
    }
    case "restrain_distances": {
      const next = restraintsAfter(s, input);
      const placed = { ...s.refinedStructure, restraints: next };
      const added = next.filter((r) => !s.distanceRestraints.some((w) => JSON.stringify(w) === JSON.stringify(r)));
      const removed = s.distanceRestraints.length - (next.length - added.length);
      return [
        ...(added.length ? [`Restrain ${restraintReport(placed, added).map((r) => r.text.replace(/ — the largest deviation.*$/, "")).join("; ")}`] : []),
        ...(removed > 0 ? [`drop ${removed} restraint${removed === 1 ? "" : "s"}`] : []),
      ].join(" · ") + ` — ${restraintCount(next)} restraint${restraintCount(next) === 1 ? "" : "s"} in all`;
    }
    case "tie_parameters": {
      const u = scTieUpdate(s, input);
      const kind = (id: string | undefined): string => {
        const k = s.parameters.find((p) => p.id === id)?.kind;
        return k === "occupancy" ? "occupancy" : k === "uAniso" ? "U" : "B";
      };
      return [
        ...(u.equal ? [`Tie ${u.equal.slice(1).join(", ")} = ${u.equal[0]} (one ${kind(u.equal[0])} refines)`] : []),
        ...(u.groups?.length ? [`${(input.adp as string[]).slice(1).join(", ")} take${(input.adp as string[]).length > 2 ? "" : "s"} the ADP of ${String((input.adp as string[])[0])} (EADP: ${u.groups.length} row${u.groups.length === 1 ? "" : "s"} each)`] : []),
        ...(u.complement ? [`${u.complement[1]} = 1 − ${u.complement[0]}: the two alternatives add up to one, and the split refines as one fraction`] : []),
        ...(u.release ? [`Release the tie on ${u.release.join(", ")}`] : []),
      ].join(" · ");
    }
    case "set_riding_hydrogens": {
      const hydrogens = new Set(s.structure.sites.filter((site) => isHydrogen(site)).map((site) => site.label));
      if (!input.on) return `Hydrogens refine on their own again: ${hydrogens.size} hydrogen${hydrogens.size === 1 ? "" : "s"} get their own position and B rows (fixed, at the loaded positions)`;
      const rules = ridingRules({ ...s.refinedStructure, riding: [] }, ridingOptionsOf(input)).rules;
      // A hydrogen whose position refines keeps its position rows: only its U leaves.
      const placed = new Set(rules.filter((r) => r.geometry === "free").map((r) => r.site));
      const positional = new Set(["positionShift", "atomX", "atomY", "atomZ"]);
      const rows = new Set(s.bindings.filter((b) => b.targetKey !== undefined && hydrogens.has(b.targetKey) && !(placed.has(b.targetKey) && positional.has(b.kind))).map((b) => b.parameterId)).size;
      const counts = (Object.keys(AFIX) as RidingRule["geometry"][]).flatMap((g) => {
        const n = rules.filter((r) => r.geometry === g).length;
        return n ? [`${n} ${g === "free" ? "with their positions refined" : `AFIX ${AFIX[g]}`}`] : [];
      });
      const groups = sharedUGroups(rules);
      const sharing = [...groups.values()].reduce((t, g) => t + g.length, 0);
      const u = `${input.uFactor !== undefined ? `${input.uFactor}·U_eq of the parent` : "1.2·U_eq of the parent (1.5 for methyl and hydroxyl)"}${sharing ? `; ${sharing === rules.length ? "every one's" : `${sharing}'s`} refined instead, shared: ${[...groups].map(([key, labels]) => `B_shared_${key} for ${labels.length}`).join(", ")}` : ""}`;
      const d = input.distance !== undefined ? `, X–H ${input.distance} Å` : input.temperature !== undefined ? `, SHELXL's X–H at ${input.temperature} K` : "";
      const torsions = new Set(rules.filter(isRotating).map((r) => r.parent)).size;
      const joining = [torsions ? `${torsions} torsion${torsions === 1 ? "" : "s"}` : "", groups.size ? `${groups.size} shared U_iso` : ""].filter(Boolean).join(" and ");
      return `Ride ${rules.length} hydrogen${rules.length === 1 ? "" : "s"} on ${rules.length === 1 ? "its parent" : "their parents"} (SHELXL AFIX: ${counts.join(", ")}${d}; U_iso = ${u})${rows ? ` — ${rows} parameter${rows === 1 ? "" : "s"} leave the fit` : ""}${joining ? `, ${joining} join${torsions + groups.size === 1 ? "s" : ""} it` : ""}`;
    }
    case "set_resolution_range": {
      const next = resolutionAfter(s, input);
      const outside = s.allRows.filter((r) => !inResolution(r, s.structure.cell, next) && !isOmitted(r, s.omitted)).length;
      return `Resolution ${rangeText(next)}: ${outside === 0 ? "every reflection in range" : `leaves out ${outside} reflection${outside === 1 ? "" : "s"}`}`;
    }
    case "set_radiation": {
      const probe = input.probe ?? s.probe;
      const wl = input.wavelength ?? ("wavelength" in s.dataset.radiation ? s.dataset.radiation.wavelength : undefined);
      const was = "wavelength" in s.dataset.radiation ? s.dataset.radiation.wavelength : undefined;
      return `Radiation: ${radiationText(probe, wl)}, in place of ${radiationText(s.probe, was)} — every Fc changes; the scale restarts from its best value`;
    }
    case "refine": {
      const free = s.parameters.filter((p) => !p.fixed && !p.expression).length;
      return input.mode === "thorough"
        ? `${s.result ? "Escape minimum" : "Prefit"} (multi-start) on ${free} free parameter${free === 1 ? "" : "s"}`
        : `Refine F², ${free} free parameter${free === 1 ? "" : "s"} against ${s.observationCount} reflections`;
    }
    case "reset_parameters":
      return input.parameters ? `Reset ${matchIds(s.parameters, input.parameters as string[]).join(", ")} to the starting value` : "Reset every parameter to its starting value";
    case "go_to_step":
      return `Go to step ${String(input.step)}`;
    default:
      return spec.title;
  }
}

/**
 * tie_parameters on this page: ids and globs as on the powder page; a
 * disorder's two occupancies, the second one minus the first (by occ_ id or
 * site label); and SHELXL's EADP, every ADP row of the later sites held to
 * the first's, mode by mode.
 */
function scTieUpdate(s: SingleCrystalLiveState, input: Input): EqualTieUpdate {
  const expand = (list: readonly string[]): string[] => [...new Set(list.flatMap((g) => matchIds(s.parameters, [g])))];
  const occupancy = (name: string): string => {
    if (s.parameters.some((p) => p.id === name)) return name;
    if (s.parameters.some((p) => p.id === `occ_${name}`)) return `occ_${name}`;
    throw new Error(`no occupancy row for ${name}${s.structure.sites.some((site) => site.label === name) ? " (a site at full occupancy and in no disorder has none)" : ""}`);
  };
  const groups = Array.isArray(input.adp) ? adpTieGroups(s, input.adp as string[]) : [];
  const update: EqualTieUpdate = {
    ...(Array.isArray(input.equal) ? { equal: expand(input.equal as string[]) } : {}),
    ...(groups.length ? { groups } : {}),
    ...(Array.isArray(input.complement) ? { complement: [occupancy(String(input.complement[0])), occupancy(String(input.complement[1]))] as const } : {}),
    ...(Array.isArray(input.release) ? { release: expand(input.release as string[]) } : {}),
  };
  if (!update.equal && !update.groups && !update.complement && !update.release) throw new Error("pass `equal`, `complement`, `adp` or `release`");
  return update;
}

/** EADP: the ADP rows of each later site, mode by mode, held to the first site's; their site symmetry must give the same modes. */
function adpTieGroups(s: SingleCrystalLiveState, labels: readonly string[]): string[][] {
  const rowsOf = (label: string): { id: string; kind: string; basis: readonly number[] | undefined }[] => {
    if (!s.structure.sites.some((site) => site.label === label)) throw new Error(`no site ${label}`);
    const rows = s.bindings.filter((b) => b.targetKey === label && (b.kind === "uAniso" || b.kind === "bIso")).map((b) => ({ id: b.parameterId, kind: b.kind, basis: b.uBasis }));
    if (rows.length === 0) throw new Error(`${label} has no ADP row of its own${s.riding.some((r) => r.site === label) ? ": it rides, its U follows its parent's" : ""}`);
    return rows;
  };
  const lead = rowsOf(labels[0]!);
  const groups = lead.map((r) => [r.id]);
  for (const label of labels.slice(1)) {
    const rows = rowsOf(label);
    const same = rows.length === lead.length && rows.every((r, i) => r.kind === lead[i]!.kind && (r.basis ?? []).every((v, j) => Math.abs(v - (lead[i]!.basis?.[j] ?? NaN)) < 1e-9));
    if (!same) throw new Error(`${label}'s ADP is not of ${labels[0]}'s form (${rows.length} ${rows[0]!.kind === "uAniso" ? "U" : "B"} row${rows.length === 1 ? "" : "s"} against ${lead.length} ${lead[0]!.kind === "uAniso" ? "U" : "B"}: another ADP model or site symmetry), so it cannot take it whole`);
    if (rows.some((r, i) => r.id === lead[i]!.id)) throw new Error(`${label} already shares ${labels[0]}'s ADP rows: they are one site`);
    rows.forEach((r, i) => groups[i]!.push(r.id));
  }
  return groups;
}

/** What the tie leaves to do: the leader to free, the fraction to report. */
function tieNote(s: SingleCrystalLiveState, update: EqualTieUpdate): string | undefined {
  const fixedLeaders = [...(update.complement ? [update.complement[0]] : []), ...(update.groups ?? []).map((g) => g[0]!), ...(update.equal ? [update.equal[0]!] : [])]
    .filter((id) => s.parameters.find((p) => p.id === id)?.fixed);
  // Each site whose ADP rows follow another's, by name (EADP).
  const siteOf = (id: string): string => s.bindings.find((b) => b.parameterId === id)?.targetKey ?? id;
  const followed = new Map<string, Set<string>>();
  for (const g of update.groups ?? []) {
    for (const f of g.slice(1)) {
      const site = siteOf(f);
      (followed.get(site) ?? followed.set(site, new Set()).get(site)!).add(siteOf(g[0]!));
    }
  }
  const parts = [
    ...(update.complement ? [`${update.complement[1]} follows 1 − ${update.complement[0]}`] : []),
    ...[...followed].map(([site, leaders]) => `${site}'s ADP follows ${[...leaders].join(" and ")}'s (EADP)`),
    ...(fixedLeaders.length ? [`the leading row${fixedLeaders.length === 1 ? " is" : "s are"} fixed (${fixedLeaders.join(", ")}): free ${fixedLeaders.length === 1 ? "it" : "them"} with set_free to refine`] : []),
  ];
  return parts.length ? `${parts.join("; ")}.` : undefined;
}

/**
 * restrain_distances' outcome: the restraints on the page, less those
 * removed, with those added (each pair the shorter contact between its two
 * atoms, as SHELXL takes it); an identical restraint is not added twice.
 */
function restraintsAfter(s: SingleCrystalLiveState, input: Input): DistanceRestraint[] {
  if (input.add === undefined && input.remove === undefined) throw new Error("pass `add`, `remove`, or both");
  const same = (p: RestrainedPair, [a, b]: readonly [string, string]): boolean => (p.from === a && p.to === b) || (p.from === b && p.to === a);
  let next = input.remove === true ? [] : [...s.distanceRestraints];
  if (Array.isArray(input.remove)) {
    const drop = input.remove as [string, string][];
    next = next.filter((r) => !r.pairs.some((p) => drop.some((d) => same(p, d))));
  }
  for (const item of (input.add ?? []) as { kind: "dfix" | "sadi"; pairs: [string, string][]; distance?: number; sigma?: number }[]) {
    if (item.kind === "dfix" && item.distance === undefined) throw new Error("a DFIX needs its target `distance`");
    if (item.kind === "sadi" && item.pairs.length < 2) throw new Error("a SADI holds two distances or more equal: name at least two pairs");
    if (item.kind === "sadi" && item.distance !== undefined) throw new Error("a SADI has no target distance (the distances are held to one another): use a DFIX for one");
    const pairs = item.pairs.map(([a, b]) => {
      if (a === b) throw new Error(`a pair joins two atoms (${a} twice)`);
      const p = nearestPair(s.refinedStructure, a, b);
      if (!p) throw new Error(`no site ${[a, b].filter((x) => !s.refinedStructure.sites.some((site) => site.label === x)).join(", ")} in the model`);
      return { from: p.from, to: p.to, op: p.op, cell: p.cell };
    });
    const restraint: DistanceRestraint = { kind: item.kind, ...(item.kind === "dfix" ? { target: item.distance! } : {}), sigma: item.sigma ?? DEFAULT_RESTRAINT_SIGMA, pairs };
    if (!next.some((r) => JSON.stringify(r) === JSON.stringify(restraint))) next.push(restraint);
  }
  return next;
}

/** An extinction refined against a refinement's listing, whose Fo² have that refinement's extinction divided out (SHELXL's LIST 4): a note, or null. */
function listingExtinctionNote(s: SingleCrystalLiveState): string | null {
  if (s.dataset.origin !== "refinement-listing") return null;
  const ext = s.parameters.find((p) => p.kind === "extinction");
  if (!ext || ext.fixed || ext.expression) return null;
  return "The extinction refined against a refinement's listing: SHELXL's LIST 4 has its own extinction divided out of the Fo², so a second correction counts it twice. Hold it at 0 (set_free fix extinction, reset_parameters) and say in the report that the listing's Fo² carry SHELXL's.";
}

/**
 * X-ray data with hydrogens refined on their own: a note, or null. Neutron
 * data place them as well as any atom. A hydrogen chosen to refine
 * (set_riding_hydrogens `refine`: a hydride, its U riding) draws a note only
 * while no restraint holds it.
 */
function freeHydrogenNote(s: SingleCrystalLiveState): string | null {
  if (s.probe !== "xray") return null;
  const hydrogens = new Set(s.structure.sites.filter((site) => isHydrogen(site)).map((site) => site.label));
  // A riding group's shared U_iso (SHELXL's free variable on the U column) refines one value for the group: no hydrogen of it refines on its own.
  const shared = new Set([...sharedUGroups(s.riding).keys()].map((key) => `B_shared_${key}`));
  const free = new Set(s.parameters.filter((p) => !p.fixed && !p.expression && !shared.has(p.id)).map((p) => p.id));
  const refined = new Set(s.bindings.filter((b) => b.targetKey !== undefined && hydrogens.has(b.targetKey) && free.has(b.parameterId)).map((b) => b.targetKey!));
  const chosen = new Set(s.riding.filter((r) => r.geometry === "free").map((r) => r.site));
  const restrained = new Set(s.distanceRestraints.flatMap((r) => r.pairs.flatMap((p) => [p.from, p.to])));
  const unasked = [...refined].filter((h) => !chosen.has(h));
  const loose = [...refined].filter((h) => chosen.has(h) && !restrained.has(h));
  if (unasked.length > 0) {
    return `${unasked.length} hydrogen${unasked.length === 1 ? "" : "s"} refined on ${unasked.length === 1 ? "its" : "their"} own against X-ray data: X-rays see a hydrogen's one electron, displaced into its bond, so free positions come out short and scattered and its U poorly defined. Ride them (set_riding_hydrogens), as published structures do, unless the data are good enough to place them — and then say so in the report.`;
  }
  if (loose.length > 0) {
    return `${loose.join(", ")} refine${loose.length === 1 ? "s its position" : " their positions"} as asked, with nothing holding ${loose.length === 1 ? "it" : "them"}: X-rays place a hydrogen beside a heavy atom poorly. Restrain what the chemistry fixes (restrain_distances: SADI on equivalent M–H, or DFIX), and say so in the report.`;
  }
  return null;
}

/** X–H distances no refinement would publish (as a difference map placed them): a note, or null. X-rays see the electron, displaced into the bond; neutrons the nucleus. */
function oddHydrogenDistances(probe: SingleCrystalLiveState["probe"], model: SingleCrystalLiveState["refinedStructure"]): string | null {
  // C–H, N–H and O–H only (X-rays see each shorter, the electron drawn into the bond): a hydride's bond to a metal is longer by nature.
  const ranges: Readonly<Record<string, readonly [number, number]>> = probe === "xray" ? { C: [0.85, 1.05], N: [0.8, 1.05], O: [0.75, 1.0] } : { C: [0.95, 1.15], N: [0.95, 1.1], O: [0.9, 1.05] };
  const element = new Map(model.sites.map((site) => [site.label, site.element.replace(/[^A-Za-z]/g, "")]));
  const parent = new Map((model.riding ?? []).map((r) => [r.site, r.parent]));
  const odd = ridingDistances(model).filter((x) => {
    const range = ranges[element.get(parent.get(x.site) ?? "") ?? ""];
    return x.geometry !== "free" && range !== undefined && (x.distance < range[0] || x.distance > range[1]);
  });
  if (odd.length === 0) return null;
  return `X–H as placed is out of the usual range for ${odd.map((x) => `${x.site} (${x.distance.toFixed(2)} Å)`).join(", ")}: \`temperature\` places each group at SHELXL's X–H (C–H 0.93–0.98 Å at room temperature, +0.02 Å below 203 K; neutron 1.08 Å), or \`distance\` at one value.`;
}

/** set_riding_hydrogens' options from its input. */
function ridingOptionsOf(input: Input): RidingOptions {
  return {
    ...(input.uFactor !== undefined ? { uFactor: input.uFactor } : {}),
    ...(input.distance !== undefined ? { distance: input.distance } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(Array.isArray(input.refine) && input.refine.length ? { refine: input.refine as string[] } : {}),
    ...(Array.isArray(input.sharedU) && input.sharedU.length ? { sharedU: input.sharedU as string[][] } : {}),
  };
}

// ── twinning and the absolute structure ─────────────────────────────────────

const sameLaws = (a: readonly TwinLaw[], b: readonly TwinLaw[]): boolean => a.length === b.length && a.every((law, i) => law.matrix.every((row, r) => row.every((v, c) => v === b[i]!.matrix[r]![c])));

const twinText = (law: TwinLaw): string => (isInversion(law) ? "inversion (h′ = −h)" : `h′ = R·h, R = ${JSON.stringify(law.matrix)}`);

/** The tabulated line whose f′, f″ the fit carries, or null (neutrons, or no line at this wavelength). */
function anomalousLine(s: SingleCrystalLiveState): string | null {
  const r = s.dataset.radiation;
  return r.kind === "xray" ? dispersionLine(r.wavelength)?.name ?? null : null;
}

/**
 * The twin laws after set_twin. Throws, before the user is asked, on a law
 * that cannot twin this crystal: the inversion in a centrosymmetric group, a
 * matrix that is not a symmetry of the lattice (the domains' reflections would
 * not overlap), or one of the point group's own operations (the domains would
 * be the same crystal).
 */
function twinAfter(s: SingleCrystalLiveState, input: Input): TwinLaw[] {
  if (input.remove) return [];
  if (input.law === undefined) throw new Error("give `law` (\"inversion\" or a 3×3 matrix) or `remove: true`");
  const ops = s.structure.spaceGroup.operations;
  const centrosymmetric = ops.some((op) => op.rotation.every((row, i) => row.every((v, j) => Math.round(v) === (i === j ? -1 : 0))));
  if (input.law === "inversion") {
    if (centrosymmetric) throw new Error("the space group is centrosymmetric: an inversion twin is the same crystal");
    if (input.withInversion) throw new Error("`withInversion` goes with a merohedral law; the inversion alone is law \"inversion\"");
    return [INVERSION_TWIN];
  }
  if (input.withInversion && centrosymmetric) throw new Error("the space group is centrosymmetric: there is no other hand to add");
  const R = input.law as number[][];
  const det = R[0]![0]! * (R[1]![1]! * R[2]![2]! - R[1]![2]! * R[2]![1]!) - R[0]![1]! * (R[1]![0]! * R[2]![2]! - R[1]![2]! * R[2]![0]!) + R[0]![2]! * (R[1]![0]! * R[2]![1]! - R[1]![1]! * R[2]![0]!);
  if (Math.abs(det) !== 1) throw new Error(`a twin law has determinant ±1; this one has ${det}`);
  // h′ = R·h keeps every d when Rᵀ·G*·R = G*, G* the reciprocal metric.
  const g = reciprocalMetricTensor(s.structure.cell);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) v += R[a]![i]! * g[a]![b]! * R[b]![j]!;
    if (Math.abs(v - g[i]![j]!) > 1e-4 * Math.max(g[0]![0]!, g[1]![1]!, g[2]![2]!)) throw new Error("not a symmetry of this lattice: the twin domains' reflections would not overlap");
  }
  // h′ = R·h equivalent to h by the point group (R = opᵀ for some operation): the same crystal.
  if (ops.some((op) => [0, 1, 2].every((i) => [0, 1, 2].every((j) => Math.round(op.rotation[j]![i]!) === R[i]![j])))) throw new Error("this law is one of the point group's own operations: its domains are the same crystal");
  const law: TwinLaw = { matrix: [[R[0]![0]!, R[0]![1]!, R[0]![2]!], [R[1]![0]!, R[1]![1]!, R[1]![2]!], [R[2]![0]!, R[2]![1]!, R[2]![2]!]] };
  // With the inversion as well: four domains, as SHELXL's TWIN R −4 — the law, the inversion, and the two together.
  if (input.withInversion) return [law, INVERSION_TWIN, { matrix: law.matrix.map((row) => row.map((v) => -v)) as unknown as TwinLaw["matrix"] }];
  return [law];
}

/** The twin fractions as refined, with their esds, and what an inversion twin's says about the absolute structure. */
function twinningView(s: SingleCrystalLiveState): Record<string, unknown> | null {
  if (s.twinLaws.length === 0) return null;
  const fraction = (i: number): { x: number; esd?: number } => {
    const p = s.parameters.find((q) => q.kind === "twinFraction" && s.bindings.some((b) => b.parameterId === q.id && b.targetKey === String(i + 1)));
    const esd = p && !p.fixed ? s.result?.esd[p.id] : undefined;
    return { x: p?.value ?? NaN, ...(esd !== undefined ? { esd } : {}) };
  };
  const laws = s.twinLaws.map((law, i) => {
    const { x, esd } = fraction(i);
    const text = esd !== undefined ? withEsd(x, esd, 4) : sig(x, 3);
    if (s.twinLaws.length === 1 && isInversion(law)) return { law: "inversion", flackX: text, reading: flackReading(x, esd, anomalousLine(s)) };
    return { law: isInversion(law) ? "inversion" : law.matrix, fraction: text, ...(improper(law.matrix) ? { hand: "inverted" } : {}) };
  });
  // Beside a merohedral law, the Flack x is what the domains of the other hand hold together.
  const inverted = s.twinLaws.map((law, i) => ({ law, i })).filter(({ law }) => improper(law.matrix));
  if (s.twinLaws.length > 1 && inverted.length > 0) {
    const parts = inverted.map(({ i }) => fraction(i));
    const x = parts.reduce((t, p) => t + p.x, 0);
    const known = parts.every((p) => p.esd !== undefined);
    // The esd of the sum from the fit's covariance (the fractions trade against each other); else theirs in quadrature.
    const covariant = known ? s.result?.combinationEsd?.flack : undefined;
    const esd = covariant ?? (known ? Math.sqrt(parts.reduce((t, p) => t + p.esd! ** 2, 0)) : undefined);
    const first = s.result?.combinationEsd?.twin_first;
    const firstX = 1 - s.twinLaws.reduce((t, _, i) => t + fraction(i).x, 0);
    return {
      laws,
      firstDomain: first !== undefined ? withEsd(firstX, first, 4) : sig(firstX, 3),
      flackX: esd !== undefined ? withEsd(x, esd, 4) : sig(x, 3),
      flackNote: `the domains of the inverted hand together (${inverted.map(({ i }) => `twin_${i + 1}`).join(" + ")}); ${covariant !== undefined ? "the esd from the fit's covariance, their correlation counted" : "the esd from theirs in quadrature, their correlation not counted"}`,
      reading: flackReading(x, esd, anomalousLine(s)),
    };
  }
  return { laws };
}

/**
 * The absolute structure by Parsons' quotients, from the Bijvoet pairs the fit
 * holds both ways, against the model's Fc² of its own hand (an inverted twin
 * domain folded onto the one it inverts); null for a centrosymmetric group or
 * without anomalous scattering.
 */
function absoluteStructureView(s: SingleCrystalLiveState): Record<string, unknown> | null {
  const line = anomalousLine(s);
  if (!line || isCentrosymmetric(s.structure.spaceGroup.operations)) return null;
  const fitted = new Set(s.rows.map((r) => `${r.h} ${r.k} ${r.l}`));
  const est = parsonsOfModel(s.structure, { ...s.dataset, reflections: s.dataset.reflections.filter((r) => fitted.has(`${r.h} ${r.k} ${r.l}`)) }, s.parameters, s.bindings);
  if (!est) return { parsonsX: "none", reading: "no Bijvoet pair measured both ways (the Friedel opposites merged, or never measured): the absolute structure cannot be determined from these data" };
  const twinned = s.twinLaws.some((law) => improper(law.matrix));
  return {
    parsonsX: withEsd(est.x, est.esd, 4),
    quotients: est.quotients,
    bijvoetSigns: est.signs.observed ? `of the ${est.signs.observed} Bijvoet difference${est.signs.observed === 1 ? "" : "s"} observed at more than 3σ, ${est.signs.modelSign} ${est.signs.modelSign === 1 ? "has" : "have"} the model's sign` : "no Bijvoet difference observed at more than 3σ",
    reading: flackReading(est.x, est.esd, line),
    note: `Parsons' quotients (I⁺ − I⁻)/(I⁺ + I⁻) of the ${est.quotients} Bijvoet pairs fitted both ways, against the model's${twinned ? " with each inverted domain folded onto the domain it inverts (the model's hand alone)" : ""}: Q_obs = (1 − 2x)·Q_calc, the scale and most systematic errors cancelling, as SHELXL determines x after its refinement (Parsons, Flack & Wagner, Acta Cryst. B69 (2013) 249). √χ²_ν of the quotients ${sig(est.goodness, 3)}${est.goodness > 1 ? ", the esd scaled by it" : ""}.`,
  };
}

/** What a Flack x with its esd u says (Flack & Bernardinelli, J. Appl. Cryst. 33 (2000) 1143). */
export function flackReading(x: number, u: number | undefined, line: string | null): string {
  if (!line) return "no anomalous scattering at this radiation: x is undetermined, whatever its value";
  if (u === undefined) return "not refined yet: refine it with the structure for its esd";
  if (u > 0.3) return `u = ${sig(u, 2)}: the anomalous signal is too weak to say anything about the absolute structure`;
  if (Math.abs(x) <= 2 * u) {
    if (u < 0.04) return "the model's hand: the absolute structure is determined";
    if (u < 0.1) return `the model's hand: x is 0 within 2u. With u = ${sig(u, 2)} (above 0.04) a few per cent of the other hand cannot be excluded for a compound of unknown enantiopurity; for one known to be enantiopure, u < 0.1 confirms the hand (Flack & Bernardinelli)`;
    return `x is 0 within 2u, but u = ${sig(u, 2)} is too large to determine the hand (u < 0.1 is needed even for a compound known to be enantiopure): compare the two hands' fits (invert_structure) and quote both`;
  }
  // Near 1 the bands are the same as near 0: the inverse model's x is 1 − x, with the same u.
  if (Math.abs(1 - x) <= 2 * u) {
    const invert = "invert the model (invert_structure: every coordinate to its negative, the space group to its enantiomorph if it has one) and refine again";
    if (u < 0.04) return `the inverted hand: ${invert}`;
    if (u < 0.1) return `the inverted hand: ${invert}. With u = ${sig(u, 2)} (above 0.04) a few per cent of this model's hand cannot be excluded for a compound of unknown enantiopurity (Flack & Bernardinelli)`;
    return `x is 1 within 2u, but u = ${sig(u, 2)} is too large to determine the hand (u < 0.1 is needed even for a compound known to be enantiopure): the data lean to the inverted model, no more — compare the two hands' fits (invert_structure) and quote both`;
  }
  // Outside [0, 1] by more than 2u: no crystal holds a negative share of a hand.
  if (x < 0 || x > 1) {
    return `x = ${sig(x, 2)} lies ${x < 0 ? "below 0" : "above 1"} by more than 2u (u = ${sig(u, 2)}), which no crystal can be: the model's hand is ${x < 0 ? "this one" : "the inverted one"} as far as the data go, but the excess points to a systematic error (absorption, the weighting, extinction, an unresolved twin or disorder) to find before quoting x`;
  }
  return `between the hands: an inversion twin, ${sig(100 * x, 2)} % of the crystal of the inverted hand${Math.abs(x - 0.5) <= 2 * u ? " — a racemic twin" : ""}`;
}

/**
 * Where each fraction of a new set of laws starts, as the page sets them: a
 * law that stays at its place keeps its row's value (twin_i), a new one
 * starts at 0.1.
 */
export function twinStarts(s: SingleCrystalLiveState, next: readonly TwinLaw[]): { id: string; kept: boolean; value: number }[] {
  const same = (a: TwinLaw | undefined, b: TwinLaw): boolean => !!a && a.matrix.every((row, i) => row.every((v, j) => Math.round(v) === Math.round(b.matrix[i]![j]!)));
  return next.map((law, i) => {
    const id = `twin_${i + 1}`;
    const row = same(s.twinLaws[i], law) ? s.parameters.find((p) => p.id === id) : undefined;
    return row ? { id, kept: true, value: row.value } : { id, kept: false, value: 0.1 };
  });
}

const startsText = (starts: readonly { id: string; kept: boolean; value: number }[]): string =>
  starts.map((t) => (t.kept ? `${t.id} kept at ${sig(t.value, 4)}` : `${t.id} from 0.1`)).join(", ");

// ── extinction test ─────────────────────────────────────────────────────────

/**
 * The extinction test as two probes, the page untouched: the fit on all the
 * data fitted, and on them less the reflections whose y is below `below`.
 * What moves by more than 2 esd between them rests on the reflections the
 * extinction correction carries.
 */
async function extinctionTest(s: SingleCrystalLiveState, port: SingleCrystalAgentPort, below: number): Promise<ChangeResult> {
  if (!s.result) throw new Error("refine first: the test starts from the converged fit, and reads the shifts against its esds");
  const free = s.parameters.filter((p) => !p.fixed && !p.expression);
  if (free.length === 0) throw new Error("no parameter is free: free what the test should follow (the ADPs, the extinction, the scale), refine, then test");
  const cut = s.rows.filter((r) => (r.extinction ?? 1) < below).length;
  if (cut === 0) {
    const lowest = s.rows.reduce((m, r) => Math.min(m, r.extinction ?? 1), 1);
    return { note: `No reflection fitted has y below ${below} (the lowest is ${sig(lowest, 3)}): none rests on a severe correction, and there is nothing to test. The page is unchanged.`, data: { below, leftOut: 0, lowestY: sig(lowest, 3) } };
  }
  const options = { maxIterations: 30 };
  const all = await port.probe(options);
  const without = await port.probe(options, { minExtinction: below });
  const extinction = free.find((p) => p.kind === "extinction");
  const moved = free.flatMap((p) => {
    const a = all.parameters[p.id];
    const b = without.parameters[p.id];
    const e = all.esd[p.id];
    if (a === undefined || b === undefined || !(e !== undefined && e > 0)) return [];
    const shift = (b - a) / e;
    return Math.abs(shift) > 2 ? [{ id: p.id, all: a, without: b, esds: shift }] : [];
  }).sort((x, y) => Math.abs(y.esds) - Math.abs(x.esds));
  const wr = (r: typeof all): string => (r.agreement.rWeighted !== undefined ? `${pct(r.agreement.rWeighted)} %` : "—");
  const reading = moved.length === 0
    ? `No free parameter moves by more than 2 esd without the ${cut} reflections of y < ${below}: the structure does not rest on what the extinction correction carries. Keep all the data, and report the test.`
    : `${moved.length} free parameter${moved.length === 1 ? " moves" : "s move"} by more than 2 esd without them (${moved.slice(0, 4).map((m) => `${m.id} ${sig(m.esds, 2)} esd`).join(", ")}): the model leans on the reflections the extinction correction carries. Try the other extinction model (set_extinction_model), refine, and test again; report which holds.`;
  return {
    note: `${reading} The page is unchanged: both fits were probes.`,
    data: {
      below,
      leftOut: `${cut} of ${s.rows.length} reflections fitted`,
      wR2: { allData: wr(all), without: wr(without) },
      ...(extinction ? { extinction: { allData: sig(all.parameters[extinction.id] ?? NaN, 4), without: sig(without.parameters[extinction.id] ?? NaN, 4) } } : {}),
      movedBeyond2Esd: moved.map((m) => `${m.id}: ${sig(m.all, 5)} → ${sig(m.without, 5)} (${sig(m.esds, 2)} esd)`),
    },
  };
}

// ── weighting scheme ────────────────────────────────────────────────────────

const weightingText = (w: ShelxWeighting | null): string => (w ? `WGHT ${w.a} ${w.b} (w = 1/[σ² + (${w.a}P)² + ${w.b}P])` : "w = 1/σ²");

/** The weights SHELXL's criterion suggests for the fit on screen: the a and b that bring each Fc² bin's GooF nearest 1. */
function suggestionOf(s: SingleCrystalLiveState): WeightingSuggestion {
  return suggestShelxWeighting(s.rows.map((r) => r.foSq), s.rows.map((r) => r.fcSq), s.rows.map((r) => r.sigma), s.parameters.filter((p) => !p.fixed && !p.expression).length, 10, overallScale(s));
}

/** The scheme after set_weighting (null: w = 1/σ²). Throws, before the user is asked, on a request that cannot be met. */
function weightingAfter(s: SingleCrystalLiveState, input: Input): ShelxWeighting | null {
  if (input.use !== undefined && (input.a !== undefined || input.b !== undefined)) throw new Error("give `use` or `a` and `b`, not both");
  if (input.use === "sigma") return null;
  if (input.use === "suggested") {
    if (!s.result) throw new Error("the suggestion is for a refined model: refine first (a change of model or setting clears the last result)");
    const sug = suggestionOf(s);
    return sug.a > 0 || sug.b > 0 ? { a: sug.a, b: sug.b } : null;
  }
  if (input.a === undefined && input.b === undefined) throw new Error("give `use` (\"suggested\" or \"sigma\") or the terms `a` and `b`");
  const a = input.a ?? s.weighting?.a ?? 0;
  const b = input.b ?? s.weighting?.b ?? 0;
  return a > 0 || b > 0 ? { a, b } : null;
}

/** R_int, or why there is none: data merged already have one value per reflection. */
/**
 * The merge a crystallographer quotes: in an acentric group the Friedel mates
 * kept apart and the absences left out, as SHELXL merges it (MERG 2); in a
 * centrosymmetric one, the Laue class.
 */
const quotedMerge = (s: SingleCrystalLiveState): { readonly unique: number; readonly redundancy: number; readonly rInt: number; readonly rSigma: number } => s.merge.friedelApart ?? s.merge;

/**
 * R_int, or why there is none: data holding each reflection once (merged, or
 * a refinement's listing) have no equivalents to compare. In an acentric group
 * each reflection's Friedel mate is another reflection: merged in the Laue
 * class, a listing's Bijvoet pairs would differ by their anomalous signal,
 * which is no R_int.
 */
const rIntOf = (s: SingleCrystalLiveState): number | string => {
  const m = quotedMerge(s);
  if (m.redundancy > 1 + 1e-9) return pct(m.rInt);
  if (!(s.merge.friedelApart && s.merge.redundancy > 1 + 1e-9)) return "n/a (each reflection once: merged data)";
  // What the Bijvoet pairs differ by: the anomalous signal the model gives them, and the measurements' noise. The model says which.
  const model = modelBijvoetSpread(s);
  const which = model === null ? ""
    : model >= 0.5 * s.merge.rInt ? `, mostly their anomalous signal (the model's own Bijvoet differences give ${pct(model)} %)`
      : `; the model's anomalous differences give ${pct(model)} %, so the rest is the measurements' disagreement`;
  return `n/a (each reflection once, its Friedel mate apart; merged with them the Bijvoet pairs differ by ${pct(s.merge.rInt)} %${which})`;
};

/** Σ|Fc²(h) − Fc²(−h)| / Σ(Fc²(h) + Fc²(−h)) over the Bijvoet pairs fitted: the anomalous difference the model gives them, as an R_int would read it. */
function modelBijvoetSpread(s: SingleCrystalLiveState): number | null {
  const pg = pointGroupRotations(s.structure.spaceGroup.operations);
  const byKey = new Map(s.rows.map((r) => [canonicalKey(pg, r.h, r.k, r.l), r.fcSq]));
  let diff = 0;
  let sum = 0;
  for (const r of s.rows) {
    const key = canonicalKey(pg, r.h, r.k, r.l);
    const mate = canonicalKey(pg, -r.h, -r.k, -r.l);
    // Each pair once; a centric reflection is its own mate.
    if (mate <= key) continue;
    const other = byKey.get(mate);
    if (other === undefined) continue;
    diff += Math.abs(r.fcSq - other);
    sum += r.fcSq + other;
  }
  return sum > 0 ? diff / sum : null;
}

const LISTING_NOTE = "The Fo² come from a refinement's listing (.fcf), not from data reduction: each reflection once, on that refinement's scale, the systematic absences left out, and in SHELXL's LIST 4 its extinction divided out. R_int, the absences and the extinction cannot be judged from them, and R1 compares with that refinement's own.";

const radiationText = (probe: "xray" | "neutron" | "neutron-tof", wavelength: number | undefined): string =>
  probe === "neutron-tof" ? "neutron time of flight (each reflection its own wavelength)" : `${probe === "xray" ? "X-ray" : "neutron"}, λ ${wavelength ?? "?"} Å`;

// ── resolution range ────────────────────────────────────────────────────────

/** The range after set_resolution_range: a limit given as null opens that end, one not given stays. */
function resolutionAfter(s: SingleCrystalLiveState, input: Input): ResolutionRange {
  const end = (v: unknown, was: number | undefined): number | undefined => (v === undefined ? was : typeof v === "number" ? v : undefined);
  const dMin = end(input.dMin, s.resolution.dMin);
  const dMax = end(input.dMax, s.resolution.dMax);
  return { ...(dMin !== undefined ? { dMin } : {}), ...(dMax !== undefined ? { dMax } : {}) };
}

const rangeText = (r: ResolutionRange): string =>
  r.dMin === undefined && r.dMax === undefined ? "the full range" : `d ${r.dMax !== undefined ? `≤ ${r.dMax} Å` : ""}${r.dMin !== undefined && r.dMax !== undefined ? " and " : ""}${r.dMin !== undefined ? `≥ ${r.dMin} Å` : ""}`;

// ── omitting measurements ───────────────────────────────────────────────────

const omittedText = (o: OmittedMeasurement): string => `${o.h} ${o.k} ${o.l}${o.batch !== undefined ? ` (batch ${o.batch})` : ""}`;
const sameMeasurement = (a: OmittedMeasurement, b: OmittedMeasurement): boolean => a.h === b.h && a.k === b.k && a.l === b.l && a.batch === b.batch;

/**
 * omit_reflections: the list after the call, what it adds and what it puts
 * back. Each named measurement must be in the file; when the file has batches
 * and the indices were measured in more than one, the batch must be named
 * (the others stay). Throws, before the user is asked, on a measurement that
 * is not there.
 */
function omitPlan(s: SingleCrystalLiveState, input: Input): { next: OmittedMeasurement[]; added: OmittedMeasurement[]; restored: OmittedMeasurement[] } {
  const named = (item: { h: number; k: number; l: number; batch?: number }): OmittedMeasurement => {
    const matches = s.dataset.reflections.filter((r) => r.h === item.h && r.k === item.k && r.l === item.l && (item.batch === undefined || r.batch === item.batch));
    const where = `${item.h} ${item.k} ${item.l}${item.batch !== undefined ? ` in batch ${item.batch}` : ""}`;
    if (matches.length === 0) {
      const batches = [...new Set(s.dataset.reflections.filter((r) => r.h === item.h && r.k === item.k && r.l === item.l).flatMap((r) => (r.batch !== undefined ? [r.batch] : [])))];
      throw new Error(`no measurement ${where} in the data${batches.length ? ` (it was measured in batch${batches.length === 1 ? "" : "es"} ${batches.join(", ")})` : " — the indices are the file's own, not an equivalent's"}`);
    }
    const batches = [...new Set(matches.flatMap((r) => (r.batch !== undefined ? [r.batch] : [])))];
    if (item.batch === undefined && batches.length > 1) throw new Error(`${where} was measured in batches ${batches.join(", ")}: name the batch of the one that failed`);
    return { h: item.h, k: item.k, l: item.l, ...(item.batch !== undefined ? { batch: item.batch } : batches.length === 1 ? { batch: batches[0]! } : {}) };
  };
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
  const added = ((input.omit ?? []) as { h: number; k: number; l: number; batch?: number }[]).map(named)
    .filter((o, i, all) => all.findIndex((x) => sameMeasurement(x, o)) === i && !s.omitted.some((x) => sameMeasurement(x, o)))
    .map((o) => ({ ...o, ...(reason ? { reason } : {}) }));
  const restoreAll = input.restore === "all";
  const restoreList = Array.isArray(input.restore) ? (input.restore as { h: number; k: number; l: number; batch?: number }[]) : [];
  const restored = restoreAll ? [...s.omitted] : s.omitted.filter((o) => restoreList.some((r) => r.h === o.h && r.k === o.k && r.l === o.l && (r.batch === undefined || r.batch === o.batch)));
  if (!restoreAll) {
    for (const r of restoreList) {
      if (!s.omitted.some((o) => r.h === o.h && r.k === o.k && r.l === o.l && (r.batch === undefined || r.batch === o.batch))) {
        throw new Error(`${r.h} ${r.k} ${r.l}${r.batch !== undefined ? ` (batch ${r.batch})` : ""} is not omitted${s.omitted.length ? ` — omitted: ${s.omitted.map(omittedText).join(", ")}` : ""}`);
      }
    }
  }
  const next = [...s.omitted.filter((o) => !restored.includes(o)), ...added];
  return { next, added, restored };
}

// ── views ───────────────────────────────────────────────────────────────────

const hklOf = (x: { h: number; k: number; l: number }): string => `${x.h} ${x.k} ${x.l}`;
const median = (values: readonly number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
};
const measurementKey = (r: SingleCrystalRow): string => `${r.h},${r.k},${r.l},${r.batch ?? ""},${r.foSq},${r.sigma}`;

/**
 * What a misfit measurement's equivalents say: the other measurements of the
 * same reflection (the Laue class), each against its own Fc² (the extinction
 * differs with wavelength), as the ratio Fo²/Fc². One far from the others'
 * median while they agree among themselves failed — whatever the model, so it
 * holds when that one failure drags the whole fit. All of them off the same
 * way is the model's misfit, which no omission should hide; equivalents that
 * scatter among themselves are a correction that differs between them
 * (extinction at different wavelengths, before it is refined) or the model.
 */
/**
 * What the measurements behind a merged reflection say: each of them against
 * the reflection's Fc² (symmetry-equivalent under the merge, so one Fc²). One
 * far from the rest, which agree, is a measurement that failed inside the
 * merge; all of them off together is the model's misfit.
 */
function mergedReading(s: SingleCrystalLiveState, row: SingleCrystalRow): string {
  const ops = s.structure.spaceGroup.operations;
  const rotations = s.dataset.merged?.friedelApart ? pointGroupRotations(ops) : laueRotations(ops);
  const key = canonicalKey(rotations, row.h, row.k, row.l);
  const members = s.measurement.filter((m) => canonicalKey(rotations, m.h, m.k, m.l) === key);
  // Measured once (a file its data reduction merged): what the reflection's Laue-class equivalents — its Friedel mate — say instead.
  if (members.length === 1 && row.fcSq > 0) {
    const laue = laueRotations(ops);
    return againstOthers(s, row, (r) => canonicalKey(laue, r.h, r.k, r.l), "measured once");
  }
  if (members.length < 2 || !(row.fcSq > 0)) return members.length === 1 ? "measured once" : "no measurement behind it";
  const ratio = (m: (typeof members)[number]): number => Math.max(m.iObs, m.sigma ?? 0, 1e-9 * row.fcSq) / row.fcSq;
  const logs = members.map((m) => Math.log(ratio(m)));
  const lm = median(logs);
  const spread = median(logs.map((v) => Math.abs(v - lm)));
  let worst = 0;
  logs.forEach((v, i) => { if (Math.abs(v - lm) > Math.abs(logs[worst]! - lm)) worst = i; });
  const off = members[worst]!;
  const apart = Math.abs(logs[worst]! - lm);
  const n = `merged from ${members.length} measurements at Fo²/Fc² ${sig(Math.exp(lm), 3)} (median, scatter ${sig(Math.exp(spread) - 1, 2)})`;
  if (members.length >= 3 && apart >= Math.max(0.5, 4 * spread)) {
    return `${n}, one of them (${hklOf(off)}${off.batch !== undefined ? `, batch ${off.batch}` : ""}) at ${sig(ratio(off), 3)}: a measurement that failed inside the merge`;
  }
  if (Math.sign(lm) === Math.sign(row.deltaOverSigma) && Math.abs(lm) >= 0.02) return `${n}: they agree, and the model (or a correction) misses the reflection`;
  return `${n}: they scatter about the merged value as their σ allow`;
}

function equivalentsReading(s: SingleCrystalLiveState, row: SingleCrystalRow, keyOf: (r: { h: number; k: number; l: number }) => string): string {
  if (s.dataset.merged) return mergedReading(s, row);
  return againstOthers(s, row, keyOf, s.dataset.origin === "refinement-listing" ? "a listing's value, merged by the refinement that wrote it from equivalents this file does not hold" : "no equivalent measured");
}

/** A reflection against the others of its class among the rows fitted (its equivalents, or in an acentric group its Friedel mate); `alone` when there are none. */
function againstOthers(s: SingleCrystalLiveState, row: SingleCrystalRow, keyOf: (r: { h: number; k: number; l: number }) => string, alone: string): string {
  const key = keyOf(row);
  const self = measurementKey(row);
  const others = s.allRows.filter((r) => keyOf(r) === key && measurementKey(r) !== self && r.fcSq > 0);
  if (others.length === 0 || !(row.fcSq > 0)) return alone;
  // In an acentric group a Laue-class equivalent of the other hand is the Friedel mate: another reflection, which the anomalous signal sets apart (its own Fc² carries that).
  const pg = pointGroupRotations(s.structure.spaceGroup.operations);
  const own = canonicalKey(pg, row.h, row.k, row.l);
  const mates = !isCentrosymmetric(s.structure.spaceGroup.operations) && others.every((r) => canonicalKey(pg, r.h, r.k, r.l) !== own);
  // A ratio floored at σ, so a measurement that caught nothing still has one.
  const ratio = (r: SingleCrystalRow): number => Math.max(r.foSq, r.sigma, 1e-9 * r.fcSq) / r.fcSq;
  const logs = others.map((r) => Math.log(ratio(r)));
  const lm = median(logs);
  const spread = logs.length > 1 ? median(logs.map((v) => Math.abs(v - lm))) : 0;
  const lq = Math.log(ratio(row));
  const apart = Math.abs(lq - lm);
  // Three digits: near 1 a few per cent is several σ.
  const what = mates ? (others.length === 1 ? "its Friedel mate" : `${others.length} equivalents of its Friedel mate`) : `${others.length} equivalent${others.length === 1 ? "" : "s"}`;
  // A floored ratio is a bound: the measurement's Fo² lies below its σ (negative, perhaps), the ratio below σ/Fc².
  const floored = (r: SingleCrystalRow): boolean => r.foSq < r.sigma;
  const bound = (r: SingleCrystalRow, v: number): string => (floored(r) ? `below ${sig(v, 3)} (Fo² under its σ)` : String(sig(v, 3)));
  const mateRatio = others.length === 1 ? bound(others[0]!, Math.exp(lm)) : String(sig(Math.exp(lm), 3));
  const n = `${what} at Fo²/Fc² ${mateRatio}${others.length > 1 ? ` (median${others.length > 2 ? `, scatter ${sig(Math.exp(spread) - 1, 2)}` : ""})` : ""}, this one ${bound(row, Math.exp(lq))}`;
  // Failed: off by itself — its equivalents agree among themselves and roughly with the model (within ×1.8, so a
  // fit that one failure drags still counts), and it lies farther from the model than they do.
  if (Math.abs(row.deltaOverSigma) >= 6 && Math.abs(lm) <= 0.6 && Math.abs(lq) > Math.abs(lm) && apart >= Math.max(0.5, 4 * spread)) {
    return `${n}: ${others.length >= 2 && (apart >= 1 || Math.abs(row.deltaOverSigma) >= 10) ? "a failed measurement" : "possibly a failed measurement"}`;
  }
  // The largest of N misfits reaches about √(2 ln N)σ by chance alone (in the weights' esd, under a scheme).
  const chance = Math.sqrt(2 * Math.log(Math.max(s.rows.length, 2)));
  if (Math.abs(row.deltaOverEsd ?? row.deltaOverSigma) <= chance) return `${n}: no more than chance — the largest of ${s.rows.length} misfits reaches about ${chance.toFixed(1)}σ with nothing wrong`;
  if (Math.sign(lm) === Math.sign(lq) && Math.abs(lm) >= Math.abs(lq) / 2) return `${n}: the model (or a correction) misses the reflection`;
  // Laue data (each reflection its own λ) differ in λ as well as in path; a monochromatic measurement only in path.
  const laue = row.wavelength !== undefined;
  return `${n}: they disagree among themselves — a correction that differs between them (${laue ? "extinction or absorption at another wavelength or path" : "absorption along another path"}), or the model`;
}

/**
 * The largest misfits fitted, each with its batch and what its equivalents
 * say. Under a weighting scheme they are ranked and given in the scheme's esd,
 * as SHELXL lists its most disagreeable reflections, the file's σ beside it.
 */
function outliersView(s: SingleCrystalLiveState, count: number): string[] {
  const rotations = laueRotations(s.structure.spaceGroup.operations);
  const keyOf = (r: { h: number; k: number; l: number }): string => canonicalKey(rotations, r.h, r.k, r.l);
  const misfit = (r: SingleCrystalRow): number => Math.abs(r.deltaOverEsd ?? r.deltaOverSigma);
  const residual = (r: SingleCrystalRow): string => (r.deltaOverEsd !== undefined ? `Δ/esd ${sig(r.deltaOverEsd, 3)} by the weights (${sig(r.deltaOverSigma, 3)}σ by the file's σ)` : `${sig(r.deltaOverSigma, 3)}σ`);
  return [...s.rows]
    .filter((r) => r.sigma > 0)
    .sort((a, b) => misfit(b) - misfit(a))
    .slice(0, count)
    .map((r) => `${hklOf(r)}${r.batch !== undefined ? ` (batch ${r.batch})` : ""}: Fo² ${sig(r.foSq, 4)}, Fc² ${sig(r.fcSq, 4)}, ${residual(r)} (d ${sig(dSpacing(s.structure.cell, r.h, r.k, r.l), 3)} Å) — ${equivalentsReading(s, r, keyOf)}`);
}

/** How a measurement is named to the user: its indices and batch. */
const measurementName = (r: { h: number; k: number; l: number; batch?: number }): string => `${r.h} ${r.k} ${r.l}${r.batch !== undefined ? ` (batch ${r.batch})` : ""}`;
const keptKey = (r: { h: number; k: number; l: number; batch?: number }): string => `${r.h},${r.k},${r.l},${r.batch ?? ""}`;

/**
 * The measurements the user chose to keep in the fit though they read as
 * failed (keep_reflections, always their decision), with their reasons: kept
 * in the analysis' record, so they are saved with the project, and a change
 * of the data (another analysis) starts a new list, as it lifts an exception.
 */
export function keptMeasurements(record: AgentRecord): ReadonlyMap<string, string> {
  return new Map((record.kept ?? []).map((k) => [k.measurement, k.reason]));
}

/**
 * The measurements still fitted that read as failed: off by themselves at 6σ
 * or more, their equivalents agreeing among themselves and with the model
 * (the reading the outlier list gives "a failed measurement"). Computed, not
 * judged: the list write_report refuses on while one is fitted and not kept.
 */
export function failedMeasurements(s: SingleCrystalLiveState): SingleCrystalRow[] {
  if (s.dataset.merged) return [];
  const rotations = laueRotations(s.structure.spaceGroup.operations);
  const keyOf = (r: { h: number; k: number; l: number }): string => canonicalKey(rotations, r.h, r.k, r.l);
  return s.rows.filter((r) => r.sigma > 0 && Math.abs(r.deltaOverSigma) >= 6 && /: a failed measurement$/.test(equivalentsReading(s, r, keyOf)));
}

/** The least and greatest of `values`, by a loop: spreading a TOF file's 10⁵–10⁶ values into Math.min overflows the call stack. */
export function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** How the reflections were measured, when the file says: each at its own wavelength (TOF Laue), in batches. */
function measurementView(s: SingleCrystalLiveState): Record<string, unknown> | null {
  const refl = s.dataset.reflections;
  const range = (values: number[], digits: number): string => {
    const [lo, hi] = extent(values);
    return `${sig(lo, digits)}–${sig(hi, digits)}`;
  };
  const wl = refl.flatMap((r) => (r.wavelength !== undefined ? [r.wavelength] : []));
  const tt = refl.flatMap((r) => (r.twoTheta !== undefined ? [r.twoTheta] : []));
  const tr = refl.flatMap((r) => (r.transmission !== undefined ? [r.transmission] : []));
  const batches = new Set(refl.flatMap((r) => (r.batch !== undefined ? [r.batch] : [])));
  if (wl.length === 0 && batches.size < 2) return null;
  return {
    ...(wl.length > 0 ? { wavelengths: `${range(wl, 3)} Å, each reflection its own (Laue)` } : {}),
    ...(tt.length > 0 ? { twoTheta: `${range(tt, 4)}°` } : {}),
    ...(batches.size >= 2 ? { batches: `${batches.size} (runs or orientations), one scale for all` } : {}),
    ...(tr.length > 0 ? { transmission: `${range(tr, 3)}, applied in data reduction` } : {}),
  };
}

/** Per batch: K = ΣFo²/ΣFc², R1 and its worst reflection, when the reflections carry batches. */
function batchView(rows: readonly SingleCrystalRow[]): Record<string, unknown> | null {
  const groups = new Map<number, SingleCrystalRow[]>();
  for (const r of rows) if (r.batch !== undefined) (groups.get(r.batch) ?? groups.set(r.batch, []).get(r.batch)!).push(r);
  if (groups.size < 2) return null;
  const per = [...groups].map(([batch, rs]) => {
    const fo = rs.reduce((a, r) => a + r.foSq, 0);
    const fc = rs.reduce((a, r) => a + r.fcSq, 0);
    const obs = rs.filter((r) => r.sigma > 0 && r.foSq > 2 * r.sigma);
    const f = (x: number): number => Math.sqrt(Math.max(x, 0));
    const r1 = obs.reduce((a, r) => a + Math.abs(f(r.foSq) - f(r.fcSq)), 0) / Math.max(1e-12, obs.reduce((a, r) => a + f(r.foSq), 0));
    const worst = rs.reduce((w, r) => (Math.abs(r.deltaOverSigma) > Math.abs(w.deltaOverSigma) ? r : w));
    return { batch, n: rs.length, k: fc > 0 ? fo / fc : NaN, r1, worst };
  }).filter((b) => Number.isFinite(b.k) && b.k > 0);
  if (per.length < 2) return null;
  const logs = per.map((b) => Math.log(b.k));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1));
  per.sort((a, b) => Math.abs(Math.log(b.k) - mean) - Math.abs(Math.log(a.k) - mean));
  return {
    batches: per.length,
    K: `${sig(extent(per.map((b) => b.k))[0], 3)}–${sig(extent(per.map((b) => b.k))[1], 3)} (geometric mean ${sig(Math.exp(mean), 3)}, scatter ${pct(sd)} %)`,
    farthest: per.slice(0, 5).map((b) => `batch ${b.batch}: ${b.n} reflections, K ${sig(b.k, 3)}, R1 ${pct(b.r1)} %; worst ${hklOf(b.worst)} at ${sig(b.worst.deltaOverSigma, 3)}σ`),
    reading: "One scale serves every batch, so K should scatter about its mean by each batch's precision. A batch whose K stands apart has a scale of its own, or holds a reflection measured wrongly (an edge of the detector, a shadow): its worst reflection says which.",
  };
}

/**
 * reflection_equivalents: every measurement of h k l and its Laue equivalents,
 * against the model and against each other.
 */
function equivalentsView(s: SingleCrystalLiveState, h: number, k: number, l: number): Record<string, unknown> {
  const rotations = laueRotations(s.structure.spaceGroup.operations);
  const key = canonicalKey(rotations, h, k, l);
  const fitted = new Set(s.rows.map((r) => `${r.h},${r.k},${r.l},${r.foSq},${r.sigma}`));
  const matches = s.allRows.filter((r) => canonicalKey(rotations, r.h, r.k, r.l) === key);
  if (matches.length === 0) return { reflection: `${h} ${k} ${l}`, measured: 0, note: "Neither it nor an equivalent is in the data." };
  // The median, not the weighted mean: one failed measurement with a small σ
  // (most of the peak missed, so few counts) drags a weighted mean to itself
  // (sapphire's 5 4 1 pulled its family's mean from ≈ 1400 to 340).
  const sorted = matches.map((r) => r.foSq).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const weighted = matches.filter((r) => r.sigma > 0);
  const spread = weighted.length > 1 ? Math.sqrt(weighted.reduce((a, r) => a + ((r.foSq - median) / r.sigma) ** 2, 0) / (weighted.length - 1)) : undefined;
  return {
    reflection: `${h} ${k} ${l}`,
    measured: matches.length,
    medianFoSq: sig(median, 5),
    fcSq: sig(matches.reduce((a, r) => a + r.fcSq, 0) / matches.length, 5),
    ...(spread !== undefined ? { scatterInSigma: sig(spread, 3) } : {}),
    measurements: matches.map((r) => [
      hklOf(r),
      ...(r.batch !== undefined ? [`batch ${r.batch}`] : []),
      ...(r.wavelength !== undefined ? [`λ ${sig(r.wavelength, 4)} Å`] : []),
      `Fo² ${sig(r.foSq, 5)}(${sig(r.sigma, 3)})`,
      `Fc² ${sig(r.fcSq, 5)}`,
      `${sig(r.deltaOverSigma, 3)}σ from Fc²`,
      ...(r.sigma > 0 ? [`${sig((r.foSq - median) / r.sigma, 3)}σ from the median`] : []),
      ...(r.extinction !== undefined && r.extinction < 1 ? [`y ${sig(r.extinction, 3)}`] : []),
      ...(fitted.has(`${r.h},${r.k},${r.l},${r.foSq},${r.sigma}`) ? [] : [isOmitted(r, s.omitted) ? "omitted" : !inResolution(r, s.structure.cell, s.resolution) ? "outside the resolution range" : "left out by the filter"]),
    ].join(", ")),
    reading: "Equivalents agree to their σ (scatter ≈ 1) when each was measured well. One far from the others, which agree with Fc², failed (a detector edge, a gap, a shadow); all off the same way is the model's misfit, or a correction (extinction, absorption) that differs with wavelength.",
  };
}

/** How hard the extinction correction bites: the smallest y, and how many reflections it reduces a lot. */
function extinctionView(rows: readonly SingleCrystalRow[]): Record<string, unknown> | null {
  const ys = rows.filter((r) => r.extinction !== undefined && r.extinction < 1);
  if (ys.length === 0) return null;
  const min = ys.reduce((m, r) => (r.extinction! < m.extinction! ? r : m));
  return {
    yMin: `${sig(min.extinction!, 3)} at ${hklOf(min)} (Fo² ${sig(min.foSq, 4)})`,
    belowPoint8: ys.filter((r) => r.extinction! < 0.8).length,
    belowPoint5: ys.filter((r) => r.extinction! < 0.5).length,
    reading: "y multiplies |F|² in Fc²: y = 0.6 takes 40 % off. Below about 0.7–0.8 the correction is severe: the extinction model carries those reflections, and their Fo² say little about the structure.",
  };
}

function validationOf(s: SingleCrystalLiveState): ScValidation {
  return singleCrystalValidation({
    rows: s.rows.map((r) => ({ h: r.h, k: r.k, l: r.l, foSq: r.foSq, fcSq: r.fcSq, ...(r.sigma > 0 ? { sigma: r.sigma } : {}) })),
    // Fitting the merge, each shell's R_int still reads the measurement.
    ...(s.dataset.merged ? { measurement: s.measurement.map((m) => ({ h: m.h, k: m.k, l: m.l, intensity: m.iObs, sigma: m.sigma ?? 0 })) } : {}),
    cell: s.structure.cell,
    spaceGroup: s.structure.spaceGroup,
    nParams: s.parameters.filter((p) => !p.fixed && !p.expression).length,
    // The analysis of variance with the fit's own weights.
    ...(s.weighting ? { weights: shelxWeights(s.rows.map((r) => r.foSq), s.rows.map((r) => r.fcSq), s.rows.map((r) => r.sigma), s.weighting.a, s.weighting.b, overallScale(s)) } : {}),
  });
}

function stateView(s: SingleCrystalLiveState, history: ProjectHistory | null, select: readonly string[] | undefined): Record<string, unknown> {
  const ph = s.refinedStructure;
  const r = s.dataset.radiation;
  const ag = s.agreement;
  return {
    technique: "singleCrystal",
    source: s.source,
    busy: s.busy,
    phase: {
      name: ph.name || ph.id,
      spaceGroup: ph.spaceGroup.hermannMauguin ?? ph.spaceGroup.number,
      cell: cellOf(ph),
      sites: ph.sites.map((site) => `${site.label} ${site.element}`),
      adpModel: s.adpModel,
      ...disorderView(s),
      ...(s.structureFile ? { shelxInstructions: s.structureFile, shelxReading: "What the SHELX file's refinement applied. None of it is applied here until you set it: set_twin for TWIN and BASF, set_weighting for WGHT, the extinction for EXTI (not against a listing, whose Fo² have it divided out), set_riding_hydrogens for AFIX and the hydrogens' U (sharedU for a free variable on the U column)." } : {}),
      ...(s.inverted ? { hand: s.inverted } : {}),
      ...polarView(s),
      note: "The cell is fixed input from indexing: intensities carry no peak positions.",
    },
    data: {
      probe: s.probe === "xray" ? "X-ray" : s.probe === "neutron" ? "neutron, constant wavelength" : "neutron, time of flight (Laue)",
      ...(r.kind !== "neutron-tof" ? { wavelength: r.wavelength } : {}),
      reflectionsInFile: s.totalReflections,
      fitted: s.observationCount,
      merging: {
        unique: quotedMerge(s).unique,
        ...(s.merge.friedelApart ? { uniqueNote: `the Friedel mates apart and the absences left out, as SHELXL merges this group; ${s.merge.unique} in the Laue class` } : {}),
        redundancy: sig(quotedMerge(s).redundancy, 3),
        rInt: rIntOf(s),
        rSigma: pct(quotedMerge(s).rSigma),
        ...(s.merge.dMin !== undefined ? { dMin: sig(s.merge.dMin, 4) } : {}),
        fitted: s.dataset.merged ? mergedText(s) : s.dataset.origin === "refinement-listing" ? "the listing as it is: each reflection once, as the refinement that wrote it merged them" : quotedMerge(s).redundancy > 1 + 1e-9 ? "every measurement, each equivalent apart (merge_equivalents merges them as SHELXL does)" : "each reflection once",
      },
      ...(s.dataset.origin === "refinement-listing" ? { origin: LISTING_NOTE } : {}),
      outlierFilter: s.outlierFilter.on ? `on at ${s.outlierFilter.cutoffSigma}σ${s.outlierFilter.minExtinction !== undefined ? ` and y ≥ ${s.outlierFilter.minExtinction}` : ""}: ${s.outlierFilter.excluded} reflections left out` : "off",
      omitted: s.omitted.length ? s.omitted.map((o) => `${omittedText(o)}${o.reason ? `: ${o.reason}` : ""}`) : "none",
      resolution: s.resolution.dMin === undefined && s.resolution.dMax === undefined ? "the full range" : `${rangeText(s.resolution)}: ${s.resolution.excluded} reflections outside`,
      weights: weightingText(s.weighting),
      anomalousScattering: s.dataset.radiation.kind !== "xray" ? "none (neutrons)" : anomalousLine(s) ? `f′, f″ at ${anomalousLine(s)} (Cromer & Liberman)` : `none: no tabulated line at λ ${s.dataset.radiation.wavelength} Å`,
      twin: s.twinLaws.length ? s.twinLaws.map(twinText).join("; ") : "none",
      restraints: restraintsLine(s),
      extinctionModel: extinctionLabel(s),
    },
    agreement: { R1: pct(ag.r1), wR2: pct(ag.wr2), GooF: sig(ag.goof, 4), observed: ag.observed, total: ag.total, note: `R1 over Fo² > 2σ; wR2 and GooF over every reflection fitted, ${s.weighting ? `weighted by WGHT ${s.weighting.a} ${s.weighting.b}` : "w = 1/σ²"}.` },
    magneticModel: s.magnetic,
    lastRefinement: s.result ? { status: s.result.status, iterations: s.result.history.length, ...(s.result.diagnostics ? { maxShiftOverEsd: sig(s.result.diagnostics.maxShiftOverEsd, 3) } : {}) } : null,
    ...parameterSummary(s.parameters, s.result?.esd, select),
    history: historyView(history),
  };
}

/**
 * The model's disorder, as SHELXL's PARTs: each assembly's alternatives with
 * their occupancies and the sum, and how the occupancies are tied (or that
 * they are not).
 */
function disorderView(s: SingleCrystalLiveState): { disorder?: string[] } {
  const sites = s.refinedStructure.sites.filter((site) => site.disorder);
  if (sites.length === 0) return {};
  const assemblies = [...new Set(sites.map((site) => site.disorder!.assembly))];
  return {
    disorder: assemblies.map((a) => {
      const members = sites.filter((site) => site.disorder!.assembly === a);
      const parts = [...new Set(members.map((site) => site.disorder!.group))].sort((x, y) => x - y).map((g) => {
        const these = members.filter((site) => site.disorder!.group === g);
        return { g, labels: these.map((site) => site.label), occ: these[0]!.occupancy };
      });
      const sum = parts.reduce((t, x) => t + x.occ, 0);
      const ties = members.flatMap((site) => {
        const row = s.parameters.find((p) => p.id === `occ_${site.label}`);
        return row?.expression ? [`${row.id} ${row.expression}`] : [];
      });
      return `assembly ${a || "(unnamed)"}: ${parts.map((x) => `part ${x.g} ${x.labels.join(" ")} at occupancy ${x.occ.toFixed(3)}`).join("; ")} — Σ ${sum.toFixed(3)}; ${ties.length ? `tied: ${ties.join(", ")}` : "the occupancies are not tied: tie_parameters `complement` makes them add up to one, and the split refines as one fraction"}`;
    }),
  };
}

/** A polar group's floating origin: what holds it in the fit (SHELXL's restraint), or that nothing needs to. */
function polarView(s: SingleCrystalLiveState): Record<string, unknown> {
  const directions = polarDirections(s.structure.spaceGroup.operations);
  if (directions.length === 0) return {};
  const floating = floatingOrigins(s.refinedStructure, s.parameters, s.bindings);
  const axes = directions.map((d) => (d[0] === 1 && d[1] === 0 && d[2] === 0 ? "a" : d[0] === 0 && d[1] === 1 && d[2] === 0 ? "b" : d[0] === 0 && d[1] === 0 && d[2] === 1 ? "c" : `[${d.join(" ")}]`));
  return {
    polarAxes: `${axes.join(", ")}: the origin floats along ${axes.length === 1 ? "it" : "them"}. ${floating.length
      ? `With every coordinate along ${floating.map((f) => f.axis).join(", ")} free, the fit holds the weighted mean coordinate (Z² weights) by a restraint, as SHELXL does (one per direction, counted with the restraints): nothing to fix by hand.`
      : "While an atom's coordinate along it is held, the origin is fixed and needs no restraint."}`,
  };
}

/** The overall scale on screen (SHELXL's OSF²): WGHT's b is on the absolute scale, so its term on these data is scale·b·P. */
const overallScale = (s: SingleCrystalLiveState): number => s.parameters.find((p) => p.kind === "scale")?.value ?? 1;

/** What the fit runs on when the equivalents are merged. */
function mergedText(s: SingleCrystalLiveState): string {
  const m = s.dataset.merged!;
  const absences = m.absences ? `, ${m.absences} systematic absence${m.absences === 1 ? "" : "s"} left out${m.absentMeasurements ? ` (${m.absentMeasurements} of the measurements: ${m.from - m.absentMeasurements} without them, the count SHELXL reports)` : ""}` : "";
  return `the equivalents merged as SHELXL's MERG 2: ${m.from} measurements → ${s.dataset.reflections.length} reflections, ${m.friedelApart ? "the Friedel opposites apart" : "the Friedel opposites merged (centrosymmetric)"}${absences}`;
}

/** reflection_statistics: the data before the model. */
function statisticsView(s: SingleCrystalLiveState): Record<string, unknown> {
  const v = validationOf(s);
  const ops = s.structure.spaceGroup.operations;
  const special = s.structure.sites.filter((site) => allowedPositionShifts(ops, site.position).basis.length < 3).length;
  // The data as measured: with the fit on the merged set, the measurement as loaded (its absences, its Friedel pairs).
  const read = s.dataset.merged ? s.measurement.map((r) => ({ h: r.h, k: r.k, l: r.l, intensity: r.iObs, sigma: r.sigma ?? 0 })) : s.rows.map((r) => ({ h: r.h, k: r.k, l: r.l, intensity: r.foSq, sigma: r.sigma }));
  const st = reflectionStatistics(read, s.structure.cell, s.structure.spaceGroup, { sites: s.structure.sites.length, special, twinned: s.twinLaws.some((l) => !isInversion(l)) });
  const f = st.friedel;
  const hkl = (x: { h: number; k: number; l: number }): string => `${x.h} ${x.k} ${x.l}`;
  return {
    reflections: {
      [s.dataset.origin === "refinement-listing" ? "listed" : "measured"]: s.dataset.merged ? s.totalReflections : s.observationCount,
      // Data holding each reflection once (a listing, or merged) count as the merge that keeps the Friedel mates apart: a mate is not a repeat.
      unique: quotedMerge(s).redundancy > 1 + 1e-9 ? s.merge.unique : quotedMerge(s).unique,
      redundancy: sig(quotedMerge(s).redundancy > 1 + 1e-9 ? s.merge.redundancy : quotedMerge(s).redundancy, 3),
      // A listing (or merged data) holds each reflection once: its Laue-class "R_int" is only the Bijvoet pairs' anomalous difference.
      rInt: quotedMerge(s).redundancy > 1 + 1e-9 ? pct(s.merge.rInt) : rIntOf(s),
      ...(f.rIntApart !== undefined && quotedMerge(s).redundancy > 1 + 1e-9 ? { rIntFriedelApart: pct(f.rIntApart), rIntNote: "rInt merges each reflection's Laue-class equivalents, the Friedel mates among them; rIntFriedelApart keeps the mates apart and leaves the absences out, as SHELXL merges a non-centrosymmetric group and reports it. The difference is what the mates differ by: the anomalous signal." } : {}),
      rSigma: pct(quotedMerge(s).redundancy > 1 + 1e-9 ? s.merge.rSigma : quotedMerge(s).rSigma),
      ...(s.dataset.merged ? { fitted: mergedText(s) } : {}),
    },
    ...(s.dataset.origin === "refinement-listing" ? { origin: LISTING_NOTE } : {}),
    resolution: { dMin: sig(v.dMin, 4), sinThetaOverLambdaMax: sig(v.sinThetaOverLambdaMax, 4), ...(v.completeness !== undefined ? { completeness: pct(v.completeness) } : {}), uniqueAllowed: v.uniqueAllowed ?? v.uniqueObserved, ...(v.uniqueExpected !== undefined ? { uniqueExpected: v.uniqueExpected } : {}) },
    shells: v.shells.map((sh) => ({
      d: `${sig(sh.dMax, 3)}–${sig(sh.dMin, 3)} Å`,
      n: sh.n,
      unique: sh.unique,
      ...(sh.completeness !== undefined ? { completeness: pct(sh.completeness) } : {}),
      iOverSigma: sig(sh.iOverSigma, 3),
      ...(sh.rInt !== undefined && quotedMerge(s).redundancy > 1 + 1e-9 ? { rInt: pct(sh.rInt) } : {}),
    })),
    friedel: f.centrosymmetric
      ? "centrosymmetric group: Friedel mates are equivalent; no absolute structure to determine"
      : `${f.withMate} of the ${f.unique - f.centric} acentric reflections unique under the point group have their Friedel mate measured (${pct(f.fraction)} %)${f.centric ? `; ${f.centric} more are centric (no Bijvoet pair)` : ""}${f.fraction < 0.2 ? ": the Friedel pairs were merged (or never measured) — the absolute structure cannot be determined from these data" : ""}`,
    absences: st.absences.measured === 0
      ? "no reflection the space group forbids was measured (or the file left them out)"
      : {
          measured: st.absences.measured,
          atThreeSigma: st.absences.violated.length,
          strongest: st.absences.violated.slice(0, 8).map((a) => `${hkl(a)} (d ${sig(a.d, 4)} Å, ${sig(a.iOverSigma, 3)}σ${a.ofAllowed !== undefined ? `, ${pct(a.ofAllowed)} % of the mean allowed intensity at that d` : ""})`),
          reading: "A few weak ones, at a small fraction of the allowed intensity, are what multiple diffraction (Renninger) gives in a good crystal, or λ/2; a whole class of strong ones questions the group.",
        },
    intensityStatistics: !Number.isFinite(st.intensities.meanAbsE2Minus1) ? "too few reflections"
      : !st.intensities.applies ? { meanAbsE2Minus1: sig(st.intensities.meanAbsE2Minus1, 3), reading: st.intensities.reading }
        : {
            meanAbsE2Minus1: sig(st.intensities.meanAbsE2Minus1, 3),
            fractionWeak: sig(st.intensities.fractionWeak, 3),
            reading: st.intensities.reading,
            expected: "0.968 centrosymmetric, 0.736 non-centrosymmetric, 0.541 for a perfect twin of a non-centrosymmetric crystal (each intensity the mean of two); E² < 0.1 for 24.8 % or 9.5 % of reflections",
            group: v.centrosymmetric ? "the space group is centrosymmetric" : "the space group is non-centrosymmetric",
            note: "From the measured intensities: strong extinction lowers the strong end, and the value with it.",
          },
    twinLaws: twinLawsView(read, s),
    reflectionsPerParameter: sig(v.reflectionsPerParameter, 3),
    ...(measurementView(s) ? { measurement: measurementView(s) } : {}),
  };
}

/** The lattice's merohedral twin laws, each with the fraction Yeates' H-test reads for it from the data alone. */
function twinLawsView(read: readonly { h: number; k: number; l: number; intensity: number; sigma: number }[], s: SingleCrystalLiveState): Record<string, unknown> | string {
  const laws = merohedralTwinLaws(read, s.structure.cell, s.structure.spaceGroup);
  if (laws.length === 0) return "none: the lattice holds no symmetry beyond the Laue class, so no merohedral twin (a pseudo-merohedral one needs a cell that nearly holds more)";
  return {
    laws: laws.map((l) => ({ law: l.matrix, indices: l.indices, pairs: l.pairs, ...(l.pairs > 0 ? { meanH: sig(l.meanH, 3), alpha: sig(l.alpha, 3) } : { alpha: `no ${l.distribution} pair (h, R·h) measured above 3σ: the test has nothing to read for this law` }) })),
    reading: `Yeates' H-test, before any model: over the pairs (h, R·h) both measured above 3σ, ⟨H⟩ = ⟨|I₁ − I₂|/(I₁ + I₂)⟩ = ${laws[0]!.distribution === "centric" ? "(2/π)(1 − 2α) — the group is centrosymmetric, so every reflection is centric and I₁/(I₁ + I₂) follows the arcsine law" : "½ − α over the acentric pairs"}. A law with α well above the others' twins the crystal: set_twin with it, and refine its fraction (the test's α is an estimate; noise lowers it). A perfect twin by one law leaves the others near α ≈ 0.12 (each intensity then the mean of two), and pseudo-symmetry raises every α; all near 0: no merohedral twin.`,
  };
}

/** The numbers the Agent quotes by reference on the single-crystal page ({{R1}}, {{wR2}}, {{GooF}}, {{flack}}, {{verdict}}; {{p:ID}} for any row). */
export function singleCrystalReferences(s: SingleCrystalLiveState): ReferenceEntry[] {
  return [
    { key: "R1", what: "R1 (%) over Fo² > 2σ", value: () => `${pct(s.agreement.r1)} %` },
    { key: "wR2", what: "wR2 (%) over every reflection fitted", value: () => `${pct(s.agreement.wr2)} %` },
    { key: "GooF", what: "the GooF", value: () => s.agreement.goof.toFixed(3) },
    { key: "Nobs", what: "the reflections with Fo² > 2σ", value: () => String(s.agreement.observed) },
    { key: "Nref", what: "the reflections fitted", value: () => String(s.agreement.total) },
    { key: "flack", what: "the Flack x by Parsons' quotients, with its esd", value: () => {
      const v = absoluteStructureView(s);
      return v && typeof v.parsonsX === "string" && v.parsonsX !== "none" ? v.parsonsX : null;
    } },
    { key: "verdict", what: "the engine's verdict on the last refinement (its band)", value: () => {
      if (!s.result) return null;
      return assess_refinement({ result: s.result, parameters: [...s.parameters], observationCount: s.observationCount, mode: "single-crystal", restraints: s.restraints, disorder: disorderAssemblies(s.structure, s.bindings, s.twinLaws) }).verdict.band;
    } },
  ];
}

function assessment(s: SingleCrystalLiveState, kept: ReadonlyMap<string, string>): Record<string, unknown> {
  if (!s.result) throw new Error("there is no refinement result on screen — refine first (a model change clears the last result)");
  const a = assess_refinement({ result: s.result, parameters: [...s.parameters], observationCount: s.observationCount, mode: "single-crystal", restraints: s.restraints, disorder: disorderAssemblies(s.structure, s.bindings, s.twinLaws) });
  const v = validationOf(s);
  const npd = nonPositiveDefiniteSites(s.refinedStructure);
  return {
    ...a,
    agreement: { R1: pct(s.agreement.r1), wR2: pct(s.agreement.wr2), GooF: sig(s.agreement.goof, 4) },
    analysisOfVariance: {
      byIntensity: v.bins.map((b) => ({ fcOverFcMax: `≤ ${sig(b.fcRatioMax, 3)}`, n: b.n, K: sig(b.k, 3), GooF: sig(b.goof, 3) })),
      byResolution: v.shells.map((sh) => ({ d: `${sig(sh.dMax, 3)}–${sig(sh.dMin, 3)} Å`, n: sh.n, K: sig(sh.k, 3), GooF: sig(sh.goof, 3), R1: pct(sh.r1) })),
      reading: "K = ΣFo²/ΣFc² should stay level (near 1 once the scale is right) and GooF level across both: K falling on the strongest reflections, against the other bins, is extinction; K rising on the weakest is twinning or a wrong model; K rising with resolution is ADPs too large (or extinction at low angle); GooF growing with intensity is the weighting.",
    },
    // A listing's Fo² have the extinction of the refinement that wrote it divided out: a level K on the strongest bin shows that correction.
    extinction: s.dataset.origin === "refinement-listing"
      ? `not judged from a listing: its Fo² have the extinction of the refinement that wrote it divided out (SHELXL's LIST 4); the strongest bin's K = ${sig(v.extinction.strongBinK, 3)} (the other bins ${sig(v.extinction.otherBinsK, 3)}) reflects that correction, not the crystal`
      : v.extinction.suspected
      ? `suspected: the strongest bin has K = ${sig(v.extinction.strongBinK, 3)} against ${sig(v.extinction.otherBinsK, 3)} in the other bins, GooF ${sig(v.extinction.strongBinGoof, 3)}; ${v.extinction.strongUnder} of ${v.extinction.outliers} outliers are strong with Fo² < Fc²`
      : `not indicated (strongest bin K = ${sig(v.extinction.strongBinK, 3)}, the other bins ${sig(v.extinction.otherBinsK, 3)})`,
    ...(extinctionView(s.rows) ? { extinctionCorrection: extinctionView(s.rows) } : {}),
    ...(batchView(s.rows) ? { byBatch: batchView(s.rows) } : {}),
    outliers: outliersView(s, 8),
    ...(() => {
      const failed = failedMeasurements(s);
      return failed.length > 0 ? { failedMeasurements: failed.map((r) => `${measurementName(r)}${kept.has(keptKey(r)) ? ` — kept by the user: ${kept.get(keptKey(r))}` : ""}`) } : {};
    })(),
    outliersReading: "Each outlier against its equivalents: one marked a failed measurement goes with omit_reflections (by its batch); a reflection the model misses stays, whatever its residual.",
    ...(s.omitted.length ? { omitted: s.omitted.map((o) => `${omittedText(o)}${o.reason ? `: ${o.reason}` : ""}`) } : {}),
    extinctionModel: extinctionLabel(s),
    ...(twinningView(s) ? { twinning: twinningView(s) } : {}),
    ...((hand) => (hand ? { absoluteStructure: hand } : {}))(absoluteStructureView(s)),
    ...(s.distanceRestraints.length || floatingOrigins(s.refinedStructure, s.parameters, s.bindings).length ? { restraints: restraintsView(s) } : {}),
    weighting: (() => {
      const sug = suggestionOf(s);
      return {
        scheme: weightingText(s.weighting),
        suggested: `WGHT ${sug.a} ${sug.b}: GooF ${sig(sug.goof, 3)}, by intensity bin ${sug.bins.map((g) => sig(g, 3)).join(", ")}`,
        reading: "The weights SHELXL's criterion suggests for the model as it stands: the a and b that bring each of ten Fc² bins' GooF nearest 1, the overall GooF left where that puts it (near √(N/(N−P)), a little above 1). SHELXL prints its own after every run from a coarser search, in the same shallow valley: its numbers can differ by a few thousandths in a and up to about 0.2 in b. Apply it (set_weighting) at the end, when nothing is left to refine, and refine once more; a model error it would absorb shows first in the analysis of variance and the outliers.",
      };
    })(),
    ...(npd.length ? { nonPositiveDefinite: npd } : {}),
    reflectionsPerParameter: sig(v.reflectionsPerParameter, 3),
  };
}

/** The restraints as the fit left them: each one's distances and deviation in σ, and the GooF with them counted. */
/** The restraints in force, as SHELXL counts them: the distance restraints' rows and a polar group's floating origin, one per direction. */
function restraintsLine(s: SingleCrystalLiveState): string {
  const origins = floatingOrigins(s.refinedStructure, s.parameters, s.bindings);
  const n = (s.distanceRestraints.length ? restraintCount(s.distanceRestraints) : 0) + origins.length;
  if (n === 0) return "none";
  const each = [
    ...(s.distanceRestraints.length ? restraintReport(s.refinedStructure, s.distanceRestraints).map((r) => r.text) : []),
    ...origins.map((o) => `the floating origin along ${o.axis} (SHELXL's floating-origin restraint)`),
  ];
  return `${n}: ${each.join("; ")}`;
}

/** The extinction model in use; none when its parameter is held at 0 (as against a listing, whose Fo² have it divided out). */
function extinctionLabel(s: SingleCrystalLiveState): string {
  const ext = s.parameters.find((p) => p.kind === "extinction");
  if (ext && ext.fixed && !ext.expression && ext.value === 0) {
    return s.dataset.origin === "refinement-listing" ? "none: held at 0, the listing's Fo² carrying the correction of the refinement that wrote them" : `none: held at 0 (${EXTINCTION_MODEL_LABELS[s.extinctionModel]} when it refines)`;
  }
  return EXTINCTION_MODEL_LABELS[s.extinctionModel];
}

function restraintsView(s: SingleCrystalLiveState): Record<string, unknown> {
  const report = restraintReport(s.refinedStructure, s.distanceRestraints);
  const { pairs, rows } = restraintRows(s.distanceRestraints);
  const values = restraintValues(s.refinedStructure, pairs, rows);
  const chi2Restraints = rows.reduce((t, row, i) => t + ((values[i]! - row.target) / row.sigma) ** 2, 0);
  // A polar group's floating origin is held by a restraint of its own, one per direction, as SHELXL counts it (it adds nothing to χ²).
  const origins = floatingOrigins(s.refinedStructure, s.parameters, s.bindings);
  const count = rows.length + origins.length;
  const nData = s.observationCount;
  const nFree = s.parameters.filter((p) => !p.fixed && !p.expression).length;
  const goof = s.agreement.goof;
  const restrainedGoof = Math.sqrt((goof * goof * Math.max(nData - nFree, 1) + chi2Restraints) / Math.max(nData + count - nFree, 1));
  return {
    count,
    each: [...report.map((r) => r.text), ...origins.map((o) => `the floating origin along ${o.axis}: the Z²-weighted mean coordinate held (SHELXL's floating-origin restraint)`)],
    restrainedGooF: sig(restrainedGoof, 4),
    reading: "Each restraint is an observation with its own esd: a deviation within 1–2σ is the restraint and the data agreeing; beyond 3σ the data pull against it — check the chemistry, or the data's reach, before tightening it. SHELXL reports the GooF over the data (S) and with the restraints counted (restrained S).",
  };
}

/** The report's checks: the engine's view of the fit on screen. */
export function singleCrystalReportChecks(s: SingleCrystalLiveState, probe: RefinementResult | null = null, kept: ReadonlyMap<string, string> = new Map()): ReportCheck[] {
  if (!s.result || s.structure.sites.length === 0) return [noResultCheck()];
  // A measurement the data say failed, still fitted and not kept by the user: no report on a fit that carries it.
  const failed = failedMeasurements(s);
  const open = failed.filter((r) => !kept.has(keptKey(r)));
  if (open.length > 0) {
    throw new Error(`not yet: ${open.length === 1 ? "a failed measurement is" : `${open.length} failed measurements are`} still fitted (${open.map(measurementName).join(", ")}: off by themselves, their equivalents agreeing with the model). Leave ${open.length === 1 ? "it" : "them"} out with omit_reflections (by batch, with the reason) and refine; or, if the user wants ${open.length === 1 ? "it" : "them"} kept, keep_reflections asks them. Then write the report.`);
  }
  const a = assess_refinement({ result: s.result, parameters: [...s.parameters], observationCount: s.observationCount, mode: "single-crystal", restraints: s.restraints, disorder: disorderAssemblies(s.structure, s.bindings, s.twinLaws) });
  const v = validationOf(s);
  const checks: ReportCheck[] = [
    convergenceCheck(s.result),
    verdictCheck(a),
    probe ? correlationsCheck(probe, s.parameters, s.restraints, undefined, disorderAssemblies(s.structure, s.bindings, s.twinLaws)) : correlationsCheck(s.result, s.parameters, s.restraints, CORRELATION_LISTED, disorderAssemblies(s.structure, s.bindings, s.twinLaws)),
    boundsCheck(s.result, s.parameters),
    {
      name: "Data",
      status: (s.merge.friedelApart ?? s.merge).rInt > 0.1 || (v.completeness !== undefined && v.completeness < 0.95) ? "note" : "pass",
      detail: dataLine(s, v),
    },
    s.dataset.origin === "refinement-listing" ? {
      name: "Extinction",
      status: "note",
      detail: `Held at ${sig(s.parameters.find((p) => p.kind === "extinction")?.value ?? 0, 3)}: the listing's Fo² have the extinction of the refinement that wrote it divided out (SHELXL's LIST 4), so it cannot be judged here; the strongest reflections stand at K = ${sig(v.extinction.strongBinK, 3)} against ${sig(v.extinction.otherBinsK, 3)} in the others.`,
    } : {
      name: "Extinction",
      status: v.extinction.suspected ? "warn" : "pass",
      detail: (v.extinction.suspected
        ? `Strong reflections are weaker than calculated: the strongest bin has K = ${sig(v.extinction.strongBinK, 3)} against ${sig(v.extinction.otherBinsK, 3)} in the others, GooF ${sig(v.extinction.strongBinGoof, 3)}.`
        : `The strongest reflections agree (K = ${sig(v.extinction.strongBinK, 3)} in the strongest bin, ${sig(v.extinction.otherBinsK, 3)} in the others).`) + extinctionLine(s.rows),
    },
  ];
  // The tables a single-crystal listing gives, so the account can quote them.
  checks.push({
    name: "Resolution shells",
    status: "note",
    detail: v.shells.map((sh) => `${sig(sh.dMax, 3)}–${sig(sh.dMin, 3)} Å: ${sh.n} reflections${sh.completeness !== undefined ? `, completeness ${pct(sh.completeness)} %` : ""}, ⟨I/σ⟩ ${sig(sh.iOverSigma, 3)}${sh.rInt !== undefined && quotedMerge(s).redundancy > 1 + 1e-9 ? `, R_int ${pct(sh.rInt)} %` : ""}, K ${sig(sh.k, 3)}, GooF ${sig(sh.goof, 3)}, R1 ${pct(sh.r1)} %`).join("; ") + ".",
  });
  checks.push({
    name: "Analysis of variance",
    status: "note",
    detail: `By intensity (weakest to strongest): ${v.bins.map((b) => `K ${sig(b.k, 3)}, GooF ${sig(b.goof, 3)}`).join("; ")}.`,
  });
  // The scheme in use beside the one SHELXL's criterion suggests for the model as refined, as SHELXL prints both.
  if (s.weighting) {
    const sug = suggestionOf(s);
    checks.push({ name: "Weights", status: "note", detail: `${weightingText(s.weighting)} in use; suggested for the model as refined, by SHELXL's criterion: WGHT ${sug.a} ${sug.b} (GooF ${sig(sug.goof, 3)}, by intensity bin ${sug.bins.map((g) => sig(g, 3)).join(", ")}).` });
  }
  // Against a published refinement loaded with its su's: the shifts, the ADPs and the esds, in the report so the account can quote them.
  if (s.structure.sites.some((site) => site.su)) {
    const cmp = compareWithLoaded(structureTable(s.refinedStructure, 0, s.parameters, s.bindings, s.result.esd), s.refinedStructure, s.structure) as { positions?: string; adps?: string; esds?: Record<string, string> };
    const esds = cmp.esds ? Object.entries(cmp.esds).filter(([k]) => k !== "reading").map(([k, v]) => `${k === "uij" ? "U^ij" : k} ${v}`).join("; ") : "";
    if (cmp.positions) checks.push({ name: "Against the model loaded", status: "note", detail: `${cmp.positions}; ${cmp.adps ?? ""}${esds ? `. Refined esd / published su: ${esds}` : ""}.` });
  }
  const batches = batchView(s.rows);
  if (batches) checks.push({ name: "Batches", status: "note", detail: `${String(batches.batches)} batches, K ${String(batches.K)}; farthest: ${(batches.farthest as string[]).slice(0, 3).join("; ")}.` });
  if (failed.length > 0) checks.push({ name: "Failed measurements kept", status: "warn", detail: `Kept in the fit at the user's word: ${failed.map((r) => `${measurementName(r)} (${kept.get(keptKey(r))})`).join("; ")}.` });
  if (v.outliers.length > 0) {
    checks.push({ name: "Largest outliers", status: "note", detail: outliersView(s, 6).join("; ") + (s.outlierFilter.on ? `; ${s.outlierFilter.excluded} left out by the filter (|Δ|/σ > ${s.outlierFilter.cutoffSigma}${s.outlierFilter.minExtinction !== undefined ? ` or y < ${s.outlierFilter.minExtinction}` : ""}).` : ".") });
  }
  const npd = nonPositiveDefiniteSites(s.refinedStructure);
  if (npd.length) checks.push({ name: "ADPs", status: "warn", detail: `Not positive definite: ${npd.join(", ")} — the ellipsoid is unphysical; refine those sites isotropically, or look for disorder.` });
  const bv = bondValenceCheck([s.refinedStructure]);
  if (bv) checks.push(bv);
  checks.push(...findingChecks(a));
  return checks;
}

/**
 * The report's data line, in SHELXL's terms: merged, the measurements and the
 * reflections they became; R_int as SHELXL reports it (a non-centrosymmetric
 * group's with the Friedel mates apart); data per parameter as SHELXL counts them.
 */
function dataLine(s: SingleCrystalLiveState, v: ScValidation): string {
  const m = s.merge;
  const apart = m.friedelApart;
  const merged = s.dataset.merged;
  const quoted = quotedMerge(s);
  // Each reflection once (merged, or a listing): no equivalents to compare. In an acentric group the Laue-class
  // figure would only measure the Bijvoet pairs' anomalous difference.
  const rInt = quoted.redundancy <= 1 + 1e-9
    ? `R_int n/a, ${s.dataset.origin === "refinement-listing" ? "a listing" : "merged data"}: each reflection once${apart ? ", its Friedel mate apart" : ""}`
    : apart ? `R_int ${pct(apart.rInt)} % with the Friedel mates apart, as SHELXL reports it (${pct(m.rInt)} % in the Laue class)` : `R_int ${pct(m.rInt)} %`;
  const counts = merged
    ? mergedOnlyAbsences(merged, s.dataset.reflections.length)
      ? `${merged.from} reflections in the file, each once (merged by its data reduction${merged.friedelApart ? ", the Friedel opposites apart" : ""}), ${merged.absences ? `the ${merged.absences} systematic absences left out as SHELXL's MERG 2 leaves them: ` : ""}${s.dataset.reflections.length} fitted${s.observationCount < s.dataset.reflections.length ? ` (${s.observationCount} after the omissions)` : ""}`
      : `${merged.from} measurements merged as SHELXL's MERG 2 into ${s.dataset.reflections.length} reflections${merged.friedelApart ? ", the Friedel opposites apart" : ""}${s.observationCount < s.dataset.reflections.length ? `, ${s.observationCount} of them fitted` : ""}`
    : `${s.observationCount} reflections, ${quoted.unique} unique${apart ? " with the Friedel mates apart" : ""}`;
  const pairs = v.independent > (v.uniqueAllowed ?? v.uniqueObserved) ? " (the Friedel pairs apart, as SHELXL counts its data)" : "";
  return `${counts} (${rInt}, R_σ ${pct((apart ?? m).rSigma)} %), d_min ${sig(v.dMin, 4)} Å (sinθ/λ ${sig(v.sinThetaOverLambdaMax, 3)} Å⁻¹)${v.completeness !== undefined ? `, completeness ${pct(v.completeness)} %` : ""}; ${sig(v.reflectionsPerParameter, 3)} independent reflections per free parameter${pairs}.${s.dataset.origin === "refinement-listing" ? ` ${LISTING_NOTE}` : ""}`;
}

/** The correction's reach, for the report: the smallest y and how many reflections fall below 0.8. */
function extinctionLine(rows: readonly SingleCrystalRow[]): string {
  const ext = extinctionView(rows);
  return ext ? ` The correction reaches y = ${String(ext.yMin)}; ${String(ext.belowPoint8)} reflections have y < 0.8.` : "";
}
