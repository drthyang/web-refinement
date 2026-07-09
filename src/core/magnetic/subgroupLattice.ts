/**
 * The **full lattice of candidate magnetic space groups** for a commensurate
 * propagation vector k — every translationengleiche magnetic subgroup, not only
 * the maximal (index-2) ones that decorate the whole little group G_k.
 *
 * Theory. The possible symmetry groups of a magnetic ordering with propagation
 * vector k are the subgroups M of the grey (paramagnetic) group G_k·1' that do
 * **not** contain pure time reversal 1'. Keeping the translation lattice intact
 * (no cell enlargement — type-IV/anti-translation groups are the star-of-k /
 * supercell follow-up), each such M is determined by a pair (H, θ):
 *
 *   - H ≤ G_k, a translationengleiche subgroup of the little group (a subgroup
 *     of the little co-group, retaining all lattice/centring translations), and
 *   - θ: H → {±1}, a time-reversal homomorphism on it (θ ≡ +1 → type I;
 *     a non-trivial θ primes the coset of its index-2 kernel → type III).
 *
 *   M = { (h, θ(h)) : h ∈ H },   with index [G_k·1' : M] = 2·|Ḡ_k| / |H̄|.
 *
 * The previous candidate generator enumerated only H = G_k (index 2). This
 * module enumerates **all** subgroups H̄ of the finite little co-group Ḡ_k by
 * breadth-first closure over generator sets (every subgroup of a finite group
 * is reached by adding one generator at a time, so the BFS is exhaustive), runs
 * the same GF(2) θ-enumeration on each, and classifies the resulting magnetic
 * groups into conjugacy classes under G_k — conjugate candidates describe the
 * same ordering in symmetry-equivalent **domains**, so the UI shows one
 * representative per class with its domain count, as k-SUBGROUPSMAG does.
 *
 * References:
 *  - J. M. Perez-Mato, S. V. Gallego, E. S. Tasci, L. Elcoro, G. de la Flor &
 *    M. I. Aroyo, "Symmetry-Based Computational Tools for Magnetic
 *    Crystallography", Annu. Rev. Mater. Res. 45 (2015) 217 — possible magnetic
 *    groups = subgroups of the grey group enumerated by index (the
 *    k-SUBGROUPSMAG framework on the Bilbao Crystallographic Server).
 *  - C. Hermann, Z. Kristallogr. 69 (1929) 533 — subgroup chains factor through
 *    translationengleiche and klassengleiche steps; here only the t-part is
 *    enumerated (fixed lattice), the k-part being the type-IV extension.
 *  - International Tables for Crystallography Vol. A1 (Wondratschek & Müller,
 *    eds.) — group–subgroup relations, index, conjugacy and domains.
 *  - D. B. Litvin, *Magnetic Group Tables* (IUCr, 2013) — the type-I/III groups
 *    the candidates are matched against (via {@link identifyMagneticGroup}).
 */

import type { SymmetryOperation } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { composeOperations } from "@/core/crystal/symmetry";
import {
  distinctCosets,
  generateMagneticCandidates,
  littleGroup,
  rotationKey,
  type MagneticCandidate,
} from "./magneticGroups";
import {
  identifyMagneticGroupAnySetting,
  type TransformedIdentification,
} from "./bnsOg";

export interface LatticeCandidate {
  /** The magnetic group itself (operations, label, BNS/OG identification). */
  readonly candidate: MagneticCandidate;
  /** Order of the spatial subgroup H̄ (distinct rotation cosets). */
  readonly subgroupOrder: number;
  /** Index of M in the grey group G_k·1': 2·|Ḡ_k| / |H̄|. Maximal ⇔ 2. */
  readonly index: number;
  /** 0-based conjugacy-class id (classes are contiguous in the output). */
  readonly classId: number;
  /** Number of conjugate candidates under G_k = number of symmetry-equivalent
   *  domain descriptions. 1 for a normal magnetic subgroup. */
  readonly domainCount: number;
  /** True for the first (canonical) member of its conjugacy class — the one
   *  the UI lists; the conjugates are the same physics in other domains. */
  readonly classRepresentative: boolean;
  /** When the exact standard-setting match failed, the BNS/OG identity found
   *  through a setting transformation (axis permutation + origin shift) —
   *  computed for class representatives only. Undefined: no match either way. */
  readonly settingMatch?: TransformedIdentification;
}

