/**
 * Single-crystal **joint nuclear + magnetic co-refinement** (Phase 2): fit one
 * StructureModel + one MagneticModel simultaneously against TWO integrated-
 * intensity datasets — a nuclear .int and a magnetic .int — with a user-weighted
 * combined objective
 *
 *   χ²_total = w_N · χ²_N + w_M · χ²_M
 *
 * The engine is data-agnostic (it minimises Σ w(obs−calc)² over one flat
 * observations/weights vector), so the joint objective is assembled by
 * CONCATENATING the two datasets' rows — nuclear block first, then magnetic —
 * and folding the per-block weights w_N, w_M into the weight vector. No engine
 * change is needed; the block scalars realise the weighted sum exactly.
 *
 * Block forward models (unpolarized neutrons ⇒ no nuclear–magnetic interference):
 *   nuclear:   I = k_N · L(θ) · P(θ) · y_ext · |F_N|²      (reflectionIntensity)
 *   magnetic:  I = k_M · L(θ) · P(θ) ·          |F_M⊥|²
 * with k_N the kind-`scale` value and k_M the kind-`magneticScale` value (routing
 * is by ParameterKind, not by dataset id). The single-crystal Lorentz factor
 * L = 1/sin2θ is purely geometric (identical for nuclear and magnetic scattering
 * at the same 2θ) and P = 1 for neutrons; both are gated by the `lorentz` flag so
 * files already reduced to corrected F² (e.g. FullProf DataRed) are not
 * double-corrected. The magnetic block carries NO secondary extinction (magnetic
 * Bragg intensities are weak; the correction is negligible) — see the extinction
 * and twin/domain plug-in points below.
 *
 * Setting: the model lives in ONE setting; each dataset may carry an integer 3×3
 * `HklTransform` mapping its file indices into the model setting ([h',k',l'] =
 * M·[h,k,l]). This is what lets a base-cell nuclear file co-refine with a
 * magnetic-supercell file: describe the model in the supercell, give the nuclear
 * file the (integer) base→supercell map. Identity when omitted.
 *
 * The magnetic block's precondition is a PURELY magnetic supercell (no nuclear
 * superstructure): supercell-only reflections then carry only magnetic intensity.
 * See docs/REFINEMENT_NOTES.md §8.
 *
 * References: Rodríguez-Carvajal, *Physica B* **192**, 55 (1993) (FullProf multi-
 * pattern weighted co-refinement); Halpern & Johnson, *Phys. Rev.* **55**, 898
 * (1939) (magnetic interaction vector M⊥Q).
 */

import type { StructureModel } from "@/core/crystal/types";
import type { SingleCrystalDataset } from "@/core/diffraction/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { isMomentParameterKind, type ParameterBinding, type RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { weightsFromSigma } from "@/core/refinement/factors";
import { resolveTies } from "@/core/refinement/constraints";
import { applyParameters } from "@/core/workflow/apply";
import { reflectionIntensity } from "@/core/workflow/singleCrystalRefinement";
import { applyMagneticMoments } from "@/core/workflow/magnetic";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { singleCrystalLorentz, polarizationFactor, shelxWeights, singleCrystalAgreement, type SingleCrystalAgreement } from "@/core/diffraction/singleCrystalFactors";
import { dSpacing } from "@/core/crystal/unitCell";

/**
 * Integer 3×3 reflection-index transform, dataset setting → model setting:
 * `[h',k',l']ᵀ = M · [h,k,l]ᵀ`. Rows of M are `[m[0], m[1], m[2]]`. Entries are
 * integers so a transformed index stays an exact integer.
 */
export type HklTransform = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/** Apply an HklTransform (identity when absent). */
function mapHkl(t: HklTransform | undefined, h: number, k: number, l: number): [number, number, number] {
  if (!t) return [h, k, l];
  return [
    t[0][0] * h + t[0][1] * k + t[0][2] * l,
    t[1][0] * h + t[1][1] * k + t[1][2] * l,
    t[2][0] * h + t[2][1] * k + t[2][2] * l,
  ];
}

