/**
 * Gates for the structural translationengleiche subgroup lattice:
 *  - the m-3m golden: O_h has exactly 98 t-subgroups (Bilbao/ITA1), three
 *    index-2 maximal subgroups (P432, P-43m, Pm-3), conjugate 4/mmm (×3) and
 *    -3m (×4) classes, and a covering chain down to P1;
 *  - Pnma (point group mmm ≅ (C₂)³): exactly 16 subgroups (the subspaces of
 *    𝔽₂³), operations closed and index-consistent — the non-symmorphic case,
 *    verifying intrinsic glide/screw translations ride along on each node;
 *  - P1: the trivial one-node lattice;
 *  - each node's operations feed `realizeSubgroup` (subgroup-driven activation).
 */
import { describe, it, expect } from "vitest";
import type { StructureModel, UnitCell, AtomSite } from "@/core/crystal/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { composeOperations } from "@/core/crystal/symmetry";
import { rotationKey } from "@/core/magnetic/magneticGroups";
import { realizeSubgroup } from "@/core/crystal/isotropyTree";
import { structuralSubgroupLattice, subgroupClassRepresentatives } from "@/core/crystal/subgroupTree";

const CELL: UnitCell = { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 };
function site(label: string, position: readonly [number, number, number]): AtomSite {
  return { label, element: "Sr", position, occupancy: 1, adp: { kind: "isotropic", bIso: 0.5 } };
}
function structure(sgId: number, sites: AtomSite[], cell: UnitCell = CELL): StructureModel {
  return { id: "t", name: "t", cell, spaceGroup: buildSpaceGroup(sgId), sites };
}

