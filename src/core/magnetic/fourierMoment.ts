/**
 * Single-k Fourier-coefficient magnetic structure factor (M4).
 *
 * A commensurate (or incommensurate) magnetic structure with one propagation
 * vector **k** stores, per magnetic atom j, a *complex* Fourier coefficient
 * **S**_j (crystal-axis μ_B components). The real-space moment of atom j in the
 * unit cell whose lattice translation has integer coordinates **n** is
 *
 *   **m**_j(**n**) = Σ_arms **S**_j e^{−2πi k·n}
 *                  = 2·Re[ **S**_j e^{−2πi k·n} ]          (real, +k/−k arms)
 *                  = 2·( **S**_j^Re·cos φ + **S**_j^Im·sin φ ),   φ = 2π k·n
 *
 * so **S**^Re alone is a collinear sinusoid (SDW / commensurate AFM), while
 * **S**^Re ⊥ **S**^Im with |**S**^Re| = |**S**^Im| is a circular helix, and the
 * general case is an ellipse (cycloid / conical when combined with a k=0 term).
 * This is exactly what the existing real-moment path in
 * [`structureFactor.ts`](./structureFactor.ts) cannot represent: it carries one
 * *real* moment per site and never applies the inter-cell k-phase, so it is
 * correct only for collinear commensurate structures.
 *
 * The magnetic structure factor for the satellite at **h** = **H** + k (with
 * **H** a nuclear reciprocal-lattice vector) is
 *
 *   **M**(**h**) = p · Σ_j f_j(s) · **S**_j · exp[2πi **h**·**r**_j]
 *
 * (sum over magnetic atoms in the cell; p = 0.2695 fm/μ_B). Only the component
 * of **M** perpendicular to **h** scatters, so the intensity is |**M**_⊥|²,
 * where **M**_⊥ = **M** − (**M**·ĥ)ĥ is applied to the real and imaginary parts
 * independently (ĥ is real). The −k satellite uses **S**_j* and gives the same
 * |**M**_⊥|² for a centro-related pair.
 *
 * References: Bertaut, *Acta Cryst.* A24 (1968) 217; Rodríguez-Carvajal,
 * *Physica B* 192 (1993) 55 (FullProf magnetic structure-factor convention).
 *
 * This module is pure (no side effects) and imports only nuclear/scattering
 * geometry, so it is both unit-testable and tool-callable.
 */