export interface JointSingleCrystalOptions {
  /** Relative weight on the nuclear block (multiplies its 1/σ² weights). Default 1. */
  readonly weightNuclear?: number;
  /** Relative weight on the magnetic block (multiplies its 1/σ² weights). Default 1. */
  readonly weightMagnetic?: number;
  /** Apply the single-crystal Lorentz–polarization geometry to BOTH blocks.
   *  Default true; false for files already reduced to corrected F². */
  readonly lorentz?: boolean;
  /** Integer index map for the nuclear file → model setting. Identity when omitted. */
  readonly nuclearHklTransform?: HklTransform;
  /** Integer index map for the magnetic file → model setting. Identity when omitted. */
  readonly magneticHklTransform?: HklTransform;
}

/** Magnetic-block intensity for one reflection: k_M · L · P · |F_M⊥|². */
function magneticReflectionIntensity(
  applied: ReturnType<typeof applyParameters>,
  appliedMag: MagneticModel,
  radiation: SingleCrystalDataset["radiation"],
  h: number,
  k: number,
  l: number,
  lorentz: boolean,
): number {
  const model = applied.model;
  const d = dSpacing(model.cell, h, k, l);
  const fm2 = magneticStructureFactor(model, appliedMag, h, k, l).squared;
  const lp = lorentz ? singleCrystalLorentz(radiation, d) * polarizationFactor(radiation, d) : 1;
  return applied.magneticScale * lp * fm2;
}

export interface JointReflectionCalc {
  readonly h: number;
  readonly k: number;
  readonly l: number;
  readonly iObs: number;
  readonly sigma?: number;
  readonly iCalc: number;
}

/** Per-reflection calc for both blocks at a value record (drives comparison + calculate). */
function computeBlocks(
  structure: StructureModel,
  magnetic: MagneticModel,
  nuclearDataset: SingleCrystalDataset,
  magneticDataset: SingleCrystalDataset,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
  opts: JointSingleCrystalOptions,
): { nuclear: JointReflectionCalc[]; magnetic: JointReflectionCalc[] } {
  const lorentz = opts.lorentz ?? true;
  // ONE applyParameters — the updated structure (freed positions/ADP/cell) feeds
  // BOTH blocks, including |F_M⊥|², so a joint fit's structural shifts propagate
  // into the magnetic scattering (unlike the legacy single-dataset path).
  const applied = applyParameters(structure, bindings, values);
  const appliedMag = applyMagneticMoments(magnetic, bindings, values);

  const nuclear = nuclearDataset.reflections.map((r) => {
    const [h, k, l] = mapHkl(opts.nuclearHklTransform, r.h, r.k, r.l);
    return {
      h: r.h, k: r.k, l: r.l, iObs: r.iObs,
      ...(r.sigma !== undefined ? { sigma: r.sigma } : {}),
      iCalc: reflectionIntensity(applied, nuclearDataset, h, k, l, lorentz),
    };
  });
  const magneticRows = magneticDataset.reflections.map((r) => {
    const [h, k, l] = mapHkl(opts.magneticHklTransform, r.h, r.k, r.l);
    return {
      h: r.h, k: r.k, l: r.l, iObs: r.iObs,
      ...(r.sigma !== undefined ? { sigma: r.sigma } : {}),
      iCalc: magneticReflectionIntensity(applied, appliedMag, magneticDataset.radiation, h, k, l, lorentz),
    };
  });
  return { nuclear, magnetic: magneticRows };
}

/**
 * Build the joint two-dataset refinement problem. observations/weights/calculate
 * concatenate the nuclear block then the magnetic block in a FIXED order (the
 * pool splits the Jacobian by column, never by observation, so this order is the
 * spec-derived contract every replica reproduces). Per-block weights fold w_N,
 * w_M onto the 1/σ² statistical weights.
 *
 * EXTINSION / TWIN plug-in point: secondary extinction is applied only inside the
 * nuclear `reflectionIntensity` (SHELXL EXTI); a twin/domain-fraction correction,
 * if added, would scale per-reflection intensities in `computeBlocks` before the
 * block concatenation. Both are out of scope for Phase 2 (see the plan).
 */