interface CosetContext {
  /** One representative op per rotation coset, identity first. */
  readonly cosets: readonly SymmetryOperation[];
  /** cosets[i] ∘ cosets[j] lies in coset comp[i][j]. */
  readonly comp: readonly (readonly number[])[];
  /** Index of the inverse coset. */
  readonly inv: readonly number[];
}

function buildCosetContext(lgOps: readonly SymmetryOperation[]): CosetContext {
  const cosets = distinctCosets(lgOps);
  const index = new Map<string, number>();
  cosets.forEach((op, i) => index.set(rotationKey(op), i));
  const comp = cosets.map((a) =>
    cosets.map((b) => index.get(rotationKey(composeOperations(a, b))) ?? 0),
  );
  const inv = cosets.map((_, i) => comp[i]!.findIndex((c) => c === 0));
  return { cosets, comp, inv };
}

/** Closure of a set of coset indices under the composition table. */
function closure(seed: readonly number[], comp: CosetContext["comp"]): number[] {
  const inSet = new Set<number>(seed);
  inSet.add(0); // identity
  const queue = [...inSet];
  while (queue.length > 0) {
    const a = queue.pop()!;
    for (const b of inSet) {
      for (const c of [comp[a]![b]!, comp[b]![a]!]) {
        if (!inSet.has(c)) {
          inSet.add(c);
          queue.push(c);
        }
      }
    }
  }
  return [...inSet].sort((x, y) => x - y);
}

/**
 * All subgroups of the finite co-group, as sorted coset-index arrays. BFS over
 * "add one generator and close": starting from {E}, every subgroup is reached
 * because any H = ⟨g₁, …, gₘ⟩ appears after m steps. Exhaustive and cheap for
 * crystallographic co-groups (|Ḡ| ≤ 48, e.g. m-3m has 98 subgroups).
 */
