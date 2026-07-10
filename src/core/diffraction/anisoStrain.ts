/**
 * Anisotropic microstrain broadening — the **Stephens (1999)** phenomenological
 * model, the standard for direction-dependent strain in Rietveld refinement.
 *
 * Physical model. Lattice-metric fluctuations broaden each reflection by an
 * amount that depends on its *direction*, not just its Bragg angle. Stephens
 * parametrises the **variance of M = 1/d²** as a quartic form in the Miller
 * indices,
 *
 *   σ²(M) = Σ_{H+K+L=4} S_HKL · hᴴ kᴷ lᴸ ,
 *
 * with the S_HKL restricted by the Laue symmetry (equal or zero by class). The
 * strain FWHM then follows from propagating σ(M) through Bragg's law. For an
 * isotropic strain ε (σ(M) = 2ε·M) this reduces to the familiar Γ ∝ tanθ.
 *
 * Deriving the allowed S_HKL. Rather than hard-code Stephens' Table 1 per Laue
 * class (error-prone, and incomplete for the trigonal/hexagonal invariants),
 * the symmetry-allowed terms are computed **from the space-group operations**:
 * a quartic form is admissible iff it is invariant under the Laue group acting
 * on the indices (h → Rᵀh), so the allowed forms are the invariant subspace of
 * the 15-dimensional quartic space under the group. We build the Reynolds
 * projector P = (1/|G|)Σ_g ρ(g) on that space and take its symmetrised
 * monomials as the basis — one refinable S per basis form. This reproduces
 * Stephens' counts exactly (triclinic 15, monoclinic 9, orthorhombic 6,
 * cubic m3̄m 2, …) for *any* class, computed rather than tabulated.
 *
 * Broadening (Gaussian, from the variance):
 *   Γ_G(2θ) = 2√(2 ln2) · d² · √(σ²(M)) · tanθ            [FWHM, same angular unit]
 * derived from δ(2θ) = 2·tanθ·(δd/d) and δd/d = ½·δM/M, so a Gaussian second
 * moment in M maps to a Gaussian width in 2θ. Added in quadrature to the
 * Caglioti Gaussian width (Gaussian ⊗ Gaussian ⇒ variances add).
 *
 * References:
 *  - P. W. Stephens, "Phenomenological model of anisotropic peak broadening in
 *    powder diffraction," J. Appl. Cryst. 32 (1999) 281.
 *  - N. C. Popa, J. Appl. Cryst. 31 (1998) 176 — the symmetry rules for the
 *    strain (and size) broadening coefficients by Laue class.
 *  - D. Balzar et al., J. Appl. Cryst. 37 (2004) 911 — size–strain round robin,
 *    Voigt/second-moment conventions.
 */

import type { SymmetryOperation, UnitCell } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { laueRotations } from "@/core/diffraction/merge";
import { dSpacing, braggTheta } from "@/core/crystal/unitCell";
import { cos2Psi } from "@/core/diffraction/anisoSize";

/** A degree-4 monomial hᴴ kᴷ lᴸ, keyed "H,K,L". */
const MONOMIALS: readonly [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  // Priority order so symmetrised bases read nicely (pure powers, then squares…).
  const order: [number, number, number][] = [
    [4, 0, 0], [0, 4, 0], [0, 0, 4],
    [2, 2, 0], [2, 0, 2], [0, 2, 2],
    [3, 1, 0], [1, 3, 0], [3, 0, 1], [1, 0, 3], [0, 3, 1], [0, 1, 3],
    [2, 1, 1], [1, 2, 1], [1, 1, 2],
  ];
  for (const m of order) out.push(m);
  return out;
})();
const MONO_INDEX = new Map(MONOMIALS.map((m, i) => [m.join(","), i]));

type Poly = Map<string, number>; // "H,K,L" → coefficient

function polyMul(a: Poly, b: Poly): Poly {
  const out: Poly = new Map();
  for (const [ka, va] of a) {
    const [ha, kka, la] = ka.split(",").map(Number) as [number, number, number];
    for (const [kb, vb] of b) {
      const [hb, kkb, lb] = kb.split(",").map(Number) as [number, number, number];
      const key = `${ha + hb},${kka + kkb},${la + lb}`;
      out.set(key, (out.get(key) ?? 0) + va * vb);
    }
  }
  return out;
}

function polyPow(base: Poly, n: number): Poly {
  let out: Poly = new Map([["0,0,0", 1]]);
  for (let i = 0; i < n; i++) out = polyMul(out, base);
  return out;
}

