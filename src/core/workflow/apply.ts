/**
 * Apply a flat parameter-value record onto a domain model, using parameter
 * bindings. This is the bridge between the crystallography-blind engine and the
 * StructureModel / auxiliary scalars the calculators need.
 */

import type { AtomSite, StructureModel, UnitCell } from "@/core/crystal/types";
import type { ParameterBinding } from "@/core/refinement/types";
import type { UAniso } from "@/core/crystal/adpConstraints";
import { isCorrectionKind, type CorrectionValues } from "@/core/diffraction/corrections";

export interface AppliedModel {
  readonly model: StructureModel;
  readonly scale: number;
  readonly magneticScale: number;
  /** Background polynomial coefficients by ascending power. */
  readonly background: number[];
  /** Single peak-width parameter (FWHM proxy / Caglioti W). */
  readonly peakWidth: number;
  /**
   * Caglioti profile coefficients (GSAS-II convention, centidegrees²):
   * FWHM² = U·tan²θ + V·tanθ + W. Present only when a profileU/V/W binding is
   * supplied; then the angle-dependent width supersedes `peakWidth`.
   */
  readonly caglioti?: { readonly u: number; readonly v: number; readonly w: number };
  /**
   * Lorentzian size–strain coefficients (GSAS-II X,Y) for the Thompson–Cox–
   * Hastings pseudo-Voigt: Γ_L = X/cosθ + Y·tanθ. Present only when a
   * profileX/profileY binding is supplied; combined with the Gaussian Caglioti
   * width per peak. Only applies to a 2θ pattern.
   */
  readonly lorentzian?: { readonly x: number; readonly y: number };
  /**
   * Finger–Cox–Jephcoat axial-divergence asymmetry (S/L, H/L): the sample and
   * detector-slit half-heights over the diffractometer radius. Present only when
   * an asymSL/asymHL binding is supplied; drives the low-angle peak asymmetry.
   * Only applies to a 2θ pattern.
   */
  readonly axial?: { readonly sl: number; readonly hl: number };
  /**
   * Time-of-flight diffractometer constants (GSAS-II convention, µs):
   * TOF = Zero + difC·d + difA·d² + difB/d. Present only when a `tofCalibration`
   * binding is supplied; drives TOF peak positions. Zero is carried by
   * `zeroShift`. Only applies to a TOF pattern.
   */
  readonly tof?: { readonly difC: number; readonly difA: number; readonly difB: number };
  /**
   * Time-of-flight peak-shape coefficients (GSAS-II convention). The d-dependent
   * rise/decay/Gaussian widths of the back-to-back-exponential profile:
   *   α = α₀ + α₁/d,  β = β₀ + β₁/d⁴,  σ² = σ₀ + σ₁·d² + σ₂·d⁴.
   * Present only when a `tofProfile` binding is supplied. Only applies to a TOF
   * pattern.
   */
  readonly tofProfile?: {
    readonly alpha0: number; readonly alpha1: number;
    readonly beta0: number; readonly beta1: number; readonly betaQ: number;
    readonly sig0: number; readonly sig1: number; readonly sig2: number; readonly sigQ: number;
  };
  /** Zero-point shift of the abscissa, in the pattern's x-unit. */
  readonly zeroShift: number;
  /**
   * Bound peak-correction values keyed by ParameterKind — the sample-geometry
   * and intensity corrections (displacement, transparency, absorption μR, Suortti
   * roughness). The forward model reads these through the correction registry
   * (`core/diffraction/corrections`); an absent kind means the correction's
   * identity (no-op). One bag replaces the former per-correction fields so a new
   * correction is one registry descriptor, not another field + switch case here.
   */
  readonly corrections: CorrectionValues;
  /** March–Dollase preferred orientation (axis in hkl + ratio). Absent ⇒ none. */
  readonly po?: { readonly axis: [number, number, number]; readonly ratio: number };
  /** Secondary-extinction parameter (SHELXL EXTI). 0 ⇒ none. */
  readonly extinction: number;
  /**
   * Stephens anisotropic-microstrain S coefficients, indexed by symmetry-allowed
   * invariant (order from `quarticStrainInvariants`). Present only when bound;
   * the invariants themselves are recomputed from the space group where used.
   */
  readonly stephensStrain?: number[];
  /**
   * Uniaxial (spheroidal) anisotropic size: perpendicular/parallel Lorentzian
   * coefficients about a unique reciprocal-lattice axis. Present only when bound.
   */
  readonly uniaxialSize?: { readonly xPerp: number; readonly xPar: number; readonly axis: [number, number, number] };
  /** Uniaxial anisotropic microstrain: equatorial/axial Lorentzian coefficients
   *  about a unique reciprocal-lattice axis. Present only when bound. */
  readonly uniaxialStrain?: { readonly yPerp: number; readonly yPar: number; readonly axis: [number, number, number] };
  /**
   * Isotropic microstrain ε = Δd/d (dimensionless) for TOF, GSAS-II Mustrain.
   * Adds σ_T = |dT/dd|·ε·d in quadrature to the TOF Gaussian variance. Present
   * only when bound (a `mustrainIso` parameter, stored in µstrain, ×10⁻⁶).
   */
  readonly mustrainIso?: number;
  /** Moment-magnitude scale applied to magnetic moments. */
  readonly momentScale: number;
  /**
   * Pair-distribution-function parameters (real-space G(r) fit): the overall
   * PDF scale, the Qdamp/Qbroad instrument-resolution envelope (Å⁻¹), and the
   * δ1/δ2 correlated-motion sharpening (Å, Å²). Present only when a PDF kind is
   * bound (a PDF refinement problem); the reciprocal-space workflows never see it.
   */
  readonly pdf?: {
    readonly scale: number;
    readonly qdamp: number;
    readonly qbroad: number;
    readonly delta1: number;
    readonly delta2: number;
    /** Spherical-particle diameter (Å); 0 disables the envelope (bulk). */
    readonly spdiameter: number;
    /** Near-neighbour width ratio (≤1) applied below rcut; 1 disables. */
    readonly sratio: number;
    /** Cutoff (Å) for the sratio sharpening; 0 disables. */
    readonly rcut: number;
  };
  /**
   * Magnetic-PDF (mPDF) parameters (roadmap P4). Present only when an mPDF kind
   * is bound (a magnetic PDF problem); every other workflow ignores it.
   */
  readonly mpdf?: {
    /** Scale of the ordered (spin-pair) d_mag(r) component. */
    readonly ordScale: number;
    /** Scale of the paramagnetic self-scattering component. */
    readonly paraScale: number;
    /** Gaussian broadening σ (Å) of the magnetic pair peaks. */
    readonly psigma: number;
    /** Exponential short-range-order damping length ξ (Å); 0 = infinite. */
    readonly corrLength: number;
  };
}

