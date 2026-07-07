/**
 * Apply a flat parameter-value record onto a domain model, using parameter
 * bindings. This is the bridge between the crystallography-blind engine and the
 * StructureModel / auxiliary scalars the calculators need.
 */

import type { AtomSite, StructureModel, UnitCell } from "@/core/crystal/types";
import type { ParameterBinding } from "@/core/refinement/types";
import type { UAniso } from "@/core/crystal/adpConstraints";

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
  /** Zero-point shift of the abscissa, in the pattern's x-unit. */
  readonly zeroShift: number;
  /** March–Dollase preferred orientation (axis in hkl + ratio). Absent ⇒ none. */
  readonly po?: { readonly axis: [number, number, number]; readonly ratio: number };
  /** Absorption coefficient μR (cylinder radius × linear absorption). 0 ⇒ none. */
  readonly muR: number;
  /** Moment-magnitude scale applied to magnetic moments. */
  readonly momentScale: number;
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
  let profileU: number | undefined;
  let profileV: number | undefined;
  let profileW: number | undefined;
  let profileX: number | undefined;
  let profileY: number | undefined;
  let asymSL: number | undefined;
  let asymHL: number | undefined;
  let muR = 0;
  let po: { axis: [number, number, number]; ratio: number } | undefined;
  const background: number[] = [];

  for (const binding of bindings) {
    const v = values[binding.parameterId];
    if (v === undefined) continue;

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
      case "poRatio":
        po = { axis: (binding.axis ? [...binding.axis] : [0, 0, 1]) as [number, number, number], ratio: v };
        break;
      case "absorption":
        muR = v;
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
  return {
    model: appliedModel,
    scale,
    magneticScale,
    momentScale,
    peakWidth,
    zeroShift,
    muR,
    ...(caglioti ? { caglioti } : {}),
    ...(lorentzian ? { lorentzian } : {}),
    ...(axial ? { axial } : {}),
    ...(po ? { po } : {}),
    background: background.length ? background.map((c) => c ?? 0) : [],
  };
}
