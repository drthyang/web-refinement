/**
 * The **translationengleiche subgroup lattice** of a structure's space group —
 * the structural counterpart of `magneticSubgroupLattice`, and the "search for
 * subgroups" step of the PDF distortion workflow (parent → fit → residual →
 * pick a subgroup → activate its distortion modes → refine amplitudes).
 *
 * It reuses the generic finite-group subgroup enumerator `allSubgroups`
 * (`add-a-generator-and-close` BFS over the rotation-coset composition table —
 * exhaustive for any crystallographic group, |Ḡ| ≤ 48). Every subgroup found is
 *
 *  - named with `identifySubgroup` (exact op-set match → H-M symbol + IT number,
 *    retried over axis-permutation settings; honest point-group-only fallback);
 *  - linked into the group–subgroup lattice by its COVERING relations (immediate
 *    maximal subgroups / minimal supergroups) — the Bärnighausen-tree edges; and
 *  - grouped into conjugacy classes under the parent (conjugate subgroups are
 *    the same distortion in symmetry-equivalent DOMAINS), each class reporting a
 *    representative and a domain count, exactly as the magnetic lattice does.
 *
 * Each node carries its own OPERATIONS, so a chosen node feeds `realizeSubgroup`
 * (orbit splitting) and then `buildSymmetryModes` directly — the subgroup-driven
 * activation path: pick H → realize the child → refine the symmetry-allowed
 * displacement modes H permits. (Tagging each such mode with the parent irrep it
 * descends from is the later per-irrep-label phase.)
 *
 * Scope (deliberate, matching the rest of the distortion stack): **t-subgroups
 * only** — subgroups that keep the lattice (point-group level). Klassengleiche
 * (cell-multiplying / centering-losing) subgroups — the zone-boundary /
 * supercell half of the full ITA1 tree — are NOT enumerated here; they ride
 * along with the k≠0 displacive engine.
 */

import type { SymmetryOperation, StructureModel } from "@/core/crystal/types";
import { IDENTITY3 } from "@/core/math/mat3";
import { identifySubgroup, type SubgroupIdentity } from "@/core/crystal/isotropyTree";
import { allSubgroups, buildCosetContext, type CosetContext } from "@/core/magnetic/subgroupLattice";

export interface SubgroupNode {
  /** Stable id (derived from the coset-index set) — the key covering edges use. */
  readonly id: string;
  /** The subgroup's operations (one representative per rotation coset, with the
   *  parent's intrinsic translations) — ready for `realizeSubgroup`. */
  readonly operations: readonly SymmetryOperation[];
  /** Name: H-M symbol + IT number when matched, else point group + index. */
  readonly identity: SubgroupIdentity;
  /** Point-group symbol (always defined when classifiable). */
  readonly pointGroup: string | null;
  /** |H| — number of rotation cosets. */
  readonly order: number;
  /** [G : H] index in the parent. */
  readonly index: number;
  /** Immediate maximal subgroups of this node (Bärnighausen children). */
  readonly maximalSubgroupIds: readonly string[];
  /** Immediate minimal supergroups of this node (Bärnighausen parents). */
  readonly minimalSupergroupIds: readonly string[];
  /** 0-based conjugacy-class id (classes are contiguous in `nodes`). */
  readonly conjugacyClassId: number;
  /** True for the canonical member the UI lists; conjugates are other domains. */
  readonly classRepresentative: boolean;
  /** Number of conjugate subgroups in this class = symmetry-equivalent domains. */
  readonly domainCount: number;
  /** The whole group H = G. */
  readonly isParent: boolean;
  /** The trivial subgroup H = P1. */
  readonly isTrivial: boolean;
}

export interface StructuralSubgroupTree {
  /** Node id of the parent (whole group). */
  readonly parentId: string;
  /** All subgroups, sorted index ascending (parent first), conjugates contiguous. */
  readonly nodes: readonly SubgroupNode[];
  /** True when `maxIndex` cut deeper subgroups from the full lattice. */
  readonly truncated: boolean;
}

const IDENTITY_OP: SymmetryOperation = { rotation: IDENTITY3, translation: [0, 0, 0], xyz: "x,y,z" };

/** Conjugate the coset-index set S by coset g: h ↦ g·h·g⁻¹. */
function conjugateSet(S: readonly number[], g: number, ctx: CosetContext): number[] {
  return S.map((h) => ctx.comp[ctx.comp[g]![h]!]![ctx.inv[g]!]!).sort((a, b) => a - b);
}

