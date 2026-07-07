/**
 * Assemble a full powder *structure* refinement: the symmetry-reduced parameter
 * set (scale, background, cell, profile width, per-site ADP, and symmetry-adapted
 * atomic positions), the bindings that map each parameter back onto the model,
 * and a staged plan that unlocks them in the expert order.
 *
 * This is the piece that turns the powder path from "scale + width + cell" into
 * genuine Rietveld structure refinement: atomic coordinates are refined as
 * symmetry-adapted displacement modes (so special-position atoms stay on their
 * sites), and isotropic ADPs damp the high-angle intensities.
 */

import type { StructureModel } from "@/core/crystal/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { RefinementOptions } from "@/core/refinement/types";
import { refineStaged, type RefinementStage, type StagedRefinementResult } from "@/core/refinement/staged";
import { buildPowderProblem, type PowderProfile } from "@/core/workflow/powder";
import { independentCellParameters } from "@/core/crystal/cellConstraints";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";

export interface StructureRefinementOptions {
  /** Starting scale factor (seed with `optimalScale` for real data). Default 1. */
  readonly scale?: number;
  /** Number of Chebyshev background terms. Default 4; 0 disables background. */
  readonly backgroundTerms?: number;
  /** Starting peak FWHM in the pattern's x-unit. Default 0.1. Used only when
   *  `caglioti` is absent (single-width fallback). */
  readonly width?: number;
  /**
   * Caglioti Gaussian width coefficients (GSAS-II, centidegrees²) for an
   * angle-dependent FWHM² = U·tan²θ + V·tanθ + W. When given (e.g. seeded from a
   * `.instprm` file), U/V/W are refined as instrument parameters and the single
   * `width` is dropped. Only applies to a 2θ pattern.
   */
  readonly caglioti?: { readonly u: number; readonly v: number; readonly w: number };
  /** Starting zero-point shift in the pattern's x-unit. Default 0. */
  readonly zero?: number;
  /** Refine the zero-point shift. Default true when `caglioti` is provided. */
  readonly refineZero?: boolean;
  /**
   * Refine the Caglioti U (tan²θ) term. Default false: over a narrow low-angle
   * range tan²θ is tiny, so U is nearly unconstrained and drifts to unphysical
   * values, trading off against W. Keep it fixed at the instrument value and let
   * V and W absorb sample broadening.
   */
  readonly refineU?: boolean;
  /** Starting isotropic B for every site, in Å². Default 0.5. */
  readonly startB?: number;
  /** Refine per-site isotropic ADP (B_iso). Default true. */
  readonly refineAdp?: boolean;
  /** Refine symmetry-adapted atomic positions. Default true. */
  readonly refinePositions?: boolean;
  /** Refine site occupancies. Default false. */
  readonly refineOccupancy?: boolean;
  /** Max fractional shift of a positional mode from its start. Default 0.2. */
  readonly positionBound?: number;
  /**
   * March–Dollase preferred orientation on one axis (reciprocal-lattice hkl).
   * The ratio r (1 = random) is refined in the corrections stage. Only add this
   * when a systematic hkl-family intensity mismatch justifies it.
   */
  readonly preferredOrientation?: { readonly axis: readonly [number, number, number]; readonly ratio?: number };
  /**
   * Debye–Scherrer cylinder absorption: starting μR (linear absorption × capillary
   * radius). Refined in the corrections stage when `refineAbsorption` is set.
   */
  readonly absorption?: number;
  /** Refine μR. Default false (correlates strongly with scale and ADP). */
  readonly refineAbsorption?: boolean;
}

export interface StructureRefinementSpec {
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  /** Expert-order stages for `refineStaged` (cumulative). */
  readonly stages: RefinementStage[];
}

/**
 * Build the parameter set, bindings, and staged plan for a powder structure
 * refinement of `structure` against `pattern`. All parameters start `fixed:
 * false`; the staged plan controls the unlock order, so a one-shot `refine` on
 * this set is also valid (it just frees everything at once).
 */
