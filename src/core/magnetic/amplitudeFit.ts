/**
 * Recover symmetry-mode AMPLITUDES from a magnetic model's moments.
 *
 * `buildMagneticModel` parameterizes a candidate group's moments as amplitudes
 * over its symmetry-allowed modes; `applyMagneticMoments` maps amplitudes →
 * moments. This is the inverse: given a target model (an applied or refined
 * one, an mCIF, a demo answer), find the amplitudes that reproduce its moments
 * in least squares. It lets the magnetic page open ON a model — the candidate
 * is identified by its operations, and its amplitude inputs are seeded from
 * the moments — instead of asking the user to re-derive what is already known.
 *
 * The map is linear: for sublattice key s and Fourier part (cos / sin),
 *   m_s^part = Σ_j a_j · basis_{j,s}^part,
 * so the amplitudes are the least-squares solution of a small dense system
 * (3 rows per sublattice and part, one column per parameter). Ties are already
 * folded into the bindings by the builder, so a tied amplitude simply drives
 * several rows. A target sublattice the build does not address contributes
 * nothing; a build sublattice missing from the target is fitted to zero.
 */

import type { ParameterBinding } from "@/core/refinement/types";
import type { MagneticModel } from "@/core/magnetic/types";
import { momentBindingKey } from "@/core/magnetic/types";
import type { MagneticModelBuild } from "@/core/magnetic/momentModel";
import { resolveTies } from "@/core/refinement/constraints";

export interface AmplitudeFit {
  /** Fitted amplitude per parameter id (every parameter of the build). */
  readonly values: Record<string, number>;
  /** Root-mean-square misfit of the reproduced moments (µ_B per component). 0 = exact. */
  readonly rms: number;
  /** Largest single-component misfit (µ_B). */
  readonly maxMisfit: number;
}

/** Fit the build's amplitudes so its moments reproduce `target`'s. */
export function fitAmplitudesToMoments(build: Pick<MagneticModelBuild, "params" | "bindings" | "magnetic">, target: MagneticModel): AmplitudeFit {
  const ids = build.params.map((p) => p.id);
  const col = new Map(ids.map((id, j) => [id, j]));
  const targetByKey = new Map(target.moments.map((m) => [momentBindingKey(m), m]));

  // Rows: (sublattice key, part) × 3 components, one column per parameter.
  const rows: { a: number[]; b: number }[] = [];
  const parts = new Map<string, Set<"cos" | "sin">>();
  for (const bd of build.bindings) {
    if (bd.kind !== "momentMode" || !bd.targetKey || !bd.momentBasis) continue;
    const set = parts.get(bd.targetKey) ?? new Set<"cos" | "sin">();
    set.add(bd.momentPart ?? "cos");
    parts.set(bd.targetKey, set);
  }
  for (const [key, set] of parts) {
    const t = targetByKey.get(key);
    for (const part of set) {
      const rhs = part === "sin" ? (t?.sinComponents ?? [0, 0, 0]) : (t?.components ?? [0, 0, 0]);
      for (let c = 0; c < 3; c++) {
        const a = new Array<number>(ids.length).fill(0);
        for (const bd of build.bindings) {
          if (bd.kind !== "momentMode" || bd.targetKey !== key || !bd.momentBasis) continue;
          if ((bd.momentPart ?? "cos") !== part) continue;
          const j = col.get(bd.parameterId);
          if (j !== undefined) a[j]! += bd.momentBasis[c]!;
        }
        rows.push({ a, b: rhs[c]! });
      }
    }
  }

  // A tied (derived) amplitude — the |M| tie's "= ±hypot(…)" — is not a free
  // column: it follows from the reference amplitudes, so the least squares
  // runs over the free parameters only (a free column would let it spread the
  // target between the two and break the tie) and the derived values are
  // resolved afterwards; the misfit is then judged with every parameter.
  const freeIdx = build.params.map((p, j) => (p.expression ? -1 : j)).filter((j) => j >= 0);
  const x = leastSquares(rows.map((r) => ({ a: freeIdx.map((j) => r.a[j]!), b: r.b })), freeIdx.length);
  const seed: Record<string, number> = {};
  ids.forEach((id) => { seed[id] = 0; });
  freeIdx.forEach((j, k) => { seed[ids[j]!] = x[k] ?? 0; });
  const values = resolveTies(build.params, seed);

  let sum = 0;
  let maxMisfit = 0;
  for (const r of rows) {
    let pred = 0;
    for (let j = 0; j < ids.length; j++) pred += r.a[j]! * (values[ids[j]!] ?? 0);
    const d = pred - r.b;
    sum += d * d;
    maxMisfit = Math.max(maxMisfit, Math.abs(d));
  }
  return { values, rms: rows.length > 0 ? Math.sqrt(sum / rows.length) : 0, maxMisfit };
}

/** Least squares via the normal equations with a tiny ridge, solved by
 *  Gaussian elimination with partial pivoting (n is a handful of amplitudes). */
function leastSquares(rows: readonly { a: number[]; b: number }[], n: number): number[] {
  if (n === 0) return [];
  const N: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const r of rows) {
    for (let i = 0; i < n; i++) {
      const ai = r.a[i]!;
      if (ai === 0) continue;
      for (let j = 0; j < n; j++) N[i]![j]! += ai * r.a[j]!;
      N[i]![n]! += ai * r.b;
    }
  }
  // Ridge: a parameter no row touches (an unobservable amplitude) stays 0
  // instead of making the system singular.
  for (let i = 0; i < n; i++) N[i]![i]! += 1e-12;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(N[r]![c]!) > Math.abs(N[p]![c]!)) p = r;
    if (p !== c) { const t = N[c]!; N[c] = N[p]!; N[p] = t; }
    const piv = N[c]![c]!;
    if (Math.abs(piv) < 1e-300) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = N[r]![c]! / piv;
      if (f === 0) continue;
      for (let j = c; j <= n; j++) N[r]![j]! -= f * N[c]![j]!;
    }
  }
  return Array.from({ length: n }, (_, i) => (Math.abs(N[i]![i]!) < 1e-300 ? 0 : N[i]![n]! / N[i]![i]!));
}

/** Bindings of a build restricted to its moment modes (what the fit reads). */
export function momentModeBindings(bindings: readonly ParameterBinding[]): ParameterBinding[] {
  return bindings.filter((b) => b.kind === "momentMode");
}
