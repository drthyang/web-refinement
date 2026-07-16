/**
 * Total-scattering composition weighting for pair distribution functions.
 *
 * The reduced PDF G(r) is normalized by the sample-average scattering power. In
 * the REAL-SPACE model (PDFfit2/PDFgui convention) the per-atom weight is
 * Q-INDEPENDENT — neutrons use the constant coherent scattering length b, X-rays
 * use the electron count Z = f(Q=0) (folding the full Q-dependent f(Q) into the
 * pair sum would double-count the form-factor falloff; see PDF_MPDF_ROADMAP §3).
 *
 * This module supplies the composition averages ⟨b⟩, ⟨b²⟩ and the number density
 * ρ₀ that the forward model needs; it does NOT compute the reciprocal-space
 * data-reduction normalization (⟨f(Q)²⟩, Compton, …) — that is the deferred
 * reduction track.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import type { PdfScatteringType } from "@/core/diffraction/types";
import { neutronScatteringLength } from "@/core/scattering/neutron";
import { xrayFormFactor } from "@/core/scattering/xray";
import { cellVolume } from "@/core/crystal/unitCell";

/** Q-independent real-space scattering weight of one atom (fm for n, electrons for X). */
export function speciesWeight(element: string, scatteringType: PdfScatteringType, isotope?: number): number {
  return scatteringType === "neutron"
    ? neutronScatteringLength(element, isotope)
    : xrayFormFactor(element, 0); // f(0) = Z
}

export interface CompositionWeights {
  /** Per-atom scattering weight `o_i · b_i`, aligned with the input atom list. */
  readonly perAtom: Float64Array;
  /** Occupancy-weighted average scattering length ⟨b⟩ = Σ o_i b_i / Σ o_i. */
  readonly bAvg: number;
  /** Occupancy-weighted mean square ⟨b²⟩ = Σ o_i b_i² / Σ o_i (for the Laue term). */
  readonly bSqAvg: number;
  /** Effective atom count in the cell N = Σ o_i. */
  readonly nEff: number;
}

/**
 * Composition averages over one unit cell's atoms. `perAtom[i] = o_i · b_i` is the
 * occupancy-folded weight used directly in the pair amplitude; ⟨b⟩ and N give the
 * `1/(N⟨b⟩²)` normalization and, with the cell volume, the ρ₀ baseline.
 */
export function compositionWeights(atoms: readonly ExpandedAtom[], scatteringType: PdfScatteringType): CompositionWeights {
  const perAtom = new Float64Array(atoms.length);
  let sumOB = 0;
  let sumOBsq = 0;
  let nEff = 0;
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i]!;
    const b = speciesWeight(atom.element, scatteringType, atom.isotope);
    perAtom[i] = atom.occupancy * b;
    sumOB += atom.occupancy * b;
    sumOBsq += atom.occupancy * b * b;
    nEff += atom.occupancy;
  }
  const bAvg = nEff > 0 ? sumOB / nEff : 0;
  const bSqAvg = nEff > 0 ? sumOBsq / nEff : 0;
  return { perAtom, bAvg, bSqAvg, nEff };
}

/** Average number density ρ₀ = N_eff / V_cell (atoms · Å⁻³), for the −4πρ₀r baseline. */
export function numberDensity(nEff: number, cell: UnitCell): number {
  const v = cellVolume(cell);
  return v > 0 ? nEff / v : 0;
}