export function allSubgroups(ctx: CosetContext): number[][] {
  const found = new Map<string, number[]>();
  const trivial = closure([], ctx.comp);
  found.set(trivial.join(","), trivial);
  const queue = [trivial];
  while (queue.length > 0) {
    const S = queue.pop()!;
    const inS = new Set(S);
    for (let g = 0; g < ctx.cosets.length; g++) {
      if (inS.has(g)) continue;
      const T = closure([...S, g], ctx.comp);
      const key = T.join(",");
      if (!found.has(key)) {
        found.set(key, T);
        queue.push(T);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.length - a.length);
}

/** θ per coset index for a candidate, from its operations' timeReversal flags. */
function thetaByCoset(
  cand: MagneticCandidate,
  cosetIndex: ReadonlyMap<string, number>,
): Map<number, 1 | -1> {
  const theta = new Map<number, 1 | -1>();
  for (const op of cand.operations) {
    const i = cosetIndex.get(rotationKey(op));
    if (i !== undefined) theta.set(i, (op.timeReversal ?? 1) as 1 | -1);
  }
  return theta;
}

/** Canonical signature of (H, θ) as a sorted "coset:θ" string. */
function pairSignature(theta: ReadonlyMap<number, 1 | -1>): string {
  return [...theta.entries()]
    .map(([i, t]) => `${i}:${t}`)
    .sort()
    .join(" ");
}

/** Signature of the conjugate g·(H,θ)·g⁻¹ — h ↦ ghg⁻¹ keeps its θ sign. */
function conjugateSignature(
  theta: ReadonlyMap<number, 1 | -1>,
  g: number,
  ctx: CosetContext,
): string {
  const conj = new Map<number, 1 | -1>();
  for (const [h, t] of theta) conj.set(ctx.comp[ctx.comp[g]![h]!]![ctx.inv[g]!]!, t);
  return pairSignature(conj);
}

/**
 * Enumerate the full lattice of candidate magnetic space groups for a
 * commensurate k: every (subgroup H ≤ G_k, time-reversal homomorphism θ) pair,
 * wrapped with its index in the grey group and its conjugacy class under G_k.
 *
 * Ordered by index (maximal candidates first), then type I before type III,
 * conjugacy classes kept contiguous. `maxIndex` truncates the enumeration (the
 * k-SUBGROUPSMAG convention: the practically relevant candidates sit at low
 * index; pass Infinity for everything down to triclinic P1-type groups).
 */
export function magneticSubgroupLattice(
  parentOps: readonly SymmetryOperation[],
  k: Vec3,
  opts: { maxIndex?: number } = {},
): LatticeCandidate[] {
  const lg = littleGroup(parentOps, k);
  if (lg.length === 0) return [];
  const ctx = buildCosetContext(lg);
  const n = ctx.cosets.length;
  const maxIndex = opts.maxIndex ?? Number.POSITIVE_INFINITY;

  const cosetIndex = new Map<string, number>();
  ctx.cosets.forEach((op, i) => cosetIndex.set(rotationKey(op), i));

  interface Raw {
    cand: MagneticCandidate;
    order: number;
    index: number;
    theta: Map<number, 1 | -1>;
    canonical: string;
    self: string;
  }
  const raws: Raw[] = [];

  for (const S of allSubgroups(ctx)) {
    const index = (2 * n) / S.length;
    if (index > maxIndex) continue;
    const inS = new Set(S);
    // Full operation list of H: every little-group op whose rotation coset is
    // in S (centring translations preserved, as in the maximal-only generator).
    const subOps = lg.filter((op) => inS.has(cosetIndex.get(rotationKey(op)) ?? -1));
    for (const cand of generateMagneticCandidates(subOps)) {
      const theta = thetaByCoset(cand, cosetIndex);
      const self = pairSignature(theta);
      // Canonical class signature: lexicographic minimum over all conjugates.
      let canonical = self;
      for (let g = 0; g < n; g++) {
        const sig = conjugateSignature(theta, g, ctx);
        if (sig < canonical) canonical = sig;
      }
      raws.push({
        cand: { ...cand, id: `mag-sub-${S.join("_")}-${cand.id}` },
        order: S.length,
        index,
        theta,
        canonical,
        self,
      });
    }
  }

  // Group into conjugacy classes; count distinct conjugates (= domains).
  const classes = new Map<string, Raw[]>();
  for (const r of raws) {
    const list = classes.get(r.canonical);
    if (list) list.push(r);
    else classes.set(r.canonical, [r]);
  }

  const ordered = [...classes.values()].sort((A, B) => {
    const a = A[0]!;
    const b = B[0]!;
    return (
      a.index - b.index ||
      Number(b.cand.isTypeI) - Number(a.cand.isTypeI) ||
      b.cand.unprimedCount - a.cand.unprimedCount ||
      a.canonical.localeCompare(b.canonical)
    );
  });

  const out: LatticeCandidate[] = [];
  ordered.forEach((members, classId) => {
    const domainCount = new Set(members.map((m) => m.self)).size;
    members.forEach((m, i) => {
      const isRep = i === 0;
      // Setting search only for the representatives the UI lists, and only
      // when the exact standard-setting identification failed.
      const settingMatch =
        isRep && m.cand.standard === null
          ? identifyMagneticGroupAnySetting(m.cand.operations)
          : null;
      out.push({
        candidate: m.cand,
        subgroupOrder: m.order,
        index: m.index,
        classId,
        domainCount,
        classRepresentative: isRep,
        ...(settingMatch ? { settingMatch } : {}),
      });
    });
  });
  return out;
}

/** Only the class representatives — what a candidate list should display. */
export function latticeRepresentatives(
  lattice: readonly LatticeCandidate[],
): LatticeCandidate[] {
  return lattice.filter((c) => c.classRepresentative);
}