export function buildJointSingleCrystalProblem(
  structure: StructureModel,
  magnetic: MagneticModel,
  nuclearDataset: SingleCrystalDataset,
  magneticDataset: SingleCrystalDataset,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  opts: JointSingleCrystalOptions = {},
): RefinementProblem {
  const wN = opts.weightNuclear ?? 1;
  const wM = opts.weightMagnetic ?? 1;
  const nN = nuclearDataset.reflections.length;
  const nM = magneticDataset.reflections.length;

  const observations = new Float64Array(nN + nM);
  for (let i = 0; i < nN; i++) observations[i] = nuclearDataset.reflections[i]!.iObs;
  for (let i = 0; i < nM; i++) observations[nN + i] = magneticDataset.reflections[i]!.iObs;

  const wNuc = weightsFromSigma(nuclearDataset.reflections.map((r) => r.sigma));
  const wMag = weightsFromSigma(magneticDataset.reflections.map((r) => r.sigma));
  const weights = new Float64Array(nN + nM);
  for (let i = 0; i < nN; i++) weights[i] = wN * wNuc[i]!;
  for (let i = 0; i < nM; i++) weights[nN + i] = wM * wMag[i]!;

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    const resolved = resolveTies(parameters, values);
    const { nuclear, magnetic: magneticRows } = computeBlocks(
      structure, magnetic, nuclearDataset, magneticDataset, bindings, resolved, opts,
    );
    const out = new Float64Array(nN + nM);
    for (let i = 0; i < nN; i++) out[i] = nuclear[i]!.iCalc;
    for (let i = 0; i < nM; i++) out[nN + i] = magneticRows[i]!.iCalc;
    return out;
  };

  return { parameters, observations, weights, calculate };
}

export interface JointBlockReport {
  readonly agreement: SingleCrystalAgreement;
  /** Fraction of this block's reflections carrying a usable σ (>0). When < 1 the
   *  block mixes 1/σ² and unit weights, so the w_N/w_M scale is not comparable. */
  readonly sigmaCoverage: number;
}

export interface JointSingleCrystalComparison {
  readonly nuclear: JointBlockReport;
  readonly magnetic: JointBlockReport;
}

function blockReport(rows: readonly JointReflectionCalc[], nParams: number): JointBlockReport {
  const foSq = rows.map((r) => r.iObs);
  const fcSq = rows.map((r) => r.iCalc);
  const sigma = rows.map((r) => r.sigma ?? 0);
  const weights = shelxWeights(foSq, fcSq, sigma, 0, 0);
  const withSigma = sigma.filter((s) => s > 0).length;
  return {
    agreement: singleCrystalAgreement(foSq, fcSq, sigma, weights, nParams),
    sigmaCoverage: rows.length > 0 ? withSigma / rows.length : 1,
  };
}

/**
 * Per-block SHELX F² agreement (R1/wR2/GooF for the nuclear and magnetic blocks
 * separately) plus σ-coverage, computed OUTSIDE the engine — the engine reports a
 * single combined GoF over the stacked residual, so the two R-factors the plan
 * requires surfaced must be sliced per block here.
 */
export function jointSingleCrystalComparison(
  structure: StructureModel,
  magnetic: MagneticModel,
  nuclearDataset: SingleCrystalDataset,
  magneticDataset: SingleCrystalDataset,
  parameters: readonly RefinementParameter[],
  bindings: readonly ParameterBinding[],
  opts: JointSingleCrystalOptions = {},
): JointSingleCrystalComparison {
  const values: Record<string, number> = {};
  for (const p of parameters) values[p.id] = p.value;
  const { nuclear, magnetic: magneticRows } = computeBlocks(
    structure, magnetic, nuclearDataset, magneticDataset, bindings, resolveTies(parameters, values), opts,
  );
  // Attribute free parameters to each block for its GooF dof (N_block − P_block):
  // moment modes + the magnetic scale belong to the magnetic block; everything
  // else (nuclear scale + structural) to the nuclear block. This mirrors the
  // FullProf convention of a magnetic R-factor with the nuclear structure fixed —
  // charging a block only with the parameters that fit it, not the joint total.
  const isMagneticParam = (p: RefinementParameter): boolean => isMomentParameterKind(p.kind) || p.kind === "magneticScale";
  const free = parameters.filter((p) => !p.fixed && !p.expression);
  const freeMagnetic = free.filter(isMagneticParam).length;
  const freeNuclear = free.length - freeMagnetic;
  return {
    nuclear: blockReport(nuclear, freeNuclear),
    magnetic: blockReport(magneticRows, freeMagnetic),
  };
}