import type { Complex, Vec3 } from "@/core/math/types";
import type { UnitCell } from "@/core/crystal/types";
import type { MagneticFormFactorTable } from "@/core/scattering/types";
import type { RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";
import { dSpacing } from "@/core/crystal/unitCell";
import { magneticTable } from "@/core/scattering/magnetic";
import { MAGNETIC_PREFACTOR } from "@/core/magnetic/structureFactor";
import { crystalComponentsToCartesian, perpendicularMoment, qCartesian } from "@/core/magnetic/moment";

const TWO_PI = 2 * Math.PI;

/** A magnetic atom carrying a complex single-k Fourier coefficient S_j. */
export interface FourierSite {
  /** Fractional position in the nuclear unit cell. */
  readonly position: Vec3;
  /** Re(S_j): crystal-axis μ_B components (the cosine / SDW amplitude). */
  readonly sReal: Vec3;
  /** Im(S_j): crystal-axis μ_B components (the sine / quadrature amplitude). */
  readonly sImag: Vec3;
  /** ⟨j0⟩ form-factor id (e.g. "Mn2"); f = 1 when absent or untabulated. */
  readonly formFactorId?: string;
  /** Site occupancy (default 1). */
  readonly occupancy?: number;
}

export interface FourierStructureFactor {
  /** Perpendicular magnetic interaction vector M_⊥ (complex, Cartesian μ_B·fm). */
  readonly vector: readonly [Complex, Complex, Complex];
  /** |M_⊥|² = Σ_a (Re M_⊥,a)² + (Im M_⊥,a)². */
  readonly squared: number;
}

/**
 * Real-space moment of a magnetic atom in the cell with integer lattice
 * coordinates `n`, reconstructed from its Fourier coefficient S = (sReal, sImag):
 *   m(n) = 2·(sReal·cos φ + sImag·sin φ),   φ = 2π k·n.
 * The factor 2 folds in the −k partner arm that keeps the moment real.
 */
export function momentInCell(sReal: Vec3, sImag: Vec3, k: Vec3, n: Vec3): Vec3 {
  const phi = TWO_PI * (k[0] * n[0] + k[1] * n[1] + k[2] * n[2]);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return [
    2 * (sReal[0] * c + sImag[0] * s),
    2 * (sReal[1] * c + sImag[1] * s),
    2 * (sReal[2] * c + sImag[2] * s),
  ];
}

/**
 * Magnetic structure factor at the satellite reflection `index = H + k` (in
 * reciprocal-lattice units; the index is generally fractional). Sums the complex
 * Fourier coefficients of all supplied magnetic atoms with the per-atom phase
 * exp[2πi(H+k)·r_j], projects perpendicular to the scattering vector, and returns
 * both M_⊥ and |M_⊥|².
 */
export function fourierMagneticStructureFactor(
  cell: UnitCell,
  sites: readonly FourierSite[],
  index: Vec3,
  table: MagneticFormFactorTable = magneticTable,
): FourierStructureFactor {
  const [h, k, l] = index;
  const d = dSpacing(cell, h, k, l);
  const s = !Number.isFinite(d) || d === 0 ? 0 : 1 / (2 * d);
  const q = qCartesian(cell, h, k, l);

  // Accumulate the full complex M in Cartesian as separate real/imag vectors.
  const reAcc: [number, number, number] = [0, 0, 0];
  const imAcc: [number, number, number] = [0, 0, 0];

  for (const site of sites) {
    const occ = site.occupancy ?? 1;
    const fMag =
      site.formFactorId && table.has(site.formFactorId) ? table.j0(site.formFactorId, s) : 1;
    const w = MAGNETIC_PREFACTOR * occ * fMag;

    const sRealCart = crystalComponentsToCartesian(cell, site.sReal);
    const sImagCart = crystalComponentsToCartesian(cell, site.sImag);

    const phase = TWO_PI * (h * site.position[0] + k * site.position[1] + l * site.position[2]);
    const cph = Math.cos(phase);
    const sph = Math.sin(phase);

    // (sRealCart + i·sImagCart)·(cph + i·sph)·w, component-wise.
    for (let a = 0; a < 3; a++) {
      const reC = sRealCart[a] ?? 0;
      const imC = sImagCart[a] ?? 0;
      reAcc[a] = (reAcc[a] ?? 0) + w * (reC * cph - imC * sph);
      imAcc[a] = (imAcc[a] ?? 0) + w * (reC * sph + imC * cph);
    }
  }

  // Projecting the summed M equals summing per-atom projections (all atoms share
  // one Q for a given reflection, and the projection is linear).
  const rePerp = perpendicularMoment(reAcc, q);
  const imPerp = perpendicularMoment(imAcc, q);
  const squared =
    rePerp[0] * rePerp[0] + rePerp[1] * rePerp[1] + rePerp[2] * rePerp[2] +
    imPerp[0] * imPerp[0] + imPerp[1] * imPerp[1] + imPerp[2] * imPerp[2];

  const vector: [Complex, Complex, Complex] = [
    { re: rePerp[0], im: imPerp[0] },
    { re: rePerp[1], im: imPerp[1] },
    { re: rePerp[2], im: imPerp[2] },
  ];
  return { vector, squared };
}

/**
 * A symmetry-adapted magnetic mode: a unit contribution to the Fourier
 * coefficients of one or more sites, scaled by a single refinable amplitude. The
 * moment is refined through these amplitudes — never raw M_x/M_y/M_z — mirroring
 * the `momentMode` mechanism for k = 0.
 */
export interface FourierMode {
  /** Id of the RefinementParameter carrying this mode's amplitude. */
  readonly parameterId: string;
  /** Per-site coefficient contribution per unit amplitude. */
  readonly terms: readonly { readonly site: number; readonly sReal: Vec3; readonly sImag: Vec3 }[];
}

/** One observed magnetic satellite: its index (H+k) and integrated intensity. */
export interface FourierSatelliteObs {
  readonly index: Vec3;
  readonly iObs: number;
  readonly sigma?: number;
}

/**
 * Build a least-squares problem that refines magnetic-mode amplitudes (and,
 * optionally, a shared `magneticScale`) against observed satellite intensities:
 *   I_calc(h) = scale · |M_⊥(h)|²,   S_j = S_j^base + Σ_m amp_m · mode_m[j].
 * The engine sees only the parameter list and this closure, so it stays
 * crystallography-agnostic.
 */
export function buildFourierSatelliteProblem(
  cell: UnitCell,
  baseSites: readonly FourierSite[],
  modes: readonly FourierMode[],
  observations: readonly FourierSatelliteObs[],
  parameters: readonly RefinementParameter[],
  table: MagneticFormFactorTable = magneticTable,
): RefinementProblem {
  const obs = Float64Array.from(observations.map((o) => o.iObs));
  const weights = Float64Array.from(
    observations.map((o) => {
      const sigma = o.sigma ?? (o.iObs > 0 ? Math.sqrt(o.iObs) : 1);
      return 1 / (sigma * sigma);
    }),
  );
  const scaleParam = parameters.find((p) => p.kind === "magneticScale");

  const calculate = (values: Readonly<Record<string, number>>): Float64Array => {
    // Current site coefficients = base + Σ amplitude·mode-term (mutable copies).
    const sites = baseSites.map((site) => ({
      ...site,
      sReal: [...site.sReal] as [number, number, number],
      sImag: [...site.sImag] as [number, number, number],
    }));
    for (const mode of modes) {
      const amp = values[mode.parameterId] ?? 0;
      if (amp === 0) continue;
      for (const term of mode.terms) {
        const site = sites[term.site];
        if (!site) continue;
        for (let a = 0; a < 3; a++) {
          site.sReal[a] = (site.sReal[a] ?? 0) + amp * (term.sReal[a] ?? 0);
          site.sImag[a] = (site.sImag[a] ?? 0) + amp * (term.sImag[a] ?? 0);
        }
      }
    }
    const scale = scaleParam ? values[scaleParam.id] ?? 1 : 1;
    return Float64Array.from(
      observations.map((o) => scale * fourierMagneticStructureFactor(cell, sites, o.index, table).squared),
    );
  };

  return { parameters, observations: obs, weights, calculate };
}
