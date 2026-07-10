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

import type { AtomSite, StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import type { PowderPattern } from "@/core/diffraction/types";
import type { LinearRestraint, ParameterBinding, ParameterKind, RefinementParameter } from "@/core/refinement/types";
import type { RefinementOptions } from "@/core/refinement/types";
import { refineStaged, type RefinementStage, type StagedRefinementResult } from "@/core/refinement/staged";
import { buildPowderProblem, type PowderProfile } from "@/core/workflow/powder";
import { independentCellParameters } from "@/core/crystal/cellConstraints";
import { allowedPositionShifts } from "@/core/crystal/siteConstraints";
import { allowedAnisotropicAdpModes } from "@/core/crystal/adpConstraints";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import { quarticStrainInvariants } from "@/core/diffraction/anisoStrain";

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
  /**
   * Lorentzian size–strain coefficients (GSAS-II X,Y) for a Thompson–Cox–Hastings
   * pseudo-Voigt: Γ_L = X/cosθ + Y·tanθ, combined with the Gaussian Caglioti
   * width per peak. When given, X and Y are refined in the profile stage — the
   * peak-shape freedom real synchrotron/CW data needs. Only applies to a 2θ
   * pattern; requires a pseudo-Voigt profile.
   */
  readonly lorentzian?: { readonly x: number; readonly y: number };
  /**
   * Finger–Cox–Jephcoat axial-divergence asymmetry (S/L, H/L). When given, both
   * are refined in the profile stage — essential for the long low-angle tails of
   * high-resolution synchrotron data. Only applies to a 2θ pattern.
   */
  readonly axial?: { readonly sl: number; readonly hl: number };
  /**
   * Time-of-flight calibration + peak-shape seeds. When given (pattern is TOF),
   * the diffractometer constants (difC/difA/difB) are emitted as fixed
   * `tofCalibration` parameters that place the peaks, and the back-to-back-
   * exponential shape coefficients (α/β/σ) as refinable `tofProfile` parameters.
   * Mutually exclusive with `caglioti`/`lorentzian`/`axial` (those are 2θ-only).
   */
  readonly tof?: TofSeed;
  /** Starting zero-point shift in the pattern's x-unit (µs for TOF). Default 0. */
  readonly zero?: number;
  /** Refine the zero-point shift. Default true when `caglioti` or `tof` is set. */
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
  /** Refine symmetry-adapted anisotropic ADP modes for Uani sites. Default follows `refineAdp`. */
  readonly refineAnisotropicAdp?: boolean;
  /** Refine symmetry-adapted atomic positions. Default true. */
  readonly refinePositions?: boolean;
  /** Refine site occupancies. Default false. */
  readonly refineOccupancy?: boolean;
  /**
   * Tie the atomic **position** of atoms sharing one crystallographic site
   * (identical fractional coordinates — a mixed/disordered site, e.g. the six 3d
   * cations of the high-entropy tungstate). One symmetry-adapted position mode is
   * emitted per shared site and bound to every member, so they move together and
   * never split. Default true — atoms literally at the same site must stay
   * coincident. Set false to refine each independently (rarely physical).
   */
  readonly tieSharedPositions?: boolean;
  /** As `tieSharedPositions`, for the isotropic/anisotropic **ADP**. Default true. */
  readonly tieSharedAdp?: boolean;
  /**
   * Add an automatic Σ(occupancy) restraint per shared site, holding the total
   * site occupancy at its starting value while the mixing ratio refines (so the
   * disordered fractions can vary without the whole site emptying or over-filling).
   * Only acts on sites with ≥2 members. Default true.
   */
  readonly restrainSharedOccupancy?: boolean;
  /**
   * Make the shared-site Σ(occupancy) restraint target **1** (a fully-occupied
   * mixed site) instead of the starting-model sum. Default false (keep the sum).
   */
  readonly constrainOccupancyToUnity?: boolean;
  /**
   * Soft linear restraints on occupancies. Use coefficients to express total
   * occupancy, sublattice totals, or charge-balance terms. Targets default to
   * the starting model's weighted sum.
   */
  readonly occupancyRestraints?: readonly OccupancyRestraint[];
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
  /**
   * Emit Stephens (1999) anisotropic-microstrain S parameters — one per
   * symmetry-allowed quartic invariant of the space group. Seeded at 0 (no
   * anisotropic strain) and refined in the microstructure stage. Only meaningful
   * on a 2θ CW pattern. Off by default.
   */
  readonly stephensStrain?: boolean;
  /**
   * Emit uniaxial (spheroidal) anisotropic-size parameters about a unique
   * reciprocal-lattice axis: perpendicular/parallel Lorentzian coefficients,
   * seeded from the isotropic size (`lorentzian.x`) so it starts isotropic. Only
   * meaningful on a 2θ CW pattern. Off by default.
   */
  readonly uniaxialSize?: { readonly axis: readonly [number, number, number] };
  /**
   * Emit uniaxial anisotropic-microstrain parameters about a unique reciprocal
   * axis: equatorial/axial Lorentzian coefficients (GSAS-II "uniaxial" Mustrain),
   * seeded from the isotropic strain (`lorentzian.y`) so it starts isotropic. 2θ
   * CW only. Off by default.
   */
  readonly uniaxialStrain?: { readonly axis: readonly [number, number, number] };
  /**
   * Emit an isotropic microstrain (GSAS-II Mustrain) parameter for **TOF**, in
   * µstrain (×10⁻⁶), seeded at this value. It carries the ∝d² Gaussian strain
   * term (σ_T = |dT/dd|·ε·d), so the redundant instrument `sig1` (σ₁²·d², the
   * same functional form) is **not** emitted when this is set — avoiding an exact
   * refinement degeneracy. TOF only; freed in the microstructure stage.
   */
  readonly mustrainIso?: number;
}

