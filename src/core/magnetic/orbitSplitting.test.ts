import { describe, it, expect } from "vitest";
import type { StructureModel } from "@/core/crystal/types";
import type { Vec3 } from "@/core/math/types";
import { buildSpaceGroup } from "@/core/crystal/spaceGroups";
import { applyOperation } from "@/core/crystal/symmetry";
import { generateMagneticCandidatesForK, littleGroup } from "@/core/magnetic/magneticGroups";
import { buildMagneticModel } from "@/core/magnetic/momentModel";
import { magneticStructureFactor } from "@/core/magnetic/structureFactor";
import { momentBindingKey } from "@/core/magnetic/types";
import { applyMagneticMoments } from "@/core/workflow/magnetic";

/**
 * When the magnetic group is smaller than the nuclear group (a k ≠ 0 little
 * group), it can split a site's crystallographic orbit. Each split orbit is an
 * independent magnetic sublattice and must carry its own moment — previously
 * the split-off atoms silently had NO moment (zero magnetic contribution, no
 * arrow in the viewer).
 */

const iso = { kind: "isotropic", bIso: 0.4 } as const;
const wrap = (v: number): number => ((v % 1) + 1) % 1;

// P2₁/c (order 4) with k = (0,0,1/3): only {1, c} leave k invariant, so the
// little group has order 2 and a general-position orbit (4 atoms) splits into
// two G_k-orbits of 2 atoms each.
const sg = buildSpaceGroup(14);
const structure: StructureModel = {
  id: "t",
  name: "t",
  cell: { a: 5, b: 6, c: 7, alpha: 90, beta: 100, gamma: 90 },
  spaceGroup: sg,
  sites: [{ label: "Fe1", element: "Fe", oxidationState: 3, position: [0.1, 0.2, 0.3], occupancy: 1, adp: iso }],
};
const k: Vec3 = [0, 0, 1 / 3];
const candidates = generateMagneticCandidatesForK(sg.operations, k);
const typeI = candidates.find((c) => c.isTypeI)!;

describe("orbit splitting under a k ≠ 0 little group", () => {
  it("sanity: G_k is index 2 in G and the orbit splits", () => {
    expect(sg.operations).toHaveLength(4);
    expect(littleGroup(sg.operations, k)).toHaveLength(2);
  });

  it("emits an independent moment entry (own position, own parameters) per split orbit", () => {
    const build = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 2 });
    // Two split orbits → two moment entries for the one site label.
    expect(build.magnetic.moments).toHaveLength(2);
    const [first, second] = build.magnetic.moments;
    expect(first!.orbitIndex).toBeUndefined(); // orbit 1: legacy shape
    expect(first!.position).toBeUndefined();
    expect(second!.orbitIndex).toBe(2);
    expect(second!.position).toBeDefined();
    expect(momentBindingKey(second!)).toBe("Fe1#2");
    // The orbit-2 anchor really is in the nuclear orbit but not the G_k-orbit
    // of the site position.
    const lg = littleGroup(sg.operations, k);
    const inLgOrbit = lg.some((op) => {
      const p = applyOperation(op, structure.sites[0]!.position).map(wrap);
      return p.every((v, i) => Math.abs(v - wrap(second!.position![i]!)) < 1e-3);
    });
    expect(inLgOrbit).toBe(false);
    // Parameters exist for both orbits, orbit-2 ids carry the orbit tag.
    expect(build.params.some((p) => p.id === "mom_Fe1_0")).toBe(true);
    expect(build.params.some((p) => p.id.startsWith("mom_Fe1_o2_"))).toBe(true);
  });

  it("applyMagneticMoments drives each split orbit independently", () => {
    const build = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 0 });
    const orbit1Params = build.params.filter((p) => !p.id.includes("_o2_"));
    const orbit2Params = build.params.filter((p) => p.id.includes("_o2_"));
    expect(orbit1Params.length).toBeGreaterThan(0);
    expect(orbit2Params.length).toBeGreaterThan(0);
    // Zero orbit 1, drive orbit 2 only.
    const values: Record<string, number> = {};
    for (const p of orbit1Params) values[p.id] = 0;
    for (const p of orbit2Params) values[p.id] = 0;
    values[orbit2Params[0]!.id] = 1.7;
    const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
    const m1 = applied.moments.find((m) => momentBindingKey(m) === "Fe1")!;
    const m2 = applied.moments.find((m) => momentBindingKey(m) === "Fe1#2")!;
    expect(Math.hypot(...m1.components)).toBeLessThan(1e-9);
    expect(Math.hypot(...m2.components)).toBeGreaterThan(0.1);
  });

  it("a split-orbit moment contributes magnetic intensity (was silently zero)", () => {
    const build = buildMagneticModel(structure, k, ["Fe1"], typeI.operations, { moment: 0 });
    const orbit2Params = build.params.filter((p) => p.id.includes("_o2_"));
    const values: Record<string, number> = {};
    for (const p of build.params) values[p.id] = 0;
    values[orbit2Params[0]!.id] = 2;
    const applied = applyMagneticMoments(build.magnetic, build.bindings, values);
    // Satellite of (1 0 0) at +k: h,k,l = (1, 0, 1/3).
    const sf = magneticStructureFactor(structure, applied, 1, 0, 1 / 3);
    expect(sf.squared).toBeGreaterThan(1e-6);
  });

  it("k = 0 (no split) keeps the legacy single-orbit shape and parameter ids", () => {
    const k0: Vec3 = [0, 0, 0];
    const cands0 = generateMagneticCandidatesForK(sg.operations, k0);
    const build = buildMagneticModel(structure, k0, ["Fe1"], cands0[0]!.operations, { moment: 2 });
    expect(build.magnetic.moments).toHaveLength(1);
    expect(build.magnetic.moments[0]!.orbitIndex).toBeUndefined();
    expect(build.magnetic.moments[0]!.position).toBeUndefined();
    expect(build.params.every((p) => /^mom_Fe1_\d+$/.test(p.id))).toBe(true);
  });
});