type MutableCell = { -readonly [K in keyof UnitCell]: UnitCell[K] };

export function applyParameters(
  model: StructureModel,
  bindings: readonly ParameterBinding[],
  values: Readonly<Record<string, number>>,
): AppliedModel {
  const cell: MutableCell = { ...model.cell };
  const sites: AtomSite[] = model.sites.map((s) => ({
    ...s,
    position: [...s.position] as [number, number, number],
    adp: s.adp.kind === "anisotropic"
      ? { kind: "anisotropic", uAniso: [...s.adp.uAniso] as [number, number, number, number, number, number] }
      : { kind: "isotropic", bIso: s.adp.bIso },
  }));
  const byLabel = new Map(sites.map((s) => [s.label, s]));
  const uAnisoByLabel = new Map<string, [number, number, number, number, number, number]>();

  let scale = 1;
  let magneticScale = 1;
  let momentScale = 1;
  let peakWidth = 0.1;
  let zeroShift = 0;
  const corrections: CorrectionValues = {};
  let profileU: number | undefined;
  let profileV: number | undefined;
  let profileW: number | undefined;
  let profileX: number | undefined;
  let profileY: number | undefined;
  let asymSL: number | undefined;
  let asymHL: number | undefined;
  let extinction = 0;
  let po: { axis: [number, number, number]; ratio: number } | undefined;
  const stephensS = new Map<number, number>();
  let sizePerp: number | undefined;
  let sizePar: number | undefined;
  let sizeAxis: [number, number, number] | undefined;
  let mustrainPerp: number | undefined;
  let mustrainPar: number | undefined;
  let mustrainAxis: [number, number, number] | undefined;
  let mustrainIsoMu: number | undefined; // isotropic microstrain, µstrain (×10⁻⁶)
  const background: number[] = [];
  const tofCal = new Map<string, number>();
  const tofProf = new Map<string, number>();
  const pdfVals = new Map<string, number>();
  const mpdfVals = new Map<string, number>();

  for (const binding of bindings) {
    const v = values[binding.parameterId];
    if (v === undefined) continue;

    // Peak corrections (displacement, transparency, absorption, roughness) flow
    // into one bag keyed by kind; the registry owns their forward-model math.
    if (isCorrectionKind(binding.kind)) {
      corrections[binding.kind] = v;
      continue;
    }

    switch (binding.kind) {
      case "scale":
        scale = v;
        break;
      case "magneticScale":
        magneticScale = v;
        break;
      case "peakWidth":
        peakWidth = v;
        break;
      case "profileU":
        profileU = v;
        break;
      case "profileV":
        profileV = v;
        break;
      case "profileW":
        profileW = v;
        break;
      case "profileX":
        profileX = v;
        break;
      case "profileY":
        profileY = v;
        break;
      case "asymSL":
        asymSL = v;
        break;
      case "asymHL":
        asymHL = v;
        break;
      case "background": {
        const idx = binding.targetKey ? Number(binding.targetKey) : 0;
        background[idx] = v;
        break;
      }
      case "cellLength":
      case "cellAngle": {
        if (binding.targetKey && binding.targetKey in cell) {
          (cell as Record<string, number>)[binding.targetKey] = v;
        }
        break;
      }
      case "atomX":
      case "atomY":
      case "atomZ": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site) {
          const idx = binding.kind === "atomX" ? 0 : binding.kind === "atomY" ? 1 : 2;
          (site.position as [number, number, number])[idx] = v;
        }
        break;
      }
      case "positionShift": {
        // Symmetry-adapted mode: shift the site along `axis` by `v` (fractional),
        // anchored at the model's stored position. Coupled coordinates move
        // together, keeping the atom on its special position.
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site && binding.axis) {
          const p = site.position as [number, number, number];
          for (let i = 0; i < 3; i++) p[i] = p[i]! + v * binding.axis[i]!;
        }
        break;
      }
      case "occupancy": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site) (site as { occupancy: number }).occupancy = v;
        break;
      }
      case "bIso": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site && site.adp.kind === "isotropic") {
          (site as { adp: { kind: "isotropic"; bIso: number } }).adp = { kind: "isotropic", bIso: v };
        }
        break;
      }
      case "uAniso": {
        const site = binding.targetKey ? byLabel.get(binding.targetKey) : undefined;
        if (site && binding.uBasis) {
          const acc = uAnisoByLabel.get(site.label) ?? [0, 0, 0, 0, 0, 0];
          for (let i = 0; i < 6; i++) acc[i]! += v * binding.uBasis[i]!;
          uAnisoByLabel.set(site.label, acc);
        }
        break;
      }
      case "momentX":
      case "momentY":
      case "momentZ":
        momentScale = v; // moment vector edits handled by magnetic workflow
        break;
      case "zeroShift":
        zeroShift = v;
        break;
      case "tofCalibration":
        if (binding.targetKey) tofCal.set(binding.targetKey, v);
        break;
      case "tofProfile":
        if (binding.targetKey) tofProf.set(binding.targetKey, v);
        break;
      case "poRatio":
        po = { axis: (binding.axis ? [...binding.axis] : [0, 0, 1]) as [number, number, number], ratio: v };
        break;
      case "extinction":
        extinction = v;
        break;
      case "stephensStrain":
        if (binding.targetKey !== undefined) stephensS.set(Number(binding.targetKey), v);
        break;
      case "anisoSizePerp":
        sizePerp = v;
        break;
      case "anisoSizePar":
        sizePar = v;
        if (binding.axis) sizeAxis = [...binding.axis] as [number, number, number];
        break;
      case "mustrainPerp":
        mustrainPerp = v;
        break;
      case "mustrainPar":
        mustrainPar = v;
        if (binding.axis) mustrainAxis = [...binding.axis] as [number, number, number];
        break;
      case "mustrainIso":
        mustrainIsoMu = v;
        break;
      case "pdfScale":
      case "qdamp":
      case "qbroad":
      case "delta1":
      case "delta2":
      case "spdiameter":
      case "sratio":
      case "rcut":
        pdfVals.set(binding.kind, v);
        break;
      case "mpdfOrdScale":
      case "mpdfParaScale":
      case "mpdfPsigma":
      case "corrLength":
        mpdfVals.set(binding.kind, v);
        break;
    }
  }

  for (const [label, u] of uAnisoByLabel) {
    const site = byLabel.get(label);
    if (site) (site as { adp: { kind: "anisotropic"; uAniso: UAniso } }).adp = { kind: "anisotropic", uAniso: u };
  }

  const appliedModel: StructureModel = { ...model, cell, sites };
  const caglioti =
    profileU !== undefined || profileV !== undefined || profileW !== undefined
      ? { u: profileU ?? 0, v: profileV ?? 0, w: profileW ?? 0 }
      : undefined;
  const lorentzian =
    profileX !== undefined || profileY !== undefined
      ? { x: profileX ?? 0, y: profileY ?? 0 }
      : undefined;
  const axial =
    asymSL !== undefined || asymHL !== undefined
      ? { sl: asymSL ?? 0, hl: asymHL ?? 0 }
      : undefined;
  const tof = tofCal.size
    ? { difC: tofCal.get("difC") ?? 0, difA: tofCal.get("difA") ?? 0, difB: tofCal.get("difB") ?? 0 }
    : undefined;
  const tofProfile = tofProf.size
    ? {
        alpha0: tofProf.get("alpha0") ?? 0, alpha1: tofProf.get("alpha1") ?? 0,
        beta0: tofProf.get("beta0") ?? 0, beta1: tofProf.get("beta1") ?? 0, betaQ: tofProf.get("betaQ") ?? 0,
        sig0: tofProf.get("sig0") ?? 0, sig1: tofProf.get("sig1") ?? 0, sig2: tofProf.get("sig2") ?? 0, sigQ: tofProf.get("sigQ") ?? 0,
      }
    : undefined;
  const stephensStrain = stephensS.size
    ? Array.from({ length: Math.max(...stephensS.keys()) + 1 }, (_, i) => stephensS.get(i) ?? 0)
    : undefined;
  const uniaxialSize =
    sizePerp !== undefined || sizePar !== undefined
      ? { xPerp: sizePerp ?? 0, xPar: sizePar ?? sizePerp ?? 0, axis: sizeAxis ?? ([0, 0, 1] as [number, number, number]) }
      : undefined;
  const uniaxialStrain =
    mustrainPerp !== undefined || mustrainPar !== undefined
      ? { yPerp: mustrainPerp ?? 0, yPar: mustrainPar ?? mustrainPerp ?? 0, axis: mustrainAxis ?? ([0, 0, 1] as [number, number, number]) }
      : undefined;
  const pdf = pdfVals.size
    ? {
        scale: pdfVals.get("pdfScale") ?? 1,
        qdamp: pdfVals.get("qdamp") ?? 0,
        qbroad: pdfVals.get("qbroad") ?? 0,
        delta1: pdfVals.get("delta1") ?? 0,
        delta2: pdfVals.get("delta2") ?? 0,
        spdiameter: pdfVals.get("spdiameter") ?? 0,
        sratio: pdfVals.get("sratio") ?? 1,
        rcut: pdfVals.get("rcut") ?? 0,
      }
    : undefined;
  const mpdf = mpdfVals.size
    ? {
        ordScale: mpdfVals.get("mpdfOrdScale") ?? 1,
        paraScale: mpdfVals.get("mpdfParaScale") ?? 1,
        psigma: mpdfVals.get("mpdfPsigma") ?? 0.1,
        corrLength: mpdfVals.get("corrLength") ?? 0,
      }
    : undefined;

  return {
    model: appliedModel,
    scale,
    magneticScale,
    momentScale,
    peakWidth,
    zeroShift,
    corrections,
    extinction,
    ...(stephensStrain ? { stephensStrain } : {}),
    ...(uniaxialSize ? { uniaxialSize } : {}),
    ...(uniaxialStrain ? { uniaxialStrain } : {}),
    ...(mustrainIsoMu !== undefined ? { mustrainIso: mustrainIsoMu * 1e-6 } : {}),
    ...(caglioti ? { caglioti } : {}),
    ...(lorentzian ? { lorentzian } : {}),
    ...(axial ? { axial } : {}),
    ...(tof ? { tof } : {}),
    ...(tofProfile ? { tofProfile } : {}),
    ...(pdf ? { pdf } : {}),
    ...(mpdf ? { mpdf } : {}),
    ...(po ? { po } : {}),
    background: background.length ? background.map((c) => c ?? 0) : [],
  };
}