/** Lexicographically minimal conjugate signature — equal for conjugate subgroups. */
function conjugacyKey(S: readonly number[], ctx: CosetContext): string {
  let best: string | null = null;
  for (let g = 0; g < ctx.cosets.length; g++) {
    const k = conjugateSet(S, g, ctx).join(",");
    if (best === null || k < best) best = k;
  }
  return best ?? [...S].sort((a, b) => a - b).join(",");
}

/**
 * Enumerate the full translationengleiche subgroup lattice of `structure`'s
 * space group: every t-subgroup, named, with covering (Bärnighausen) edges and
 * conjugacy/domain grouping. `maxIndex` caps the enumeration by index (the whole
 * lattice otherwise — cheap, ≤ a few hundred nodes); covering edges are then
 * recomputed within the retained set so the tree stays a valid sub-poset.
 */
export function structuralSubgroupLattice(
  structure: StructureModel,
  opts: { readonly maxIndex?: number } = {},
): StructuralSubgroupTree {
  const parentOps = structure.spaceGroup.operations.length ? structure.spaceGroup.operations : [IDENTITY_OP];
  const ctx = buildCosetContext(parentOps);
  const N = ctx.cosets.length;
  const maxIndex = opts.maxIndex ?? Number.POSITIVE_INFINITY;

  // allSubgroups → coset-index arrays, sorted |S| descending (parent first).
  const all = allSubgroups(ctx);
  const idOf = (S: readonly number[]): string => `h${[...S].sort((a, b) => a - b).join("_")}`;

  // Conjugacy classes over the FULL lattice (before any index cut).
  const classKey = all.map((S) => conjugacyKey(S, ctx));
  const classOrder: string[] = [];
  for (const k of classKey) if (!classOrder.includes(k)) classOrder.push(k);
  const classIdByKey = new Map(classOrder.map((k, i) => [k, i] as const));
  const domainCountByKey = new Map<string, number>();
  for (const k of classKey) domainCountByKey.set(k, (domainCountByKey.get(k) ?? 0) + 1);

  // Retain by index, keep original (size-descending) order for now.
  const retained = all
    .map((S, i) => ({ S, i }))
    .filter(({ S }) => (N / S.length) <= maxIndex);
  const truncated = retained.length < all.length;

  const sets = retained.map(({ S }) => new Set(S));
  const strictSub = (a: number, b: number): boolean =>
    retained[a]!.S.length < retained[b]!.S.length && [...sets[a]!].every((x) => sets[b]!.has(x));

  // Covering relations within the retained set: A ⋖ B iff A ⊊ B and no retained
  // C strictly between. O(n³) but n ≤ few hundred.
  const children: string[][] = retained.map(() => []);
  const parents: string[][] = retained.map(() => []);
  for (let b = 0; b < retained.length; b++) {
    for (let a = 0; a < retained.length; a++) {
      if (!strictSub(a, b)) continue;
      let covered = true;
      for (let c = 0; c < retained.length; c++) {
        if (c !== a && c !== b && strictSub(a, c) && strictSub(c, b)) {
          covered = false;
          break;
        }
      }
      if (covered) {
        children[b]!.push(idOf(retained[a]!.S));
        parents[a]!.push(idOf(retained[b]!.S));
      }
    }
  }

  // First node in each class (by size desc, then id) is the representative.
  const seenClass = new Set<number>();
  const built = retained.map(({ S }, r) => {
    const ops = S.map((ci) => ctx.cosets[ci]!);
    const identity = identifySubgroup(ops, parentOps);
    const key = classKey[retained[r]!.i]!;
    const conjugacyClassId = classIdByKey.get(key)!;
    const isRep = !seenClass.has(conjugacyClassId);
    seenClass.add(conjugacyClassId);
    const order = S.length;
    return {
      id: idOf(S),
      operations: ops,
      identity,
      pointGroup: identity.pointGroup,
      order,
      index: N / order,
      maximalSubgroupIds: children[r]!,
      minimalSupergroupIds: parents[r]!,
      conjugacyClassId,
      classRepresentative: isRep,
      domainCount: domainCountByKey.get(key)!,
      isParent: order === N,
      isTrivial: order === 1,
    } satisfies SubgroupNode;
  });

  // Present index ascending (parent first), conjugates contiguous, deterministic.
  built.sort(
    (a, b) => a.index - b.index || a.conjugacyClassId - b.conjugacyClassId || a.id.localeCompare(b.id),
  );

  const parent = built.find((n) => n.isParent);
  return { parentId: parent?.id ?? built[0]?.id ?? "", nodes: built, truncated };
}

/** Only the conjugacy-class representatives — what a subgroup picker should list. */
export function subgroupClassRepresentatives(tree: StructuralSubgroupTree): SubgroupNode[] {
  return tree.nodes.filter((n) => n.classRepresentative);
}
