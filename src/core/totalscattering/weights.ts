/**
 * Total-scattering composition weighting for pair distribution functions.
 *
 * The reduced PDF G(r) is normalized by the sample-average scattering power. In
 * the REAL-SPACE model (PDFfit2/PDFgui convention) the per-atom weight is
 * Q-INDEPENDENT — neutrons use the constant coherent scattering length b
 * (complex for absorbing nuclei, see CompositionWeights), X-rays
 * use the electron count Z = f(Q=0) (folding the full Q-dependent f(Q) into the
 * pair sum would double-count the form-factor falloff; see PDF_MPDF_ROADMAP §3).
 *
 * This module supplies the composition averages ⟨b⟩, ⟨b²⟩ and the number density
 * ρ₀ that the forward model needs; it does NOT compute the reciprocal-space
 * data-reduction normalization (⟨f(Q)²⟩, Compton, …) — that is the deferred
 * reduction track.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { Complex } from "@/core/math/types";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import type { PdfScatteringType } from "@/core/diffraction/types";
import { neutronAmplitude } from "@/core/scattering/neutron";
import { xrayFormFactor } from "@/core/scattering/xray";
import { cellVolume } from "@/core/crystal/unitCell";

/**
 * Q-independent real-space scattering amplitude of one atom: the neutron
 * amplitude conj(b) in fm (complex for absorbing nuclei), or the X-ray electron
 * count Z = f(0) (real).
 */
export function speciesAmplitude(element: string, scatteringType: PdfScatteringType, isotope?: number): Complex {
  return scatteringType === "neutron"
    ? neutronAmplitude(element, isotope)
    : { re: xrayFormFactor(element, 0), im: 0 }; // f(0) = Z
}

/**
 * Composition weights. With complex amplitudes the powder-averaged pair weight
 * is Re(w_i·w_j*) = w′_i·w′_j + w″_i·w″_j (the Debye sum over ordered pairs is
 * real), and the normalization uses |⟨b⟩|² and ⟨|b|²⟩. When every species is
 * real (X-rays, and neutrons without B/Cd/In/Sm/Eu/Gd/Dy) the imaginary parts
 * are absent and every quantity is the plain real one.
 */
export interface CompositionWeights {
  /** Per-atom weight `o_i · Re(b_i)`, aligned with the input atom list. */
  readonly perAtom: Float64Array;
  /** Per-atom `o_i · Im(b_i)`; null when every species has a real amplitude. */
  readonly perAtomIm: Float64Array | null;
  /** Re⟨b⟩, the occupancy-weighted average Σ o_i Re(b_i) / Σ o_i. */
  readonly bAvg: number;
  /** Im⟨b⟩ (0 when `perAtomIm` is null). */
  readonly bAvgIm: number;
  /** |⟨b⟩|² — the G(r) normalization; exactly bAvg² for real amplitudes. */
  readonly bAvgAbs2: number;
  /** Occupancy-weighted mean square ⟨|b|²⟩ = Σ o_i |b_i|² / Σ o_i (for the Laue term). */
  readonly bSqAvg: number;
  /** Effective atom count in the cell N = Σ o_i. */
  readonly nEff: number;
}

/** Pair weight Re(w_i·w_j*) from composition weights (see {@link CompositionWeights}). */
export function pairWeight(weights: CompositionWeights, i: number, j: number): number {
  const im = weights.perAtomIm;
  return im
    ? weights.perAtom[i]! * weights.perAtom[j]! + im[i]! * im[j]!
    : weights.perAtom[i]! * weights.perAtom[j]!;
}

/**
 * Composition averages over one unit cell's atoms. `perAtom[i] = o_i · b_i` is the
 * occupancy-folded weight used directly in the pair amplitude; |⟨b⟩|² and N give
 * the `1/(N|⟨b⟩|²)` normalization and, with the cell volume, the ρ₀ baseline.
 */
export function compositionWeights(atoms: readonly ExpandedAtom[], scatteringType: PdfScatteringType): CompositionWeights {
  const perAtom = new Float64Array(atoms.length);
  let perAtomIm: Float64Array | null = null;
  let sumOB = 0;
  let sumOBIm = 0;
  let sumOBsq = 0;
  let nEff = 0;
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i]!;
    const amp = speciesAmplitude(atom.element, scatteringType, atom.isotope);
    const b = amp.re;
    perAtom[i] = atom.occupancy * b;
    sumOB += atom.occupancy * b;
    sumOBsq += atom.occupancy * b * b;
    if (amp.im !== 0) {
      perAtomIm ??= new Float64Array(atoms.length);
      perAtomIm[i] = atom.occupancy * amp.im;
      sumOBIm += atom.occupancy * amp.im;
      sumOBsq += atom.occupancy * amp.im * amp.im;
    }
    nEff += atom.occupancy;
  }
  const bAvg = nEff > 0 ? sumOB / nEff : 0;
  const bAvgIm = nEff > 0 ? sumOBIm / nEff : 0;
  const bAvgAbs2 = perAtomIm ? bAvg * bAvg + bAvgIm * bAvgIm : bAvg * bAvg;
  const bSqAvg = nEff > 0 ? sumOBsq / nEff : 0;
  return { perAtom, perAtomIm, bAvg, bAvgIm, bAvgAbs2, bSqAvg, nEff };
}

/** Average number density ρ₀ = N_eff / V_cell (atoms · Å⁻³), for the −4πρ₀r baseline. */
export function numberDensity(nEff: number, cell: UnitCell): number {
  const v = cellVolume(cell);
  return v > 0 ? nEff / v : 0;
}