export function buildStructureRefinement(
  structure: StructureModel,
  pattern: PowderPattern,
  opts: StructureRefinementOptions = {},
): StructureRefinementSpec {
  const {
    scale = 1,
    backgroundTerms = 4,
    width = 0.1,
    caglioti,
    zero = 0,
    refineZero = caglioti !== undefined,
    refineU = false,
    startB = 0.5,
    refineAdp = true,
    refinePositions = true,
    refineOccupancy = false,
    positionBound = 0.2,
    preferredOrientation,
    absorption,
    refineAbsorption = false,
  } = opts;

  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];

  // Scale.
  params.push({ id: "scale", label: "scale", kind: "scale", value: scale, initialValue: scale, min: 0, fixed: false });
  bindings.push({ parameterId: "scale", kind: "scale", targetId: pattern.id });

  // Chebyshev background.
  for (let k = 0; k < backgroundTerms; k++) {
    const id = `bkg${k}`;
    const v = k === 0 ? 1 : 0;
    params.push({ id, label: `bkg c${k}`, kind: "background", value: v, initialValue: v, fixed: false });
    bindings.push({ parameterId: id, kind: "background", targetId: pattern.id, targetKey: String(k) });
  }

  // Cell (symmetry-reduced): one parameter per independent lattice parameter.
  for (const spec of independentCellParameters(structure)) {
    params.push({ id: spec.id, label: spec.label, kind: spec.kind, value: spec.value, initialValue: spec.value, fixed: false });
    for (const target of spec.targets) {
      bindings.push({ parameterId: spec.id, kind: spec.kind, targetId: structure.id, targetKey: target });
    }
  }

  // Profile: an angle-dependent Caglioti width (instrument U,V,W) when seeded,
  // otherwise a single FWHM. U,V,W are refined as instrument parameters.
  if (caglioti) {
    const uvw: [string, "profileU" | "profileV" | "profileW", number, boolean][] = [
      ["profU", "profileU", caglioti.u, !refineU],
      ["profV", "profileV", caglioti.v, false],
      ["profW", "profileW", caglioti.w, false],
    ];
    for (const [id, kind, value, fixed] of uvw) {
      params.push({ id, label: id.replace("prof", "prof "), kind, value, initialValue: value, fixed });
      bindings.push({ parameterId: id, kind, targetId: pattern.id });
    }
  } else {
    params.push({ id: "width", label: "peak FWHM", kind: "peakWidth", value: width, initialValue: width, min: 1e-3, fixed: false });
    bindings.push({ parameterId: "width", kind: "peakWidth", targetId: pattern.id });
  }

  // Zero-point shift (instrument).
  if (refineZero) {
    params.push({ id: "zero", label: "zero shift", kind: "zeroShift", value: zero, initialValue: zero, min: -0.5, max: 0.5, fixed: false });
    bindings.push({ parameterId: "zero", kind: "zeroShift", targetId: pattern.id });
  }

  // Per-site isotropic ADP.
  if (refineAdp) {
    for (const site of structure.sites) {
      if (site.adp.kind !== "isotropic") continue;
      const id = `B_${site.label}`;
      params.push({ id, label: `${site.label} B`, kind: "bIso", value: startB, initialValue: startB, min: 0, max: 10, fixed: false });
      bindings.push({ parameterId: id, kind: "bIso", targetId: structure.id, targetKey: site.label });
    }
  }

  // Symmetry-adapted atomic positions. A parameter per free displacement mode,
  // starting at 0 (no shift from the model position). Fully fixed sites (e.g.
  // the origin) emit nothing.
  if (refinePositions) {
    for (const site of structure.sites) {
      const { basis } = allowedPositionShifts(structure.spaceGroup.operations, site.position);
      basis.forEach((axis, i) => {
        const id = `pos_${site.label}_${i}`;
        // Label by the direction the mode moves: "x"/"y"/"z" for a general site,
        // or the coupled combination for a special site (e.g. "x+y+z" at (x,x,x)).
        const label = `${site.label} ${describePositionMode(axis)}`;
        params.push({ id, label, kind: "positionShift", value: 0, initialValue: 0, min: -positionBound, max: positionBound, fixed: false });
        bindings.push({ parameterId: id, kind: "positionShift", targetId: structure.id, targetKey: site.label, axis });
      });
    }
  }

  // Occupancies (optional; off by default — correlates strongly with scale/ADP).
  if (refineOccupancy) {
    for (const site of structure.sites) {
      const id = `occ_${site.label}`;
      params.push({ id, label: `${site.label} occ`, kind: "occupancy", value: site.occupancy, initialValue: site.occupancy, min: 0, max: 1, fixed: false });
      bindings.push({ parameterId: id, kind: "occupancy", targetId: structure.id, targetKey: site.label });
    }
  }

  // Corrections: preferred orientation (March–Dollase) and cylinder absorption.
  if (preferredOrientation) {
    params.push({ id: "po", label: "MD ratio", kind: "poRatio", value: preferredOrientation.ratio ?? 1, initialValue: preferredOrientation.ratio ?? 1, min: 0.2, max: 5, fixed: false });
    bindings.push({ parameterId: "po", kind: "poRatio", targetId: pattern.id, axis: [...preferredOrientation.axis] });
  }
  if (absorption !== undefined) {
    params.push({ id: "absorption", label: "μR", kind: "absorption", value: absorption, initialValue: absorption, min: 0, max: 10, fixed: !refineAbsorption });
    bindings.push({ parameterId: "absorption", kind: "absorption", targetId: pattern.id });
  }

  return { params, bindings, stages: defaultStages() };
}

