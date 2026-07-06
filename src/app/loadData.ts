/**
 * Wiring for **real, user-supplied observed data** (as opposed to the bundled
 * synthetic self-consistent demo). Given the text of a powder pattern or an HKL
 * reflection list, produce a dataset plus a set of *starting* refinement
 * parameters whose scale is estimated from the data — so a fit against genuinely
 * external data converges from a sensible point instead of a hardcoded guess.
 *
 * These are pure functions (no React) so they can be unit-tested directly.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern, SingleCrystalDataset, SingleCrystalReflection } from "@/core/diffraction/types";
import type { InstrumentParameters } from "@/core/diffraction/instrument";
import type { ParameterBinding, RefinementParameter } from "@/core/refinement/types";
import type { PowderParseOptions } from "@/parsers/powderData";
import { powderParameters, singleCrystalParameters } from "@/examples/synthetic";
import { powderCurves } from "@/core/workflow/powder";
import { singleCrystalComparison } from "@/core/workflow/singleCrystal";
import { parseHkl } from "@/parsers/hkl";
import { parseReflectionList } from "@/parsers/reflectionList";
import { dSpacing } from "@/core/crystal/unitCell";

/**
 * Optimal linear scale s minimizing Σ wᵢ(obsᵢ − s·calcᵢ)², where `calc` is the
 * model evaluated at unit scale. This is the closed-form least-squares scale and
 * gives a robust starting point regardless of the observed data's absolute
 * counts. Background is not subtracted here (the minimal engine has no refined
 * background), so on data with a large flat background the estimate is biased a
 * little high; the subsequent refinement corrects it.
 */
export function optimalScale(
  obs: readonly number[],
  calcUnit: readonly number[],
  weights?: readonly number[],
): number {
  let num = 0;
  let den = 0;
  const n = Math.min(obs.length, calcUnit.length);
  for (let i = 0; i < n; i++) {
    const w = weights?.[i] ?? 1;
    const c = calcUnit[i]!;
    num += w * obs[i]! * c;
    den += w * c * c;
  }
  return den > 0 && Number.isFinite(num / den) ? num / den : 1;
}

/** Parse options derived from the currently loaded instrument calibration. */
export function powderOptsFromInstrument(
  instrument: InstrumentParameters,
  id: string,
  name: string,
): PowderParseOptions {
  if (instrument.kind === "tof") {
    return { id, name, xUnit: "tof", radiation: { kind: "neutron-tof" } };
  }
  return {
    id,
    name,
    xUnit: "twoTheta",
    radiation: { kind: "neutron", wavelength: instrument.wavelength },
    wavelength: instrument.wavelength,
  };
}

/**
 * Starting powder parameters for a loaded pattern: scale estimated from the data
 * and freed, peak width freed, cell held (the user can free it). Nothing here is
 * seeded from a "true" value — the demo's circular self-consistency is gone.
 */
export function startingPowderParams(
  structure: StructureModel,
  pattern: PowderPattern,
  bindings: readonly ParameterBinding[],
): RefinementParameter[] {
  const base = powderParameters(structure, 1); // unit scale for the estimate
  const curves = powderCurves(structure, pattern, base, bindings);
  const s = optimalScale(curves.yObs, curves.yCalc);
  return base.map((p) => {
    if (p.id === "scale") return { ...p, value: s, initialValue: s, fixed: false };
    if (p.id === "width") return { ...p, fixed: false };
    return p;
  });
}

/**
 * Starting single-crystal parameters for a loaded HKL list: scale estimated from
 * the data (unit-scale calc vs observed) and freed.
 */
export function startingSxParams(
  structure: StructureModel,
  dataset: SingleCrystalDataset,
  bindings: readonly ParameterBinding[],
): RefinementParameter[] {
  const base = singleCrystalParameters(1);
  const rows = singleCrystalComparison(structure, dataset, base, bindings);
  const s = optimalScale(rows.map((r) => r.iObs), rows.map((r) => r.iCalc));
  return base.map((p) => (p.id === "scale" ? { ...p, value: s, initialValue: s, fixed: false } : p));
}

export interface LoadedReflections {
  readonly dataset: SingleCrystalDataset;
  /** Reflections whose indices reproduce the file's d-spacing in this phase. */
  readonly kept: number;
  /** Reflections dropped (belong to another phase, e.g. an impurity). */
  readonly dropped: number;
  readonly format: "gsas" | "shelx";
}

/** True when the text looks like a GSAS-II reflection list (has Fo**2 / header). */
export function isGsasReflectionList(text: string): boolean {
  return /Reflection List|Fo\*\*2|Fc\*\*2/i.test(text);
}

/**
 * Build a single-crystal dataset from a reflection file, using observed |F|² as
 * the intensity. GSAS-II `*_hkl.dat` lists are multi-phase (the histogram sees
 * every phase), so reflections are filtered to those whose (h,k,l) reproduces
 * the file's d-spacing **in this structure's cell** — dropping impurity-phase
 * reflections the loaded model cannot describe. A plain `h k l Iobs [σ]` list is
 * taken as-is (no d column to filter on).
 */
export function loadReflectionDataset(
  text: string,
  structure: StructureModel,
  datasetId: string,
  name: string,
): LoadedReflections {
  if (isGsasReflectionList(text)) {
    const rows = parseReflectionList(text);
    const reflections: SingleCrystalReflection[] = [];
    let dropped = 0;
    for (const r of rows) {
      const d = dSpacing(structure.cell, r.h, r.k, r.l);
      if (Number.isFinite(d) && Math.abs(d - r.d) / r.d < 0.01) {
        reflections.push({ h: r.h, k: r.k, l: r.l, iObs: r.foSq });
      } else {
        dropped++;
      }
    }
    return {
      dataset: { id: datasetId, name, radiation: { kind: "neutron-tof" }, reflections },
      kept: reflections.length,
      dropped,
      format: "gsas",
    };
  }
  const reflections = parseHkl(text);
  return {
    dataset: { id: datasetId, name, radiation: { kind: "neutron" as const, wavelength: 1.54 }, reflections },
    kept: reflections.length,
    dropped: 0,
    format: "shelx",
  };
}

/**
 * A structural refinement parameter set for a loaded structure + reflection
 * dataset: an auto-estimated overall scale (freed) and a per-site isotropic B
 * (freed — always safe, no symmetry-direction constraint). Positions/occupancies
 * are intentionally omitted: those can carry special-position constraints the
 * minimal engine does not enforce, so freeing them blindly could break symmetry.
 */
export function structuralParameters(
  structure: StructureModel,
  dataset: SingleCrystalDataset,
): { parameters: RefinementParameter[]; bindings: ParameterBinding[] } {
  const bindings: ParameterBinding[] = [{ parameterId: "scale", kind: "scale", targetId: dataset.id }];
  const scaleGuess = startingSxParams(structure, dataset, bindings)[0]!.value;

  const parameters: RefinementParameter[] = [
    { id: "scale", label: "scale", kind: "scale", value: scaleGuess, initialValue: scaleGuess, min: 0, fixed: false },
  ];
  for (const site of structure.sites) {
    if (site.adp.kind !== "isotropic") continue;
    const b = site.adp.bIso;
    parameters.push({
      id: `${site.label}_Biso`,
      label: `${site.label} B (Å²)`,
      kind: "bIso",
      value: b,
      initialValue: b,
      min: 0,
      fixed: false,
    });
    bindings.push({ parameterId: `${site.label}_Biso`, kind: "bIso", targetId: structure.id, targetKey: site.label });
  }
  return { parameters, bindings };
}