describe("m-3m (Pm-3m) subgroup lattice — golden", () => {
  const tree = structuralSubgroupLattice(structure(221, [site("A", [0, 0, 0])]));

  it("enumerates all 98 translationengleiche subgroups", () => {
    expect(tree.nodes.length).toBe(98);
    expect(tree.truncated).toBe(false);
  });

  it("puts the whole group first, named Pm-3m (#221)", () => {
    const parent = tree.nodes.find((n) => n.id === tree.parentId)!;
    expect(parent).toBe(tree.nodes[0]); // index ascending → parent first
    expect(parent.isParent).toBe(true);
    expect(parent.index).toBe(1);
    expect(parent.order).toBe(48);
    expect(parent.identity.number).toBe(221);
  });

  it("has the three index-2 maximal subgroups P432, P-43m, Pm-3", () => {
    const idx2 = tree.nodes.filter((n) => n.index === 2);
    expect(idx2.length).toBe(3);
    expect(new Set(idx2.map((n) => n.identity.number))).toEqual(new Set([207, 215, 200]));
    expect(new Set(idx2.map((n) => n.pointGroup))).toEqual(new Set(["432", "-43m", "m-3"]));
  });

  it("links the parent's covering (maximal) subgroups — 3×i2 + 3×i3 + 4×i4 = 10", () => {
    const parent = tree.nodes[0]!;
    expect(parent.maximalSubgroupIds.length).toBe(10);
    const covers = parent.maximalSubgroupIds.map((id) => tree.nodes.find((n) => n.id === id)!);
    expect(covers.filter((n) => n.index === 2).length).toBe(3);
    expect(covers.filter((n) => n.pointGroup === "4/mmm").length).toBe(3);
    expect(covers.filter((n) => n.pointGroup === "-3m").length).toBe(4);
  });

  it("groups conjugate subgroups into domains (4/mmm ×3, -3m ×4)", () => {
    const fourMmm = tree.nodes.filter((n) => n.pointGroup === "4/mmm");
    expect(fourMmm.length).toBe(3);
    expect(new Set(fourMmm.map((n) => n.conjugacyClassId)).size).toBe(1); // one class
    expect(fourMmm.every((n) => n.domainCount === 3)).toBe(true);
    expect(fourMmm.filter((n) => n.classRepresentative).length).toBe(1);

    const bar3m = tree.nodes.filter((n) => n.pointGroup === "-3m");
    expect(bar3m.length).toBe(4);
    expect(bar3m.every((n) => n.domainCount === 4)).toBe(true);
  });

  it("class-representative view is a smaller, deduplicated list", () => {
    const reps = subgroupClassRepresentatives(tree);
    expect(reps.length).toBeLessThan(tree.nodes.length);
    expect(reps.length).toBeGreaterThan(0);
    // Every conjugacy class has exactly one representative.
    const classIds = new Set(tree.nodes.map((n) => n.conjugacyClassId));
    expect(reps.length).toBe(classIds.size);
  });

  it("has a covering chain from the parent down to P1", () => {
    const trivial = tree.nodes.find((n) => n.isTrivial)!;
    expect(trivial.order).toBe(1);
    expect(trivial.index).toBe(48);
    expect(trivial.pointGroup).toBe("1");
    // Greedy descent through covering edges reaches the trivial node.
    let cur = tree.nodes[0]!;
    const visited = new Set([cur.id]);
    while (!cur.isTrivial && cur.maximalSubgroupIds.length > 0) {
      const next = cur.maximalSubgroupIds
        .map((id) => tree.nodes.find((n) => n.id === id)!)
        .sort((a, b) => b.order - a.order)[0]!;
      if (visited.has(next.id)) break;
      visited.add(next.id);
      cur = next;
    }
    expect(cur.isTrivial).toBe(true);
  });

  it("maxIndex truncates the lattice", () => {
    const capped = structuralSubgroupLattice(structure(221, [site("A", [0, 0, 0])]), { maxIndex: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.nodes.every((n) => n.index <= 2)).toBe(true);
    expect(capped.nodes.length).toBe(4); // parent + 3 index-2
  });
});

describe("Pnma (mmm ≅ (C₂)³) — non-symmorphic, 16 subgroups", () => {
  const tree = structuralSubgroupLattice(
    structure(62, [site("A", [0.1, 0.25, 0.2])], { a: 7, b: 5, c: 8, alpha: 90, beta: 90, gamma: 90 }),
  );

  it("has exactly 16 t-subgroups (subspaces of 𝔽₂³)", () => {
    expect(tree.nodes.length).toBe(16);
    expect(tree.nodes[0]!.identity.number).toBe(62);
  });

  it("every node is index-consistent and closed under composition", () => {
    const N = 8;
    for (const n of tree.nodes) {
      expect(n.order * n.index).toBe(N);
      const keys = new Set(n.operations.map(rotationKey));
      for (const a of n.operations) {
        for (const b of n.operations) {
          expect(keys.has(rotationKey(composeOperations(a, b)))).toBe(true);
        }
      }
    }
  });
});

describe("P1 — trivial lattice", () => {
  it("is a single self-parent, self-trivial node", () => {
    const tree = structuralSubgroupLattice(structure(1, [site("A", [0.3, 0.3, 0.3])]));
    expect(tree.nodes.length).toBe(1);
    const only = tree.nodes[0]!;
    expect(only.isParent).toBe(true);
    expect(only.isTrivial).toBe(true);
    expect(only.index).toBe(1);
    expect(only.order).toBe(1);
  });
});

describe("nodes feed realizeSubgroup (subgroup-driven activation)", () => {
  it("realizes the Pm-3 (#200) child from its node operations", () => {
    const parent = structure(221, [site("A", [0, 0, 0])]);
    const tree = structuralSubgroupLattice(parent);
    const pm3 = tree.nodes.find((n) => n.identity.number === 200)!;
    const child = realizeSubgroup(parent, pm3.operations, pm3.identity);
    expect(child.spaceGroup.operations.length).toBe(24);
    expect(child.spaceGroup.number).toBe(200); // direct match → standard name stamped
    expect(child.sites.length).toBe(1); // the 1a site at the origin stays one orbit
  });
});
