/**
 * Real-space atom-pair enumeration for the PDF forward model.
 *
 * For each atom in the unit cell, list every neighbouring atom (over periodic
 * images) within `rMax`, returning the pair distance and the UNCORRELATED
 * mean-square displacement projected onto the bond direction — the ingredients
 * of each PDF peak (position and width). This generalizes `crystal/geometry.ts`
 * `bondLengths`, which dedups near-equal bonds and tiles only ±1 cell and so
 * must NOT be reused for a pair sum (PDF_MPDF_ROADMAP §2).
 *
 * The anisotropic ADP is projected via the Cartesian displacement tensor
 * `U_cart = M · (Ñ U Ñ) · Mᵀ` (M = orthogonalization matrix, Ñ = diag(a*,b*,c*),
 * U = CIF U^{ij}); the along-bond variance is then `n̂ᵀ(U_cart,i + U_cart,j)n̂`.
 * Isotropic sites use `U_cart = u_iso·I` exactly (no tensor conversion needed).
 */

import type { Mat3, Vec3 } from "@/core/math/types";
import type { UnitCell, DisplacementParameters } from "@/core/crystal/types";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import { orthogonalizationMatrix, reciprocalMetricTensor, fractionalToCartesian } from "@/core/crystal/unitCell";
import { mulVec, mulMat, transpose } from "@/core/math/mat3";
import { uIsoFromBIso } from "@/core/crystal/adp";

/** One ordered atom pair (origin i, neighbour image j) within `rMax`. */
export interface PdfPair {
  /** Interatomic distance r_ij (Å). */
  readonly rij: number;
  /** Index of the origin atom in the input list (for its scattering weight). */
  readonly i: number;
  /** Index of the neighbour atom in the input list. */
  readonly j: number;
  /** Uncorrelated along-bond mean-square displacement σ′² = n̂ᵀ(U_i+U_j)n̂ (Å²). */
  readonly msd: number;
}

/** Cartesian atomic displacement tensor U_cart (Å²) from a CIF ADP. */
export function cartesianAdpTensor(cell: UnitCell, adp: DisplacementParameters): Mat3 {
  if (adp.kind === "isotropic") {
    const u = uIsoFromBIso(adp.bIso);
    return [
      [u, 0, 0],
      [0, u, 0],
      [0, 0, u],
    ];
  }
  const [u11, u22, u33, u12, u13, u23] = adp.uAniso;
  const gStar = reciprocalMetricTensor(cell);
  const na = Math.sqrt(Math.max(gStar[0][0], 0));
  const nb = Math.sqrt(Math.max(gStar[1][1], 0));
  const nc = Math.sqrt(Math.max(gStar[2][2], 0));
  const n = [na, nb, nc] as const;
  const U: Mat3 = [
    [u11, u12, u13],
    [u12, u22, u23],
    [u13, u23, u33],
  ];
  // Ñ U Ñ : scale entry (i,j) by n_i n_j.
  const nUn: Mat3 = [
    [n[0] * n[0] * U[0][0], n[0] * n[1] * U[0][1], n[0] * n[2] * U[0][2]],
    [n[1] * n[0] * U[1][0], n[1] * n[1] * U[1][1], n[1] * n[2] * U[1][2]],
    [n[2] * n[0] * U[2][0], n[2] * n[1] * U[2][1], n[2] * n[2] * U[2][2]],
  ];
  const M = orthogonalizationMatrix(cell);
  return mulMat(mulMat(M, nUn), transpose(M));
}

/** Mean-square displacement along Cartesian unit vector n̂: n̂ᵀ U n̂. */
export function msdAlong(uCart: Mat3, nHat: Vec3): number {
  return dotv(nHat, mulVec(uCart, nHat));
}

function dotv(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Enumerate all ordered atom pairs within `rMax` (Å) over periodic images. */
export function enumeratePairs(cell: UnitCell, atoms: readonly ExpandedAtom[], rMax: number): PdfPair[] {
  const M = orthogonalizationMatrix(cell);
  const cart: Vec3[] = atoms.map((a) => fractionalToCartesian(cell, a.position));
  const uCart: Mat3[] = atoms.map((a) => cartesianAdpTensor(cell, a.adp));

  // Lattice vectors (columns of M) and a generous per-axis image range.
  const aVec: Vec3 = [M[0][0], M[1][0], M[2][0]];
  const bVec: Vec3 = [M[0][1], M[1][1], M[2][1]];
  const cVec: Vec3 = [M[0][2], M[1][2], M[2][2]];
  const bodyDiag = len([aVec[0] + bVec[0] + cVec[0], aVec[1] + bVec[1] + cVec[1], aVec[2] + bVec[2] + cVec[2]]);
  const reach = rMax + bodyDiag;
  // Per-axis image counts from the reciprocal basis: t1 = a*·T, so any image
  // with |T| ≤ reach has |t1| ≤ |a*|·reach. Bounding with the axis LENGTH
  // (reach/|a|) instead would under-enumerate oblique cells — |a| ≥ 1/|a*|
  // (the (100) plane spacing), and e.g. a hexagonal cell needs ~15% more
  // images along a/b than reach/|a| suggests, dropping edge-of-window pairs
  // at unlucky window sizes. The extra shells this admits for orthogonal
  // cells hold no pairs within rMax, so results are unchanged there.
  const gStar = reciprocalMetricTensor(cell);
  const n1 = Math.ceil(reach * Math.sqrt(Math.max(gStar[0][0], 0)));
  const n2 = Math.ceil(reach * Math.sqrt(Math.max(gStar[1][1], 0)));
  const n3 = Math.ceil(reach * Math.sqrt(Math.max(gStar[2][2], 0)));

  const pairs: PdfPair[] = [];
  const rMaxSq = rMax * rMax;
  for (let t1 = -n1; t1 <= n1; t1++) {
    for (let t2 = -n2; t2 <= n2; t2++) {
      for (let t3 = -n3; t3 <= n3; t3++) {
        const T = mulVec(M, [t1, t2, t3]);
        for (let i = 0; i < atoms.length; i++) {
          const ci = cart[i]!;
          for (let j = 0; j < atoms.length; j++) {
            const cj = cart[j]!;
            const dx = cj[0] + T[0] - ci[0];
            const dy = cj[1] + T[1] - ci[1];
            const dz = cj[2] + T[2] - ci[2];
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 <= 1e-10 || r2 > rMaxSq) continue; // skip self; keep within rMax
            const rij = Math.sqrt(r2);
            const nHat: Vec3 = [dx / rij, dy / rij, dz / rij];
            const msd = msdAlong(uCart[i]!, nHat) + msdAlong(uCart[j]!, nHat);
            pairs.push({ rij, i, j, msd });
          }
        }
      }
    }
  }
  return pairs;
}

function len(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
