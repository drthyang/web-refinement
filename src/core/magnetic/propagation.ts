/**
 * Propagation-vector classification — the one place that decides how a
 * single-k magnetic structure is parameterized and how its satellites count.
 *
 * Three questions, each with a physical consequence:
 *
 *  1. **Is k = 0?** The magnetic cell is the nuclear cell and magnetic
 *     intensity sits on the nuclear reflections.
 *  2. **Is k self-conjugate (−k ≡ k modulo a reciprocal-lattice vector of the
 *     PARENT lattice, i.e. 2k ∈ Λ*: k = 0, (½,0,0), (½,½,½), … in a primitive
 *     cell — but in a centred cell Λ* is a sublattice of ℤ³, so k = (½,0,0) is
 *     a two-arm k in a C lattice and (0,0,½) in an I lattice)?** Then
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
 * `componentDenominator` / `kDenominators` below are the one place that
 * decision is made — the `.int` supercell transform, the 3D view / mCIF box
 * and `classifyPropagation` all resolve k through them, so they cannot disagree.
 *
 * Conventions match FullProf (Rodríguez-Carvajal, *Physica B* **192** (1993)
 * 55): m_lj = Σ_k S_kj·exp(−2πi k·R_l) with S_{−k} = S_k*, and the satellite
 * structure factor M(H + k) = p·Σ_j f_j·S_kj·exp[2πi (H + k)·r_j].
 */

import type { Vec3 } from "@/core/math/types";
import { isReciprocalLatticeVector } from "@/core/crystal/symmetry";

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
  /**
   * Centring translations of the parent lattice (`centringTranslations`). The
   * reciprocal lattice of a centred cell is a sublattice of ℤ³, so −k ≡ k
   * needs 2k in THAT lattice. Empty (a primitive lattice) by default.
   */
  readonly centrings?: readonly Vec3[];
}

/**
 * Smallest denominator n ∈ [1, maxDenominator] with n·v within `tolerance` of
 * an integer — the supercell multiplier along one axis — or null when the
 * component is incommensurate within the search. Integers (0 included) give 1.
 */
export function componentDenominator(v: number, options: ClassifyOptions = {}): number | null {
  const maxDen = options.maxDenominator ?? 12;
  const tol = options.tolerance ?? 1e-4;
  if (Math.abs(v) < tol) return 1;
  for (let n = 1; n <= maxDen; n++) {
    if (Math.abs(v * n - Math.round(v * n)) < tol) return n;
  }
  return null;
}

/** Finite magnetic supercell of a commensurate k. */
export interface KSupercell {
  /** Per-axis multiplier Nᵢ: the supercell is (N₁a, N₂b, N₃c). */
  readonly denominators: readonly [number, number, number];
  /** k in the supercell: the integer reciprocal-lattice vector Kᵢ = Nᵢ·kᵢ. */
  readonly kInteger: readonly [number, number, number];
  /** Cells in the supercell, N₁·N₂·N₃. */
  readonly cellCount: number;
}

/**
 * The magnetic supercell of `k`, or null when any component is
 * incommensurate — callers state what they do about that null instead of
 * approximating it away.
 */
export function kDenominators(k: Vec3, options: ClassifyOptions = {}): KSupercell | null {
  const denominators: number[] = [];
  for (const c of k) {
    const n = componentDenominator(c, options);
    if (n === null) return null;
    denominators.push(n);
  }
  const [n1, n2, n3] = denominators as [number, number, number];
  return {
    denominators: [n1, n2, n3],
    kInteger: [Math.round(n1 * k[0]), Math.round(n2 * k[1]), Math.round(n3 * k[2])],
    cellCount: n1 * n2 * n3,
  };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);

/**
 * Joint supercell of several arms (multi-k): the componentwise LCM of their
 * denominators, the smallest cell in which every arm's modulation repeats.
 * `kInteger` is the FIRST arm's integer vector in that cell. Null when any arm
 * is incommensurate, when `ks` is empty, or when the joint cell exceeds
 * `maxCells` — arms can be individually commensurate yet jointly enormous
 * (⅕ and ⅐ on one axis need 35 cells), and a caller asking for a drawable
 * box needs that refusal rather than a runaway expansion.
 */
export function jointDenominators(
  ks: readonly Vec3[],
  options: ClassifyOptions & { readonly maxCells?: number } = {},
): KSupercell | null {
  if (ks.length === 0) return null;
  const denominators: [number, number, number] = [1, 1, 1];
  for (const k of ks) {
    const res = kDenominators(k, options);
    if (!res) return null;
    for (let i = 0; i < 3; i++) denominators[i] = lcm(denominators[i]!, res.denominators[i]!);
  }
  const cellCount = denominators[0] * denominators[1] * denominators[2];
  if (cellCount > (options.maxCells ?? 4096)) return null;
  const first = ks[0]!;
  return {
    denominators,
    kInteger: [
      Math.round(denominators[0] * first[0]),
      Math.round(denominators[1] * first[1]),
      Math.round(denominators[2] * first[2]),
    ],
    cellCount,
  };
}

/**
 * True when −k ≡ k modulo the reciprocal lattice of the parent: 2k is an
 * integer vector AND, for a centred cell, lies in its reciprocal sublattice
 * (2k·t ∈ ℤ for every centring translation t).
 */
export function isSelfConjugate(k: Vec3, centrings: readonly Vec3[] = [], tol = 1e-6): boolean {
  return isReciprocalLatticeVector([2 * k[0]!, 2 * k[1]!, 2 * k[2]!], centrings, tol);
}

/**
 * The factor turning a real-space modulation amplitude (µ_B) into the Fourier
 * coefficient of the +k satellite: ½ when ±k are distinct arms, 1 when k is
 * self-conjugate (k = 0 included).
 */
export function fourierArmFactor(k: Vec3, centrings: readonly Vec3[] = [], tol = 1e-6): 0.5 | 1 {
  return isSelfConjugate(k, centrings, tol) ? 1 : 0.5;
}

/** Classify a propagation vector (see the module doc). */
export function classifyPropagation(k: Vec3, options: ClassifyOptions = {}): PropagationClass {
  const tol = options.tolerance ?? 1e-4;
  const isZero = k.every((c) => Math.abs(c) < tol);
  const selfConjugate = isSelfConjugate(k, options.centrings ?? [], tol);
  const supercell = kDenominators(k, options)?.denominators ?? null;
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
