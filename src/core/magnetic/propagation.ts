/**
 * Propagation-vector classification — the one place that decides how a
 * single-k magnetic structure is parameterized and how its satellites count.
 *
 * Three questions, each with a physical consequence:
 *
 *  1. **Is k = 0?** The magnetic cell is the nuclear cell and magnetic
 *     intensity sits on the nuclear reflections.
 *  2. **Is k self-conjugate (−k ≡ k modulo a reciprocal-lattice vector, i.e.
 *     every component of 2k is an integer: k = 0, (½,0,0), (½,½,½), …)?** Then
 *     the +k and −k arms are the SAME reflection set, the Fourier coefficient
 *     S_j of every atom must be real, the real-space moment is
 *     m_j(n) = M_j·cos(2π k·n) = ±M_j with **S_j = M_j** (one arm), and the
 *     quadrature (sine) amplitude is identically unobservable: sin(2π k·n) = 0
 *     on every lattice point. Each satellite G + k must be counted ONCE — the
 *     naive "G + k and G − k" enumeration lists every one of them twice.
 *  3. **Otherwise the two arms ±k are distinct.** The moment
 *     m_j(n) = S_j·e^{−2πi k·n} + S_j*·e^{+2πi k·n} = 2·Re[S_j e^{−2πi k·n}]
 *     needs a COMPLEX coefficient, S_j = ½(M_j^cos + i·M_j^sin), so that the
 *     real-space amplitudes M^cos/M^sin are the cosine/sine modulation
 *     amplitudes in µ_B: m_j(n) = M^cos·cos(2π k·n) + M^sin·sin(2π k·n). The
 *     factor ½ is the two-arm factor; omitting it quadruples every satellite
 *     intensity and halves every refined moment. Both arms scatter, at
 *     different positions.
 *
 * Commensurate vs incommensurate is a separate, weaker distinction: a
 * commensurate k (rational components) admits a finite magnetic supercell —
 * useful for display, mCIF export, and the supercell-merge single-crystal
 * path — but the structure factor and the parameterization above do not care.
 * An irrational k simply has no supercell; everything else is identical.
 *
 * Conventions match FullProf (Rodríguez-Carvajal, *Physica B* **192** (1993)
 * 55): m_lj = Σ_k S_kj·exp(−2πi k·R_l) with S_{−k} = S_k*, and the satellite
 * structure factor M(H + k) = p·Σ_j f_j·S_kj·exp[2πi (H + k)·r_j].
 */

import type { Vec3 } from "@/core/math/types";

export type PropagationKind = "zero" | "commensurate" | "incommensurate";

export interface PropagationClass {
  readonly kind: PropagationKind;
  /**
   * True when −k ≡ k (mod reciprocal lattice): one satellite arm, real
   * coefficients, quadrature amplitudes unobservable. Always true for k = 0.
   */
  readonly selfConjugate: boolean;
  /**
   * Whether the sine (quadrature) modulation amplitude is observable — the
   * complement of `selfConjugate`. When true the model carries a complex
   * Fourier coefficient per site and one global modulation phase is a gauge.
   */
  readonly twoArms: boolean;
  /**
   * The factor multiplying the real-space modulation amplitude to give the
   * Fourier coefficient that enters the satellite structure factor:
   * ½ for two distinct arms, 1 for a self-conjugate k.
   */
  readonly armFactor: 0.5 | 1;
  /**
   * Per-axis denominators of a commensurate k (the magnetic supercell
   * multipliers), or null for an incommensurate k. (1,1,1) for k = 0.
   */
  readonly supercell: readonly [number, number, number] | null;
}

export interface ClassifyOptions {
  /** Largest denominator accepted as commensurate (default 12). */
  readonly maxDenominator?: number;
  /** Tolerance on |n·kᵢ − round(n·kᵢ)| (default 1e-4). */
  readonly tolerance?: number;
}

function denominatorOf(v: number, maxDen: number, tol: number): number | null {
  if (Math.abs(v) < tol) return 1;
  for (let n = 1; n <= maxDen; n++) {
    if (Math.abs(v * n - Math.round(v * n)) < tol) return n;
  }
  return null;
}

/** True when every component of 2k is an integer (within `tol`), i.e. −k ≡ k. */
export function isSelfConjugate(k: Vec3, tol = 1e-6): boolean {
  return k.every((c) => Math.abs(2 * c - Math.round(2 * c)) < tol);
}

/**
 * The factor turning a real-space modulation amplitude (µ_B) into the Fourier
 * coefficient of the +k satellite: ½ when ±k are distinct arms, 1 when k is
 * self-conjugate (k = 0 included).
 */
export function fourierArmFactor(k: Vec3, tol = 1e-6): 0.5 | 1 {
  return isSelfConjugate(k, tol) ? 1 : 0.5;
}

/** Classify a propagation vector (see the module doc). */
export function classifyPropagation(k: Vec3, options: ClassifyOptions = {}): PropagationClass {
  const maxDen = options.maxDenominator ?? 12;
  const tol = options.tolerance ?? 1e-4;
  const isZero = k.every((c) => Math.abs(c) < tol);
  const selfConjugate = isSelfConjugate(k, tol);
  const dens = k.map((c) => denominatorOf(c, maxDen, tol));
  const supercell: readonly [number, number, number] | null =
    dens.every((d): d is number => d !== null) ? [dens[0]!, dens[1]!, dens[2]!] : null;
  return {
    kind: isZero ? "zero" : supercell ? "commensurate" : "incommensurate",
    selfConjugate,
    twoArms: !selfConjugate,
    armFactor: selfConjugate ? 1 : 0.5,
    supercell,
  };
}

/** Human label for the classification, e.g. "incommensurate (two arms)". */
export function describePropagation(cls: PropagationClass): string {
  if (cls.kind === "zero") return "k = 0 (magnetic cell = nuclear cell)";
  const arms = cls.selfConjugate ? "one arm, real coefficients" : "two arms ±k, complex coefficients";
  if (cls.kind === "commensurate") {
    const n = cls.supercell!;
    return `commensurate (${n[0]}×${n[1]}×${n[2]} supercell; ${arms})`;
  }
  return `incommensurate (no finite supercell; ${arms})`;
}
