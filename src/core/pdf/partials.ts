/**
 * Partial (element-pair) PDF decomposition — PDF_MPDF_ROADMAP P3.
 *
 * The total reduced PDF splits exactly over unordered element pairs (the
 * Faber–Ziman partials): each pair class carries its Gaussian peaks AND its
 * share of the −4πρ₀r baseline,
 *
 *   baseline_AB = −4π r · (2−δ_AB) · W_A·W_B / (N⟨b⟩² V)   (W_A = Σ_{i∈A} o_i b_i)
 *
 * which sums to −4πρ₀r over all pairs (the weights sum to 1), so
 * Σ_AB G_AB(r) ≡ G(r) point-for-point — pinned by a test against
 * {@link computeGofR}, which this module deliberately mirrors term-for-term.
 * Envelopes (sphere, Qdamp) and scale are per-partial multiplicative, and the
 * Qmax termination is linear, so partials remain an exact decomposition after
 * both. Useful for interpretation: which chemistry produces which peak — e.g.
 * whether a shoulder is the dopant–host or host–host correlation.
 */

import type { UnitCell } from "@/core/crystal/types";
import type { ExpandedAtom } from "@/core/diffraction/structureFactor";
import { compositionWeights } from "@/core/totalscattering/weights";
import { enumeratePairs, type PdfPair } from "@/core/pdf/pairEnumerator";
import { sphereEnvelope, PAIR_REACH_MARGIN, type PdfModelParams } from "@/core/pdf/forwardModel";
import { cellVolume } from "@/core/crystal/unitCell";

const GAUSS_WINDOW = 5; // must mirror forwardModel
const SIGMA_FLOOR = 1e-4;

export interface PartialPdf {
  /** Unordered element pair, alphabetical: "Co–Sn", "Ni–Ni". */
  readonly label: string;
  /** This pair's G_AB(r) contribution (peaks + its baseline share, enveloped, scaled). */
  readonly g: Float64Array;
}

/** Unordered pair key, alphabetical. */
function pairLabel(a: string, b: string): string {
  return a <= b ? `${a}–${b}` : `${b}–${a}`;
}

/**
 * All element-pair partial G_AB(r) on `rGrid`, in one pair pass. Their sum is
 * exactly `computeGofR(cell, atoms, rGrid, params, pairs)`.
 */
export function computePartialsGofR(
  cell: UnitCell,
  atoms: readonly ExpandedAtom[],
  rGrid: ArrayLike<number>,
  params: PdfModelParams,
  pairs?: readonly PdfPair[],
): PartialPdf[] {
  const n = rGrid.length;
  if (n === 0 || atoms.length === 0) return [];
  const r0 = rGrid[0]!;
  const step = n > 1 ? rGrid[1]! - rGrid[0]! : 1;
  const rMaxGrid = rGrid[n - 1]!;

  const weights = compositionWeights(atoms, params.scatteringType);
  const norm = 1 / (weights.bAvg * weights.bAvg * weights.nEff);
  const sratio = params.sratio ?? 1;
  const rcut = params.rcut ?? 0;

  // One accumulator per unordered element pair present in the cell, plus the
  // per-element scattering weight totals W_A for the baseline shares.
  const elements = [...new Set(atoms.map((a) => a.element))].sort();
  const wByElement = new Map<string, number>(elements.map((e) => [e, 0]));
  for (let i = 0; i < atoms.length; i++) {
    const e = atoms[i]!.element;
    wByElement.set(e, wByElement.get(e)! + weights.perAtom[i]!);
  }
  const acc = new Map<string, Float64Array>();
  for (let a = 0; a < elements.length; a++) {
    for (let b = a; b < elements.length; b++) {
      acc.set(pairLabel(elements[a]!, elements[b]!), new Float64Array(n));
    }
  }

  const pairList = pairs ?? enumeratePairs(cell, atoms, rMaxGrid + PAIR_REACH_MARGIN);
  const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
  for (const pair of pairList) {
    const r = pair.rij;
    let sig2 = pair.msd * (1 - params.delta1 / r - params.delta2 / (r * r) + params.qbroad * params.qbroad * r * r);
    if (!(sig2 > 0)) sig2 = pair.msd > 0 ? pair.msd : SIGMA_FLOOR * SIGMA_FLOOR;
    let sigma = Math.sqrt(sig2);
    if (rcut > 0 && r < rcut) sigma *= sratio;
    if (sigma < SIGMA_FLOOR) sigma = SIGMA_FLOOR;

    const amp = (weights.perAtom[pair.i]! * weights.perAtom[pair.j]!) * norm / r;
    const invTwoSig2 = 1 / (2 * sigma * sigma);
    const peak = amp * INV_SQRT_2PI / sigma;
    const g = acc.get(pairLabel(atoms[pair.i]!.element, atoms[pair.j]!.element))!;

    const lo = Math.max(0, Math.ceil((r - GAUSS_WINDOW * sigma - r0) / step));
    const hi = Math.min(n - 1, Math.floor((r + GAUSS_WINDOW * sigma - r0) / step));
    for (let k = lo; k <= hi; k++) {
      const dr = r0 + k * step - r;
      g[k] = g[k]! + peak * Math.exp(-dr * dr * invTwoSig2);
    }
  }

  // Baseline share per pair + envelopes + scale (mirrors forwardModel's tail loop).
  const v = cellVolume(cell);
  const spd = params.spdiameter ?? 0;
  const out: PartialPdf[] = [];
  for (const [label, g] of acc) {
    const [ea, eb] = label.split("–") as [string, string];
    const share = (ea === eb ? 1 : 2) * wByElement.get(ea)! * wByElement.get(eb)! * norm / (v > 0 ? v : Infinity);
    for (let k = 0; k < n; k++) {
      const r = rGrid[k]!;
      let val = g[k]! - 4 * Math.PI * share * r;
      if (spd > 0) val *= sphereEnvelope(r, spd);
      if (params.qdamp > 0) val *= Math.exp(-0.5 * (r * params.qdamp) * (r * params.qdamp));
      g[k] = params.scale * val;
    }
    out.push({ label, g });
  }
  return out;
}
