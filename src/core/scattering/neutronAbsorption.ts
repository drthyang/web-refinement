/**
 * Neutron linear absorption coefficient μ(λ), computed from first principles
 * for a crystal structure — the physics input for absorption/transmission
 * corrections.
 *
 * For neutrons μ is not a fitted fudge factor: it is fixed by the material and
 * the wavelength. Each nuclide contributes a total cross-section
 *
 *   σ_tot(λ) = σ_a(λ) + σ_coh + σ_incoh,    σ_a(λ) = σ_a(2200) · (λ / 1.798)
 *
 * (absorption follows the 1/v law; the scattering terms are treated as
 * wavelength-independent in the bound-atom approximation). The macroscopic
 * coefficient is the number-density-weighted sum μ = Σⱼ nⱼ σⱼ, and with number
 * densities taken straight from the unit cell (nⱼ = Nⱼ / V) the barn·Å⁻³ units
 * collapse to a clean form:
 *
 *   μ [cm⁻¹] = ( Σⱼ Nⱼ · σⱼ(λ) [barn] ) / V [Å³]
 *
 * because 1 barn / 1 Å³ = 10⁻²⁴ cm² / 10⁻²⁴ cm³ = 1 cm⁻¹. Nⱼ is the number of
 * atoms of element j in the cell, Σ over sites of (site multiplicity ×
 * occupancy). See neutronCrossSectionData.ts for the σ table.
 *
 * Wavelength must be supplied by the caller. For constant-wavelength data that
 * is the single instrument λ; for time-of-flight each point has its own λ (μ is
 * larger at long λ), so a TOF caller evaluates μ per point rather than once.
 */

import type { StructureModel } from "@/core/crystal/types";
import { cellVolume } from "@/core/crystal/unitCell";
import { siteMultiplicity } from "@/core/crystal/symmetry";
import {
  NEUTRON_CROSS_SECTIONS,
  RESONANCE_ABSORBERS,
} from "@/core/scattering/neutronCrossSectionData";

/**
 * Reference neutron wavelength for the tabulated 2200 m/s absorption
 * cross-sections (Å). σ_a is quoted at v = 2200 m/s ⇔ λ = 1.7982 Å ⇔ 25.3 meV.
 */
export const THERMAL_WAVELENGTH = 1.7982;

/** Absorption cross-section σ_a(λ) via the 1/v law (barn). */
export function absorptionCrossSection(element: string, wavelength: number): number {
  return crossSections(element).absorption * (wavelength / THERMAL_WAVELENGTH);
}

/** Total scattering cross-section σ_coh + σ_incoh (barn), wavelength-independent. */
export function scatteringCrossSection(element: string): number {
  const xs = crossSections(element);
  return xs.coherent + xs.incoherent;
}

/** Total cross-section σ_tot(λ) = σ_a(λ) + σ_coh + σ_incoh (barn). */
export function totalCrossSection(element: string, wavelength: number): number {
  return absorptionCrossSection(element, wavelength) + scatteringCrossSection(element);
}

/** Atoms of each element in the unit cell: Σ over sites of (multiplicity × occupancy). */
export function cellContents(structure: StructureModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of structure.sites) {
    const mult = site.multiplicity ?? siteMultiplicity(structure.spaceGroup.operations, site.position);
    const n = mult * site.occupancy;
    counts.set(site.element, (counts.get(site.element) ?? 0) + n);
  }
  return counts;
}

/** Per-element contribution to μ, for display and diagnostics. */
export interface AbsorptionTerm {
  readonly element: string;
  /** Atoms of this element in the cell (Σ multiplicity × occupancy). */
  readonly atomsPerCell: number;
  /** Absorption cross-section at this wavelength (barn). */
  readonly sigmaAbsorption: number;
  /** Scattering cross-section σ_coh + σ_incoh (barn). */
  readonly sigmaScattering: number;
  /** This element's contribution to μ (cm⁻¹). */
  readonly muContribution: number;
}

export interface AbsorptionBreakdown {
  /** Linear absorption coefficient μ (cm⁻¹). */
  readonly mu: number;
  /** Wavelength the coefficient was evaluated at (Å). */
  readonly wavelength: number;
  /** Unit-cell volume (Å³). */
  readonly cellVolume: number;
  /** Per-element breakdown, largest μ contribution first. */
  readonly terms: readonly AbsorptionTerm[];
  /**
   * Elements present whose absorption breaks the 1/v law near thermal (strong
   * resonances). Non-empty only when the wavelength is far from 1.798 Å, where
   * the extrapolation would be unreliable. See RESONANCE_ABSORBERS.
   */
  readonly resonanceWarnings: readonly string[];
}

/**
 * Full breakdown of the neutron linear absorption coefficient for a structure
 * at a given wavelength: μ, per-element contributions, and any resonance-
 * absorber warnings. Throws if an element is missing from the cross-section
 * table (naming it).
 */
export function absorptionBreakdown(structure: StructureModel, wavelength: number): AbsorptionBreakdown {
  const volume = cellVolume(structure.cell);
  const contents = cellContents(structure);

  const terms: AbsorptionTerm[] = [];
  const resonanceWarnings: string[] = [];
  // Only warn when the 1/v extrapolation is actually being stretched; at the
  // thermal reference the tabulated value stands on its own.
  const farFromThermal = Math.abs(wavelength - THERMAL_WAVELENGTH) > 0.05 * THERMAL_WAVELENGTH;

  for (const [element, atomsPerCell] of contents) {
    const sigmaAbsorption = absorptionCrossSection(element, wavelength);
    const sigmaScattering = scatteringCrossSection(element);
    const muContribution = (atomsPerCell * (sigmaAbsorption + sigmaScattering)) / volume;
    terms.push({ element, atomsPerCell, sigmaAbsorption, sigmaScattering, muContribution });
    if (farFromThermal && RESONANCE_ABSORBERS.has(element)) resonanceWarnings.push(element);
  }

  terms.sort((a, b) => b.muContribution - a.muContribution);
  const mu = terms.reduce((sum, t) => sum + t.muContribution, 0);
  return { mu, wavelength, cellVolume: volume, terms, resonanceWarnings };
}

/**
 * Neutron linear absorption coefficient μ (cm⁻¹) for a structure at a given
 * wavelength (Å). Convenience wrapper over {@link absorptionBreakdown}.
 */
export function linearAbsorptionCoefficient(structure: StructureModel, wavelength: number): number {
  return absorptionBreakdown(structure, wavelength).mu;
}

function crossSections(element: string) {
  const xs = NEUTRON_CROSS_SECTIONS[element];
  if (xs === undefined) {
    throw new Error(`No neutron cross-sections tabulated for element "${element}"`);
  }
  return xs;
}