/**
 * Representation matrix of one rotation on the 15 quartic monomials: column j is
 * monomial_j evaluated at the transformed indices h → Rᵀh, re-expanded over the
 * monomial basis. (Reflection indices transform as h' = Rᵀh, matching the merge
 * module's `transformIndices`.)
 */
function monomialRepresentation(R: SymmetryOperation["rotation"]): number[][] {
  // Linear forms for h' = Rᵀh: h'_i = Σ_j R[j][i]·(h,k,l)_j.
  const lin = (i: number): Poly =>
    new Map([
      ["1,0,0", R[0]![i]!],
      ["0,1,0", R[1]![i]!],
      ["0,0,1", R[2]![i]!],
    ]);
  const lh = lin(0), lk = lin(1), ll = lin(2);
  const mat: number[][] = Array.from({ length: 15 }, () => new Array(15).fill(0));
  MONOMIALS.forEach(([H, K, L], j) => {
    const expanded = polyMul(polyMul(polyPow(lh, H), polyPow(lk, K)), polyPow(ll, L));
    for (const [key, coeff] of expanded) {
      const idx = MONO_INDEX.get(key);
      if (idx !== undefined) mat[idx]![j] = coeff;
    }
  });
  return mat;
}

export interface QuarticInvariant {
  /** Coefficient over the 15 monomials (indexed as MONOMIALS), scaled so the
   *  dominant coefficient is 1. */
  readonly coeffs: number[];
  /** Label from the dominant monomial, e.g. "S400", "S220". */
  readonly label: string;
}

const TOL = 1e-6;

/** Evaluate the 15-monomial coefficient vector at (h,k,l). */
function evalMonomials(h: number, k: number, l: number): number[] {
  return MONOMIALS.map(([H, K, L]) => Math.pow(h, H) * Math.pow(k, K) * Math.pow(l, L));
}

/** Dot product of two 15-vectors. */
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((s, v, i) => s + v * b[i]!, 0);

/**
 * The symmetry-allowed anisotropic-strain invariants for a space group: a basis
 * of the invariant quartic subspace under its Laue group, as symmetrised
 * monomials. One refinable S parameter per returned invariant. Deterministic
 * order (pure powers first), so parameter ↔ invariant indexing is stable.
 */
export function quarticStrainInvariants(operations: readonly SymmetryOperation[]): QuarticInvariant[] {
  const rots = laueRotations(operations);
  const reps = rots.map(monomialRepresentation);
  // Reynolds projector P = (1/|G|) Σ ρ(g).
  const P: number[][] = Array.from({ length: 15 }, () => new Array(15).fill(0));
  for (const rep of reps) for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) P[i]![j]! += rep[i]![j]! / reps.length;

  // Greedy basis of range(P): symmetrise each monomial (q = P·e_j) and keep it
  // when independent of those already chosen (Gram–Schmidt residual test).
  const basis: QuarticInvariant[] = [];
  const ortho: number[][] = [];
  for (let j = 0; j < 15; j++) {
    const q = P.map((row) => row[j]!); // P · e_j
    // Orthogonalise against existing basis to test independence.
    const r = [...q];
    for (const e of ortho) {
      const proj = dot(r, e) / dot(e, e);
      for (let i = 0; i < 15; i++) r[i]! -= proj * e[i]!;
    }
    if (Math.sqrt(dot(r, r)) < TOL) continue; // dependent
    ortho.push(r);
    // Prettify q: scale so the dominant coefficient is 1, clean tiny values.
    const cleaned = q.map((v) => (Math.abs(v) < TOL ? 0 : v));
    let domIdx = 0;
    for (let i = 1; i < 15; i++) if (Math.abs(cleaned[i]!) > Math.abs(cleaned[domIdx]!)) domIdx = i;
    const scale = cleaned[domIdx]! || 1;
    const coeffs = cleaned.map((v) => {
      const s = v / scale;
      return Math.abs(s - Math.round(s)) < 1e-6 ? Math.round(s) : s;
    });
    const [H, K, L] = MONOMIALS[domIdx]!;
    basis.push({ coeffs, label: `S${H}${K}${L}` });
  }
  return basis;
}