/**
 * Run a staged powder structure refinement end to end: build the powder problem
 * from the current parameters each stage, unlock in the expert order, and return
 * the converged parameters (with esds) plus per-stage results.
 */
export function refinePowderStructure(
  structure: StructureModel,
  pattern: PowderPattern,
  spec: StructureRefinementSpec,
  profile: PowderProfile = { shape: "gaussian" },
  options: Partial<RefinementOptions> = {},
): StagedRefinementResult {
  const buildProblem = (params: readonly RefinementParameter[]) =>
    buildPowderProblem(structure, pattern, params, spec.bindings, profile);
  return refineStaged(spec.params, buildProblem, spec.stages, options);
}

/**
 * Human label for a positional displacement mode: which fractional coordinates
 * move and in what proportion. A general position gives pure "x"/"y"/"z"; a
 * special position gives the coupled combination the site symmetry allows, e.g.
 * "x+y+z" for a body-diagonal (x,x,x) site or "x+2y" for a (x,2x,z)-type site.
 */
export function describePositionMode(axis: readonly [number, number, number]): string {
  const names = ["x", "y", "z"];
  const nz = axis.map((c, i) => ({ c, i })).filter((o) => Math.abs(o.c) > 1e-6);
  if (nz.length === 0) return "·";
  const minAbs = Math.min(...nz.map((o) => Math.abs(o.c)));
  return nz
    .map(({ c, i }, idx) => {
      const k = Math.round((c / minAbs) * 100) / 100;
      const mag = Math.abs(k);
      const coeff = Math.abs(mag - 1) < 1e-6 ? "" : Number.isInteger(mag) ? String(mag) : mag.toFixed(2);
      const sign = k < 0 ? "−" : idx === 0 ? "" : "+";
      return `${sign}${coeff}${names[i]}`;
    })
    .join("");
}

const byKind = (...kinds: RefinementParameter["kind"][]): ((p: RefinementParameter) => boolean) => {
  const set = new Set(kinds);
  return (p) => set.has(p.kind);
};

/** One stage's name and the parameter kinds it unlocks — a serializable form of
 *  the stage plan (predicates are not structured-clone-safe for the worker). */
export interface StageKinds {
  readonly name: string;
  readonly kinds: readonly ParameterKind[];
}

/**
 * Expert unlock order. Cumulative: each stage adds its group to the free set and
 * co-refines with everything freed before it. Strong, near-linear parameters
 * (scale, background) go first so later gradients are trustworthy; correlated,
 * weakly-acting parameters (ADP, positions, occupancy) go last.
 */
export const DEFAULT_STAGE_KINDS: readonly StageKinds[] = [
  { name: "scale", kinds: ["scale"] },
  { name: "background", kinds: ["background"] },
  { name: "cell", kinds: ["cellLength", "cellAngle"] },
  { name: "profile", kinds: ["peakWidth", "profileU", "profileV", "profileW", "zeroShift"] },
  { name: "ADP", kinds: ["bIso"] },
  { name: "positions", kinds: ["positionShift"] },
  { name: "occupancy", kinds: ["occupancy"] },
  { name: "corrections", kinds: ["poRatio", "absorption"] },
];

/** Reconstruct predicate stages from the serializable kind-group plan. */
export function stagesFromKindGroups(groups: readonly StageKinds[]): RefinementStage[] {
  return groups.map((g) => ({ name: g.name, select: byKind(...g.kinds) }));
}

export function defaultStages(): RefinementStage[] {
  return stagesFromKindGroups(DEFAULT_STAGE_KINDS);
}