/**
 * Time-of-flight calibration + peak-shape seed values (GSAS-II convention).
 * difC is the primary diffractometer constant (from calibration, held fixed);
 * the α/β/σ coefficients drive the d-dependent back-to-back-exponential widths.
 */
export interface TofSeed {
  readonly difC: number;
  readonly difA?: number;
  readonly difB?: number;
  /** α = α₀ + α₁/d (rising edge, µs⁻¹). */
  readonly alpha0?: number;
  readonly alpha1?: number;
  /** β = β₀ + β₁/d⁴ (falling tail, µs⁻¹). */
  readonly beta0?: number;
  readonly beta1?: number;
  /** σ² = σ₀ + σ₁·d² + σ₂·d⁴ (Gaussian variance, µs²). */
  readonly sig0?: number;
  readonly sig1?: number;
  readonly sig2?: number;
}

export interface StructureRefinementSpec {
  readonly params: RefinementParameter[];
  readonly bindings: ParameterBinding[];
  readonly restraints: LinearRestraint[];
  /** Expert-order stages for `refineStaged` (cumulative). */
  readonly stages: RefinementStage[];
}

export interface OccupancyRestraint {
  readonly id?: string;
  readonly label?: string;
  readonly sites: readonly {
    readonly label: string;
    /** Defaults to the site's crystallographic multiplicity. */
    readonly coefficient?: number;
  }[];
  /** Defaults to the starting model's weighted occupancy sum. */
  readonly target?: number;
  /** Default 0.02 occupancy units after coefficients. */
  readonly sigma?: number;
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
    lorentzian,
    axial,
    tof,
    zero = 0,
    refineZero = caglioti !== undefined || tof !== undefined,
    refineU = false,
    startB = 0.5,
    refineAdp = true,
    refineAnisotropicAdp = refineAdp,
    refinePositions = true,
    refineOccupancy = false,
    tieSharedPositions = true,
    tieSharedAdp = true,
    restrainSharedOccupancy = true,
    constrainOccupancyToUnity = false,
    occupancyRestraints = [],
    positionBound = 0.2,
    preferredOrientation,
    absorption,
    refineAbsorption = false,
    stephensStrain = false,
    uniaxialSize,
    uniaxialStrain,
    mustrainIso,
  } = opts;

  const params: RefinementParameter[] = [];
  const bindings: ParameterBinding[] = [];
  const restraints: LinearRestraint[] = [];

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
  } else if (!tof) {
    params.push({ id: "width", label: "peak FWHM", kind: "peakWidth", value: width, initialValue: width, min: 1e-3, fixed: false });
    bindings.push({ parameterId: "width", kind: "peakWidth", targetId: pattern.id });
  }

  // Time-of-flight profile: fixed diffractometer constants (positions) plus the
  // refinable back-to-back-exponential α/β/σ coefficients (peak shape).
  if (tof) {
    const calib: [string, string, number][] = [
      ["difC", "difC", tof.difC],
      ["difA", "difA", tof.difA ?? 0],
      ["difB", "difB", tof.difB ?? 0],
    ];
    for (const [key, label, value] of calib) {
      // difC/difA/difB come from instrument calibration and are held fixed (they
      // correlate strongly with the cell); the cell + Zero absorb sample offsets.
      params.push({ id: `tof_${key}`, label: `TOF ${label}`, kind: "tofCalibration", value, initialValue: value, fixed: true });
      bindings.push({ parameterId: `tof_${key}`, kind: "tofCalibration", targetId: pattern.id, targetKey: key });
    }
    const prof: [string, string, number, number, number][] = [
      // id, label, value, min, max
      ["alpha0", "α₀", tof.alpha0 ?? 0, 0, 10],
      ["alpha1", "α₁", tof.alpha1 ?? 1, 0, 200],
      ["beta0", "β₀", tof.beta0 ?? 0.03, 1e-4, 10],
      ["beta1", "β₁", tof.beta1 ?? 0, 0, 1e8],
      ["sig0", "σ₀²", tof.sig0 ?? 0, 0, 1e7],
      // σ₁²·d² is the isotropic-strain variance. When an isotropic Mustrain is
      // emitted it carries that term (physical µstrain), so σ₁² is dropped here
      // to keep the two from being an exactly-degenerate free pair.
      ...(mustrainIso === undefined ? [["sig1", "σ₁²", tof.sig1 ?? 200, 0, 1e7]] as [string, string, number, number, number][] : []),
      ["sig2", "σ₂²", tof.sig2 ?? 0, 0, 1e7],
    ];
    for (const [key, label, value, min, max] of prof) {
      params.push({ id: `tof_${key}`, label: `TOF ${label}`, kind: "tofProfile", value, initialValue: value, min, max, fixed: false });
      bindings.push({ parameterId: `tof_${key}`, kind: "tofProfile", targetId: pattern.id, targetKey: key });
    }
  }

  // Lorentzian size–strain (TCH pseudo-Voigt): X (size, 1/cosθ) ≥ 0; Y (strain,
  // tanθ) may be negative. Refined in the profile stage; combined with the
  // Gaussian per peak via the Thompson–Cox–Hastings mixing.
  if (lorentzian) {
    // These are the *sample* Lorentzian terms: X = crystallite size (Scherrer,
    // 1/cosθ), Y = isotropic microstrain (Mustrain, tanθ). Labelled and grouped
    // as microstructure (like GSAS-II's Size/Mustrain sample parameters), not as
    // instrument profile — the instrument's contribution is the U/V/W resolution.
    const xy: [string, "profileX" | "profileY", string, number, number][] = [
      ["profX", "profileX", "size (Lorentzian X)", lorentzian.x, 0],
      ["profY", "profileY", "mustrain (Lorentzian Y)", lorentzian.y, -50],
    ];
    for (const [id, kind, label, value, min] of xy) {
      params.push({ id, label, kind, value, initialValue: value, min, max: 100, fixed: false });
      bindings.push({ parameterId: id, kind, targetId: pattern.id });
    }
  }

  // Finger–Cox–Jephcoat axial-divergence asymmetry (S/L, H/L), both refined.
  if (axial) {
    const shl: [string, "asymSL" | "asymHL", number][] = [
      ["asymSL", "asymSL", axial.sl],
      ["asymHL", "asymHL", axial.hl],
    ];
    for (const [id, kind, value] of shl) {
      params.push({ id, label: id === "asymSL" ? "S/L" : "H/L", kind, value, initialValue: value, min: 0, max: 0.2, fixed: false });
      bindings.push({ parameterId: id, kind, targetId: pattern.id });
    }
  }

  // Zero-point shift (instrument). Degrees for 2θ (±0.5°); µs for TOF (±50 µs).
  if (refineZero) {
    const zBound = tof ? 50 : 0.5;
    params.push({ id: "zero", label: "zero shift", kind: "zeroShift", value: zero, initialValue: zero, min: -zBound, max: zBound, fixed: false });
    bindings.push({ parameterId: "zero", kind: "zeroShift", targetId: pattern.id });
  }

  // Per-site ADP. Isotropic sites refine B_iso; anisotropic sites refine the
  // symmetry-adapted U tensor modes allowed by site symmetry.
  if (refineAdp) {
    for (const g of siteGroups(structure.sites, tieSharedAdp)) {
      if (g.rep.adp.kind !== "isotropic") continue;
      const id = `B_${g.key}`;
      params.push({ id, label: `${groupLabel(g)} B`, kind: "bIso", value: startB, initialValue: startB, min: 0, max: 10, fixed: false });
      for (const m of g.members) {
        if (m.adp.kind === "isotropic") bindings.push({ parameterId: id, kind: "bIso", targetId: structure.id, targetKey: m.label });
      }
    }
  }
  if (refineAnisotropicAdp) {
    for (const g of siteGroups(structure.sites, tieSharedAdp)) {
      if (g.rep.adp.kind !== "anisotropic") continue;
      const allowed = allowedAnisotropicAdpModes(structure.spaceGroup.operations, g.rep.position, g.rep.adp.uAniso);
      allowed.modes.forEach((mode, i) => {
        const id = `U_${g.key}_${i}`;
        const abs = Math.abs(mode.coefficient);
        const span = Math.max(0.02, abs * 4);
        params.push({
          id,
          label: `${groupLabel(g)} ${mode.label}`,
          kind: "uAniso",
          value: mode.coefficient,
          initialValue: mode.coefficient,
          min: mode.diagonal ? 0 : mode.coefficient - span,
          max: mode.diagonal ? Math.max(0.2, mode.coefficient + span) : mode.coefficient + span,
          fixed: false,
        });
        for (const m of g.members) {
          if (m.adp.kind === "anisotropic") bindings.push({ parameterId: id, kind: "uAniso", targetId: structure.id, targetKey: m.label, uBasis: mode.basis });
        }
      });
    }
  }

  // Symmetry-adapted atomic positions. A parameter per free displacement mode,
  // starting at 0 (no shift from the model position). Fully fixed sites (e.g.
  // the origin) emit nothing.
  if (refinePositions) {
    for (const g of siteGroups(structure.sites, tieSharedPositions)) {
      const { basis } = allowedPositionShifts(structure.spaceGroup.operations, g.rep.position);
      basis.forEach((axis, i) => {
        const id = `pos_${g.key}_${i}`;
        // Label by the direction the mode moves: "x"/"y"/"z" for a general site,
        // or the coupled combination for a special site (e.g. "x+y+z" at (x,x,x)).
        const label = `${groupLabel(g)} ${describePositionMode(axis)}`;
        params.push({ id, label, kind: "positionShift", value: 0, initialValue: 0, min: -positionBound, max: positionBound, fixed: false });
        for (const m of g.members) bindings.push({ parameterId: id, kind: "positionShift", targetId: structure.id, targetKey: m.label, axis });
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
    restraints.push(...buildOccupancyRestraints(structure, occupancyRestraints));
    if (restrainSharedOccupancy) restraints.push(...sharedOccupancyRestraints(structure.sites, constrainOccupancyToUnity));
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

  // Anisotropic microstrain (Stephens): one S parameter per symmetry-allowed
  // quartic invariant, seeded at 0 (isotropic) and freed in the microstructure stage.
  if (stephensStrain) {
    const invariants = quarticStrainInvariants(structure.spaceGroup.operations);
    invariants.forEach((inv, i) => {
      params.push({ id: `stephens_${i}`, label: `strain ${inv.label}`, kind: "stephensStrain", value: 0, initialValue: 0, fixed: false });
      bindings.push({ parameterId: `stephens_${i}`, kind: "stephensStrain", targetId: pattern.id, targetKey: String(i) });
    });
  }

  // Uniaxial anisotropic size: perpendicular + parallel Lorentzian coefficients
  // about the given axis, seeded from the isotropic size so it starts isotropic.
  if (uniaxialSize) {
    const seed = lorentzian?.x ?? 1;
    params.push({ id: "sizePerp", label: "size X⊥", kind: "anisoSizePerp", value: seed, initialValue: seed, min: 0, max: 100, fixed: false });
    bindings.push({ parameterId: "sizePerp", kind: "anisoSizePerp", targetId: pattern.id });
    params.push({ id: "sizePar", label: "size X∥", kind: "anisoSizePar", value: seed, initialValue: seed, min: 0, max: 100, fixed: false });
    bindings.push({ parameterId: "sizePar", kind: "anisoSizePar", targetId: pattern.id, axis: [...uniaxialSize.axis] });
  }

  // Uniaxial anisotropic microstrain (GSAS-II "uniaxial" Mustrain): equatorial +
  // axial Lorentzian coefficients about the axis, seeded from the isotropic strain.
  if (uniaxialStrain) {
    const seed = lorentzian?.y ?? 0;
    params.push({ id: "mustrainPerp", label: "mustrain Y⊥", kind: "mustrainPerp", value: seed, initialValue: seed, min: 0, max: 200, fixed: false });
    bindings.push({ parameterId: "mustrainPerp", kind: "mustrainPerp", targetId: pattern.id });
    params.push({ id: "mustrainPar", label: "mustrain Y∥", kind: "mustrainPar", value: seed, initialValue: seed, min: 0, max: 200, fixed: false });
    bindings.push({ parameterId: "mustrainPar", kind: "mustrainPar", targetId: pattern.id, axis: [...uniaxialStrain.axis] });
  }

  // Isotropic microstrain (GSAS-II Mustrain) for TOF: a single µstrain (×10⁻⁶)
  // sample parameter carrying the ∝d² Gaussian strain term. Seeded from the
  // instrument resolution (so the initial peak widths are unchanged) and freed
  // in the microstructure stage; the readout deconvolutes the seed.
  if (mustrainIso !== undefined) {
    params.push({ id: "mustrainIso", label: "mustrain (×10⁻⁶)", kind: "mustrainIso", value: mustrainIso, initialValue: mustrainIso, min: 0, max: 1e5, fixed: false });
    bindings.push({ parameterId: "mustrainIso", kind: "mustrainIso", targetId: pattern.id });
  }

  return { params, bindings, restraints, stages: defaultStages() };
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
    buildPowderProblem(structure, pattern, params, spec.bindings, profile, spec.restraints);
  return refineStaged(spec.params, buildProblem, spec.stages, options);
}

function buildOccupancyRestraints(
  structure: StructureModel,
  specs: readonly OccupancyRestraint[],
): LinearRestraint[] {
  const byLabel = new Map(structure.sites.map((s) => [s.label, s]));
  return specs.map((spec, idx) => {
    const terms = spec.sites.map((siteSpec) => {
      const site = byLabel.get(siteSpec.label);
      if (!site) throw new Error(`Unknown occupancy restraint site: ${siteSpec.label}`);
      const coefficient = siteSpec.coefficient ?? site.multiplicity ?? siteMultiplicity(structure.spaceGroup.operations, site.position);
      return { parameterId: `occ_${site.label}`, coefficient };
    });
    const target = spec.target ?? terms.reduce((acc, term) => {
      const label = term.parameterId.slice("occ_".length);
      return acc + term.coefficient * (byLabel.get(label)?.occupancy ?? 0);
    }, 0);
    return {
      id: spec.id ?? `occ_restraint_${idx}`,
      label: spec.label ?? `occupancy restraint ${idx + 1}`,
      target,
      sigma: spec.sigma ?? 0.02,
      terms,
    };
  });
}

/** A set of atom sites treated as one crystallographic site for tying. */
interface SiteGroup {
  readonly key: string;
  readonly rep: AtomSite;
  readonly members: readonly AtomSite[];
}

/** True if two fractional positions coincide (periodic, per-component). */
function positionsCoincide(a: Vec3, b: Vec3, tol = 1e-3): boolean {
  for (let i = 0; i < 3; i++) {
    let d = Math.abs(a[i]! - b[i]!);
    d = Math.min(d, 1 - d); // wrap across the cell boundary
    if (d > tol) return false;
  }
  return true;
}

/**
 * Group atom sites that share a fractional position — a mixed/disordered
 * crystallographic site (e.g. the six 3d cations of the high-entropy tungstate).
 * With `tie = false` every site is its own group (independent parameters). The
 * group key is the first member's label, so ordered structures keep their
 * original parameter ids.
 */
export function siteGroups(sites: readonly AtomSite[], tie = true): SiteGroup[] {
  if (!tie) return sites.map((s) => ({ key: s.label, rep: s, members: [s] }));
  const groups: { key: string; rep: AtomSite; members: AtomSite[] }[] = [];
  for (const s of sites) {
    const g = groups.find((grp) => positionsCoincide(grp.rep.position, s.position));
    if (g) g.members.push(s);
    else groups.push({ key: s.label, rep: s, members: [s] });
  }
  return groups;
}

/** Parameter label for a group: "Co1" alone, or "Co1+5" for a shared site. */
function groupLabel(g: SiteGroup): string {
  return g.members.length > 1 ? `${g.rep.label}+${g.members.length - 1}` : g.rep.label;
}

/**
 * Automatic Σ(occupancy) restraint per shared site: holds the total site
 * occupancy so the disordered mixing ratio can refine without the site emptying
 * or over-filling. Coefficient 1 per member (fractional occupancies of one site
 * sum directly); only sites with ≥2 members get one.
 *
 * `toUnity` sets the target to exactly **1** (a fully-occupied mixed site — the
 * common physical case) instead of the starting-model sum.
 */
function sharedOccupancyRestraints(sites: readonly AtomSite[], toUnity = false): LinearRestraint[] {
  const out: LinearRestraint[] = [];
  for (const g of siteGroups(sites, true)) {
    if (g.members.length < 2) continue;
    const startSum = g.members.reduce((acc, m) => acc + m.occupancy, 0);
    out.push({
      id: `occ_sum_${g.key}`,
      label: `Σ occ @ ${g.rep.label} site${toUnity ? " = 1" : ""}`,
      target: toUnity ? 1 : startSum,
      sigma: 0.01,
      terms: g.members.map((m) => ({ parameterId: `occ_${m.label}`, coefficient: 1 })),
    });
  }
  return out;
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
  { name: "profile", kinds: ["peakWidth", "profileU", "profileV", "profileW", "profileX", "profileY", "asymSL", "asymHL", "zeroShift", "tofCalibration", "tofProfile"] },
  { name: "ADP", kinds: ["bIso", "uAniso"] },
  { name: "positions", kinds: ["positionShift"] },
  { name: "occupancy", kinds: ["occupancy"] },
  { name: "microstructure", kinds: ["stephensStrain", "anisoSizePerp", "anisoSizePar", "mustrainPerp", "mustrainPar", "mustrainIso"] },
  { name: "corrections", kinds: ["poRatio", "absorption"] },
];

/** Reconstruct predicate stages from the serializable kind-group plan. */
export function stagesFromKindGroups(groups: readonly StageKinds[]): RefinementStage[] {
  return groups.map((g) => ({ name: g.name, select: byKind(...g.kinds) }));
}

export function defaultStages(): RefinementStage[] {
  return stagesFromKindGroups(DEFAULT_STAGE_KINDS);
}