/** σ²(M) = Σ Sᵢ·invariantᵢ(h,k,l). Pure polynomial — no cell needed. */
export function strainVarianceM(
  h: number,
  k: number,
  l: number,
  s: readonly number[],
  invariants: readonly QuarticInvariant[],
): number {
  const mono = evalMonomials(h, k, l);
  let w = 0;
  for (let i = 0; i < invariants.length; i++) w += (s[i] ?? 0) * dot(invariants[i]!.coeffs, mono);
  return w;
}

const SQRT_8LN2 = Math.sqrt(8 * Math.log(2)); // 2√(2 ln2), FWHM = this·σ

/**
 * Anisotropic-strain Gaussian FWHM (degrees 2θ) for one reflection, on a CW
 * pattern of wavelength λ. Returns 0 for a non-positive variance (over-fit) or
 * outside the diffractable range. Add in quadrature to the Caglioti Gaussian
 * width: Γ_G,total² = Γ_G,caglioti² + Γ_G,strain².
 */
export function stephensStrainFwhmDeg(
  h: number,
  k: number,
  l: number,
  cell: UnitCell,
  wavelength: number,
  s: readonly number[],
  invariants: readonly QuarticInvariant[],
): number {
  const w = strainVarianceM(h, k, l, s, invariants);
  if (w <= 0) return 0;
  const d = dSpacing(cell, h, k, l);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const theta = braggTheta(d, wavelength);
  if (Number.isNaN(theta)) return 0;
  // Γ (rad, FWHM) = 2√(2ln2)·d²·√W·tanθ ; convert to degrees.
  const gammaRad = SQRT_8LN2 * d * d * Math.sqrt(w) * Math.tan(theta);
  return (gammaRad * 180) / Math.PI;
}

/**
 * Anisotropic-strain Gaussian **σ** contribution (TOF µs) for one reflection.
 * The strain variance σ²(M) with M = 1/d² gives σ(d) = ½·d³·√W (same as the CW
 * case); mapping to TOF through the calibration T(d) = difC·d + difA·d² + difB/d
 * gives σ_T = |dT/dd|·σ(d). Add its square to the TOF Gaussian variance:
 * σ²_total = σ²_instrument + σ²_strain. Returns 0 for a non-positive variance.
 */
export function stephensStrainSigmaTof(
  h: number,
  k: number,
  l: number,
  cell: UnitCell,
  cal: { readonly difC: number; readonly difA?: number; readonly difB?: number },
  s: readonly number[],
  invariants: readonly QuarticInvariant[],
): number {
  const w = strainVarianceM(h, k, l, s, invariants);
  if (w <= 0) return 0;
  const d = dSpacing(cell, h, k, l);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const sigmaD = 0.5 * d * d * d * Math.sqrt(w); // std dev of d (Å)
  const dTdd = cal.difC + 2 * (cal.difA ?? 0) * d - (cal.difB ?? 0) / (d * d);
  return Math.abs(dTdd) * sigmaD; // std dev in TOF (µs)
}

/**
 * Uniaxial (GSAS-II "uniaxial") microstrain — a Lorentzian strain coefficient
 * that varies between an equatorial value Y_⊥ and an axial value Y_∥ about a
 * unique reciprocal axis, the direct analogue of the uniaxial *size* model:
 *
 *   Y(hkl) = Y_⊥ + (Y_∥ − Y_⊥)·cos²ψ ,   Γ_strain(2θ) = Y(hkl)·tanθ / 100
 *
 * cos²ψ (angle to the axis) uses the reciprocal metric, so it is correct for any
 * cell. Y_∥ = Y_⊥ recovers the isotropic Lorentzian microstrain. Each coefficient
 * converts to a microstrain through the same ε = π·Y/72000 relation GSAS-II uses.
 */
export interface UniaxialStrain {
  readonly yPerp: number;
  readonly yPar: number;
  readonly axis: Vec3;
}

/** Uniaxial Lorentzian microstrain FWHM (degrees 2θ) for one reflection. */
export function uniaxialStrainFwhmDeg(
  h: number,
  k: number,
  l: number,
  cell: UnitCell,
  wavelength: number,
  strain: UniaxialStrain,
): number {
  const d = dSpacing(cell, h, k, l);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const theta = braggTheta(d, wavelength);
  if (Number.isNaN(theta)) return 0;
  const c2 = cos2Psi(cell, h, k, l, strain.axis);
  const y = strain.yPerp + (strain.yPar - strain.yPerp) * c2;
  if (y <= 0) return 0;
  return (y * Math.tan(theta)) / 100; // centidegrees → degrees, tanθ shape
}
