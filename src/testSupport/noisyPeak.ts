/**
 * A small, realistic least-squares problem for testing convergence
 * diagnostics: one Gaussian peak on a flat background, with seeded √y counting
 * noise.
 *
 * The peak's centre is refined as an OFFSET `pos` from where the model puts
 * it, as atom positions are. The noise is mirrored about the peak, so the
 * least-squares offset is exactly 0: a fit started anywhere near it ends with
 * `pos` at round-off, where a shift measured relative to |pos| is meaningless.
 */

import type { RefinementParameter } from "@/core/refinement/types";
import type { RefinementProblem } from "@/core/refinement/engine";

export interface NoisyPeakOptions {
  /** Starting offset of the peak centre (the optimum is 0). */
  readonly start: number;
  /** Seeded √y noise; false gives the exact (noise-free) pattern. Default true. */
  readonly noise?: boolean;
  /** Free the peak height as well as the offset. Default true. */
  readonly freeHeight?: boolean;
}

export const PEAK = { height: 1000, width: 0.8, background: 50, points: 2001 } as const;

/** Standard normal draws from a seeded LCG (Box–Muller). */
function gaussian(seed: number): () => number {
  let s = seed;
  const uniform = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

export function noisyPeakProblem(opts: NoisyPeakOptions): RefinementProblem {
  const n = PEAK.points; // odd, so the grid is symmetric about 0
  const x = Array.from({ length: n }, (_, i) => -5 + (10 * i) / (n - 1));
  const model = (height: number, pos: number): number[] =>
    x.map((xi) => height * Math.exp(-((xi - pos) ** 2) / (2 * PEAK.width ** 2)) + PEAK.background);
  const exact = model(PEAK.height, 0);
  const draw = gaussian(7);
  const noise = new Array<number>(n);
  for (let i = 0; i <= n >> 1; i++) noise[i] = noise[n - 1 - i] = draw();
  const observations = exact.map((y, i) => ((opts.noise ?? true) ? y + Math.sqrt(y) * noise[i]! : y));
  const parameters: RefinementParameter[] = [
    { id: "height", label: "height", kind: "scale", value: PEAK.height, initialValue: PEAK.height, fixed: !(opts.freeHeight ?? true) },
    { id: "pos", label: "peak offset", kind: "atomX", value: opts.start, initialValue: opts.start, fixed: false },
  ];
  return {
    parameters,
    observations: Float64Array.from(observations),
    weights: Float64Array.from(exact.map((y) => 1 / y)),
    calculate: (v) => Float64Array.from(model(v.height!, v.pos!)),
  };
}
