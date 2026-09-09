/**
 * Opt-in benchmark for the mPDF forward model — the per-evaluation cost every LM
 * Jacobian column pays. Off by default (it measures, it does not gate); run with
 *
 *   MPDF_BENCH=1 npx vitest run src/core/magnetic/mpdfPerf.test.ts
 *
 * The sizes mirror the FeCoSn_PDF workload that motivated the FFT convolution:
 * a 1.5–30 Å window reduced at Δr = 0.01 Å, so the magnetic grid is ~3.4 k
 * points and the form-factor envelope 2001 points. Measured on Node 22 / Apple
 * silicon, before → after the FFT swap in `mpdf.convolveFull`:
 *
 *   computeUnnormalizedMpdf   3.65 ms → 0.34 ms   (the 3401 × 2001 ordered term)
 *   computeNormalizedMpdf     0.40 ms → 0.44 ms   (unchanged: its histogram is
 *                                                  sparse, so it stays direct —
 *                                                  the cost is the 15 872-pair
 *                                                  binning, not the convolution)
 *   per evaluation            4.05 ms → 0.78 ms   (5.2×)
 *
 * `formFactorEnvelope` (~7.4 ms) is cached once per problem and is dominated by
 * the 1.25 M-point cosine quadrature, not by its self-convolution, so the FFT
 * barely moves it.
 */

import { describe, it } from "vitest";
import type { UnitCell } from "@/core/crystal/types";
import {
  computeNormalizedMpdf,
  computeUnnormalizedMpdf,
  enumerateSpinPairs,
  formFactorEnvelope,
  j0Profile,
  averageMomentSq,
  type MpdfSpin,
} from "@/core/magnetic/mpdf";

const BENCH = process.env.MPDF_BENCH === "1";

const CELL: UnitCell = { a: 6.9, b: 6.9, c: 13.8, alpha: 90, beta: 90, gamma: 90 };
/** 4 Mn sites × the k = (0,0,½) doubling — the 8-spin magnetic box. */
const SPINS: MpdfSpin[] = [
  [0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.25], [0, 0.5, 0.25],
  [0, 0, 0.5], [0.5, 0.5, 0.5], [0.5, 0, 0.75], [0, 0.5, 0.75],
].map((p, i) => ({
  position: p as [number, number, number],
  moment: [i < 4 ? 3 : -3, 0, 0] as [number, number, number],
}));

const STEP = 0.01;
const R_MAX = 34;

function ms(fn: () => void, reps: number): number {
  fn(); // warm the JIT
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

describe.skipIf(!BENCH)("mPDF per-evaluation cost", () => {
  it("times the two forward-model stages an LM Jacobian column pays for", () => {
    const n = Math.round(R_MAX / STEP) + 1;
    const rGrid = new Float64Array(n);
    for (let k = 0; k < n; k++) rGrid[k] = k * STEP;
    const pairs = enumerateSpinPairs(CELL, SPINS.map((s) => s.position), rGrid[n - 1]! + STEP / 2);
    const profile = { psigma: 0.08, qdamp: 0.02, ordScale: 1 };
    const envelope = formFactorEnvelope(j0Profile(["Mn2"]), 5, STEP);
    const mSq = averageMomentSq(SPINS);

    const tEnvelope = ms(() => { formFactorEnvelope(j0Profile(["Mn2"]), 5, STEP); }, 3);
    const tF = ms(() => { computeNormalizedMpdf(CELL, SPINS, rGrid, profile, pairs); }, 20);
    const f = computeNormalizedMpdf(CELL, SPINS, rGrid, profile, pairs);
    const tD = ms(() => { computeUnnormalizedMpdf(rGrid, f, envelope, 1, mSq); }, 20);

    console.log(`grid = ${n} pts @ ${STEP} Å, envelope = ${envelope.s.length} pts, pairs = ${pairs.length}`);
    console.log(`formFactorEnvelope (cached once per problem):    ${tEnvelope.toFixed(2)} ms`);
    console.log(`computeNormalizedMpdf   (bin + broaden):         ${tF.toFixed(2)} ms`);
    console.log(`computeUnnormalizedMpdf (envelope convolution):  ${tD.toFixed(2)} ms`);
    console.log(`per evaluation (f + d): ${(tF + tD).toFixed(2)} ms`);
  });
});
