/**
 * External cross-check of the mPDF kernel against diffpy.mpdf (the Frandsen
 * group's reference implementation) via the committed fixture in mpdfGolden.ts
 * — the P4 gate of PDF_MPDF_ROADMAP §7: "numeric cross-check of d_mag(r)
 * against diffpy.mpdf for a fixed spin config".
 *
 * f(r) is a faithful port (same histogram binning, same Gaussian kernel and
 * slicing, same normalization) so it is gated tightly; D(r) additionally
 * involves the reference's FFT-grid + linear-interpolation form-factor
 * transform, which we replace by an exact direct quadrature, so its gate is
 * correlation/amplitude (the PDFfit2 golden convention).
 */

import { describe, it, expect } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import {
  computeNormalizedMpdf,
  computeUnnormalizedMpdf,
  formFactorEnvelope,
  j0Profile,
  type MpdfSpin,
} from "@/core/magnetic/mpdf";
import {
  MPDF_GOLDEN_CELL,
  MPDF_GOLDEN_AFM,
  MPDF_GOLDEN_FM,
  MPDF_GOLDEN_DR,
} from "@/core/magnetic/mpdfGolden";

const CELL: UnitCell = { ...MPDF_GOLDEN_CELL, alpha: 90, beta: 90, gamma: 90 };

function grid(n: number, step: number): Float64Array {
  const r = new Float64Array(n);
  for (let k = 0; k < n; k++) r[k] = k * step;
  return r;
}

/** Pearson correlation + least-squares amplitude ratio κ (golden convention). */
function corrKappa(a: ArrayLike<number>, b: ArrayLike<number>): { corr: number; kappa: number } {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    sa += a[i]!; sb += b[i]!;
    saa += a[i]! * a[i]!; sbb += b[i]! * b[i]!; sab += a[i]! * b[i]!;
  }
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return { corr: cov / Math.sqrt(va * vb), kappa: sbb > 0 ? sab / sbb : NaN };
}

const AFM_SPINS: MpdfSpin[] = [
  { position: [0, 0, 0], moment: [5, 0, 0] },
  { position: [0, 0, 0.5], moment: [-5, 0, 0] },
];
const FM_SPINS: MpdfSpin[] = [
  { position: [0, 0, 0], moment: [0, 0, 2.5] },
  { position: [0, 0, 0.5], moment: [0, 0, 2.5] },
];

describe("mPDF vs diffpy.mpdf golden", () => {
  it("AFM f(r) reproduces calculatemPDF (tight — faithful port)", () => {
    const g = MPDF_GOLDEN_AFM;
    const r = grid(g.n, g.rstep);
    const f = computeNormalizedMpdf(CELL, AFM_SPINS, r, { psigma: g.psigma, qdamp: g.qdamp });
    const peak = Math.max(...g.y.map(Math.abs));
    let maxDiff = 0;
    for (let k = 0; k < g.n; k++) maxDiff = Math.max(maxDiff, Math.abs(f[k]! - g.y[k]!));
    expect(maxDiff).toBeLessThan(1e-6 * peak);
  });

  it("FM f(r) reproduces calculatemPDF including the net-moment line", () => {
    const g = MPDF_GOLDEN_FM;
    const r = grid(g.n, g.rstep);
    const f = computeNormalizedMpdf(CELL, FM_SPINS, r, { psigma: g.psigma, qdamp: g.qdamp });
    const peak = Math.max(...g.y.map(Math.abs));
    let maxDiff = 0;
    for (let k = 0; k < g.n; k++) maxDiff = Math.max(maxDiff, Math.abs(f[k]! - g.y[k]!));
    expect(maxDiff).toBeLessThan(1e-6 * peak);
  });

  it("AFM D(r) reproduces calculateDr (corr/κ gate)", () => {
    const g = MPDF_GOLDEN_DR;
    const r = grid(g.n, g.rstep);
    const f = computeNormalizedMpdf(CELL, AFM_SPINS, r, { psigma: g.psigma, qdamp: g.qdamp });
    const envelope = formFactorEnvelope(j0Profile(["Mn2"]), 5, g.rstep);
    const d = computeUnnormalizedMpdf(r, f, envelope, g.paraScale, g.mSqAvg);
    const { corr, kappa } = corrKappa(g.y, d);
    expect(corr).toBeGreaterThan(0.9999);
    expect(Math.abs(kappa - 1)).toBeLessThan(0.005);
    // Point-wise residual bound so a locally-wrong para hump cannot hide.
    const peak = Math.max(...g.y.map(Math.abs));
    let maxDiff = 0;
    for (let k = 0; k < g.n; k++) maxDiff = Math.max(maxDiff, Math.abs(d[k]! - g.y[k]!));
    expect(maxDiff).toBeLessThan(0.01 * peak);
  });
});
